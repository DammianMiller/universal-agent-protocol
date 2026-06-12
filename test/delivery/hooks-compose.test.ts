import { describe, it, expect } from 'vitest';
import { composeIterationHooks } from '../../src/delivery/convergence-loop.js';
import type { IterationRecord, LoopExecutor } from '../../src/delivery/convergence-loop.js';

const RECORD: IterationRecord = {
  turn: 1,
  passed: false,
  score: 0,
  gateResults: [],
  filesApplied: [],
  durationMs: 1,
};

describe('composeIterationHooks', () => {
  it('runs all hooks in order and skips undefined entries', () => {
    const calls: string[] = [];
    const hook = composeIterationHooks(
      () => {
        calls.push('a');
      },
      undefined,
      () => {
        calls.push('b');
      }
    );
    hook(RECORD);
    expect(calls).toEqual(['a', 'b']);
  });

  it("ORs stop (including the legacy 'stop' string) across hooks", () => {
    const hook = composeIterationHooks(
      () => undefined,
      () => 'stop' as const
    );
    expect(hook(RECORD)).toMatchObject({ stop: true });
  });

  it('merges directives: max raiseMaxTurns, last setCandidates/executor, joined notes', () => {
    const exec: LoopExecutor = async () => 'x';
    const hook = composeIterationHooks(
      () => ({ raiseMaxTurns: 8, setCandidates: 2, note: 'widen' }),
      () => ({ raiseMaxTurns: 6, setCandidates: 4, enableCritic: true, switchExecutor: exec, note: 'escalate' })
    );
    const merged = hook(RECORD);
    expect(merged).toMatchObject({
      raiseMaxTurns: 8,
      setCandidates: 4,
      enableCritic: true,
      note: 'widen; escalate',
    });
    expect((merged as { switchExecutor?: LoopExecutor }).switchExecutor).toBe(exec);
  });

  it('returns an empty directive when no hook steers the loop', () => {
    const hook = composeIterationHooks(() => undefined);
    expect(hook(RECORD)).toEqual({});
  });

  it('isolates a throwing hook: later hooks still run and directives survive', () => {
    const calls: string[] = [];
    const hook = composeIterationHooks(
      () => {
        throw new Error('observer exploded');
      },
      () => {
        calls.push('after');
        return { raiseMaxTurns: 7 };
      }
    );
    expect(hook(RECORD)).toMatchObject({ raiseMaxTurns: 7 });
    expect(calls).toEqual(['after']);
  });
});
