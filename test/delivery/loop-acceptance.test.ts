import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ConvergenceLoop } from '../../src/delivery/convergence-loop.js';
import type { GateRung, LadderResult } from '../../src/delivery/verifier-ladder.js';

function stubRungs(): GateRung[] {
  return [{ id: 'test', name: 'test', command: 'node', args: ['-e', ''], required: true, timeoutMs: 1000 }];
}
function ladderResult(score: number, passed: boolean, feedback = 'gate feedback'): LadderResult {
  return {
    passed,
    score,
    feedback,
    results: [{ id: 'test', name: 'test', passed, skipped: false, exitCode: passed ? 0 : 1, durationMs: 1, outputTail: passed ? '' : 'fail' }],
  };
}
const FILE_BLOCK_OUTPUT = '```file:src/fix.ts\nexport const fixed = true;\n```';

describe('ConvergenceLoop — acceptance gate integration', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uap-acc-loop-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('keeps iterating while acceptance fails (objective gates already green), then succeeds when it passes', async () => {
    let accCalls = 0;
    const loop = new ConvergenceLoop(
      { projectRoot: dir, maxTurns: 5, rungs: stubRungs(), baselineCheck: false },
      async () => FILE_BLOCK_OUTPUT,
      {
        ladderRunner: () => ladderResult(1.0, true), // objective always passes
        acceptanceGate: async () =>
          ++accCalls >= 3 ? { passed: true, feedback: '' } : { passed: false, feedback: 'ACCEPTANCE GAPS: add a boss every 5 levels' },
      }
    );
    const result = await loop.deliver('build a game with a boss every 5 levels');
    expect(result.success).toBe(true);
    expect(result.turns).toBe(3); // acceptance drove 2 extra turns past objective-green
    expect(accCalls).toBe(3);
    expect(result.history[0].passed).toBe(false); // acceptance flipped the green turn to not-passed
  });

  it('does NOT judge acceptance while objective gates fail (no wasted model calls on broken code)', async () => {
    let accCalls = 0;
    const loop = new ConvergenceLoop(
      { projectRoot: dir, maxTurns: 2, rungs: stubRungs(), baselineCheck: false },
      async () => FILE_BLOCK_OUTPUT,
      {
        ladderRunner: () => ladderResult(0.5, false), // never passes
        acceptanceGate: async () => {
          accCalls++;
          return { passed: false, feedback: 'gaps' };
        },
      }
    );
    const result = await loop.deliver('x');
    expect(result.success).toBe(false);
    expect(accCalls).toBe(0); // acceptance only runs after objective gates pass
  });

  it('fails OPEN: an acceptance gate that throws never blocks an objective-green delivery', async () => {
    const loop = new ConvergenceLoop(
      { projectRoot: dir, maxTurns: 3, rungs: stubRungs(), baselineCheck: false },
      async () => FILE_BLOCK_OUTPUT,
      {
        ladderRunner: () => ladderResult(1.0, true),
        acceptanceGate: async () => {
          throw new Error('judge unavailable');
        },
      }
    );
    const result = await loop.deliver('x');
    expect(result.success).toBe(true);
    expect(result.turns).toBe(1); // succeeded immediately despite the judge erroring
  });

  it('explorer mode: acceptance runs ONCE per turn (on the winner), not per candidate', async () => {
    let accCalls = 0;
    const loop = new ConvergenceLoop(
      { projectRoot: dir, maxTurns: 1, rungs: stubRungs(), baselineCheck: false, explorer: { candidates: 3 } },
      async () => FILE_BLOCK_OUTPUT,
      {
        ladderRunner: () => ladderResult(1.0, true),
        acceptanceGate: async () => {
          accCalls++;
          return { passed: true, feedback: '' };
        },
      }
    );
    const result = await loop.deliver('x');
    expect(result.success).toBe(true);
    expect(accCalls).toBe(1); // once for the committed winner — NOT 3 (per candidate)
  });

  it('untilDelivered: acceptance progress resets stagnation so multi-criterion specs complete', async () => {
    // Objective gates always green (score pinned 1.0); only acceptance improves.
    // Without the acceptance-aware stagnation reset, the loop would stop ~4 turns
    // after objective-green; here acceptance passes only at turn 6.
    let turn = 0;
    const fractions = [0.16, 0.33, 0.5, 0.66, 0.83, 1.0];
    const loop = new ConvergenceLoop(
      { projectRoot: dir, maxTurns: 1, maxTurnsCeiling: 12, rungs: stubRungs(), baselineCheck: false, untilDelivered: true },
      async () => FILE_BLOCK_OUTPUT,
      {
        ladderRunner: () => ladderResult(1.0, true),
        acceptanceGate: async () => {
          const f = fractions[Math.min(turn, fractions.length - 1)];
          turn++;
          return f >= 1 ? { passed: true, feedback: '', score: 1 } : { passed: false, feedback: 'add more', score: f };
        },
      }
    );
    const result = await loop.deliver('multi-criterion spec');
    expect(result.success).toBe(true);
    expect(result.turns).toBe(6); // extended past STAGNATION_LIMIT because acceptance kept improving
    expect(result.history.at(-1)?.acceptanceMet).toBe(1);
  });

  it('succeeds on turn 1 when acceptance passes immediately', async () => {
    const loop = new ConvergenceLoop(
      { projectRoot: dir, maxTurns: 3, rungs: stubRungs(), baselineCheck: false },
      async () => FILE_BLOCK_OUTPUT,
      {
        ladderRunner: () => ladderResult(1.0, true),
        acceptanceGate: async () => ({ passed: true, feedback: '' }),
      }
    );
    const result = await loop.deliver('x');
    expect(result.success).toBe(true);
    expect(result.turns).toBe(1);
  });
});

describe('runAcceptanceDespiteLadder (max-fidelity vision convergence)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uap-acc-red-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('is OFF by default — a red ladder never reaches the judge', async () => {
    // The inverse of the test below. Pinning the default explicitly matters
    // because the whole flag is one boolean controlling a run mode.
    let accCalls = 0;
    const loop = new ConvergenceLoop(
      { projectRoot: dir, maxTurns: 2, rungs: stubRungs(), baselineCheck: false },
      async () => FILE_BLOCK_OUTPUT,
      {
        ladderRunner: () => ladderResult(0.5, false),
        acceptanceGate: async () => {
          accCalls++;
          return { passed: true, feedback: '' };
        },
      }
    );
    await loop.deliver('x');
    expect(accCalls).toBe(0);
  });

  it('ON: judges acceptance even while objective gates FAIL, and surfaces its feedback', async () => {
    let accCalls = 0;
    const loop = new ConvergenceLoop(
      {
        projectRoot: dir,
        maxTurns: 1,
        rungs: stubRungs(),
        baselineCheck: false,
        runAcceptanceDespiteLadder: true,
      },
      async () => FILE_BLOCK_OUTPUT,
      {
        ladderRunner: () => ladderResult(0.5, false),
        acceptanceGate: async () => {
          accCalls++;
          return { passed: false, feedback: 'VISION REVIEW FAILED — the rendered UI scores 3/10' };
        },
      }
    );
    const r = await loop.deliver('x');
    expect(accCalls).toBeGreaterThan(0);
    // Acceptance feedback is merged into the ladder feedback the operator/model
    // actually sees (IterationRecord carries no feedback field of its own).
    expect(r.finalFeedback).toContain('VISION REVIEW FAILED');
  });

  it('ON: a PASSING acceptance can never turn a red ladder into a delivery', async () => {
    // The safety invariant. "The judge said yes, so pass" is the refactor someone
    // reaches for once the flag's purpose is "let acceptance decide" — and it
    // would be a false-green delivery on failing objective gates.
    const loop = new ConvergenceLoop(
      {
        projectRoot: dir,
        maxTurns: 1,
        rungs: stubRungs(),
        baselineCheck: false,
        runAcceptanceDespiteLadder: true,
      },
      async () => FILE_BLOCK_OUTPUT,
      {
        ladderRunner: () => ladderResult(0.5, false),
        acceptanceGate: async () => ({ passed: true, feedback: '' }),
      }
    );
    const r = await loop.deliver('x');
    expect(r.success).toBe(false);
    expect(r.history[0].passed).toBe(false);
  });

  it('tells the gate whether the ladder passed, so it cannot claim gates are green on a red turn', async () => {
    const seen: Array<boolean | undefined> = [];
    const loop = new ConvergenceLoop(
      {
        projectRoot: dir,
        maxTurns: 1,
        rungs: stubRungs(),
        baselineCheck: false,
        runAcceptanceDespiteLadder: true,
      },
      async () => FILE_BLOCK_OUTPUT,
      {
        ladderRunner: () => ladderResult(0.5, false),
        acceptanceGate: async (_root, ctx) => {
          seen.push(ctx?.ladderPassed);
          return { passed: false, feedback: 'nope' };
        },
      }
    );
    await loop.deliver('x');
    expect(seen).toContain(false);
  });
});
