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

/**
 * Scripts that anchor paths to their OWN directory are structurally
 * unwinnable: the gate lives in .uap-deliver/, so ROOT="$(dirname "$0")"
 * resolves every check under .uap-deliver/<artifact>/... — always missing,
 * and the fails-on-unsolved floor is trivially satisfied for the wrong
 * reason. Observed live (octopus variant run, 2026-07-18): a correct-looking
 * gate failed every turn on `cat .uap-deliver/space-shooter/index.html`.
 * The path TOKENS were valid relative paths, so the mis-anchor token check
 * cannot catch this shape — the runtime anchor is the defect.
 */
export function usesScriptDirAnchor(script: string): boolean {
  return /dirname\s+"?\$\{?0\}?"?|\$\{?BASH_SOURCE/.test(script);
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
    '  - RUNS the code and checks what it DOES: execute the program, its test',
    '    suite or its build, and assert on the OUTPUT or the exit status',
    '  - does NOT grade the source text. A gate that only greps the source is',
    '    checking how the code is SPELLED: a correct solution written',
    '    differently fails it forever, and text that matches but does not work',
    '    passes it. Use grep on the OUTPUT of something you ran, or for a file',
    '    that has no runtime (config, docs)',
    '  - uses ONLY the repository and standard tools (no network, no access to',
    '    any hidden test harness)',
    '  - is runnable from the project root: it EXECUTES with CWD = project root,',
    '    so use plain RELATIVE paths. NEVER anchor to the script location',
    '    (no ROOT="$(dirname "$0")", no BASH_SOURCE) — the script is stored',
    '    OUTSIDE the artifact tree and such anchors make every check miss.',
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
  // Keep BOTH ends. A tool-usage error (see detectBrokenGate) is printed by the
  // FIRST failing command, which in a long gate scrolls far out of a tail-only
  // window — the broken-gate check would then never see the evidence it needs.
  const raw = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  const out = raw.length > 1000 ? `${raw.slice(0, 500)}\n[...]\n${raw.slice(-500)}` : raw;
  return { exitCode: r.status, spawnError: false, outputTail: out };
}

/**
 * Signals that the gate script is BROKEN rather than merely unsatisfied.
 *
 * A gate exits non-zero for two very different reasons: the assertion it makes
 * is not yet true (exactly what we want — it MUST fail until the work is done),
 * or the gate itself is malformed and could never pass no matter what the model
 * writes. `scriptParses` (bash -n) catches scripts that do not parse; it cannot
 * catch a script that parses fine and then misuses its tools at runtime.
 *
 * Live case (octopus_invaders_v3, 2026-07-22): the model authored
 * `grep -q 'background\.initStars\('`. In a POSIX basic regex `\(` is
 * group-open, so grep aborted with "Unmatched ( or \(" and the check reported
 * FAIL against code that was correct. "Fails on the unsolved repo" was
 * trivially satisfied, so the gate was accepted, then frozen by the
 * anti-gutting guard. The deliver spent 4 turns / ~35 min at 0% correctly
 * diagnosing verify.sh as broken and being blocked every time it tried to
 * repair it. It was right, and it had no legal move.
 *
 * Only patterns that are UNAMBIGUOUSLY an authoring bug belong here. Notably
 * absent: "command not found" and "No such file or directory" — a gate may
 * legitimately invoke a binary the deliverable has not built yet, and that is a
 * real "work not done" failure. Treating those as broken would regenerate good
 * gates and reintroduce vacuity, which is the worse failure.
 */
const BROKEN_GATE_SIGNALS: ReadonlyArray<{ re: RegExp; what: string }> = [
  { re: /\b(?:grep|egrep|fgrep):[^\n]*Unmatched\s*[[(\\]/i, what: 'malformed grep pattern (unmatched bracket or group)' },
  { re: /\b(?:grep|egrep|fgrep):[^\n]*invalid regular expression/i, what: 'invalid grep regular expression' },
  { re: /\b(?:grep|egrep|fgrep):[^\n]*trailing backslash/i, what: 'grep pattern ends in a trailing backslash' },
  { re: /\b(?:grep|egrep|fgrep):[^\n]*(?:unrecognized|invalid) option/i, what: 'invalid grep option' },
  { re: /\bsed:[^\n]*-e expression/i, what: 'malformed sed expression' },
  { re: /\bawk:[^\n]*syntax error/i, what: 'malformed awk program' },
  { re: /syntax error near unexpected token/i, what: 'shell syntax error raised at runtime' },
  { re: /\b(?:unary operator expected|integer expression expected)\b/i, what: 'misused test/[ ] comparison' },
];

/**
 * Return a description of why the gate is structurally broken, or null when its
 * non-zero exit is a legitimate "the work is not done yet".
 */
export function detectBrokenGate(output: string): string | null {
  for (const sig of BROKEN_GATE_SIGNALS) {
    if (sig.re.test(output)) return sig.what;
  }
  return null;
}

/** Manifests that mean the project has a toolchain a gate could actually invoke. */
const RUNTIME_MANIFESTS = [
  'package.json',
  'pyproject.toml',
  'setup.py',
  'requirements.txt',
  'Cargo.toml',
  'go.mod',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'Gemfile',
  'composer.json',
  'Makefile',
  'CMakeLists.txt',
  'deno.json',
  'bun.lockb',
];

const RUNNABLE_SOURCE = /\.(js|mjs|cjs|jsx|ts|tsx|py|rs|go|java|kt|rb|php|cs|swift|c|cc|cpp)$/i;

/**
 * True when the project has something a gate could run — a toolchain manifest,
 * or simply source files in a language with a runtime.
 *
 * The manifest alone is too narrow for the population that matters most: a
 * fresh scaffold has no package.json at the moment the gate is authored, and
 * "no native gate" is precisely when a self-authored one is used.
 */
function hasRuntimeManifest(projectRoot: string): boolean {
  if (RUNTIME_MANIFESTS.some((m) => existsSync(join(projectRoot, m)))) return true;
  return listRepoFiles(projectRoot, 60).some((f) => RUNNABLE_SOURCE.test(f));
}

/** Interpreters, build tools and runners that mean the gate actually RUNS something. */
const EXECUTES = new RegExp(
  String.raw`\b(node|nodejs|python3?|pytest|tox|cargo|rustc|npm|npx|pnpm|yarn|deno|bun|go|java|gradle|mvn|ruby|rake|php|dotnet|swift|make|cmake|ctest|jest|vitest|mocha|bash\s+\S+\.sh|sh\s+\S+\.sh|\./\S+)\b`
);

/**
 * Reason a gate never runs the code it is grading, or null when it does.
 *
 * Surveyed on this machine: 3 of 4 real acceptance gates execute NOTHING. They
 * assert on source text instead (`grep -q "return (sr, src)"`), which grades
 * how the implementation is spelled rather than what it does. Both failure
 * directions were seen live: a correct solution phrased differently can never
 * pass, so the mission is unwinnable; and text that matches but does not work
 * passes, so a run reports success over code nobody executed.
 *
 * Comments are stripped first — a script that merely MENTIONS `npm test` in a
 * comment still runs nothing.
 */
export function neverExecutesReason(script: string, projectRoot?: string): string | null {
  const body = script
    .split('\n')
    .map((line) => line.replace(/(^|\s)#.*$/, '$1'))
    .join('\n');
  if (!body.trim()) return null; // nothing to judge; other validators own this
  if (EXECUTES.test(body)) return null;
  // Demanding that a gate RUN something is only fair when the project has a
  // runtime to run. A docs or config tree has nothing to execute, and neither
  // does a bare scaffold — asking there would burn an attempt to arrive back
  // at the same script.
  if (projectRoot !== undefined && !hasRuntimeManifest(projectRoot)) return null;
  // The diagnosis half of this sentence is prose: rewording it is an
  // EQUIVALENT MUTANT, because what the model acts on is the instruction that
  // follows — execute something, assert on output. That half IS pinned.
  return (
    'it never RUNS anything — every check reads the source text. That grades how the code is ' +
    'written rather than what it does, so a correct solution written differently fails forever, ' +
    'and text that matches but does not work passes. Execute the program, its test suite, or its ' +
    'build, and assert on the OUTPUT or exit status. Keep grep only for checking that output.'
  );
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
    if (usesScriptDirAnchor(script)) {
      notes.push(`attempt ${attempt}: gate anchors paths to its own directory (dirname $0/BASH_SOURCE) — regenerating`);
      priorFeedback =
        'the script anchored file paths to its own directory (dirname "$0" / BASH_SOURCE). It is stored OUTSIDE ' +
        'the artifact tree, so every check misses. It runs with CWD = project root — use plain relative paths.';
      continue;
    }
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

    // Non-zero is NOT sufficient. A gate whose own tooling errored also exits
    // non-zero, and accepting it wires in a gate that can never pass — then the
    // anti-gutting guard freezes it and the deliver has no legal move.
    const broken = detectBrokenGate(run.outputTail);
    if (broken) {
      notes.push(`attempt ${attempt}: gate is BROKEN, not strict (${broken}) — regenerating`);
      priorFeedback =
        `the script ran but its OWN tooling errored: ${broken}. It did not test the repository, ` +
        'so it can never pass. Check quoting and escaping — in a POSIX basic regex `\\(` means ' +
        'group-open, so use a plain `(` to match a literal parenthesis (or use grep -F / grep -E). ' +
        'Verify each command runs cleanly before relying on its exit status.';
      continue;
    }

    // A gate that grades SPELLING rather than behaviour. Worth exactly one
    // more attempt: some tasks genuinely have nothing to run (a docs change, a
    // config file), so this must never be a hard rejection — the cost of being
    // wrong here is one model call, while refusing outright would leave such a
    // task unable to author any gate at all. Checked LAST, so a gate that is
    // vacuous or broken is still reported as that, which is more actionable.
    const noRun = neverExecutesReason(script, projectRoot);
    if (noRun && attempt < attempts) {
      notes.push(`attempt ${attempt}: gate never runs the code — regenerating once`);
      priorFeedback = noRun;
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
    // Synthetic rung: UAP authored it, the project did not declare it. It has no
    // tier, so it runs in `fast` — and while red it used to stop promotion to
    // `runtime` and `final`, starving the execution gate, the user-path validator
    // and the vision review simultaneously. It still gates delivery (required),
    // it just no longer hides every real gate behind one model-written script.
    blocksPromotion: false,
  };
}
