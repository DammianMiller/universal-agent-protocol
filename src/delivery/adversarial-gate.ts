/**
 * Adversarial Red-Team Gate — HLG master architecture, stage 5
 * (docs/plans/hlg-master-architecture-uplift-2026-09-24.md).
 *
 * When a deliver run has converged (all gates green) and BEFORE the verdict
 * is accepted, a skeptical verifier attacks the patch: it writes edge-case
 * tests designed to BREAK the change. If any fail, the run routes back into
 * the convergence loop with that failure as ordinary gate evidence; only a
 * patch that survives proceeds to acceptance (and gate evidence).
 *
 * Composition over invention, per the plan's constraint 4 (the source post's
 * anti-pattern #4: don't spend model tokens on deterministic work):
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
 *  - BOUNDED: at most `maxRounds` attacks per run (default 2). A breach
 *    consumes a round and re-enters the convergence loop; the breaching
 *    tests REMAIN in the tree, so the repaired state has already survived
 *    that attack — the next round, if budget remains, attacks with FRESH
 *    tests rather than re-running the old ones forever.
 *
 * ACCEPTED RESIDUAL (C-stage review, 2026-09-24): authored tests execute
 * with HOST FILESYSTEM privileges — sanitized-env strips environment
 * variables but does NOT stop file-based credential reads (~/.aws, ~/.ssh,
 * /etc) from inside a running test; and the repo content quoted into the
 * attack prompt is an INDIRECT PROMPT-INJECTION channel into the authoring
 * model. The additive oracle channel plus lexical+symlink path containment
 * bound what an attack may WRITE and never weaken; what it can READ at
 * runtime is everything the host user can read. This stage therefore runs
 * only on the operator's own deliver run, never on untrusted input.
 */

import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { dirname, isAbsolute, join, resolve, sep } from 'path';
import type { DeliveryResult, LoopExecutor } from './convergence-loop.js';
import { foldDeliveryResult } from './delivery-result.js';
import type { GateRung } from './verifier-ladder.js';
import { parseTestOutcomes } from './verifier-ladder.js';
import { isTestFilePath, parseFileBlocks, realParentEscapes, type FileBlock } from './applier.js';
import {
  additiveTestDeltaRefusal,
  additiveTestEditRefusal,
  extractTestTitles,
} from './test-oracle-additive.js';
import { detectStub, stubGuardDisabled } from './stub-detector.js';
import { listRepoFiles } from './self-gate.js';
import { sanitizedEnv } from './sanitized-env.js';

/** Default attacks per converged run; each breach re-enters the loop once. */
export const DEFAULT_ADVERSARIAL_ROUNDS = 2;
/** Hard ceiling — the stage must never become the loop it exists to bound. */
export const MAX_ADVERSARIAL_ROUNDS = 4;
/** At most this many model-authored test files per round. */
const MAX_ATTACK_FILES = 3;
/** Per-file content cap for authored tests (guards runaway generations). */
const MAX_ATTACK_BYTES = 100_000;
/** Changed-source excerpt budget in the attack prompt. */
const MAX_SURFACE_FILES = 6;
const MAX_FILE_EXCERPT_CHARS = 3000;

/** Files the red team attacks: runnable source, never tests/config/docs. */
const ATTACKABLE_SOURCE =
  /\.(js|mjs|cjs|jsx|ts|tsx|py|rs|go|java|kt|rb|php|cs|swift|c|cc|cpp|html)$/i;

/** Resolved on/off + round budget for the stage. */
export interface AdversarialGateSettings {
  enabled: boolean;
  maxRounds: number;
}

/**
 * Resolve the adversarial gate's effective settings.
 *
 * Precedence mirrors `resolveParallelTasks` (task-workspace.ts): the
 * `UAP_DELIVER_ADVERSARIAL_GATE` env var > `.uap.json` `deliver.adversarialGate`
 * > the default. The stage is DEFAULT ON; `0`/`off`/`false` at either layer
 * disables it. A positive integer at either layer retunes the round budget
 * (clamped to [1, MAX_ADVERSARIAL_ROUNDS]); any other truthy value keeps the
 * default budget — a typo must never silently disable a safety gate, and the
 * documented off switch is unambiguous.
 */
export function resolveAdversarialGate(
  raw: unknown,
  env: NodeJS.ProcessEnv = process.env
): AdversarialGateSettings {
  const off = (v: unknown): boolean => v === false || v === 0 || v === '0' || v === 'off';
  const budget = (v: unknown): number => {
    // Boolean `true` means "on" (the flag form), not a round count —
    // Number(true) === 1 would silently collapse the budget to one round
    // while env 'true' keeps the default. Guard the TYPE, not the value.
    if (typeof v === 'boolean') return DEFAULT_ADVERSARIAL_ROUNDS;
    const n = Number(v);
    return Number.isFinite(n) && n > 0
      ? Math.min(Math.floor(n), MAX_ADVERSARIAL_ROUNDS)
      : DEFAULT_ADVERSARIAL_ROUNDS;
  };
  const fromEnv = env.UAP_DELIVER_ADVERSARIAL_GATE;
  if (fromEnv !== undefined && fromEnv.trim() !== '') {
    return off(fromEnv)
      ? { enabled: false, maxRounds: 0 }
      : { enabled: true, maxRounds: budget(fromEnv) };
  }
  if (raw === undefined || raw === null) {
    return { enabled: true, maxRounds: DEFAULT_ADVERSARIAL_ROUNDS };
  }
  return off(raw)
    ? { enabled: false, maxRounds: 0 }
    : { enabled: true, maxRounds: budget(raw) };
}

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

/** Options for the whole stage (bounded rounds + re-convergence). */
export interface AdversarialGateOptions {
  instruction: string;
  projectRoot: string;
  rungs: GateRung[];
  executor: LoopExecutor;
  settings: AdversarialGateSettings;
  /** The converged result under attack. */
  initial: DeliveryResult;
  /**
   * Re-enter the convergence loop with the breach as feedback. The breaching
   * tests are already in the tree, so a successful re-convergence has made
   * THEM pass too — the attack persists as ordinary gate evidence.
   */
  reconverge: (prompt: string) => Promise<DeliveryResult>;
  runSuite?: SuiteRunner;
  timeoutMs?: number;
  /** Operator-facing progress lines. */
  note?: (line: string) => void;
  /**
   * Re-derive the rung set AT GATE TIME. deliver.ts wires this to
   * `mergeRedetectedRungs(rungs, detectRungs(projectRoot), …)` — the same
   * policy the loop's mid-mission redetection uses — because the rungs this
   * stage receives were detected at t0, and a mission that CREATED its own
   * test gate (greenfield) would otherwise no-surface forever. A throwing
   * detector falls back to `opts.rungs`.
   */
  redetectRungs?: () => GateRung[];
  /**
   * Called with each breaching round BEFORE reconvergence, so the caller can
   * extend the repair executor's protected set with the breaching test files
   * (the t0 protection snapshot predates them). The post-repair verification
   * below enforces the rule regardless; this is defense in depth.
   */
  onBreach?: (breach: AdversarialRoundResult) => void;
}

/** The stage's outcome, including the (possibly re-converged) final result. */
export interface AdversarialGateReport {
  status: AdversarialStatus | 'disabled';
  rounds: AdversarialRoundResult[];
  authored: number;
  ran: number;
  failed: number;
  /** The state to accept (survived/no-surface) or reject (breached). */
  result: DeliveryResult;
  /** One-line outcome for telemetry / the gate-evidence artifact. */
  summary: string;
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

interface SanctionedWrite {
  /** Repo-relative, '/'-separated. */
  rel: string;
  abs: string;
  /** Pre-existing content (append case); null for a new file. */
  prior: string | null;
  /** Test-case titles this write adds. */
  titles: string[];
}

/**
 * Sanction model-authored blocks through the additive oracle channel. The red
 * team may only ADD tests: new test files (suppressor/exit/assert-patch
 * checks), or verbatim-prefix appends to existing ones (full additive rule).
 */
export function sanctionAttackBlocks(
  blocks: FileBlock[],
  projectRoot: string
): { writes: SanctionedWrite[]; notes: string[] } {
  const writes: SanctionedWrite[] = [];
  const notes: string[] = [];
  const rootAbs = resolve(projectRoot);
  // Symlink-followed root for the containment check — the lexical resolve
  // alone lets a pre-existing symlink inside the repo redirect an attack-file
  // write outside it (same rule the applier enforces on every other write).
  let realRoot = rootAbs;
  try {
    realRoot = realpathSync(rootAbs);
  } catch {
    /* root unreadable — fall back to the lexical root */
  }
  if (blocks.length > MAX_ATTACK_FILES) {
    const dropped = blocks.slice(MAX_ATTACK_FILES).map((b) => b.path);
    // Surplus blocks are REFUSED, not silently lost — the audit trail records
    // exactly what the model tried to add beyond the cap.
    notes.push(
      `dropped ${dropped.length} surplus attack block(s) beyond the ${MAX_ATTACK_FILES}-file cap: ${dropped.join(', ')}`
    );
  }
  for (const block of blocks.slice(0, MAX_ATTACK_FILES)) {
    const rel = block.path.replace(/\\/g, '/').replace(/^\/+/, '');
    const abs = resolve(rootAbs, rel);
    if (isAbsolute(block.path) || (abs !== rootAbs && !abs.startsWith(rootAbs + sep))) {
      notes.push(`refused ${block.path}: path escapes the project root`);
      continue;
    }
    if (realParentEscapes(abs, realRoot)) {
      notes.push(`refused ${rel}: a symlink in its parent path escapes the project root`);
      continue;
    }
    if (!isTestFilePath(rel)) {
      notes.push(`refused ${rel}: not a test file — the red team may only add tests`);
      continue;
    }
    // Byte-accurate cap: a runaway generation of multibyte text must count
    // the BYTES it would write, not UTF-16 code units.
    if (Buffer.byteLength(block.content, 'utf-8') > MAX_ATTACK_BYTES) {
      notes.push(`refused ${rel}: content exceeds ${MAX_ATTACK_BYTES} bytes`);
      continue;
    }
    if (existsSync(abs)) {
      const prior = readFileSync(abs, 'utf-8');
      const refusal = additiveTestEditRefusal(prior, block.content);
      if (refusal) {
        notes.push(`refused ${rel}: append to an existing test file is not additive — ${refusal}`);
        continue;
      }
      const priorTitles = new Set(extractTestTitles(prior));
      const titles = extractTestTitles(block.content).filter((t) => !priorTitles.has(t));
      if (titles.length === 0) {
        notes.push(`refused ${rel}: the append adds no recognizable test cases`);
        continue;
      }
      writes.push({ rel, abs, prior, titles });
    } else {
      const refusal = additiveTestDeltaRefusal(block.content);
      if (refusal) {
        notes.push(`refused ${rel}: ${refusal}`);
        continue;
      }
      const titles = extractTestTitles(block.content);
      if (titles.length === 0) {
        notes.push(`refused ${rel}: no recognizable test cases — nothing runnable to add`);
        continue;
      }
      writes.push({ rel, abs, prior: null, titles });
    }
  }
  return { writes, notes };
}

/** Materialize sanctioned writes; returns nothing (rollback via the writes). */
function applyWrites(writes: SanctionedWrite[], blocks: FileBlock[]): void {
  const contentByRel = new Map(blocks.map((b) => [b.path.replace(/\\/g, '/').replace(/^\/+/, ''), b.content]));
  for (const w of writes) {
    mkdirSync(dirname(w.abs), { recursive: true });
    writeFileSync(w.abs, contentByRel.get(w.rel) ?? '', 'utf-8');
  }
}

/**
 * Undo this round's writes: remove files the round CREATED, restore files it
 * appended to. Only ever touches paths sanctionAttackBlocks sanctioned.
 */
function rollbackWrites(writes: SanctionedWrite[]): void {
  for (const w of writes) {
    try {
      if (w.prior === null) rmSync(w.abs, { force: true });
      else writeFileSync(w.abs, w.prior, 'utf-8');
    } catch {
      /* rollback is best-effort; the notes carry the residue */
    }
  }
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

/**
 * Post-repair verification (C-stage review: vacuous breach repair). The
 * reconvergence prompt's "never delete, skip, or weaken" rule is PROSE, and
 * the repair executor's protected-files set was snapshotted at t0 — before
 * the adversarial tests existed — so nothing structural stops a repair from
 * deleting or gutting the very tests that pinned the breach. After a repair
 * reports success, every breaching test file must still EXIST and still
 * contain its authored titles; anything else is a failed repair, whatever
 * the loop's gates say (a repair that removed the test trivially turns them
 * green). Returns the per-file violations; empty means the attack survived
 * the repair intact.
 */
function breachingTestsGutted(projectRoot: string, breach: AdversarialRoundResult): string[] {
  const gutted: string[] = [];
  for (const f of breach.attackFiles ?? []) {
    const abs = join(projectRoot, f.rel);
    let content: string | null = null;
    try {
      content = existsSync(abs) ? readFileSync(abs, 'utf-8') : null;
    } catch {
      content = null;
    }
    if (content === null) {
      gutted.push(`${f.rel}: breaching test file was deleted during repair`);
      continue;
    }
    const present = new Set(extractTestTitles(content));
    const missing = f.titles.filter((t) => !present.has(t));
    if (missing.length > 0) {
      gutted.push(
        `${f.rel}: ${missing.length} authored adversarial test(s) removed or renamed during repair (${missing
          .slice(0, 2)
          .join('; ')})`
      );
    }
  }
  return gutted;
}

/**
 * Terminal-breach rollback: a REJECTED run must not leave the user's suite
 * red, so the breaching round's authored files come back OUT — created files
 * removed, appended-to files restored to their pre-attack bytes. (The
 * keep-best rollback rail settled BEFORE this stage runs, so this is the
 * only rail left.) Survived and repaired rounds keep their tests: those
 * pass, and are regression tests now. Best-effort, like rollbackWrites.
 */
function rollbackAttackFiles(projectRoot: string, round: AdversarialRoundResult): string[] {
  const rolledBack: string[] = [];
  for (const f of round.attackFiles ?? []) {
    try {
      if (f.prior === null) rmSync(join(projectRoot, f.rel), { force: true });
      else writeFileSync(join(projectRoot, f.rel), f.prior, 'utf-8');
      rolledBack.push(f.rel);
    } catch {
      /* rollback is best-effort; the round notes carry the residue */
    }
  }
  return rolledBack;
}

function summarize(
  status: AdversarialGateReport['status'],
  rounds: AdversarialRoundResult[],
  totals: { authored: number; ran: number; failed: number }
): string {
  const counts = `${totals.authored} authored / ${totals.ran} ran / ${totals.failed} failed`;
  if (status === 'disabled') return 'adversarial gate: disabled';
  if (status === 'survived') {
    return `adversarial gate: patch survived ${rounds.length} round(s) (${counts})`;
  }
  if (status === 'no-surface') {
    return `adversarial gate: no attack surface found after ${rounds.length} round(s) (${counts})`;
  }
  return `adversarial gate: patch BREACHED (${counts}) — re-convergence could not repair it`;
}

/**
 * The stage: attack the converged state up to `settings.maxRounds` times,
 * routing breaches back into the convergence loop as ordinary gate evidence.
 *
 * Round-budget semantics: a breach CONSUMES a round and re-enters the loop.
 * Because the breaching tests stay in the tree, the repaired state has already
 * survived that attack — so exhausting the budget on a successful repair is an
 * accept, not an open question. Only an UNREPAIRED breach rejects the run.
 */
export async function runAdversarialGate(opts: AdversarialGateOptions): Promise<AdversarialGateReport> {
  const totals = { authored: 0, ran: 0, failed: 0 };
  const base = (status: AdversarialGateReport['status'], rounds: AdversarialRoundResult[], result: DeliveryResult): AdversarialGateReport => ({
    status,
    rounds,
    ...totals,
    result,
    summary: summarize(status, rounds, totals),
  });
  if (!opts.settings.enabled) {
    return base('disabled', [], opts.initial);
  }

  const rounds: AdversarialRoundResult[] = [];
  let result = opts.initial;
  for (let round = 1; round <= opts.settings.maxRounds; round++) {
    // Gate-time redetection (C-stage review: stale t0 rungs): the rungs this
    // stage was handed were detected at mission start, so a greenfield
    // mission that CREATED its test gate would no-surface forever. Re-merge
    // the fresh detection the way the loop's mid-mission redetection does.
    let roundRungs = opts.rungs;
    if (opts.redetectRungs) {
      try {
        roundRungs = opts.redetectRungs();
      } catch {
        roundRungs = opts.rungs;
      }
    }
    const filesApplied = [...new Set(result.history.flatMap((h) => h.filesApplied))];
    const r = await runAdversarialRound({
      instruction: opts.instruction,
      projectRoot: opts.projectRoot,
      filesApplied,
      rungs: roundRungs,
      executor: opts.executor,
      round,
      ...(opts.runSuite ? { runSuite: opts.runSuite } : {}),
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    });
    rounds.push(r);
    totals.authored += r.authored;
    totals.ran += r.ran;
    totals.failed += r.failed;
    opts.note?.(
      r.status === 'breached'
        ? `🛡 adversarial round ${r.round}: BREACH — ${r.failed} adversarial test(s) failed; re-entering the loop`
        : r.status === 'survived'
          ? `🛡 adversarial round ${r.round}: survived — ${r.ran}/${r.authored} authored test(s) ran and passed`
          : `🛡 adversarial round ${r.round}: no attack surface found (${r.feedback})`
    );
    if (r.status !== 'breached') {
      return base(r.status, rounds, result);
    }

    // Breach: let the caller extend the repair's protected set with the
    // breaching test files (its t0 protection snapshot predates them), then
    // feed the failure back into the convergence loop as ordinary evidence.
    opts.onBreach?.(r);
    const repaired = await opts.reconverge(breachReconvergencePrompt(opts.instruction, r));
    const merged: DeliveryResult = { ...result, history: [...result.history] };
    foldDeliveryResult(merged, repaired);
    merged.success = repaired.success;
    merged.changedTree = Boolean(result.changedTree || repaired.changedTree);
    if (!repaired.success) {
      // TERMINAL breach: the run is rejected, and a rejected run must not
      // leave the user's suite red — roll the round's authored files back.
      const rolledBack = rollbackAttackFiles(opts.projectRoot, r);
      r.notes.push(
        `terminal breach — authored adversarial test file(s) rolled back: ${rolledBack.join(', ') || 'none recorded'}`
      );
      merged.finalFeedback =
        `⛔ adversarial gate: the red team broke the patch and the repair loop did not converge.\n\n${repaired.finalFeedback}`;
      return base('breached', rounds, merged);
    }
    // Vacuous-repair check: a "successful" repair that deleted or gutted the
    // breaching tests did not fix anything — it removed the evidence. That
    // is a failed repair, and the (terminal) breach rolls back as above.
    const gutted = breachingTestsGutted(opts.projectRoot, r);
    if (gutted.length > 0) {
      const rolledBack = rollbackAttackFiles(opts.projectRoot, r);
      r.notes.push(`repair gutted the breaching test(s) — repair REJECTED: ${gutted.join('; ')}`);
      if (rolledBack.length > 0) {
        r.notes.push(`terminal breach — authored adversarial test file(s) rolled back: ${rolledBack.join(', ')}`);
      }
      merged.success = false;
      merged.finalFeedback =
        '⛔ adversarial gate: the repair deleted or weakened the breaching adversarial tests instead of fixing the code.\n\n' +
        gutted.map((g) => `  ${g}`).join('\n');
      return base('breached', rounds, merged);
    }
    result = merged;
  }
  // Budget exhausted on a repaired state: the breaching tests remained in the
  // tree, so every repair already had to make them green — accept.
  return base('survived', rounds, result);
}
