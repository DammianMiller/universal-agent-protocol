import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ConvergenceLoop } from '../../src/delivery/convergence-loop.js';
import type { GateRung, LadderResult } from '../../src/delivery/verifier-ladder.js';

function stubRungs(): GateRung[] {
  return [{ id: 'test', name: 'test', command: 'node', args: ['-e', ''], required: true, timeoutMs: 1000 }];
}
function ladderResult(score: number, passed: boolean): LadderResult {
  return {
    passed,
    score,
    feedback: 'gate feedback',
    results: [{ id: 'test', name: 'test', passed, skipped: false, exitCode: passed ? 0 : 1, durationMs: 1, outputTail: passed ? '' : 'fail' }],
  };
}
const FILE_BLOCK_OUTPUT = '```file:src/fix.ts\nexport const fixed = true;\n```';

describe('ConvergenceLoop — GEPA reflect (mutateInstruction)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uap-mutate-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('feeds a reflected instruction rewrite to subsequent turns', async () => {
    const seen: string[] = [];
    const loop = new ConvergenceLoop(
      {
        projectRoot: dir,
        maxTurns: 3,
        rungs: stubRungs(),
        baselineCheck: false,
        // reflect after the first turn: rewrite the APPROACH for the next turn
        onIteration: (rec) => (rec.turn === 1 ? { mutateInstruction: 'REWRITTEN APPROACH' } : undefined),
      },
      async () => FILE_BLOCK_OUTPUT,
      {
        ladderRunner: () => ladderResult(0.5, false), // never passes → runs to maxTurns
        promptBuilder: (ctx) => {
          seen.push(ctx.instruction);
          return ctx.instruction;
        },
      }
    );

    await loop.deliver('ORIGINAL APPROACH');

    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen[0]).toBe('ORIGINAL APPROACH'); // turn 1 uses the original
    // every turn after the reflect uses the rewrite
    expect(seen.slice(1).every((s) => s === 'REWRITTEN APPROACH')).toBe(true);
  });

  it('leaves the instruction unchanged when no reflect directive is issued', async () => {
    const seen: string[] = [];
    const loop = new ConvergenceLoop(
      { projectRoot: dir, maxTurns: 2, rungs: stubRungs(), baselineCheck: false },
      async () => FILE_BLOCK_OUTPUT,
      {
        ladderRunner: () => ladderResult(0.5, false),
        promptBuilder: (ctx) => {
          seen.push(ctx.instruction);
          return ctx.instruction;
        },
      }
    );
    await loop.deliver('STAYS THE SAME');
    expect(seen.every((s) => s === 'STAYS THE SAME')).toBe(true);
  });
});
