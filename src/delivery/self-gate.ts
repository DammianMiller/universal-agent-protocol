/**
 * Self-authored acceptance gate
 *
 * When a project exposes no detectable gates (no package.json build/test
 * scripts — the common case for polyglot CLI tasks), the convergence loop has
 * nothing to iterate against and degrades to a vacuous single-shot "success".
 *
 * This module asks the executor model to author a task-specific verification
 * script (`.uap-deliver/verify.sh`) that exits 0 iff the task is correctly
 * completed, using only repo-observable evidence (files, program output) — no
 * network, no hidden test harness. The script is then registered as a required
 * gate so deliver converges against it.
 *
 * The floor (anti-vacuous) rule: a usable acceptance gate MUST fail on the
 * current, unsolved repository. If it already passes before the model has done
 * any work, it is trivial and is regenerated with that feedback. This is what
 * stops deliver from "converging to 1 immediately": turn 1 cannot pass a gate
 * that is required to fail at the start.
 */

import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync, chmodSync } from 'fs';
import { basename, join } from 'path';
import type { GateRung } from './verifier-ladder.js';
import type { LoopExecutor } from './convergence-loop.js';
import { sanitizedEnv } from './sanitized-env.js';

const GATE_DIR = '.uap-deliver';
const GATE_FILE = 'verify.sh';
const DEFAULT_ATTEMPTS = 3;
const DEFAULT_TIMEOUT_MS = 120_000;

export interface SelfGateOptions {
  instruction: string;
  projectRoot: string;
  executor: LoopExecutor;
  /** Max authoring attempts before accepting a (possibly weak) gate. Default 3. */
  maxAuthorAttempts?: number;
  /** Per-run timeout for the generated script. Default 120s. */
  timeoutMs?: number;
}

export interface SelfGateResult {
  /** The registered gate, or null if no script could be produced at all. */
  rung: GateRung | null;
  scriptPath: string | null;
  /** True when the gate still passes on the unsolved repo after all attempts. */
  vacuous: boolean;
  attempts: number;
  notes: string[];
}

/**
 * Pull a shell script out of a model response (fenced block preferred).
 *
 * The closing fence is OPTIONAL. It used to be mandatory, and that was a live
 * bug: when the model's response was truncated mid-script there was no closing
 * ```, the regex did not match, and the whole raw response — opening ```bash
 * line included — was written out as the gate. bash then hit an unterminated
 * backtick on line 2 and every single turn failed with `unexpected EOF`, a
 * phantom failure the model could not see or fix.
 */
export function extractScript(modelOutput: string): string {
  const closed = modelOutput.match(/```(?:bash|sh|shell)?[^\n]*\n([\s\S]*?)```/);
  // Truncated response: an opening fence with nothing closing it.
  const open = modelOutput.match(/```(?:bash|sh|shell)?[^\n]*\n([\s\S]*)$/);
  const body = (closed?.[1] ?? open?.[1] ?? modelOutput).trim();
  // Guarantee a shebang so `bash <file>` and direct exec both behave.
  if (/^#!/.test(body)) return body;
  return `#!/usr/bin/env bash\n${body}`;
}

/**
 * Does this script even PARSE? `bash -n` reads without executing.
 *
 * A gate that cannot run is not a gate. Without this check the self-gate could
 * not tell "the gate correctly failed on the unsolved repo" from "the gate is
 * broken" — a syntax error exits non-zero, which the loop below read as proof
 * of a strict gate and happily installed. The mission then failed on that
 * script forever, for a reason that had nothing to do with the code.
 */
export function scriptParses(script: string): { ok: boolean; error?: string } {
  const r = spawnSync('bash', ['-n'], { input: script, encoding: 'utf-8', timeout: 10_000 });
  if (r.status === 0) return { ok: true };
  const error = String(r.stderr || r.stdout || 'script does not parse').trim().split('\n')[0];
  return { ok: false, error: error.slice(0, 200) };
}

const TREE_SKIP = new Set(['node_modules', '.git', '.uap', '.uap-deliver', '.uap-backups', '.worktrees', 'dist', '.claude', '.codex', '.cursor', '.factory', '.forge', '.opencode', 'agents']);
const TREE_CAP = 200;

/** Bounded relative file listing (depth-first, skips tool/dep dirs). */
export function listRepoFiles(projectRoot: string, cap: number = TREE_CAP): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    if (out.length >= cap) return;
    let entries: import('fs').Dirent[];
    try {
      entries = readdirSync(join(projectRoot, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= cap) return;
      if (e.name.startsWith('.')) continue; // dot-dirs at ANY depth (.venv, .next, .cache)
      if (TREE_SKIP.has(e.name)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r);
      else out.push(r);
    }
  };
  walk('');
  return out;
}

/**
 * Detect file probes anchored at the WRONG path: script tokens that do not
 * resolve from the project root while a file with the SAME basename exists
 * elsewhere in the tree. This is how a self-gate goes structurally
 * unwinnable — observed live (octopus retest, 2026-07-16): the gate probed
 * bare `audio.js`/`player.js` from the root while the artifacts lived at
 * `space-shooter/js/*.js`, so every turn reported "file missing" no matter
 * what the executor wrote, and "fails on the unsolved repo" was trivially
 * (and meaninglessly) satisfied. A token whose basename exists NOWHERE is
 * left alone — files the mission has yet to create are legitimate probes.
 */
export function findMisanchoredPaths(
  script: string,
  projectRoot: string,
  tree?: string[]
): Array<{ token: string; actual: string[] }> {
  const files = tree ?? listRepoFiles(projectRoot);
  const byBase = new Map<string, string[]>();
  for (const f of files) {
    const b = basename(f);
    byBase.set(b, [...(byBase.get(b) ?? []), f]);
  }
  const seen = new Set<string>();
  const hits: Array<{ token: string; actual: string[] }> = [];
  for (const m of script.matchAll(/[A-Za-z0-9_][A-Za-z0-9_./-]*\.[A-Za-z0-9]{1,6}\b/g)) {
    const token = m[0];
    if (seen.has(token)) continue;
    seen.add(token);
    if (token.startsWith('.uap-deliver/') || token.includes('://')) continue;
    if (/^[0-9.]+$/.test(token)) continue; // version-ish numerics
    // Probes into skip-dirs (dist/bundle.js before a build runs) are
    // legitimate artifact checks the tree can never contain — never flag them.
    if (TREE_SKIP.has(token.split('/')[0])) continue;
    if (existsSync(join(projectRoot, token))) continue;
    const actual = byBase.get(basename(token)) ?? [];
    // Misanchored iff the same basename exists at some OTHER path.
    if (actual.length > 0 && !actual.includes(token)) hits.push({ token, actual });
  }
  return hits;
}

function buildAuthorPrompt(
  instruction: string,
  projectRoot: string,
  priorFeedback: string | null,
  tree?: string[]
): string {
  const retry = priorFeedback
    ? `\n\nYour previous script was rejected because: ${priorFeedback}\nWrite a stricter script that genuinely verifies the required outcome.`
    : '';
  return [
    'You are writing an ACCEPTANCE TEST for a coding task, not solving it.',
    '',
    `TASK:\n${instruction}`,
    '',
    `PROJECT ROOT: ${projectRoot}`,
    ...(tree && tree.length
      ? [
          '',
          'REPOSITORY FILES (real paths — reference files EXACTLY as listed or as the task names them; never probe bare filenames from the root):',
          ...tree.slice(0, 60).map((f) => `  ${f}`),
          ...(tree.length > 60 ? [`  … (${tree.length - 60} more files not listed — they still exist)`] : []),
        ]
      : []),
    '',
    'Write a self-contained POSIX bash script that:',
    '  - exits 0 ONLY if the task is fully and correctly completed',
    '  - exits non-zero otherwise (print a short reason to stderr)',
    '  - checks concrete, observable evidence: expected files exist, a program',
    '    builds/runs, output matches what the task requires',
    '  - uses ONLY the repository and standard tools (no network, no access to',
    '    any hidden test harness)',
    '  - is runnable from the project root',
    '',
    'CRITICAL: the script must FAIL right now, on the current unsolved repo,',
    'and only PASS once the task has actually been done. Do not write a check',
    'that trivially passes (e.g. `exit 0`, or only `test -d .`).',
    '',
    'Output ONLY the script inside a single ```bash code block.',
    retry,
  ].join('\n');
}

/** Run the candidate gate against the current repo state. */
function runGate(
  scriptPath: string,
  projectRoot: string,
  timeoutMs: number
): { exitCode: number | null; spawnError: boolean; outputTail: string } {
  const r = spawnSync('bash', [scriptPath], {
    cwd: projectRoot,
    timeout: timeoutMs,
    encoding: 'utf-8',
    // Model-authored gate script: strip host/provider secrets (audit).
    env: sanitizedEnv(),
  });
  if (r.error) {
    return { exitCode: null, spawnError: true, outputTail: String(r.error.message).slice(-500) };
  }
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.slice(-500);
  return { exitCode: r.status, spawnError: false, outputTail: out };
}

/**
 * Author and validate a task-specific acceptance gate. Retries until the
 * generated script fails on the current (unsolved) repo — the non-vacuity
 * floor — or attempts are exhausted.
 */
export async function authorAcceptanceGate(opts: SelfGateOptions): Promise<SelfGateResult> {
  const { instruction, projectRoot, executor } = opts;
  const attempts = opts.maxAuthorAttempts ?? DEFAULT_ATTEMPTS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const notes: string[] = [];

  const gateDir = join(projectRoot, GATE_DIR);
  const scriptPath = join(gateDir, GATE_FILE);
  if (!existsSync(gateDir)) mkdirSync(gateDir, { recursive: true });

  let priorFeedback: string | null = null;
  let producedAny = false;
  const tree = listRepoFiles(projectRoot);

  for (let attempt = 1; attempt <= attempts; attempt++) {
    let response: string;
    try {
      response = await executor(buildAuthorPrompt(instruction, projectRoot, priorFeedback, tree));
    } catch (err) {
      notes.push(`attempt ${attempt}: model error authoring gate`);
      priorFeedback = `the authoring call errored (${String(err).slice(0, 80)})`;
      continue;
    }

    const script = extractScript(response);

    // A script that does not PARSE must never be installed. bash exits non-zero
    // on a syntax error, which the "fails on the unsolved repo" check below
    // would otherwise accept as proof of a strict gate — wiring in a gate that
    // fails every turn for a reason the model cannot see. Reject it, hand the
    // parse error back, and let the next attempt fix it.
    const parse = scriptParses(script);
    if (!parse.ok) {
      notes.push(`attempt ${attempt}: gate script does not parse (${parse.error ?? 'syntax error'}) — regenerating`);
      priorFeedback =
        `the script was not valid bash: ${parse.error ?? 'syntax error'}. ` +
        'Output ONLY the raw script — no markdown code fences, no prose — and make sure it is complete (not cut off).';
      continue;
    }

    // Wrong-path probes make the gate structurally unwinnable — reject before
    // the fails-on-unsolved check, which a mis-anchored gate satisfies for the
    // wrong reason (everything looks "missing").
    const misanchored = findMisanchoredPaths(script, projectRoot, tree);
    if (misanchored.length > 0) {
      const detail = misanchored
        .slice(0, 5)
        .map((h) => `'${h.token}' (repo has: ${h.actual.slice(0, 2).join(', ')})`)
        .join('; ');
      if (attempt < attempts) {
        notes.push(`attempt ${attempt}: gate probes wrong paths (${detail}) — regenerating`);
        priorFeedback = `the script checks paths that do not exist while the same files live elsewhere in the repo: ${detail}. Use the REAL repository paths.`;
        continue;
      }
      // Final attempt: a persistent detector hit must DEGRADE, not hard-fail
      // the run with a rung-less "no runnable script" (the script IS
      // runnable). Install it flagged; the fails-on-unsolved check and the
      // per-attempt notes carry the wrong-path warning to the operator.
      notes.push(`attempt ${attempt}: gate still probes suspect paths (${detail}) — installing anyway (degraded)`);
    }

    writeFileSync(scriptPath, script, 'utf-8');
    try {
      chmodSync(scriptPath, 0o755);
    } catch {
      /* non-fatal */
    }
    producedAny = true;

    const run = runGate(scriptPath, projectRoot, timeoutMs);
    if (run.spawnError) {
      notes.push(`attempt ${attempt}: gate failed to run (${run.outputTail.slice(0, 80)})`);
      priorFeedback = 'the script could not execute (syntax/interpreter error)';
      continue;
    }
    if (run.exitCode === 0) {
      // Vacuous: passes on the unsolved repo. Reject and retry stricter.
      notes.push(`attempt ${attempt}: gate passed on the UNSOLVED repo — too weak, regenerating`);
      priorFeedback = 'it passed on the unsolved repository (it must fail until the work is done)';
      continue;
    }

    // Good: a discriminating gate that fails now and must be made to pass.
    notes.push(`attempt ${attempt}: gate fails on unsolved repo (exit ${run.exitCode}) — accepted`);
    return {
      rung: buildRung(scriptPath, timeoutMs),
      scriptPath,
      vacuous: false,
      attempts: attempt,
      notes,
    };
  }

  // Exhausted attempts. Return the last gate (if any) flagged as vacuous/weak so
  // the caller can warn; never silently treat absence as success.
  return {
    rung: producedAny ? buildRung(scriptPath, timeoutMs) : null,
    scriptPath: producedAny ? scriptPath : null,
    vacuous: true,
    attempts,
    notes,
  };
}

function buildRung(scriptPath: string, timeoutMs: number): GateRung {
  return {
    id: 'acceptance',
    name: 'Acceptance check (.uap-deliver/verify.sh)',
    command: 'bash',
    args: [scriptPath],
    required: true,
    timeoutMs,
  };
}
