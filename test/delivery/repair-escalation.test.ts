import { describe, it, expect } from 'vitest';
import {
  extractCompileErrorCount,
  createRepairEscalation,
} from '../../src/delivery/repair-escalation.js';
import type { IterationRecord } from '../../src/delivery/convergence-loop.js';

function rec(turn: number, tail: string): IterationRecord {
  return {
    turn,
    passed: false,
    score: 0.3,
    gateResults: [
      { id: 'check', name: 'check', passed: false, skipped: false, exitCode: 1, durationMs: 1, outputTail: tail },
    ],
    filesApplied: ['src/a.rs'],
  } as IterationRecord;
}

const errs = (n: number) => `error: could not compile \`x\` (lib) due to ${n} previous errors`;

describe('extractCompileErrorCount', () => {
  it("prefers cargo's own total", () => {
    expect(extractCompileErrorCount('error[E0425]: x\nerror[E0433]: y\n' + errs(47))).toBe(47);
  });
  it('counts cargo/tsc/generic error lines when no total is present', () => {
    expect(extractCompileErrorCount('error[E0425]: a\nerror[E0308]: b')).toBe(2);
    expect(extractCompileErrorCount('x.ts(3,1): error TS2304: y\nz.ts(9,2): error TS2551: w')).toBe(2);
    expect(extractCompileErrorCount('warning: unused import')).toBe(0);
  });
});

describe('createRepairEscalation', () => {
  it('trips on growth across turns above the floor, one-shot repairs, then delegates', async () => {
    const calls: string[] = [];
    const ctl = createRepairEscalation({
      minErrors: 10,
      growthTurns: 2,
      cooldownTurns: 3,
      runRepair: async (_tail, n) => {
        calls.push(`repair:${n}`);
        return 'repaired';
      },
      originalExecutor: async (p) => {
        calls.push('original');
        return `orig:${p}`;
      },
    });
    expect(ctl.onIteration(rec(1, errs(20))).switchExecutor).toBeUndefined(); // first sighting: no growth yet
    const d2 = ctl.onIteration(rec(2, errs(45))); // grew 20 -> 45: streak 1 = growthTurns-1 → trip
    expect(d2.switchExecutor).toBeDefined();
    expect(ctl.repairCount()).toBe(1);
    // The one-shot: first call runs the repair, later calls delegate.
    const exec = d2.switchExecutor!;
    expect(await exec('mission prompt')).toBe('repaired');
    expect(await exec('mission prompt')).toBe('orig:mission prompt');
    expect(calls).toEqual(['repair:45', 'original']);
  });

  it('ignores small or shrinking counts and respects cooldown + max repairs', () => {
    const ctl = createRepairEscalation({
      minErrors: 10,
      growthTurns: 2,
      cooldownTurns: 2,
      maxRepairs: 1,
      runRepair: async () => 'r',
      originalExecutor: async () => 'o',
    });
    expect(ctl.onIteration(rec(1, errs(3))).switchExecutor).toBeUndefined();
    expect(ctl.onIteration(rec(2, errs(5))).switchExecutor).toBeUndefined(); // grew but under floor
    expect(ctl.onIteration(rec(3, errs(15))).switchExecutor).toBeDefined(); // 5 -> 15 over floor
    // Growth continues but maxRepairs=1 → never again.
    expect(ctl.onIteration(rec(4, errs(30))).switchExecutor).toBeUndefined();
    expect(ctl.onIteration(rec(5, errs(60))).switchExecutor).toBeUndefined();
    expect(ctl.repairCount()).toBe(1);
  });

  it('a clean turn resets the growth streak', () => {
    const ctl = createRepairEscalation({
      minErrors: 10,
      growthTurns: 2,
      runRepair: async () => 'r',
      originalExecutor: async () => 'o',
    });
    ctl.onIteration(rec(1, errs(20)));
    ctl.onIteration(rec(2, '')); // gates green-ish: count 0 resets
    expect(ctl.onIteration(rec(3, errs(25))).switchExecutor).toBeUndefined(); // no prior nonzero → no growth streak
  });
});
