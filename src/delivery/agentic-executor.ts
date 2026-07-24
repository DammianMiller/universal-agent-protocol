/**
 * Agentic executor (spike)
 *
 * The default deliver executor is "blind": one text completion per turn, no
 * tool use. It cannot read the repo, run a build, or inspect a failing test —
 * so on tasks that require looking before acting it produces guesses and the
 * gate stays at 0%.
 *
 * This executor instead runs a bounded tool-use loop against the model
 * (read_file / list_dir / run_bash / write_file), letting it inspect the
 * project and apply changes directly before returning. Paired with the no-op
 * applier below (the repo is already mutated), it slots into the existing
 * convergence loop: execute → gate → feedback, but with an agentic execute.
 *
 * Scope note: this is a capability spike. It allows write_file/run_bash, so it
 * bypasses the applier's test-protection — acceptable for measuring value, not
 * for production without re-adding a protected-path guard.
 */

import { spawnSync } from 'child_process';
import { normalizeToolPath } from './path-normalize.js';
import { withModelSlot, recordModelSuccess, recordModelExhaustion, isExhaustionError } from '../utils/model-slot-lease.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, rmSync } from 'fs';
import { join, dirname, resolve, relative, isAbsolute } from 'path';
import type { ModelConfig } from '../models/types.js';
import type { LoopExecutor } from './convergence-loop.js';
import { fetchModelWithRetry } from '../models/long-fetch.js';
import { resolveRequestCredential } from '../models/openai-compat-client.js';
import type { ApplyResult } from './applier.js';
import { protectedWritePathReason, parseFileBlocks, listGateConfigFiles, isGateConfigBasename } from './applier.js';
import { estimateMessagesTokens, formatBudgetStop } from './context-budget.js';
import { sanitizedEnv } from './sanitized-env.js';

/**
 * Directories the agent must never read, list, or write: its OWN machinery.
 *
 * Observed live: a routed deliver run spent 5 of its 10 tool calls recursing into
 * `.uap/deliver-runs/<its own run>/state.json`, `.uap/autoroute.log` and the lock
 * files — half of a tight budget (`--max-turns 5 --ceiling 10`) gone, so it could
 * never converge on the actual deliverable. One of those calls even errored
 * (`read_file .uap/deliver-runs` → EISDIR), burning another turn.
 *
 * The agent has no business reading the state that describes its own execution:
 * it is pure distraction, and a confusion risk (it can see its own turn counts and
 * status). This is the protected-path guard this file's scope note asked for.
 */
const AGENT_INTERNAL_DIRS = ['.uap', '.uap-deliver', '.git', 'node_modules'];

/**
 * The internal files the agent may READ: the SPECIFICATIONS it is judged against.
 *
 * These are not "internal state" in the distracting sense — they ARE the criteria.
 * Blanket-blocking their directories meant the agent could not see what it had to
 * satisfy, and it looped trying:
 *
 *  - `.uap-deliver/verify.sh` — the acceptance gate. 6 refused reads in one live
 *    mission, ERROR-LOOP firing 5 times, while the gate sat one refusal away.
 *  - `.uap/user-paths.json` — the user-path journey manifest. The user-validation
 *    gate's own failure text says "the manifest is .uap/user-paths.json", and the
 *    guard then refused to let the agent read it, so it could not know WHICH
 *    selectors the journeys assert. Live cost (octopus_invaders_v3, 2026-07-22):
 *    a deliver churned 2h44m flat at 50% of gates, rewriting one file over and
 *    over while guessing the contract. Pointing an agent at a file and then
 *    hiding it is a harness bug, not a model failure.
 *
 * Reading these is exactly what we want (target the real criteria). WRITING them
 * is the agent rigging its own gate, and stays blocked — that distinction is the
 * whole point of the carve-out.
 */
const READABLE_SPECS = new Set(['.uap-deliver/verify.sh', '.uap/user-paths.json']);

/**
 * Reason string when a path is UAP/agent-internal, else null.
 *
 * `forWrite` exists so the acceptance gate can be read but never rewritten.
 */
function agentInternalReason(projectRoot: string, abs: string, forWrite = false): string | null {
  const rel = relative(projectRoot, abs).split('\\').join('/');
  const top = rel.split('/')[0];
  if (!top || !AGENT_INTERNAL_DIRS.includes(top)) return null;

  if (READABLE_SPECS.has(rel)) {
    if (!forWrite) return null; // the spec: readable
    return (
      `ERROR: '${rel}' is a SPECIFICATION you are judged against — you may read it, ` +
      'but you must never modify it. Rewriting the gate is not passing it. ' +
      'Change the implementation so the existing gate passes.'
    );
  }

  return (
    `ERROR: '${rel}' is UAP/agent internal state (${top}/) — it is NOT part of the ` +
    'deliverable and tells you nothing about the task. Do not read, list, or write it. ' +
    "Work on the project's own source files instead."
  );
}

export interface AgenticExecutorOptions {
  projectRoot: string;
  endpoint: string;
  /** Max tool-call rounds before forcing a final answer. Default 12. */
  maxToolRounds?: number;
  temperature?: number;
  /** Per-tool bash timeout in ms. Default 30s. */
  bashTimeoutMs?: number;
  /**
   * Protected test/oracle paths (lowercased, forward-slash, relative to
   * projectRoot — the shape from snapshotProtection()). write_file refuses
   * them and run_bash restores any that a command mutated, so the agent cannot
   * pass gates by rewriting the oracle.
   */
  protectedFiles?: ReadonlySet<string>;
  /**
   * LOCKED CONTRACT files (project-relative lowercased keys, like
   * protectedFiles) — the shared types/interfaces an accepted contracts epic
   * established. write_file refuses them and run_bash restores mutations, so
   * later epics build AGAINST the contracts instead of re-inventing them.
   * Passed as a mutable Set by the epic controller and grown between epics.
   */
  contractFiles?: ReadonlySet<string>;
  /**
   * Block writes to gate-config / IaC files (tsconfig, vitest/jest config,
   * docker-compose, Dockerfile, *.tf, serverless, …) and protected segments
   * (.github, .git, node_modules). Mirrors the applier's protectGateConfigs so
   * the agentic path cannot rig the (now tiered) gates the file-block applier
   * already protects. Default true.
   */
  protectGateConfigs?: boolean;
  /** Optional sink for a structured trace of what the agent did. */
  onEvent?: (event: AgenticEvent) => void;
  /**
   * Called after EVERY tool execution (read/list/write/edit/bash) — a
   * fine-grained progress signal. Wired to the deliver heartbeat so a long,
   * legitimately-working turn keeps the heartbeat fresh; without it the
   * heartbeat only advanced between turns, so a slow turn writing many files
   * looked increasingly "wedged" to the lock's wedge-reclaim (P0 review + live
   * observation, 2026-07-19).
   */
  onToolProgress?: () => void;
  /**
   * Allow the `run_bash` tool to execute (default false). run_bash is the model
   * running an UNCONTAINED host shell when not sandboxed — `cwd` is not a
   * boundary, so it can read ~/.ssh, curl secrets out, or write outside the
   * workdir (security audit X3). It executes only when the session is
   * kernel-contained (`uap sandbox` sets UAP_SANDBOX_ACTIVE=1, auto-detected)
   * OR the operator explicitly opts in (`--allow-bash` / UAP_DELIVER_ALLOW_BASH=1).
   * Otherwise run_bash returns a refusal telling the model to use read/write
   * tools; the rest of the agentic loop is unaffected.
   */
  allowBash?: boolean;
  /**
   * Hard estimated-token ceiling for one agentic session (the per-rail
   * serving context × working fraction — see delivery/context-budget.ts).
   * Checked before every model round; when the accumulated conversation
   * estimate crosses it, the session ends with a CONTEXT_BUDGET_MARKER
   * summary instead of sending a request that would overflow (or get pruned
   * mid-flight by the proxy). The epic controller keys its split-and-retry
   * path off that marker. Omit to disable (legacy unbounded behavior).
   */
  contextTokenBudget?: number;
}

export interface AgenticEvent {
  round: number;
  kind: 'tool' | 'final' | 'error';
  tool?: string;
  detail?: string;
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/**
 * Offer only the tools we will actually RUN.
 *
 * run_bash used to be advertised unconditionally and then REFUSED at execution
 * time whenever it was not sandboxed. The model does what the menu says: on a
 * live mission it spent 58 of its 79 tool calls on run_bash — every one bounced
 * — while managing only 21 writes. Nearly three quarters of the turn budget
 * burned on a tool that was never going to run. Every attempt was read-only
 * (`cat` ×44, `wc`, `find`, `ls`, `head`), i.e. the model was not probing the
 * sandbox, it just reached for the shell it had been shown.
 *
 * A tool you refuse to execute must not appear in the schema. The execution-time
 * containment check below stays as the backstop.
 */
export function toolsFor(allowBash: boolean): Array<(typeof TOOLS)[number]> {
  return allowBash ? [...TOOLS] : TOOLS.filter((t) => t.function.name !== 'run_bash');
}

/** Pure read/inspect tools — the ones a stuck model loops on. Stripped in a
 * forced-write round so it can only mutate or finish. run_bash is NOT here: it
 * can legitimately WRITE files (codegen/scaffold), and when --allow-bash is on
 * a session may be making real progress through it, so it is kept under force
 * (guarded by allowBash in writeOnlyTools). */
const READ_ONLY_TOOL_NAMES = new Set(['read_file', 'list_dir']);

/** Mutating + terminating tools (plus run_bash when allowed). Offered with
 * tool_choice:'required' for a SINGLE forced round once a weak local model has
 * ignored the soft write-nudge and kept reading — removing the read tools makes
 * another read impossible, so the model must write_file/edit_file (or run_bash,
 * or finish). The very next round restores reads (see the alternation in the
 * loop) so a model whose correct move needs current file content — e.g. a
 * surgical edit_file — is never trapped for more than one round. */
export function writeOnlyTools(allowBash: boolean): Array<(typeof TOOLS)[number]> {
  return toolsFor(allowBash).filter((t) => !READ_ONLY_TOOL_NAMES.has(t.function.name));
}

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a UTF-8 text file relative to the project root.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: 'List files/dirs at a path relative to the project root.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_bash',
      description: 'Run a bash command from the project root and return stdout+stderr+exit code.',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create or overwrite a text file (relative to project root) with the given content.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description:
        'Surgically replace ONE exact occurrence of old_string with new_string in an existing file (path relative to project root). PREFER this over write_file for existing files — no need to re-emit the whole file (large re-emits truncate). old_string must match the CURRENT file content exactly, whitespace included, and exactly once unless occurrence (1-based) is given.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          old_string: { type: 'string' },
          new_string: { type: 'string' },
          occurrence: { type: 'number' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'finish',
      description: 'Call when the task is complete. Provide a one-line summary of what was done.',
      parameters: {
        type: 'object',
        properties: { summary: { type: 'string' } },
        required: ['summary'],
      },
    },
  },
] as const;

/** Resolve a model-supplied path inside the project root, refusing escapes. */
function safePath(projectRoot: string, p: string): string {
  const abs = isAbsolute(p) ? p : resolve(projectRoot, p);
  const rel = relative(projectRoot, abs);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`path escapes project root: ${p}`);
  }
  return abs;
}

/** Normalize an absolute path to the protected-set key shape (lowercased, /). */
const EMPTY_SET: ReadonlySet<string> = new Set();

/**
 * Add an accepted contracts epic's files to the live contract lock, skipping
 * files other machinery owns (manifests/lockfiles stay editable so later
 * epics can add crates/deps; gate configs and tests have their own
 * protection). Returns the project-relative paths newly locked — for the
 * operator log and the later epics' prompts.
 */
export function lockContractFiles(lock: Set<string>, projectRoot: string, files: string[]): string[] {
  const locked: string[] = [];
  for (const f of files) {
    const rel = f.split(/[\\/]/).join('/');
    const base = (rel.split('/').pop() ?? '').toLowerCase();
    if (!base) continue;
    if (/^(package\.json|package-lock\.json|cargo\.toml|cargo\.lock|pyproject\.toml|go\.mod|go\.sum)$/.test(base) || base.endsWith('.lock')) continue;
    if (isGateConfigBasename(base)) continue;
    if (/\.(test|spec)\.[a-z]+$/.test(base)) continue;
    const key = protectedKey(projectRoot, resolve(projectRoot, rel));
    if (!lock.has(key)) {
      lock.add(key);
      locked.push(rel);
    }
  }
  return locked;
}

export function protectedKey(projectRoot: string, abs: string): string {
  return relative(projectRoot, abs).split(/[\\/]/).join('/').toLowerCase();
}

/**
 * P3 anti-gutting predicate. A weak model re-emitting a large existing file
 * often truncates it, replacing real implementation with a stub (observed live:
 * deliver.ts collapsed 2560 → 453 lines in one write_file). Flag a write that
 * shrinks a SUBSTANTIAL existing file (≥1500 bytes) to under 35% of its size —
 * the gutting signature — so the caller can refuse it and steer to edit_file.
 * Small files are never guarded (legitimate rewrites are common there). PURE.
 */
export function isSuspectedGutting(prevLen: number, newLen: number): boolean {
  return prevLen >= 1500 && newLen < prevLen * 0.35;
}

/** Snapshot current contents of protected files that exist. */
function snapshotProtected(
  projectRoot: string,
  protectedFiles: ReadonlySet<string>
): Map<string, string> {
  const snap = new Map<string, string>();
  for (const rel of protectedFiles) {
    const abs = resolve(projectRoot, rel);
    if (existsSync(abs)) {
      try {
        snap.set(abs, readFileSync(abs, 'utf-8'));
      } catch {
        /* unreadable — skip */
      }
    }
  }
  return snap;
}

/** Restore any protected files a command mutated; return the list restored. */
function restoreProtected(snap: Map<string, string>): string[] {
  const restored: string[] = [];
  for (const [abs, content] of snap) {
    try {
      if (!existsSync(abs) || readFileSync(abs, 'utf-8') !== content) {
        writeFileSync(abs, content, 'utf-8');
        restored.push(abs);
      }
    } catch {
      /* best effort */
    }
  }
  return restored;
}

/**
 * Suppress a READ the agent has already done, unchanged.
 *
 * A live 63-minute mission sat on phase 0 of 6 because it kept re-exploring the
 * same ground: 171 list_dir calls of which 46 were the SAME `src/types`, 45 the
 * same `.`, 37 the same `src`; 23 re-reads of one file. Roughly 60% of its tool
 * calls were re-derivations of things it already knew, so it never got far
 * enough to finish a phase.
 *
 * The proxy's RECON CONVERGENCE guardrail cannot catch this: it fires on a
 * NO-WRITE streak, and this agent does write (39 times) — so the streak keeps
 * resetting while the agent re-lists the same directory for the 46th time.
 * Deliver's own loop needs its own guard.
 *
 * Correctness rule: only suppress when the underlying path is UNCHANGED since we
 * served it (mtime). A re-read AFTER the agent writes the file is legitimate and
 * must always go through — otherwise we would hand it a stale view of its own
 * edit, which is far worse than a wasted call.
 */
export interface ReadCache {
  seen: Map<string, { mtimeMs: number; round: number }>;
}

export function newReadCache(): ReadCache {
  return { seen: new Map() };
}

/** mtime of a path, or null when it does not exist / is unreadable. */
function mtimeOf(p: string): number | null {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Returns a terse steer when this exact read was already served and nothing has
 * changed since; null when the call should run normally.
 */
export function repeatReadNote(
  cache: ReadCache,
  projectRoot: string,
  name: string,
  args: Record<string, unknown>,
  round: number
): string | null {
  if (name !== 'read_file' && name !== 'list_dir') return null;
  if (typeof args.path !== 'string') return null;
  const key = `${name}:${args.path}`;
  const abs = resolve(projectRoot, args.path);
  const mtime = mtimeOf(abs);
  const prior = cache.seen.get(key);
  if (prior && mtime !== null && prior.mtimeMs === mtime) {
    return (
      `[NOTE: unchanged since you read ${args.path} at round ${prior.round}. ` +
      'The content follows anyway — but re-reading it tells you nothing new, so act on it: ' +
      'make the edit, or call finish.]'
    );
  }
  if (mtime !== null) cache.seen.set(key, { mtimeMs: mtime, round });
  return null;
}

export function runTool(
  projectRoot: string,
  name: string,
  args: Record<string, unknown>,
  bashTimeoutMs: number,
  protectedFiles: ReadonlySet<string>,
  protectGateConfigs: boolean,
  allowBash: boolean,
  contractFiles: ReadonlySet<string> = EMPTY_SET
): string {
  let pathNote = '';
  // Contain/repair garbled tool-call paths against the known project root before
  // any filesystem op — the small model mangles prefixes/subdirs and the write
  // would otherwise escape the root or land nowhere (the proxy fixes this for
  // Claude Code; deliver's agentic path bypassed it).
  if (
    (name === 'read_file' || name === 'list_dir' || name === 'write_file' || name === 'edit_file') &&
    typeof args.path === 'string'
  ) {
    const norm = normalizeToolPath(projectRoot, args.path, { forWrite: name === 'write_file' });
    if (norm.changed) {
      pathNote = ` (path corrected: ${args.path} -> ${norm.path})`;
      args = { ...args, path: norm.path };
    }
  }
  try {
    if (name === 'read_file') {
      const abs = safePath(projectRoot, String(args.path));
      const internal = agentInternalReason(projectRoot, abs);
      if (internal) return internal;
      if (!existsSync(abs)) return `ERROR: file not found: ${args.path}`;
      // read_file on a DIRECTORY threw a raw `EISDIR: illegal operation on a
      // directory` — an error the model cannot act on, so it retried and the
      // proxy's ERROR-LOOP guard fired. But its intent is obvious: it wants to
      // see what is in there. Serve that intent instead of failing, and name the
      // right tool for next time. A wasted turn becomes a useful one.
      if (statSync(abs).isDirectory()) {
        const entries = readdirSync(abs)
          .filter((e) => !AGENT_INTERNAL_DIRS.includes(e))
          .map((e) => (statSync(join(abs, e)).isDirectory() ? `${e}/` : e))
          .join('\n')
          .slice(0, 4000);
        return (
          `NOTE: '${String(args.path)}' is a DIRECTORY, not a file — use list_dir for it. ` +
          `Its contents:\n${entries}`
        );
      }
      return readFileSync(abs, 'utf-8').slice(0, 8000);
    }
    if (name === 'list_dir') {
      const abs = safePath(projectRoot, String(args.path ?? '.'));
      const internal = agentInternalReason(projectRoot, abs);
      if (internal) return internal;
      if (!existsSync(abs)) return `ERROR: not found: ${args.path}`;
      return readdirSync(abs)
        // Also HIDE the internal dirs from any listing (e.g. the project root), so
        // the agent never even sees `.uap/` and is not tempted to spelunk it.
        .filter((e) => !AGENT_INTERNAL_DIRS.includes(e))
        .map((e) => (statSync(join(abs, e)).isDirectory() ? `${e}/` : e))
        .join('\n')
        .slice(0, 4000);
    }
    if (name === 'write_file') {
      const abs = safePath(projectRoot, String(args.path));
      // Truncated-emit guard: a weak model re-emitting a whole large file hits
      // its output ceiling mid-class and the stump poisons the tree — every
      // later judge turn then rejects "code cuts off" while the model keeps
      // reproducing the same truncation (octopus run G, 2026-07-17: ui.js cut
      // mid-UIManager across 6 attempts). Refuse the obviously-cut write with
      // corrective feedback steering to edit_file. Heuristic is conservative
      // (code files only, net-unclosed braces only) — a false negative just
      // falls back to judge feedback, a false positive costs one retry.
      const truncated = looksTruncated(String(args.path), String(args.content ?? ''));
      if (truncated) {
        return (
          `ERROR: ${String(args.path)} content looks TRUNCATED (${truncated}). ` +
          'Your output was likely cut off mid-file. Do NOT re-emit the whole file: ' +
          'use edit_file to change only the parts that need changing, or write the file in smaller pieces.'
        );
      }
      const internal = agentInternalReason(projectRoot, abs, true);
      if (internal) return internal;
      if (protectedFiles.has(protectedKey(projectRoot, abs))) {
        return `ERROR: ${String(args.path)} is a protected test/oracle file — refusing to modify it. Change the implementation, not the test.`;
      }
      if (contractFiles.has(protectedKey(projectRoot, abs))) {
        return (
          `ERROR: ${String(args.path)} is a LOCKED CONTRACT file — the contracts phase established ` +
          'this shared API and later phases must BUILD AGAINST it, not modify it. Adjust YOUR code ' +
          'to match the contract exactly (imports, type names, signatures).'
        );
      }
      // Gate-config / IaC protection: the agentic path bypasses the file-block
      // applier, so enforce the same blocklist here or the model can rig the
      // (tiered) gates by writing tsconfig/compose/Dockerfile/*.tf/etc.
      const rel = relative(projectRoot, abs).split(/[\\/]/).join('/');
      const blocked = protectedWritePathReason(rel, protectGateConfigs);
      if (blocked) {
        return `ERROR: ${String(args.path)}: ${blocked}. Change the implementation, not the gate.`;
      }
      // P3 anti-gutting: refuse a write that GUTS an existing substantial file
      // into a stub (observed live: deliver.ts collapsed 2560 → 453 lines in one
      // write, silently destroying the implementation). Steer to edit_file for a
      // surgical change. Override for a real large deletion: UAP_DELIVER_ALLOW_GUTTING=1.
      if (existsSync(abs) && process.env.UAP_DELIVER_ALLOW_GUTTING !== '1') {
        try {
          const prevLen = statSync(abs).size; // bytes, no full read
          const newLen = Buffer.byteLength(String(args.content ?? ''), 'utf-8');
          if (isSuspectedGutting(prevLen, newLen)) {
            return (
              `ERROR: refusing to write ${String(args.path)} — it would shrink an existing ` +
              `${prevLen}-byte file to ${newLen} bytes (${Math.round((newLen / prevLen) * 100)}%), the ` +
              `signature of accidentally GUTTING a real file into a stub. To change PART of this file, ` +
              `use edit_file (surgical replace) — that is almost certainly what you want. Re-sending this ` +
              `same content will be refused again. ONLY if you deliberately intend to replace the ENTIRE ` +
              `file with this much smaller version, set UAP_DELIVER_ALLOW_GUTTING=1.`
            );
          }
        } catch { /* unreadable prev — allow the write */ }
      }
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, String(args.content ?? ''), 'utf-8');
      // Per-write compile feedback for Rust: without it, a weak model writes
      // whole turns of code against types it invented, and the turn-end gate
      // reports an avalanche it cannot dig out of (observed live 2026-07-10:
      // 47 → 653 errors across one epic attempt). An incremental warm
      // `cargo check` is ~2s and stops the spiral at the first bad write.
      // Feedback only — the write itself always lands. UAP_DELIVER_RUST_WRITE_CHECK=0 disables.
      const rustCheckNote = maybeRustWriteCheck(projectRoot, rel);
      const jsCheckNote = maybeJsSyntaxCheck(projectRoot, rel);
      return `OK: wrote ${String(args.path)} (${String(args.content ?? '').length} bytes)${pathNote}${rustCheckNote}${jsCheckNote}`;
    }
    if (name === 'edit_file') {
      // P1 (plan D3, 2026-07-13): anchored surgical replace. Whole-file
      // write_file re-emits are the executor's dominant failure mode on
      // 1,000+ line files (truncation/mangling observed live 4x); an exact
      // old/new replacement is deterministic and cheap. Shares write_file's
      // protection surface (tests/contracts/gate-configs).
      const abs = safePath(projectRoot, String(args.path));
      if (protectedFiles.has(protectedKey(projectRoot, abs))) {
        return `ERROR: ${String(args.path)} is a protected test/oracle file — refusing to modify it. Change the implementation, not the test.`;
      }
      if (contractFiles.has(protectedKey(projectRoot, abs))) {
        return `ERROR: ${String(args.path)} is a LOCKED CONTRACT file — build against it, do not modify it.`;
      }
      const rel = relative(projectRoot, abs).split(/[\\/]/).join('/');
      const blocked = protectedWritePathReason(rel, protectGateConfigs);
      if (blocked) {
        return `ERROR: ${String(args.path)}: ${blocked}. Change the implementation, not the gate.`;
      }
      if (!existsSync(abs)) {
        return `ERROR: ${String(args.path)} does not exist — use write_file to create new files.`;
      }
      const current = readFileSync(abs, 'utf-8');
      const oldStr = String(args.old_string ?? '');
      const newStr = String(args.new_string ?? '');
      if (!oldStr) return 'ERROR: old_string must be non-empty.';
      const count = current.split(oldStr).length - 1;
      if (count === 0) {
        return `ERROR: old_string not found in ${String(args.path)} — re-read the file and match the CURRENT content exactly (whitespace included).`;
      }
      const occurrence = args.occurrence == null ? null : Number(args.occurrence);
      if (count > 1 && occurrence == null) {
        return `ERROR: old_string matches ${count} times in ${String(args.path)} — add surrounding context or pass occurrence (1-based).`;
      }
      let updated: string;
      if (occurrence == null) {
        updated = current.replace(oldStr, newStr);
      } else {
        if (!Number.isInteger(occurrence) || occurrence < 1 || occurrence > count) {
          return `ERROR: occurrence ${String(args.occurrence)} out of range (1..${count}).`;
        }
        let idx = -1;
        for (let i = 0; i < occurrence; i++) idx = current.indexOf(oldStr, idx + 1);
        updated = current.slice(0, idx) + newStr + current.slice(idx + oldStr.length);
      }
      writeFileSync(abs, updated, 'utf-8');
      const rustCheckNote = maybeRustWriteCheck(projectRoot, rel);
      const jsCheckNote = maybeJsSyntaxCheck(projectRoot, rel);
      return `OK: edited ${String(args.path)} (1 replacement)${pathNote}${rustCheckNote}${jsCheckNote}`;
    }
    if (name === 'run_bash') {
      // Containment gate (audit X3): run_bash is an uncontained host shell when
      // not sandboxed. Refuse unless kernel-contained or explicitly allowed.
      if (!allowBash) {
        return (
          'run_bash is disabled and you do NOT need it. Do NOT run tests, builds, or any ' +
          'command to verify your work — the delivery gates run the tests and build ' +
          'AUTOMATICALLY after this turn and will report any failure back to you next turn. ' +
          'Do NOT retry this command (inline env like UAP_DELIVER_ALLOW_BASH=1 will not work). ' +
          'Just make the needed changes with write_file, then call finish. ' +
          '(Operator note: enable shell with `uap sandbox` or --allow-bash if genuinely required.)'
        );
      }
      // Snapshot protected files so a command cannot silently rewrite the
      // oracle to make a wrong answer pass.
      const snap = protectedFiles.size > 0 ? snapshotProtected(projectRoot, protectedFiles) : new Map();
      const contractSnap = contractFiles.size > 0 ? snapshotProtected(projectRoot, contractFiles) : new Map();
      // Gate-config writes are blocked on the write_file path, but sed / `git
      // checkout` / `npm pkg set` through run_bash bypassed that check entirely
      // (observed live 2026-07-10: an executor reverted a pyproject.toml gate
      // fix via bash). Snapshot the same configs and restore any the command
      // mutates; a repo-root conftest.py the command CREATES (pytest collection
      // policy, not a fixture) is removed the same way.
      const gateCfgKeys = protectGateConfigs
        ? new Set(listGateConfigFiles(projectRoot))
        : new Set<string>();
      const gateSnap = gateCfgKeys.size > 0 ? snapshotProtected(projectRoot, gateCfgKeys) : new Map();
      const rootConftest = resolve(projectRoot, 'conftest.py');
      const hadRootConftest = existsSync(rootConftest);
      // Secret-stripped env: run_bash is the model running arbitrary shell, so
      // it must not inherit provider/host credentials it could exfiltrate
      // (audit: previously ran with the full host env). Not containment —
      // file-based creds and egress still need `uap sandbox`.
      const r = spawnSync('bash', ['-c', String(args.command)], {
        cwd: projectRoot,
        timeout: bashTimeoutMs,
        encoding: 'utf-8',
        env: sanitizedEnv(),
      });
      const restored = snap.size > 0 ? restoreProtected(snap) : [];
      const gateRestored = gateSnap.size > 0 ? restoreProtected(gateSnap) : [];
      const contractRestored = contractSnap.size > 0 ? restoreProtected(contractSnap) : [];
      let conftestNote = '';
      if (protectGateConfigs && !hadRootConftest && existsSync(rootConftest)) {
        try {
          rmSync(rootConftest);
          conftestNote =
            '\n[blocked: removed the repo-root conftest.py your command created — it controls pytest collection (gate-rigging); put fixtures in a nested tests/conftest.py]';
        } catch {
          /* best effort */
        }
      }
      const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.slice(0, 4000);
      const note =
        (restored.length > 0
          ? `\n[blocked: restored ${restored.length} protected file(s) your command modified]`
          : '') +
        (gateRestored.length > 0
          ? `\n[blocked: restored ${gateRestored.length} gate-config file(s) your command modified — change the implementation, not the gate]`
          : '') +
        (contractRestored.length > 0
          ? `\n[blocked: restored ${contractRestored.length} LOCKED CONTRACT file(s) your command modified — build against the contract, do not rewrite it]`
          : '') +
        conftestNote;
      return `exit=${r.status ?? 'null'}\n${out}${note}`;
    }
    return `ERROR: unknown tool ${name}`;
  } catch (err) {
    return `ERROR: ${String(err).slice(0, 200)}`;
  }
}

/**
 * After a Rust-relevant write, run an incremental `cargo check` and return a
 * compact feedback note for the tool result ('' when not applicable). Errors
 * never fail the write — the model gets the compiler's view immediately and
 * fixes 1-2 errors instead of drowning in hundreds at turn end.
 */
/**
 * Is every reported error simply "a module you have not written yet"?
 *
 * A multi-file Rust crate CANNOT compile until its module tree is whole: write
 * `main.rs` with `use mycrate::types::*` and cargo rightly reports an unresolved
 * import until `types/mod.rs` lands. Those errors are not defects — they are the
 * scaffold being incomplete, and they resolve themselves as the agent keeps
 * writing. Exported for tests: classifying this correctly IS the fix.
 */
export function isIncompleteScaffold(errLines: string[]): boolean {
  if (errLines.length === 0) return false;
  const scaffolding =
    /E0432|E0433|E0583|E0463|unresolved import|file not found for module|can't find crate|cannot find (module|crate)|failed to resolve/i;
  return errLines.every((l) => scaffolding.test(l));
}

function maybeRustWriteCheck(projectRoot: string, rel: string): string {
  if (process.env.UAP_DELIVER_RUST_WRITE_CHECK === '0') return '';
  const isRust = /\.rs$/.test(rel) || /(^|\/)Cargo\.toml$/.test(rel);
  if (!isRust || !existsSync(join(projectRoot, 'Cargo.toml'))) return '';
  const r = spawnSync('cargo', ['check', '--workspace', '--message-format', 'short'], {
    cwd: projectRoot,
    timeout: 120_000,
    encoding: 'utf-8',
    env: sanitizedEnv(),
  });
  if (r.error || r.status === null) return '\n[cargo check: did not complete — verify manually]';
  if (r.status === 0) return '\n[cargo check: clean]';
  const errLines = `${r.stderr ?? ''}`
    .split('\n')
    .filter((l) => /error(\[|:)/.test(l));
  const shown = errLines.slice(0, 12).join('\n').slice(0, 1500);

  // A directive the agent CANNOT satisfy is worse than none. This used to say
  // "fix these BEFORE writing anything else" for ANY failure — a deadlock while
  // scaffolding a crate, because writing the missing module was the only possible
  // fix. The agent obeyed, retried, and the identical repeated message drove the
  // proxy's ERROR-LOOP guard to fire 11 times on one live mission.
  if (isIncompleteScaffold(errLines)) {
    return (
      `\n[cargo check: ${errLines.length} unresolved-module error(s) — EXPECTED while the ` +
      `module tree is incomplete. Do NOT stop to "fix" these: KEEP WRITING the missing ` +
      `modules until the tree is whole.\n${shown}]`
    );
  }
  return (
    `\n[cargo check now FAILING with real errors — fix these before adding new features ` +
    `(${errLines.length} error line(s)). If an error is a module you have simply not ` +
    `written yet, write it.\n${shown}]`
  );
}

/**
 * Per-write syntax check for plain JavaScript. A weak local model intermittently
 * emits a CORRUPTED write/edit — observed live on the octopus retest, an edit
 * boundary mangled `const level` into `}st level`, a SyntaxError that only the
 * end-of-turn execution gate caught, by which point the model had moved on and
 * its edit_file repairs kept missing the (now-shifted) anchors. The run spun and
 * ended on the broken file. Catching it the INSTANT it is written — while the
 * agent still has the file fresh — lets it fix the exact line in its next call.
 *
 * `node --check` is dependency-free (node is already running) and parses .js/.cjs/
 * .mjs exactly like the vm-dom execution gate. TS/JSX need a transform node can't
 * do, so they are left to the turn-end gate (esbuild/tsc are dev-only deps).
 * Feedback only — the write always lands. UAP_DELIVER_JS_WRITE_CHECK=0 disables.
 */
export function maybeJsSyntaxCheck(projectRoot: string, rel: string): string {
  if (process.env.UAP_DELIVER_JS_WRITE_CHECK === '0') return '';
  if (!/\.(js|cjs|mjs)$/.test(rel)) return '';
  const abs = join(projectRoot, rel);
  if (!existsSync(abs)) return '';
  let r;
  try {
    r = spawnSync(process.execPath, ['--check', abs], {
      timeout: 10_000,
      encoding: 'utf-8',
      env: sanitizedEnv(),
    });
  } catch {
    return ''; // check itself failed to run — fail-soft, never block a write
  }
  if (r.error || r.status === null || r.status === 0) return '';
  const msg = `${r.stderr ?? ''}`
    .split('\n')
    .find((l) => /SyntaxError|Error:/.test(l)) ?? `${r.stderr ?? ''}`.split('\n')[0] ?? '';
  const loc = `${r.stderr ?? ''}`.split('\n').find((l) => new RegExp(`${rel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\d+`).test(l));
  const detail = [loc, msg.trim()].filter(Boolean).join('\n').slice(0, 600);
  return (
    `\n⚠ SYNTAX ERROR — this write left ${rel} unparseable; it will NOT run and every ` +
    `user path fails until it is fixed. Correct it in your NEXT tool call (re-read ${rel} ` +
    `around the error, then edit the exact spot) before writing anything else:\n${detail}`
  );
}

/** Does the project hold any file worth inspecting (beyond scaffolding)? */
function projectHasInspectableContent(projectRoot: string): boolean {
  const ignore = new Set(['package.json', 'node_modules', '.git', '.uap', '.uap-deliver']);
  try {
    return readdirSync(projectRoot).some((e) => !ignore.has(e));
  } catch {
    return false;
  }
}

export type ExecutorMode = 'blind' | 'agentic' | 'auto';

/**
 * Resolve the dynamic executor choice. Explicit blind/agentic win; 'auto'
 * picks agentic when there is something to inspect (gates to run or repo
 * content to read) and blind for pure contextless generation (cheaper).
 */
export function selectExecutorMode(
  mode: ExecutorMode,
  projectRoot: string,
  hasGates: boolean
): 'blind' | 'agentic' {
  if (mode === 'blind' || mode === 'agentic') return mode;
  return hasGates || projectHasInspectableContent(projectRoot) ? 'agentic' : 'blind';
}

async function chat(
  endpoint: string,
  model: ModelConfig,
  messages: ChatMessage[],
  temperature?: number,
  allowBash = true,
  forceWrite = false
): Promise<ChatMessage> {
  // Hold a model slot so the agentic tool-loop's calls comply with the slot
  // budget (same work, bounded concurrency). 429/timeout feed backpressure.
  if (process.env.UAP_MODEL_LEASE === '0') return _chat(endpoint, model, messages, temperature, allowBash, forceWrite);
  return withModelSlot(`agentic:${model.apiModel ?? 'default'}`, async () => {
    try {
      const m = await _chat(endpoint, model, messages, temperature, allowBash, forceWrite);
      await recordModelSuccess({}).catch(() => undefined);
      return m;
    } catch (err) {
      if (isExhaustionError(err)) await recordModelExhaustion({}).catch(() => undefined);
      throw err;
    }
  });
}

async function _chat(
  endpoint: string,
  model: ModelConfig,
  messages: ChatMessage[],
  temperature?: number,
  allowBash = true,
  forceWrite = false
): Promise<ChatMessage> {
  const url = `${endpoint.replace(/\/$/, '')}/chat/completions`;
  // This path had NO endpoint check at all while its sibling in
  // openai-compat-client.ts refused cleartext credentials to non-local hosts. Once
  // PROXY_AUTH_TOKEN became a fallback, that asymmetry was a leak. Both now share
  // resolveRequestCredential, which scopes the proxy token to local endpoints
  // outright — https to a third party is not an acceptable destination for a
  // secret that belongs to one process on this machine.
  let apiKey: string | undefined;
  try {
    apiKey = resolveRequestCredential(model, new URL(url));
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Refusing to send')) throw err;
    apiKey = undefined; // malformed endpoint: withhold, never send blind
  }
  // Long headers/body timeouts + transient-failure retry: a local model
  // prefilling a big tool-loop prompt exceeds global fetch's 300s headers
  // timeout, which killed whole turns as `TypeError: fetch failed`.
  const res = await fetchModelWithRetry(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
    body: JSON.stringify({
      model: model.apiModel,
      // Forced-write round: offer ONLY mutating/terminating tools and require a
      // call, so a model that has looped on reads cannot read again — it must
      // write_file/edit_file or finish. Otherwise the normal auto-choice set.
      tools: forceWrite ? writeOnlyTools(allowBash) : toolsFor(allowBash),
      tool_choice: forceWrite ? 'required' : 'auto',
      messages,
      ...(temperature !== undefined ? { temperature } : {}),
    }),
  });
  if (!res.ok) throw new Error(`agentic chat failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  const data = (await res.json()) as { choices?: Array<{ message: ChatMessage }> };
  const msg = data.choices?.[0]?.message;
  if (!msg) throw new Error('agentic chat: no message in response');
  return msg;
}

/**
 * Build a LoopExecutor that runs an agentic tool loop and mutates the project
 * directly. Returns a short summary string (the no-op applier expects nothing
 * to apply).
 */
export function createAgenticExecutor(
  model: ModelConfig,
  opts: AgenticExecutorOptions
): LoopExecutor {
  const maxRounds = opts.maxToolRounds ?? 12;
  const bashTimeoutMs = opts.bashTimeoutMs ?? 30_000;
  const protectedFiles = opts.protectedFiles ?? new Set<string>();
  // Live reference — the epic controller grows this Set between epics.
  const contractFiles = opts.contractFiles ?? EMPTY_SET;
  const protectGateConfigs = opts.protectGateConfigs ?? true;
  // run_bash executes only when kernel-contained (uap sandbox sets
  // UAP_SANDBOX_ACTIVE=1) or the operator explicitly opts in (audit X3).
  const allowBash =
    opts.allowBash === true ||
    process.env.UAP_SANDBOX_ACTIVE === '1' ||
    process.env.UAP_DELIVER_ALLOW_BASH === '1';

  // When run_bash is unavailable, the model must NOT try to run tests/build to
  // verify — those calls are refused and a weak model spins retrying them
  // (observed: r4 `npm test`, r5 `UAP_DELIVER_ALLOW_BASH=1 npm test`, …). The
  // delivery gate ladder runs the tests/build automatically after each turn and
  // feeds failures back, so the model only needs to make the file changes. Tell
  // it exactly that; otherwise the generic "verify by running commands" prompt
  // sends it into a run_bash loop.
  const systemContent = allowBash
    ? 'You are an autonomous coding agent working inside a project directory. ' +
      'Use the tools to inspect the repository, make changes, and verify them by ' +
      'running commands. Read before you write. When the task is complete and you ' +
      'have verified it, call finish.'
    : 'You are an autonomous coding agent working inside a project directory. ' +
      'Use read_file/list_dir to inspect and write_file to make changes; read before you write. ' +
      'You CANNOT run shell commands (run_bash is disabled) — do NOT try to run tests, builds, ' +
      'npm/pytest/cargo, or any command to verify. Verification is AUTOMATIC: after your changes the ' +
      'delivery gates run the tests and build for you and report any failure back so you can fix it ' +
      'next turn. Just make the necessary file edits and call finish — do NOT call run_bash.';
  return async (prompt: string): Promise<string> => {
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: systemContent,
      },
      { role: 'user', content: prompt },
    ];

    const summaries: string[] = [];
    // Per-session: what this agent has already read, and at what mtime.
    const readCache = newReadCache();
    // Read-only-streak nudge: a weak model in a gap-closure/whole-mission epic
    // can spend EVERY round on read_file/list_dir and end the turn with zero
    // writes — attempt after attempt (run I live, 2026-07-17: two 5-turn
    // attempts, 12 rounds each, all reads, while the gate feedback named the
    // missing files). Reads are never denied (see repeatReadNote), but after
    // WRITE_NUDGE_AFTER consecutive mutation-free rounds the next round opens
    // with an explicit order to write.
    const WRITE_NUDGE_AFTER = 5;
    // After the soft nudge is IGNORED for this many further read-only rounds,
    // stop asking and force it: the next request offers only write/edit/finish
    // with tool_choice:'required'. A weak local model (qwen35-a3b live,
    // 2026-07-21: 5 turns, 3 nudges, ZERO writes) treats the nudge as just more
    // prose and keeps reading; removing the read tools is the only reliable
    // lever. Kept just above WRITE_NUDGE_AFTER so the model gets one soft chance
    // to self-correct before the hard rail engages.
    const FORCE_WRITE_AFTER = WRITE_NUDGE_AFTER + 1;
    let roundsWithoutWrite = 0;
    let writeNudged = false;
    // Force NON-consecutively: at most one forced round, then always a normal
    // round before forcing again. The recovery round restores the read tools so
    // a model whose correct next move is a surgical edit_file (which needs to
    // see current file content to build a valid match, and which write_file
    // can't replace under the anti-gutting guard) can re-read and recover
    // instead of being trapped read-less until the budget burns.
    let lastRoundForced = false;
    for (let round = 1; round <= maxRounds; round++) {
      if (roundsWithoutWrite >= WRITE_NUDGE_AFTER && !writeNudged) {
        writeNudged = true;
        messages.push({
          role: 'user',
          content:
            `You have used ${roundsWithoutWrite} consecutive rounds ONLY reading/listing — zero files ` +
            'written. You already have enough context. STOP exploring. THIS round, CREATE or EDIT the ' +
            'files the task and gate feedback require (write_file / edit_file), then verify and call finish.',
        });
        opts.onEvent?.({ round, kind: 'error', detail: `write-nudge injected after ${roundsWithoutWrite} read-only rounds` });
      }
      // Hard rail: the soft nudge was ignored. Force a mutating/terminating
      // call — but never twice in a row, so the next round always restores the
      // read tools (see lastRoundForced) and the model can recover.
      const forceWrite: boolean = roundsWithoutWrite >= FORCE_WRITE_AFTER && !lastRoundForced;
      lastRoundForced = forceWrite;
      if (forceWrite) {
        opts.onEvent?.({
          round,
          kind: 'error',
          detail: `forced-write round: read tools stripped after ${roundsWithoutWrite} read-only rounds`,
        });
      }
      // Rail sizing: stop BEFORE sending a request that would outgrow the
      // session's context budget — a clean under-budget stop with a partial
      // summary beats an overflow/prune that silently loses session state.
      if (opts.contextTokenBudget) {
        const est = estimateMessagesTokens(messages);
        if (est >= opts.contextTokenBudget) {
          opts.onEvent?.({
            round,
            kind: 'error',
            detail: `context budget reached: ~${est}/${opts.contextTokenBudget} est. tokens`,
          });
          return formatBudgetStop({
            estimatedTokens: est,
            budget: opts.contextTokenBudget,
            rounds: round - 1,
            summaries,
          });
        }
      }
      roundsWithoutWrite++;
      let msg: ChatMessage;
      try {
        msg = await chat(opts.endpoint, model, messages, opts.temperature, allowBash, forceWrite);
      } catch (err) {
        opts.onEvent?.({ round, kind: 'error', detail: String(err).slice(0, 200) });
        return `agentic executor error: ${String(err).slice(0, 200)}`;
      }

      const calls = msg.tool_calls ?? [];
      if (calls.length === 0) {
        // Robustness: weaker/loaded local models sometimes abandon tool-calling
        // and emit file CONTENTS as fenced blocks in the text instead of calling
        // write_file. Without this, those files are silently lost and the
        // agentic path "emits nothing". Recover them through the same write
        // pipeline (protected-path guards enforced) and keep the loop going so
        // the model can still verify and finish.
        const recovered = parseFileBlocks(msg.content ?? '');
        if (recovered.length > 0) {
          const written: string[] = [];
          for (const block of recovered) {
            const result = runTool(
              opts.projectRoot,
              'write_file',
              { path: block.path, content: block.content },
              bashTimeoutMs,
              protectedFiles,
              protectGateConfigs,
              allowBash,
              contractFiles
            );
            opts.onEvent?.({
              round,
              kind: 'tool',
              tool: 'write_file',
              detail: `recovered-from-text ${block.path} -> ${result.slice(0, 60)}`,
            });
            if (result.startsWith('OK:')) written.push(block.path);
            summaries.push(`write_file(${block.path}) [recovered-from-text]`);
          }
          // Feed back what we materialized and nudge it to verify or finish,
          // rather than ending the turn empty-handed.
          messages.push({ role: 'assistant', content: msg.content ?? null });
          messages.push({
            role: 'user',
            content:
              `Detected and wrote ${written.length} file(s) from your message: ` +
              `${written.join(', ') || '(none — all rejected)'}. ` +
              'Use the write_file tool directly for any further changes, verify with run_bash, ' +
              'then call finish.',
          });
          continue;
        }
        opts.onEvent?.({ round, kind: 'final', detail: (msg.content ?? '').slice(0, 200) });
        return msg.content || summaries.join('; ') || 'agent produced no tool calls';
      }

      messages.push({ role: 'assistant', content: msg.content ?? null, tool_calls: calls });

      for (const call of calls) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(call.function.arguments || '{}');
        } catch {
          /* leave args empty */
        }
        if (call.function.name === 'finish') {
          opts.onEvent?.({ round, kind: 'final', tool: 'finish', detail: String(args.summary ?? '') });
          return String(args.summary ?? (summaries.join('; ') || 'done'));
        }
        // A repeated read gets a NUDGE, never a denial — see repeatReadNote.
        const repeat = repeatReadNote(readCache, opts.projectRoot, call.function.name, args, round);
        const toolResult = runTool(
          opts.projectRoot,
          call.function.name,
          args,
          bashTimeoutMs,
          protectedFiles,
          protectGateConfigs,
          allowBash,
          contractFiles
        );
        // #2a: per-tool-call progress — refresh the deliver heartbeat now, not
        // just at turn end, so wedge-detection tracks real intra-turn activity.
        opts.onToolProgress?.();
        // A productive mutation resets the streak. write_file/edit_file return
        // 'OK: ...'; run_bash returns 'exit=<code> ...' and so NEVER matched
        // startsWith('OK') — a latent bug that was harmless when the streak only
        // drove a soft nudge, but not once it strips run_bash under force: an
        // --allow-bash session writing files through the shell would have been
        // forced and had its bash taken away. Reset on a clean bash exit too.
        const isWrite = call.function.name === 'write_file' || call.function.name === 'edit_file';
        const isBash = call.function.name === 'run_bash';
        if ((isWrite && toolResult.startsWith('OK')) || (isBash && /(^|\s)exit=0(\s|$)/.test(toolResult))) {
          roundsWithoutWrite = -1; // reset below by the per-round increment
          writeNudged = false;
        }
        // WITHHOLDING the content was a deadlock. The model re-reads a file for a
        // reason — its context was pruned, or this is a fresh agent session — so
        // answering "you already read that" WITHOUT the content leaves it unable
        // to proceed, and it simply asks again. Live: 76 re-reads of one file,
        // 64 nudges, ZERO writes in 36 minutes. Serve the content, and prepend
        // the nudge so repetition still costs it nothing but a line.
        const result = repeat ? `${repeat}\n\n${toolResult}` : toolResult;
        opts.onEvent?.({
          round,
          kind: 'tool',
          tool: call.function.name,
          detail: `${JSON.stringify(args).slice(0, 80)} -> ${result.slice(0, 80)}`,
        });
        summaries.push(`${call.function.name}(${JSON.stringify(args).slice(0, 60)})`);
        messages.push({ role: 'tool', tool_call_id: call.id, content: result });
      }
    }
    return `agent hit ${maxRounds}-round budget; partial: ${summaries.slice(-3).join('; ')}`;
  };
}

/**
 * No-op applier for the agentic executor: the executor already wrote files via
 * tools, so there is nothing for the convergence loop to materialize. Reports
 * zero filesApplied (the gate measures the real outcome).
 */

/**
 * Cheap truncation heuristic for code-file writes: strips string/template
 * literals and comments, then counts net-unclosed braces/brackets/parens. Only
 * flags NET-POSITIVE imbalance (more opens than closes — the signature of an
 * output cut mid-block); balanced or over-closed content is never flagged.
 * Returns a human-readable reason, or null when the content looks whole.
 */
export function looksTruncated(path: string, content: string): string | null {
  if (!/\.(m?[jt]sx?|json|css)$/i.test(path)) return null;
  if (content.trim().length < 200) return null; // small stubs are legitimate
  // Strip line/block comments and quoted strings (crude but effective).
  const stripped = content
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
  const count = (ch: string): number => stripped.split(ch).length - 1;
  const braces = count('{') - count('}');
  const brackets = count('[') - count(']');
  const parens = count('(') - count(')');
  if (braces > 0) return `${braces} unclosed {`;
  if (brackets > 0) return `${brackets} unclosed [`;
  if (parens > 0) return `${parens} unclosed (`;
  return null;
}

export async function noopApplier(): Promise<ApplyResult> {
  // No error: the executor already mutated the repo, so "nothing to apply" is
  // success, not the applyFileBlocks "no file blocks found" failure.
  return { filesWritten: [], rejected: [] };
}
