import { describe, it, expect } from 'vitest';
import {
  runTieredLadder,
  type GateRung,
  type GateTier,
  type LadderResult,
} from '../../src/delivery/verifier-ladder.js';

function rung(id: string, tier?: GateTier, required = true): GateRung {
  return { id, name: id, command: 'true', args: [], required, timeoutMs: 1000, tier };
}

/** Fake per-tier runner: rungs whose id is in `pass` pass; records each call. */
function fakeRunner(pass: Set<string>, calls: string[][]) {
  return (rungs: GateRung[]): LadderResult => {
    calls.push(rungs.map((r) => r.id));
    const results = rungs.map((r) => ({
      id: r.id,
      name: r.name,
      passed: pass.has(r.id),
      skipped: false,
      exitCode: pass.has(r.id) ? 0 : 1,
      durationMs: 1,
      outputTail: pass.has(r.id) ? '' : 'fail',
    }));
    const passed = rungs.filter((r) => r.required).every((r) => pass.has(r.id));
    return { passed, score: results.filter((r) => r.passed).length / results.length, results, feedback: '' };
  };
}

describe('runTieredLadder', () => {
  it('promotes cheapest tier first and skips later tiers when a cheaper tier fails', async () => {
    const calls: string[][] = [];
    const rungs = [rung('build', 'fast'), rung('itest', 'integration'), rung('smoke', 'deploy-dev')];
    const result = await runTieredLadder(rungs, '/tmp', {
      runner: fakeRunner(new Set([/* build fails */]), calls),
    });

    // Only the fast tier ran; integration/deploy-dev were never executed.
    expect(calls).toEqual([['build']]);
    expect(result.passed).toBe(false);
    expect(result.results.find((r) => r.id === 'itest')?.skipped).toBe(true);
    expect(result.results.find((r) => r.id === 'smoke')?.skipped).toBe(true);
  });

  it('runs every in-scope tier when each prior tier passes', async () => {
    const calls: string[][] = [];
    const rungs = [rung('build', 'fast'), rung('itest', 'integration'), rung('smoke', 'deploy-dev')];
    const result = await runTieredLadder(rungs, '/tmp', {
      runner: fakeRunner(new Set(['build', 'itest', 'smoke']), calls),
    });

    expect(calls).toEqual([['build'], ['itest'], ['smoke']]);
    expect(result.passed).toBe(true);
  });

  it('respects maxTier: integration and above are not run locally', async () => {
    const calls: string[][] = [];
    const rungs = [rung('build', 'fast'), rung('itest', 'integration')];
    const result = await runTieredLadder(rungs, '/tmp', {
      maxTier: 'fast',
      runner: fakeRunner(new Set(['build', 'itest']), calls),
    });

    expect(calls).toEqual([['build']]);
    // Out-of-scope rung is skipped and does NOT block delivery.
    expect(result.results.find((r) => r.id === 'itest')?.skipped).toBe(true);
    expect(result.passed).toBe(true);
  });

  it('never runs ci/staging/prod tiers locally even at the default ceiling', async () => {
    const calls: string[][] = [];
    const rungs = [rung('build', 'fast'), rung('ci', 'ci'), rung('prod', 'deploy-prod')];
    const result = await runTieredLadder(rungs, '/tmp', {
      runner: fakeRunner(new Set(['build']), calls),
    });

    expect(calls).toEqual([['build']]); // ci/prod never executed
    expect(result.passed).toBe(true); // remote tiers don't gate the local result
    expect(result.results.find((r) => r.id === 'ci')?.skipped).toBe(true);
  });

  it('treats rungs without a tier as fast (back-compat)', async () => {
    const calls: string[][] = [];
    const rungs = [rung('legacy', undefined), rung('itest', 'integration')];
    await runTieredLadder(rungs, '/tmp', { runner: fakeRunner(new Set(['legacy', 'itest']), calls) });

    // The untiered rung ran in the first (fast) tier.
    expect(calls[0]).toEqual(['legacy']);
  });

  it('computes score over in-scope rungs only (out-of-scope skips do not dilute it)', async () => {
    const calls: string[][] = [];
    // One fast rung that passes, plus ci/prod rungs that are never run locally.
    const rungs = [rung('build', 'fast'), rung('ci', 'ci'), rung('prod', 'deploy-prod')];
    const result = await runTieredLadder(rungs, '/tmp', {
      runner: fakeRunner(new Set(['build']), calls),
    });
    // Score must be 1 (the only in-scope rung passed), not 1/3.
    expect(result.score).toBe(1);
  });

  it('uses deployDevRunner for the deploy-dev tier and the default runner otherwise', async () => {
    const mainCalls: string[][] = [];
    const deployCalls: string[][] = [];
    const rungs = [rung('build', 'fast'), rung('smoke', 'deploy-dev')];
    await runTieredLadder(rungs, '/tmp', {
      runner: fakeRunner(new Set(['build', 'smoke']), mainCalls),
      deployDevRunner: fakeRunner(new Set(['smoke']), deployCalls),
    });

    expect(mainCalls).toEqual([['build']]);
    expect(deployCalls).toEqual([['smoke']]);
  });
});

describe('blocksPromotion — a synthetic rung must not starve the real gates', () => {
  it('a failing NON-blocking rung still runs later tiers', async () => {
    // The self-gate is model-authored and untiered, so it lands in `fast`. While
    // red it used to stop promotion, starving the execution gate (runtime) and
    // the user-path validator (final) at the same time — and that is the STEADY
    // STATE for a mature repo, because needsSelfGate is raised precisely when the
    // project's own gates are all green.
    const calls: string[][] = [];
    const synthetic: GateRung = {
      id: 'acceptance',
      name: 'acceptance',
      command: 'true',
      args: [],
      required: true,
      timeoutMs: 1000,
      blocksPromotion: false,
    };
    const result = await runTieredLadder(
      [synthetic, rung('execution', 'runtime'), rung('user-paths', 'final')],
      '/tmp',
      { runner: fakeRunner(new Set(['execution', 'user-paths']), calls) }
    );

    // Every tier ran despite the red synthetic rung.
    expect(calls.flat()).toContain('execution');
    expect(calls.flat()).toContain('user-paths');
    // …and it still fails the ladder: not promotion-blocking is not a free pass.
    expect(result.passed).toBe(false);
    expect(result.results.find((r) => r.id === 'execution')?.passed).toBe(true);
  });

  it('a failing BLOCKING rung still stops promotion (default unchanged)', async () => {
    const calls: string[][] = [];
    const result = await runTieredLadder(
      [rung('build'), rung('execution', 'runtime')],
      '/tmp',
      { runner: fakeRunner(new Set(['execution']), calls) }
    );
    expect(calls.flat()).not.toContain('execution');
    expect(result.passed).toBe(false);
  });

  it('an OPTIONAL non-blocking rung does not stop promotion either', async () => {
    const calls: string[][] = [];
    await runTieredLadder([rung('lint', 'fast', false), rung('execution', 'runtime')], '/tmp', {
      runner: fakeRunner(new Set(['execution']), calls),
    });
    expect(calls.flat()).toContain('execution');
  });
});

describe('blocksPromotion — intra-tier fail-fast must not starve either', () => {
  it('a red synthetic rung does not skip the rungs ordered AFTER it in its own tier', async () => {
    // The from-scratch shape: detectRungs finds nothing, so the self-gate is
    // pushed first; turn 1 writes package.json and redetect APPENDS build/test
    // after it. A red self-gate used to mark both `skipped` every single turn.
    const { runLadder } = await import('../../src/delivery/verifier-ladder.js');
    const synthetic: GateRung = {
      id: 'acceptance',
      name: 'acceptance',
      command: 'false',
      args: [],
      required: true,
      timeoutMs: 5000,
      blocksPromotion: false,
    };
    const real: GateRung = {
      id: 'build',
      name: 'build',
      command: 'true',
      args: [],
      required: true,
      timeoutMs: 5000,
    };
    const r = await runLadder([synthetic, real], process.cwd());
    const build = r.results.find((x) => x.id === 'build');
    expect(build?.skipped).toBe(false);
    expect(build?.passed).toBe(true);
    expect(r.passed).toBe(false); // the synthetic rung still fails the ladder
  });

  it('a red ORDINARY rung still fail-fasts the rest of its tier', async () => {
    const { runLadder } = await import('../../src/delivery/verifier-ladder.js');
    const first: GateRung = { id: 'build', name: 'build', command: 'false', args: [], required: true, timeoutMs: 5000 };
    const second: GateRung = { id: 'test', name: 'test', command: 'true', args: [], required: true, timeoutMs: 5000 };
    const r = await runLadder([first, second], process.cwd());
    expect(r.results.find((x) => x.id === 'test')?.skipped).toBe(true);
  });
});
