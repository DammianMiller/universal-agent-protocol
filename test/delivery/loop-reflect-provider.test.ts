import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ConvergenceLoop } from '../../src/delivery/convergence-loop.js';
import type { GateRung, LadderResult } from '../../src/delivery/verifier-ladder.js';

function stubRungs(): GateRung[] {
  return [{ id: 'test', name: 'test', command: 'node', args: ['-e', ''], required: true, timeoutMs: 1000 }];
}
function ladderResult(passed: boolean): LadderResult {
  return {
    passed,
    score: 0.5,
    feedback: 'gate feedback',
    results: [{ id: 'test', name: 'test', passed, skipped: false, exitCode: passed ? 0 : 1, durationMs: 1, outputTail: 'fail' }],
  };
}
const FILE_BLOCK_OUTPUT = '```file:src/fix.ts\nexport const fixed = true;\n```';

describe('ConvergenceLoop — reflectProvider (async GEPA reflect turn)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uap-reflect-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('awaits reflectProvider on requestReflect and applies the rewrite to later turns', async () => {
    const seen: string[] = [];
    let reflectCalls = 0;
    const loop = new ConvergenceLoop(
      {
        projectRoot: dir,
        maxTurns: 3,
        rungs: stubRungs(),
        baselineCheck: false,
        onIteration: (rec) => (rec.turn === 1 ? { requestReflect: true } : undefined),
        reflectProvider: async (instruction) => {
          reflectCalls++;
          return `REFLECTED(${instruction})`;
        },
      },
      async () => FILE_BLOCK_OUTPUT,
      {
        ladderRunner: () => ladderResult(false),
        promptBuilder: (ctx) => {
          seen.push(ctx.instruction);
          return ctx.instruction;
        },
      }
    );
    await loop.deliver('ORIGINAL');
    expect(reflectCalls).toBe(1);
    expect(seen[0]).toBe('ORIGINAL');
    expect(seen.slice(1).every((s) => s === 'REFLECTED(ORIGINAL)')).toBe(true);
  });

  it('mutateInstruction WINS over reflect when a directive carries both', async () => {
    const seen: string[] = [];
    let reflectCalls = 0;
    const loop = new ConvergenceLoop(
      {
        projectRoot: dir,
        maxTurns: 3,
        rungs: stubRungs(),
        baselineCheck: false,
        onIteration: (rec) =>
          rec.turn === 1 ? { requestReflect: true, mutateInstruction: 'SYNC WINS' } : undefined,
        reflectProvider: async () => {
          reflectCalls++;
          return 'ASYNC LOSES';
        },
      },
      async () => FILE_BLOCK_OUTPUT,
      {
        ladderRunner: () => ladderResult(false),
        promptBuilder: (ctx) => {
          seen.push(ctx.instruction);
          return ctx.instruction;
        },
      }
    );
    await loop.deliver('ORIGINAL');
    expect(reflectCalls).toBe(0); // reflect skipped because mutate was present
    expect(seen.slice(1).every((s) => s === 'SYNC WINS')).toBe(true);
  });

  it('is fail-soft: an undefined/throwing provider keeps the instruction', async () => {
    const seen: string[] = [];
    const loop = new ConvergenceLoop(
      {
        projectRoot: dir,
        maxTurns: 2,
        rungs: stubRungs(),
        baselineCheck: false,
        onIteration: () => ({ requestReflect: true }),
        reflectProvider: async () => undefined, // no rewrite
      },
      async () => FILE_BLOCK_OUTPUT,
      {
        ladderRunner: () => ladderResult(false),
        promptBuilder: (ctx) => {
          seen.push(ctx.instruction);
          return ctx.instruction;
        },
      }
    );
    await loop.deliver('UNCHANGED');
    expect(seen.every((s) => s === 'UNCHANGED')).toBe(true);
  });
});
