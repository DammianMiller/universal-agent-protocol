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
import type { ApplyResult } from './applier.js';
import { protectedWritePathReason, parseFileBlocks, listGateConfigFiles, isGateConfigBasename } from './applier.js';
import { estimateMessagesTokens, CONTEXT_BUDGET_MARKER } from './context-budget.js';
import { sanitizedEnv } from './sanitized-env.js';

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

function runTool(
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
      if (!existsSync(abs)) return `ERROR: file not found: ${args.path}`;
      return readFileSync(abs, 'utf-8').slice(0, 8000);
    }
    if (name === 'list_dir') {
      const abs = safePath(projectRoot, String(args.path ?? '.'));
      if (!existsSync(abs)) return `ERROR: not found: ${args.path}`;
      return readdirSync(abs)
        .map((e) => (statSync(join(abs, e)).isDirectory() ? `${e}/` : e))
        .join('\n')
        .slice(0, 4000);
    }
    if (name === 'write_file') {
      const abs = safePath(projectRoot, String(args.path));
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
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, String(args.content ?? ''), 'utf-8');
      // Per-write compile feedback for Rust: without it, a weak model writes
      // whole turns of code against types it invented, and the turn-end gate
      // reports an avalanche it cannot dig out of (observed live 2026-07-10:
      // 47 → 653 errors across one epic attempt). An incremental warm
      // `cargo check` is ~2s and stops the spiral at the first bad write.
      // Feedback only — the write itself always lands. UAP_DELIVER_RUST_WRITE_CHECK=0 disables.
      const rustCheckNote = maybeRustWriteCheck(projectRoot, rel);
      return `OK: wrote ${String(args.path)} (${String(args.content ?? '').length} bytes)${pathNote}${rustCheckNote}`;
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
      return `OK: edited ${String(args.path)} (1 replacement)${pathNote}${rustCheckNote}`;
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
  return (
    `\n[cargo check now FAILING — fix these BEFORE writing anything else ` +
    `(${errLines.length} error line(s)):\n${shown}]`
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
  temperature?: number
): Promise<ChatMessage> {
  // Hold a model slot so the agentic tool-loop's calls comply with the slot
  // budget (same work, bounded concurrency). 429/timeout feed backpressure.
  if (process.env.UAP_MODEL_LEASE === '0') return _chat(endpoint, model, messages, temperature);
  return withModelSlot(`agentic:${model.apiModel ?? 'default'}`, async () => {
    try {
      const m = await _chat(endpoint, model, messages, temperature);
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
  temperature?: number
): Promise<ChatMessage> {
  const url = `${endpoint.replace(/\/$/, '')}/chat/completions`;
  const apiKey = model.apiKeyEnvVar ? process.env[model.apiKeyEnvVar] : undefined;
  // Long headers/body timeouts + transient-failure retry: a local model
  // prefilling a big tool-loop prompt exceeds global fetch's 300s headers
  // timeout, which killed whole turns as `TypeError: fetch failed`.
  const res = await fetchModelWithRetry(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
    body: JSON.stringify({
      model: model.apiModel,
      messages,
      tools: TOOLS,
      tool_choice: 'auto',
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
    for (let round = 1; round <= maxRounds; round++) {
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
          return (
            `${CONTEXT_BUDGET_MARKER} session reached ~${est} of ${opts.contextTokenBudget} estimated tokens ` +
            `after ${round - 1} round(s) — the task is too large for one session and must be split. ` +
            `Work completed so far: ${summaries.slice(-5).join('; ') || 'none'}`
          );
        }
      }
      let msg: ChatMessage;
      try {
        msg = await chat(opts.endpoint, model, messages, opts.temperature);
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
        const result = runTool(
          opts.projectRoot,
          call.function.name,
          args,
          bashTimeoutMs,
          protectedFiles,
          protectGateConfigs,
          allowBash,
          contractFiles
        );
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
export async function noopApplier(): Promise<ApplyResult> {
  // No error: the executor already mutated the repo, so "nothing to apply" is
  // success, not the applyFileBlocks "no file blocks found" failure.
  return { filesWritten: [], rejected: [] };
}
