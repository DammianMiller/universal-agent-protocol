/**
 * Baseline-delta demotion must not absorb breakage the mission itself caused.
 *
 * Demotion exists so a mission is not punished for a gate that was already red,
 * and it promises "only NEW failures block". At rung granularity it could not
 * keep that promise: an already-red suite absorbed any amount of fresh
 * breakage. Live on 2026-08-09 a mission whose whole goal was making `cargo
 * test` green ran with cargo-test demoted — because it was red at baseline,
 * which is exactly why the mission existed — and took the crate from 6 failing
 * tests to 8 with nothing blocking.
 *
 * The metric is test NAMES, not counts. Counting was tried first and reverted:
 * `cargo test` fail-fasts at the first failing target, so a mission that FIXES
 * that target lets cargo reach the next one and report ITS pre-existing
 * failures — the count rises and an improving mission is told it regressed.
 * A test that never ran at baseline is unknown, not newly broken.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  parseTestOutcomes,
  regressedTests,
  demoteBaselineFailures,
  runLadder,
  runTieredLadder,
  type GateRung,
  type RungResult,
} from '../../src/delivery/verifier-ladder.js';

// Real shapes, kept verbatim so a formatting assumption cannot drift unnoticed.
const CARGO = [
  'test slope::tests::test_linear ... ok',
  'test slope::tests::test_precision_accuracy ... FAILED',
  'test hash::tests::test_hash_stable ... ok',
  'test hash::tests::test_ignored_case ... ignored',
  '',
  'test result: FAILED. 2 passed; 1 failed; 1 ignored;',
].join('\n');

describe('parseTestOutcomes', () => {
  it('splits cargo output into passing and failing names', () => {
    const o = parseTestOutcomes(CARGO)!;
    expect([...o.passed].sort()).toEqual(['hash::tests::test_hash_stable', 'slope::tests::test_linear']);
    expect([...o.failed]).toEqual(['slope::tests::test_precision_accuracy']);
  });

  it('counts an ignored test as neither passing nor failing', () => {
    const o = parseTestOutcomes(CARGO)!;
    expect(o.passed.has('hash::tests::test_ignored_case')).toBe(false);
    expect(o.failed.has('hash::tests::test_ignored_case')).toBe(false);
  });

  it('reads go, pytest and jest/vitest per-test lines', () => {
    const go = parseTestOutcomes('--- PASS: TestAlpha (0.00s)\n--- FAIL: TestBeta (0.01s)')!;
    expect([...go.passed]).toEqual(['TestAlpha']);
    expect([...go.failed]).toEqual(['TestBeta']);

    const py = parseTestOutcomes('tests/test_a.py::test_one PASSED\ntests/test_a.py::test_two FAILED')!;
    expect([...py.passed]).toEqual(['tests/test_a.py::test_one']);
    expect([...py.failed]).toEqual(['tests/test_a.py::test_two']);

    const js = parseTestOutcomes('  ✓ adds numbers (3 ms)\n  ✕ subtracts numbers (1 ms)')!;
    expect([...js.passed]).toEqual(['adds numbers']);
    expect([...js.failed]).toEqual(['subtracts numbers']);
  });

  it('returns null when the runner reports no per-test outcomes', () => {
    // A summary alone cannot distinguish "revealed" from "broken", so the safe
    // answer is the behaviour demotion already had.
    expect(parseTestOutcomes('test result: FAILED. 30 passed; 8 failed;')).toBeNull();
    expect(parseTestOutcomes('error[E0433]: failed to resolve')).toBeNull();
    expect(parseTestOutcomes('')).toBeNull();
  });
});

const rung = (baselinePassing?: string[]): GateRung => ({
  id: 'cargo-test',
  name: 'Tests [pre-existing failure at baseline — non-blocking]',
  command: 'true',
  args: [],
  required: false,
  timeoutMs: 1000,
  ...(baselinePassing ? { baselinePassing } : {}),
});

/** A failing RungResult whose output is `out`, parsed as runRung would. */
function failed(out: string, id = 'cargo-test'): RungResult {
  const o = parseTestOutcomes(out, id);
  return {
    id,
    name: id,
    passed: false,
    skipped: false,
    exitCode: 101,
    durationMs: 1,
    outputTail: out,
    ...(o ? { testOutcomes: { passed: [...o.passed], failed: [...o.failed] } } : {}),
  };
}

describe('regressedTests', () => {
  it('names a test that passed at baseline and fails now', () => {
    const now = 'test slope::tests::test_linear ... FAILED';
    expect(regressedTests(rung(['slope::tests::test_linear']), failed(now))).toEqual(['slope::tests::test_linear']);
  });

  it('ignores a test that was ALREADY failing at baseline', () => {
    // The whole point of demotion.
    const now = 'test slope::tests::test_precision_accuracy ... FAILED';
    expect(regressedTests(rung(['slope::tests::test_linear']), failed(now))).toEqual([]);
  });

  it('ignores failures REVEALED by fixing an earlier target', () => {
    // cargo fail-fasts, so target B's tests never ran at baseline and are not
    // in the passing set. This is the case that killed the count-based version.
    const now = 'test target_b::tests::never_ran_before ... FAILED';
    expect(regressedTests(rung(['slope::tests::test_linear']), failed(now))).toEqual([]);
  });

  it('ignores a newly ADDED failing test (TDD in an already-red suite)', () => {
    const now = 'test slope::tests::brand_new_case ... FAILED';
    expect(regressedTests(rung(['slope::tests::test_linear']), failed(now))).toEqual([]);
  });

  it('is unmoved by failure MULTIPLICITY from duplicate module wiring', () => {
    // The live crate compiled one file twice via #[path], doubling every
    // failure count while correctness was unchanged. Names make that a no-op.
    const now = [
      'test slope::tests::test_precision_accuracy ... FAILED',
      'test running_slope::tests::test_precision_accuracy ... FAILED',
    ].join('\n');
    expect(regressedTests(rung(['slope::tests::test_linear']), failed(now))).toEqual([]);
  });

  it('stays quiet when the rung was never demoted, or the output is opaque', () => {
    expect(regressedTests(rung(undefined), failed('test x ... FAILED'))).toEqual([]);
    expect(regressedTests(rung(['x']), failed('Segmentation fault'))).toEqual([]);
  });
});

describe('the block reaches BOTH ladder runners', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'uap-ns-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** A demoted rung whose current run fails `failing`. */
  const demoted = (failing: string, baselinePassing: string[]): GateRung => ({
    id: 'cargo-test',
    name: 'Tests [pre-existing failure at baseline — non-blocking]',
    command: 'bash',
    args: ['-c', `echo "test ${failing} ... FAILED"; echo "test result: FAILED. 1 failed;"; exit 101`],
    required: false,
    timeoutMs: 10_000,
    tier: 'fast',
    baselinePassing,
  });

  it('runLadder blocks on a regression', () => {
    const r = runLadder([demoted('slope::tests::was_green', ['slope::tests::was_green'])], dir, {});
    expect(r.passed).toBe(false);
  });

  it('runTieredLadder blocks too — the runner deliver actually wires', async () => {
    // A version that only touched runLadder passed 15 tests while doing
    // nothing in production, because this aggregator recomputes the verdict
    // from required rungs and a demoted rung is required:false.
    const r = await runTieredLadder([demoted('slope::tests::was_green', ['slope::tests::was_green'])], dir, {});
    expect(r.passed).toBe(false);
    expect(r.feedback).toMatch(/REGRESSION/);
    expect(r.feedback).toMatch(/slope::tests::was_green/);
  });

  it('runTieredLadder still passes when only the pre-existing failures remain', async () => {
    const r = await runTieredLadder([demoted('slope::tests::always_red', ['slope::tests::was_green'])], dir, {});
    expect(r.passed).toBe(true);
    expect(r.feedback).not.toMatch(/REGRESSION/);
  });

  it('does not tell the model a blocking rung is optional', async () => {
    // formatFeedback's optional branch says "OPTIONAL — do not prioritize it"
    // and withholds the tail. Both are wrong for breakage it just caused.
    const r = await runTieredLadder([demoted('slope::tests::was_green', ['slope::tests::was_green'])], dir, {});
    expect(r.feedback).not.toMatch(/Do not prioritize it/);
  });
});

describe('the gaps the second review found', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'uap-ns2-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('does not flag a name that also passes somewhere in the same run', () => {
    // `cargo test --workspace` prints `test tests::foo ... ok` with NO crate
    // qualifier, so two crates collide. If the name is green somewhere, it is
    // not evidence this mission broke anything — otherwise the only way to
    // clear the block is to fix the pre-existing failure, the exact wedge
    // demotion exists to remove.
    const both = 'test tests::foo ... ok\ntest tests::foo ... FAILED';
    expect(regressedTests(rung(['tests::foo']), failed(both))).toEqual([]);
  });

  it('captures the baseline set END TO END, through the real runner', () => {
    // The capture side was entirely untested; mutating it to [] passed the
    // whole suite. This drives demoteBaselineFailures against a real process.
    const src: GateRung = {
      id: 'cargo-test',
      name: 'Tests',
      command: 'bash',
      args: ['-c', 'echo "test a::green ... ok"; echo "test a::red ... FAILED"; exit 101'],
      required: true,
      timeoutMs: 10_000,
      tier: 'fast',
    };
    const bd = demoteBaselineFailures([src], dir);
    expect(bd.demoted.map((d) => d.id)).toEqual(['cargo-test']);
    expect(bd.rungs[0].required).toBe(false);
    expect(bd.rungs[0].baselinePassing).toEqual(['a::green']);
  });

  it('survives a suite whose per-test lines are far above the tail window', async () => {
    // The size-dependent bug: per-test lines sit ABOVE the panic bodies, so a
    // 2KB tail retains none of them on a real suite. Parsing must happen on the
    // full output, not the tail. 300 tests + 8KB of trailing noise.
    const script = [
      'for i in $(seq 1 300); do echo "test bulk::t$i ... ok"; done',
      'echo "test bulk::t1 ... FAILED"',
      'head -c 8000 /dev/zero | tr "\\0" "x"',
      'echo',
      'echo "test result: FAILED. 300 passed; 1 failed;"',
      'exit 101',
    ].join('; ');
    const src: GateRung = {
      id: 'cargo-test', name: 'Tests', command: 'bash', args: ['-c', script],
      required: true, timeoutMs: 20_000, tier: 'fast',
    };
    const bd = demoteBaselineFailures([src], dir);
    // The baseline still sees the early names despite the trailing noise.
    expect(bd.rungs[0].baselinePassing).toContain('bulk::t250');

    // And a later turn still detects the regression on one of them.
    const breaks: GateRung = {
      ...bd.rungs[0],
      args: ['-c', 'echo "test bulk::t250 ... FAILED"; head -c 8000 /dev/zero | tr "\\0" "x"; echo; exit 101'],
    };
    const r = await runTieredLadder([breaks], dir, {});
    expect(r.passed).toBe(false);
    expect(r.feedback).toMatch(/bulk::t250/);
  }, 60_000);

  it('does not read build noise as test outcomes for a non-test rung', () => {
    // `✓ 34 modules transformed.` from vite, `×` diagnostics from oxlint.
    const noise = '✓ 34 modules transformed.\n× unused variable';
    expect(parseTestOutcomes(noise, 'lint')).toBeNull();
    expect(parseTestOutcomes(noise, 'build')).toBeNull();
  });

  it('ignores vitest FILE-level summary lines, which are not tests', () => {
    const o = parseTestOutcomes('✓ test/foo.test.ts (12 tests) 34ms\n✓ adds numbers', 'vitest');
    expect([...o!.passed]).toEqual(['adds numbers']);
  });
});

describe('what a regression does to tier promotion and to keep-best', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'uap-ns3-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const regressed = (): GateRung => ({
    id: 'cargo-test',
    name: 'Tests [pre-existing failure at baseline — non-blocking]',
    command: 'bash',
    args: ['-c', 'echo "test a::was_green ... FAILED"; exit 101'],
    required: false,
    timeoutMs: 10_000,
    tier: 'fast',
    baselinePassing: ['a::was_green'],
  });

  it('DEFERS the costly tiers rather than running them on a doomed turn', async () => {
    const marker = join(dir, 'integration-ran');
    const integration: GateRung = {
      id: 'itest', name: 'Integration', command: 'bash', args: ['-c', `touch ${marker}`],
      required: true, timeoutMs: 10_000, tier: 'integration',
    };
    const r = await runTieredLadder([regressed(), integration], dir, {});
    expect(r.passed).toBe(false);
    expect(existsSync(marker)).toBe(false); // containers/deploy never brought up
  }, 30_000);

  it('still runs the runtime tier — the execution gate must not be starved', async () => {
    // COSTLY_TIERS is deliberately only {integration, deploy-dev}: deferring
    // runtime/final "re-starves exactly what blocksPromotion unstarved". A
    // regression can persist for turns, and the model still needs to know
    // whether the artifact runs while it fixes it.
    const marker = join(dir, 'runtime-ran');
    const runtime: GateRung = {
      id: 'exec', name: 'Execution', command: 'bash', args: ['-c', `touch ${marker}`],
      required: true, timeoutMs: 10_000, tier: 'runtime',
    };
    await runTieredLadder([regressed(), runtime], dir, {});
    expect(existsSync(marker)).toBe(true);
  }, 30_000);

  it('records the known limit: score alone cannot see a name-level regression', async () => {
    // A demoted rung is red before AND after, so score is identical either way.
    // This is why --keep-best consults regressedTests directly rather than
    // comparing scores; pinning it so the next reader does not re-derive it.
    const clean: GateRung = { ...regressed(), baselinePassing: ['someone::else'] };
    const a = await runTieredLadder([regressed()], dir, {});
    const b = await runTieredLadder([clean], dir, {});
    expect(a.score).toBe(b.score);   // identical score...
    expect(a.passed).toBe(false);    // ...but only one is a regression
    expect(b.passed).toBe(true);
  }, 30_000);

  it('does not record an ambiguous baseline name as green', () => {
    // Printed BOTH ok and FAILED at baseline (two crates, same unqualified
    // name). Recording it as green would report a regression forever, clearable
    // only by fixing the pre-existing failure — the wedge demotion removes.
    const src: GateRung = {
      id: 'cargo-test', name: 'Tests', command: 'bash',
      args: ['-c', 'echo "test tests::foo ... ok"; echo "test tests::foo ... FAILED"; exit 101'],
      required: true, timeoutMs: 10_000, tier: 'fast',
    };
    const bd = demoteBaselineFailures([src], dir);
    expect(bd.rungs[0].baselinePassing ?? []).not.toContain('tests::foo');
  });
});
