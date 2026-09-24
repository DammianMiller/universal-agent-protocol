/**
 * Adversarial ATTACK machinery — one red-team round against a converged
 * deliver patch. Split from adversarial-gate.ts (which owns the stage
 * driver, settings resolution, and breach/repair orchestration) to keep
 * both modules under the 500-LOC quality-gate threshold; the seam is the
 * architect-review's suggested one: everything about authoring, sanctioning,
 * executing, and judging ONE attack lives here; the multi-round loop and
 * re-convergence policy live in adversarial-gate.ts. The gate module
 * re-exports this module's public surface, so existing imports from
 * './adversarial-gate.js' keep working.
 *
 * Composition over invention, per the uplift plan's constraint 4 (the source
 * post's anti-pattern #4: don't spend model tokens on deterministic work):
 *
 *  - CHEAP DETERMINISTIC PROBES run first: the stub detector over the
 *    converged write-set. A stub breach routes back WITHOUT a model call.
 *  - ONE bounded model call per round authors the edge-case tests.
 *  - Authored tests pass through the additive oracle channel
 *    (test-oracle-additive.ts): the red team may only ADD tests — appends
 *    keep the existing content verbatim as a prefix, and nothing may carry
 *    suppressors (.only/.skip), process.exit, or assertion reassignment.
 *  - Anti-vacuous discipline (the same principle as the self-gate's
 *    fails-on-unsolved floor): the authored tests must demonstrably RUN —
 *    the suite's per-test output is checked for the authored titles. A round
 *    that produces zero runnable tests is recorded as "no attack surface
 *    found", NOT as a pass of anything, and is never retried into a
 *    token-burning authoring loop.
 */

import { spawnSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join, sep } from 'path';
import type { LoopExecutor } from './convergence-loop.js';
import type { GateRung } from './verifier-ladder.js';
import { parseTestOutcomes } from './verifier-ladder.js';
import { isTestFilePath, parseFileBlocks, type FileBlock } from './applier.js';
import {
  applyWrites,
  MAX_ATTACK_FILES,
  rollbackWrites,
  sanctionAttackBlocks,
  type SanctionedWrite,
} from './adversarial-sanction.js';
import { detectStub, stubGuardDisabled } from './stub-detector.js';
import { listRepoFiles } from './self-gate.js';
import { sanitizedEnv } from './sanitized-env.js';

/** Changed-source excerpt budget in the attack prompt. */
const MAX_SURFACE_FILES = 6;
const MAX_FILE_EXCERPT_CHARS = 3000;

/** Files the red team attacks: runnable source, never tests/config/docs. */
const ATTACKABLE_SOURCE =
  /\.(js|mjs|cjs|jsx|ts|tsx|py|rs|go|java|kt|rb|php|cs|swift|c|cc|cpp|html)$/i;

export type AdversarialStatus = 'survived' | 'breached' | 'no-surface';

/** Verify/rollback record for one attack file the round left in the tree. */
export interface AdversarialAttackFile {
  /** Repo-relative, '/'-separated. */
  rel: string;
  /** Test-case titles the round's write added (post-repair verification). */
  titles: string[];
  /** Pre-existing content for appended-to files; null when the round CREATED the file. */
  prior: string | null;
}

/** One adversarial round: deterministic probes plus at most one model attack. */
export interface AdversarialRoundResult {
  round: number;
  status: AdversarialStatus;
  /** Sanctioned adversarial test cases authored this round. */
  authored: number;
  /** Authored tests the runner demonstrably reported. */
  ran: number;
  /** Of those, how many FAILED (the breach evidence). */
  failed: number;
  /** Repo-relative test files written this round (kept unless rolled back). */
  testFiles: string[];
  /** Loop-facing feedback when breached; a human note otherwise. */
  feedback: string;
  notes: string[];
  /**
   * The round's kept writes with their authored titles and pre-attack bytes.
   * Two consumers: the post-repair "never delete, skip, or weaken"
   * verification re-reads the titles after a repair claims success, and a
   * TERMINAL (unrepaired) breach rolls the files back from this record so a
   * rejected run never leaves the user's suite red. Absent when the round
   * wrote nothing or already rolled its writes back.
   */
  attackFiles?: AdversarialAttackFile[];
}

/** Suite execution result — full (untruncated) combined output. */
export interface SuiteRun {
  exitCode: number | null;
  output: string;
  spawnError?: string;
}

/** Test-suite execution seam. Tests inject a fake; production spawns the rung. */
export type SuiteRunner = (rung: GateRung, projectRoot: string, timeoutMs: number) => SuiteRun;

/** Options for a single adversarial round. */
export interface AdversarialRoundOptions {
  instruction: string;
  projectRoot: string;
  /** The converged run's write-set (the patch under attack), repo-relative. */
  filesApplied: string[];
  /** The run's rungs — used to find the test gate the new tests run under. */
  rungs: GateRung[];
  /** Model executor for the ONE bounded authoring call. */
  executor: LoopExecutor;
  /** 1-based round number (drives file naming and feedback). */
  round: number;
  runSuite?: SuiteRunner;
  timeoutMs?: number;
}

const defaultRunSuite: SuiteRunner = (rung, projectRoot, timeoutMs) => {
  const r = spawnSync(rung.command, rung.args, {
    cwd: rung.cwd ? join(projectRoot, rung.cwd) : projectRoot,
    encoding: 'utf-8',
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
    // Model-authored tests run inside the project's suite: strip host secrets.
    env: sanitizedEnv(),
  });
  return {
    exitCode: r.status,
    output: `${r.stdout ?? ''}\n${r.stderr ?? ''}`,
    ...(r.error ? { spawnError: String(r.error.message ?? r.error) } : {}),
  };
};

/** The rung the adversarial tests will run under, or null when none exists. */
export function pickTestRung(rungs: GateRung[]): GateRung | null {
  return rungs.find((r) => /test|vitest|jest|pytest|spec|ctest/i.test(r.id)) ?? null;
}

/** Existing, attackable source files from the run's write-set. */
export function attackSurface(filesApplied: string[], projectRoot: string): string[] {
  return filesApplied.filter(
    (rel) =>
      ATTACKABLE_SOURCE.test(rel) &&
      !isTestFilePath(rel.split(sep).join('/')) &&
      existsSync(join(projectRoot, rel))
  );
}

/**
 * Deterministic probe: is any converged write a STUB? Costs no tokens; a hit
 * is a breach on its own (the patch declares an API it does not implement).
 */
function stubBreach(projectRoot: string, surface: string[]): string | null {
  if (stubGuardDisabled()) return null;
  const findings: string[] = [];
  for (const rel of surface) {
    let content: string;
    try {
      content = readFileSync(join(projectRoot, rel), 'utf-8');
    } catch {
      continue;
    }
    const verdict = detectStub(rel, content);
    if (verdict.isStub) findings.push(`${rel}: ${verdict.reason}`);
    if (findings.length >= 5) break;
  }
  if (findings.length === 0) return null;
  return (
    'DETERMINISTIC ADVERSARIAL PROBE — the converged patch contains stub file(s):\n' +
    findings.map((f) => `  ${f}`).join('\n') +
    '\nImplement the declared surface for real; do not ship skeletons.'
  );
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The authoring prompt — one bounded model call per round. */
export function buildAttackPrompt(
  instruction: string,
  projectRoot: string,
  surface: string[],
  rung: GateRung,
  round: number
): string {
  const excerpts = surface.slice(0, MAX_SURFACE_FILES).map((rel) => {
    let content = '';
    try {
      content = readFileSync(join(projectRoot, rel), 'utf-8').slice(0, MAX_FILE_EXCERPT_CHARS);
    } catch {
      /* unreadable — list the path only */
    }
    return `===== ${rel} =====\n${content}`;
  });
  // Show the red team the project's test conventions so the authored file
  // actually RUNS under the existing suite (framework + import style).
  const exampleTests = listRepoFiles(projectRoot)
    .filter((f) => isTestFilePath(f))
    .slice(0, 3);
  const exampleBlock =
    exampleTests.length > 0
      ? [
          'EXISTING TEST FILES (match this framework and import style):',
          ...exampleTests.map((f) => `  ${f}`),
        ]
      : ['The repository has no existing test files — use the test command above as the contract.'];
  return [
    'You are an ADVERSARIAL TESTER attacking a code change that has just passed all of the',
    "project's gates. Assume it is wrong in a way the existing suite did not catch, and prove it.",
    '',
    `TASK THE CHANGE IMPLEMENTS:\n${instruction}`,
    '',
    'CHANGED FILES (the patch under attack):',
    ...excerpts,
    '',
    ...exampleBlock,
    '',
    `TEST GATE: \`${[rung.command, ...rung.args].join(' ')}\` (run from the project root).`,
    '',
    `Write ONE new test file (at most ${MAX_ATTACK_FILES}) of EDGE-CASE tests targeting the changed`,
    'code: boundary values, empty/null/undefined inputs, error paths, off-by-one mistakes,',
    'state reset between calls — whatever this patch is most likely to get wrong. Every test',
    'must FAIL when the implementation is wrong and PASS when it is right.',
    '',
    'Rules:',
    '  - Output ONLY strict file blocks: ```file:<path> fenced blocks, nothing else.',
    `  - Tests MUST live in NEW test files (e.g. test/adversarial-round-${round}.test.*). You may`,
    '    APPEND to an existing test file only by reproducing it byte-identically first — never',
    '    modify, delete, skip, or weaken existing tests.',
    '  - No .only/.skip/.todo, no process.exit, no reassigning assert/expect.',
    '  - Import the changed modules by their real relative paths, so the tests RUN under the',
    '    test gate above.',
    '  - No network, no sleeps, no wall-clock dependence.',
  ].join('\n');
}

/**
 * Per-file fallback for runners whose default output has no per-test lines
 * (non-verbose vitest): the per-FILE summary still proves the new file's
 * tests executed — `✓ test/x.test.ts (3 tests)` or TAP `ok 1 - test/x.js`.
 */
function fileReportedRan(output: string, rel: string): boolean {
  const esc = escapeRegExp(rel);
  return (
    new RegExp(`[✓✔]\\s+${esc}\\s+\\(\\d+\\s+tests?\\)`).test(output) ||
    new RegExp(`^\\s*ok\\s+\\d+\\s+-\\s+${esc}\\b`, 'm').test(output)
  );
}

interface SuiteVerdict {
  status: AdversarialStatus;
  ran: number;
  failed: number;
  feedback: string;
  notes: string[];
  /** True when the round's writes must be rolled back (tests never ran). */
  rollback: boolean;
}

/**
 * Judge the suite run against the authored titles. The anti-vacuous floor: a
 * round where the runner never reported the authored tests is "no attack
 * surface found", not a pass — and the files are rolled back so the converged
 * tree is left exactly as the gates saw it.
 */
function judgeSuiteRun(
  run: SuiteRun,
  writes: SanctionedWrite[],
  rung: GateRung,
  round: number
): SuiteVerdict {
  const authored = writes.flatMap((w) => w.titles);
  if (run.spawnError) {
    return {
      status: 'no-surface',
      ran: 0,
      failed: 0,
      feedback: `the test suite could not run (${run.spawnError.slice(0, 120)})`,
      notes: [`round ${round}: suite spawn error — ${run.spawnError.slice(0, 120)}`],
      rollback: true,
    };
  }
  const outcomes = parseTestOutcomes(run.output, rung.id);
  const failedTitles = outcomes ? authored.filter((t) => outcomes.failed.has(t)) : [];
  if (run.exitCode !== 0 && failedTitles.length > 0) {
    const tail = run.output.trim().slice(-1200);
    return {
      status: 'breached',
      ran: failedTitles.length + (outcomes ? authored.filter((t) => outcomes.passed.has(t)).length : 0),
      failed: failedTitles.length,
      feedback:
        `ADVERSARIAL TEST FAILURE (round ${round}): ${failedTitles.length} edge-case test(s) written by the ` +
        'adversarial gate FAIL against the converged patch:\n' +
        failedTitles.map((t) => `  ✗ ${t}`).join('\n') +
        `\nThe failing tests live in: ${writes.map((w) => w.rel).join(', ')}` +
        `\nRunner output (tail):\n${tail}`,
      notes: [`round ${round}: BREACH — ${failedTitles.length} adversarial test(s) failed`],
      // The failing tests STAY: they are the gate evidence the re-converged
      // loop must turn green.
      rollback: false,
    };
  }
  const ranTitles = outcomes
    ? authored.filter((t) => outcomes.passed.has(t) || outcomes.failed.has(t))
    : authored.filter((t) => {
        const write = writes.find((w) => w.titles.includes(t));
        return write !== undefined && fileReportedRan(run.output, write.rel);
      });
  if (run.exitCode === 0 && ranTitles.length > 0) {
    return {
      status: 'survived',
      ran: ranTitles.length,
      failed: 0,
      feedback: `round ${round}: patch survived — ${ranTitles.length} adversarial test(s) ran and passed`,
      notes: [`round ${round}: survived (${ranTitles.length}/${authored.length} confirmed running)`],
      rollback: false,
    };
  }
  // Zero runnable evidence. Two shapes, kept DISTINCT in the audit trail:
  //  - green suite, authored titles never reported → genuinely no attack
  //    surface confirmed (the runner never saw our tests); and
  //  - RED suite, zero authored titles parsed as failed → INCONCLUSIVE: our
  //    file is present and the suite is red, but the reporter is unknown, so
  //    we cannot attribute the redness. Fail-open accept either way, but an
  //    inconclusive round must never read as "no attack surface found".
  if (run.exitCode === 0) {
    return {
      status: 'no-surface',
      ran: 0,
      failed: 0,
      feedback: 'adversarial round produced no runnable tests',
      notes: [
        `round ${round}: authored ${authored.length} test(s) but the runner never reported them — no attack surface confirmed`,
      ],
      rollback: true,
    };
  }
  return {
    status: 'no-surface',
    ran: 0,
    failed: 0,
    feedback: 'inconclusive: suite went red but no authored adversarial test was reported as failed',
    notes: [
      `inconclusive: round ${round}: suite went red without an authored test failing (the attack file likely failed to load) — rolled back`,
    ],
    rollback: true,
  };
}

/** Run ONE adversarial round against the converged state. */
export async function runAdversarialRound(
  opts: AdversarialRoundOptions
): Promise<AdversarialRoundResult> {
  const notes: string[] = [];
  const done = (
    status: AdversarialStatus,
    partial: Partial<AdversarialRoundResult> = {}
  ): AdversarialRoundResult => ({
    round: opts.round,
    status,
    authored: 0,
    ran: 0,
    failed: 0,
    testFiles: [],
    feedback: '',
    notes,
    ...partial,
  });

  const surface = attackSurface(opts.filesApplied, opts.projectRoot);
  if (surface.length === 0) {
    notes.push(`round ${opts.round}: the converged run left no attackable source files`);
    return done('no-surface', { feedback: 'no attackable source files in the converged patch' });
  }

  // Deterministic-first: a stub in the patch is a breach with zero tokens spent.
  const stub = stubBreach(opts.projectRoot, surface);
  if (stub) {
    notes.push(`round ${opts.round}: deterministic breach (stub detector)`);
    return done('breached', { feedback: stub });
  }

  const rung = pickTestRung(opts.rungs);
  if (!rung) {
    notes.push(`round ${opts.round}: no test gate among the rungs — adversarial tests could not run`);
    return done('no-surface', { feedback: 'no test gate to host adversarial tests' });
  }

  // The ONE bounded model call: author edge-case tests against the surface.
  let blocks: FileBlock[];
  try {
    const response = await opts.executor(
      buildAttackPrompt(opts.instruction, opts.projectRoot, surface, rung, opts.round)
    );
    blocks = parseFileBlocks(response);
  } catch (err) {
    notes.push(`round ${opts.round}: attack authoring errored (${String(err).slice(0, 120)})`);
    return done('no-surface', { feedback: 'attack authoring call errored' });
  }
  if (blocks.length === 0) {
    notes.push(`round ${opts.round}: the model authored no file blocks`);
    return done('no-surface', { feedback: 'the model authored no adversarial tests' });
  }

  const { writes, notes: sanctionNotes } = sanctionAttackBlocks(blocks, opts.projectRoot);
  notes.push(...sanctionNotes);
  if (writes.length === 0) {
    return done('no-surface', { feedback: 'no sanctionable adversarial tests authored' });
  }

  applyWrites(writes, blocks);
  const run = (opts.runSuite ?? defaultRunSuite)(
    rung,
    opts.projectRoot,
    opts.timeoutMs ?? rung.timeoutMs
  );
  const verdict = judgeSuiteRun(run, writes, rung, opts.round);
  notes.push(...verdict.notes);
  if (verdict.rollback) rollbackWrites(writes);
  return done(verdict.status, {
    authored: writes.reduce((n, w) => n + w.titles.length, 0),
    ran: verdict.ran,
    failed: verdict.failed,
    testFiles: verdict.rollback ? [] : writes.map((w) => w.rel),
    feedback: verdict.feedback,
    // Kept writes carry their titles + pre-attack bytes: the stage driver
    // verifies a "successful" repair did not gut them, and rolls them back
    // if the breach turns out terminal.
    ...(verdict.rollback
      ? {}
      : { attackFiles: writes.map((w) => ({ rel: w.rel, titles: w.titles, prior: w.prior })) }),
  });
}

/** The re-convergence prompt: the breach becomes ordinary gate feedback. */
export function breachReconvergencePrompt(
  instruction: string,
  breach: AdversarialRoundResult
): string {
  return [
    instruction,
    '',
    'ADVERSARIAL GATE BREACH — a skeptical verifier attacked the converged patch and it FAILED:',
    '',
    breach.feedback,
    '',
    'Fix the IMPLEMENTATION so these adversarial tests pass. The adversarial tests are additive',
    'oracle additions: never delete, skip, or weaken them — make the code correct instead.',
  ].join('\n');
}
