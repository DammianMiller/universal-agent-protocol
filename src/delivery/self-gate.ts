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
import { existsSync, mkdirSync, writeFileSync, chmodSync } from 'fs';
import { join } from 'path';
import type { GateRung } from './verifier-ladder.js';
import type { LoopExecutor } from './convergence-loop.js';
import { sanitizedEnv } from './sanitized-env.js';
import { discoverEntryPages } from './visual-gate.js';

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

/**
 * Where the deliverable's web entry point(s) actually live, for the gate author.
 * Reuses discoverEntryPages (which recurses into subdirectories) so a gate for a
 * subproject app — e.g. `space-shooter/index.html` — is anchored at the real
 * path instead of an assumed root `index.html`. That root-vs-subdir mismatch is
 * exactly what made a correctly built subdir game fail its acceptance gate
 * forever ("No JavaScript files found" / scripts checked at the wrong path).
 */
export function deliverableLayout(projectRoot: string): { entries: string[]; hint: string } {
  let entries: string[] = [];
  try {
    entries = discoverEntryPages(projectRoot);
  } catch {
    entries = [];
  }
  if (entries.length === 0) return { entries, hint: '' };
  const inSubdir = entries.some((e) => e.includes('/'));
  const list = entries.map((e) => `    ${e}`).join('\n');
  const hint = inSubdir
    ? [
        'DELIVERABLE LAYOUT — the entry point(s) live in a SUBDIRECTORY:',
        list,
        'Anchor EVERY path check at these actual paths (cd into that directory, or',
        'prefix paths with it). Do NOT assume a root-level index.html or that the',
        'source files sit at the repository root.',
      ].join('\n')
    : ['DELIVERABLE LAYOUT — detected entry point(s):', list].join('\n');
  return { entries, hint };
}

/**
 * Detect an acceptance gate anchored at the WRONG location: it checks for an
 * HTML entry that does not exist while the deliverable's real entry was
 * discovered elsewhere (e.g. it asserts a root `index.html` but the app lives in
 * `space-shooter/index.html`). Such a gate fails forever regardless of the work
 * — indistinguishable from "not done" to the non-vacuity floor — so we force a
 * re-author with corrective feedback naming the discovered entry.
 *
 * Conservative by design: it only fires when a DIFFERENT real entry EXISTS on
 * disk, so a gate that legitimately references a not-yet-created file (the work
 * will create it) is never flagged.
 */
export function detectMisTargetedGate(
  script: string,
  projectRoot: string,
  entries: string[]
): string | null {
  const realEntries = entries.filter((e) => existsSync(join(projectRoot, e)));
  if (realEntries.length === 0) return null; // nothing built yet — cannot judge
  const refs = new Set<string>();
  for (const m of script.matchAll(/["'`\s(]([\w./-]+\.html)\b/g)) refs.add(m[1]);
  if (refs.size === 0) return null;
  for (const ref of refs) {
    if (existsSync(join(projectRoot, ref))) continue; // referenced entry exists — fine
    if (realEntries.includes(ref)) continue; // is a discovered entry — fine
    return (
      `the gate checks "${ref}", which does not exist. The deliverable's entry ` +
      `point is: ${realEntries.join(', ')}. Anchor the checks there (the app ` +
      `lives in a subdirectory, not the repository root).`
    );
  }
  return null;
}

function buildAuthorPrompt(
  instruction: string,
  projectRoot: string,
  priorFeedback: string | null,
  layoutHint: string
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
    layoutHint ? `\n${layoutHint}` : '',
    '',
    'Write a self-contained POSIX bash script that:',
    '  - exits 0 ONLY if the task is fully and correctly completed',
    '  - exits non-zero otherwise (print a short reason to stderr)',
    '  - checks concrete, observable evidence: expected files exist, a program',
    '    builds/runs, output matches what the task requires',
    '  - resolves every path relative to the entry point shown above, not an',
    '    assumed repository root',
    '  - for a WEB deliverable, does NOT rely on text-matching alone: a page that',
    '    references scripts/styles which do not resolve to a real file (a 404 at',
    '    runtime) is a FAILURE, even though the `<script src=...>` text is present.',
    '    For each referenced asset, verify the file EXISTS at its resolved path',
    '    (relative to the HTML file), then — where feasible — that the program',
    '    actually builds or the page loads without missing resources.',
    '  - uses ONLY the repository and standard tools (no network, no access to',
    '    any hidden test harness)',
    '',
    'CRITICAL: the script must FAIL right now, on the current unsolved repo,',
    'and only PASS once the task has actually been done. Do not write a check',
    'that trivially passes (e.g. `exit 0`, or only `test -d .`).',
    '',
    'Output ONLY the script inside a single ```bash code block.',
    retry,
  ].join('\n');
}

/**
 * A gate that only greps HTML text for tags/paths — without confirming the
 * referenced assets resolve to real files — is a weak proxy: it passes on a
 * page whose scripts 404. Returns feedback to strengthen such a gate, or null.
 * Heuristic and conservative (only nudges when it sees grep-on-html with no
 * existence check of the referenced assets).
 */
export function detectWeakWebProxy(script: string): string | null {
  const grepsHtml = /\bgrep\b[^\n]*\.html\b/.test(script) || /<script[^>]*src=/.test(script);
  if (!grepsHtml) return null;
  const checksExistence = /\[\s+-[ef]\s|\btest\s+-[ef]\b|\[\[\s+-[ef]\s/.test(script);
  if (checksExistence) return null;
  return (
    'it matches text in the HTML but never checks that the referenced assets ' +
    '(scripts/styles) actually exist on disk — a page whose <script src> 404s ' +
    'would still pass. Add existence checks (test -f) for each referenced asset ' +
    'at its resolved path.'
  );
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

  // Anchor the gate author at the deliverable's real entry point(s) — including
  // a subdirectory app — so the generated check does not assume the repo root.
  const { entries, hint: layoutHint } = deliverableLayout(projectRoot);

  let priorFeedback: string | null = null;
  let producedAny = false;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    let response: string;
    try {
      response = await executor(buildAuthorPrompt(instruction, projectRoot, priorFeedback, layoutHint));
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

    // A gate that fails on the unsolved repo can still be USELESS if it is
    // anchored at the wrong path (fails forever regardless of the work) or is a
    // text-only web proxy (passes on a page whose scripts 404). Re-author on such
    // structural defects — this is the harness correcting a mis-targeted gate
    // without ever exposing the protected script to the model — bounded by the
    // attempt budget so the last attempt is still accepted rather than lost.
    const structuralIssue =
      detectMisTargetedGate(script, projectRoot, entries) ?? detectWeakWebProxy(script);
    if (structuralIssue && attempt < attempts) {
      notes.push(`attempt ${attempt}: gate rejected (structural) — ${structuralIssue.slice(0, 80)}`);
      priorFeedback = structuralIssue;
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
