/**
 * Durable delivery runs: run-state persistence + convergence-loop
 * checkpoint/resume — an interrupted mission continues where it left off.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  saveRunState,
  loadRunState,
  newRunId,
  isValidRunId,
  deliverRunsDir,
  type DeliverRunState,
} from '../../src/delivery/run-state.js';
import { ConvergenceLoop, type LoopCheckpoint } from '../../src/delivery/convergence-loop.js';
import type { GateRung, LadderResult } from '../../src/delivery/verifier-ladder.js';

const RUNG: GateRung = {
  id: 'test',
  name: 'test',
  command: 'true',
  args: [],
  required: true,
  timeoutMs: 1000,
  tier: 'fast',
};

function ladder(passed: boolean): LadderResult {
  return {
    passed,
    score: passed ? 1 : 0,
    results: [{ rung: RUNG, passed, output: '', durationMs: 1 }],
    feedback: passed ? '' : 'GATE FAILED: test',
  } as unknown as LadderResult;
}

describe('run-state store', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uap-runstate-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function makeState(overrides: Partial<DeliverRunState> = {}): DeliverRunState {
    return {
      runId: newRunId(),
      instruction: 'build the thing',
      presetId: 'test-model',
      projectRoot: dir,
      status: 'running',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...overrides,
    };
  }

  it('round-trips a run state through save/load', () => {
    const state = makeState({
      checkpoint: {
        turn: 3,
        history: [],
        prevContext: { feedback: 'fix the tests' },
        bestSoFar: 0.5,
        bestAcceptance: -1,
        stagnantTurns: 1,
      },
    });
    expect(saveRunState(state)).toBe(true);
    const loaded = loadRunState(dir, state.runId);
    expect(loaded).not.toBeNull();
    expect(loaded!.instruction).toBe('build the thing');
    expect(loaded!.checkpoint!.turn).toBe(3);
    expect(loaded!.checkpoint!.prevContext.feedback).toBe('fix the tests');
    expect(existsSync(join(deliverRunsDir(dir), state.runId, 'state.json'))).toBe(true);
  });

  it("resolves 'latest' to the most recently updated non-delivered run", async () => {
    const a = makeState({ runId: 'run-a', status: 'interrupted' });
    saveRunState(a);
    await new Promise((r) => setTimeout(r, 10));
    const b = makeState({ runId: 'run-b', status: 'running' });
    saveRunState(b);
    const done = makeState({ runId: 'run-c', status: 'delivered' });
    saveRunState(done);

    const latest = loadRunState(dir, 'latest');
    expect(latest!.runId).toBe('run-b');
  });

  it('rejects path-traversal run ids', () => {
    expect(isValidRunId('../evil')).toBe(false);
    expect(isValidRunId('a/b')).toBe(false);
    expect(loadRunState(dir, '../evil')).toBeNull();
    expect(isValidRunId(newRunId())).toBe(true);
  });
});

describe('convergence loop checkpoint + resume', () => {
  it('emits a serializable checkpoint after every failed turn', async () => {
    const checkpoints: LoopCheckpoint[] = [];
    const loop = new ConvergenceLoop(
      {
        projectRoot: '/tmp',
        maxTurns: 2,
        rungs: [RUNG],
        baselineCheck: false,
        onCheckpoint: (cp) => checkpoints.push(cp),
      },
      async () => '```file:a.txt\nx\n```',
      {
        ladderRunner: () => ladder(false),
        applier: async () => ({ filesWritten: ['a.txt'], rejected: [] }),
      }
    );
    const result = await loop.deliver('do it');
    expect(result.success).toBe(false);
    expect(checkpoints.length).toBe(2);
    expect(checkpoints[1].turn).toBe(2);
    expect(checkpoints[1].history.length).toBe(2);
    // Serializable: survives a JSON round-trip intact.
    const revived = JSON.parse(JSON.stringify(checkpoints[1])) as LoopCheckpoint;
    expect(revived.prevContext.feedback).toContain('GATE FAILED');
  });

  it('resumes from a checkpoint: history restored, turns continue after it', async () => {
    const prompts: string[] = [];
    const resumeFrom: LoopCheckpoint = {
      turn: 2,
      history: [
        { turn: 1, passed: false, score: 0, gateResults: [], filesApplied: [], durationMs: 1 },
        { turn: 2, passed: false, score: 0, gateResults: [], filesApplied: [], durationMs: 1 },
      ],
      prevContext: { feedback: 'GATE FAILED: test — from the interrupted run' },
      bestSoFar: 0,
      bestAcceptance: -1,
      stagnantTurns: 1,
    };
    const loop = new ConvergenceLoop(
      {
        projectRoot: '/tmp',
        maxTurns: 2,
        rungs: [RUNG],
        baselineCheck: false,
        resumeFrom,
      },
      async (prompt) => {
        prompts.push(prompt);
        return '```file:a.txt\nfixed\n```';
      },
      {
        ladderRunner: () => ladder(true),
        applier: async () => ({ filesWritten: ['a.txt'], rejected: [] }),
      }
    );
    const result = await loop.deliver('do it');
    expect(result.success).toBe(true);
    // 2 restored + 1 live turn.
    expect(result.history.length).toBe(3);
    expect(result.history[2].turn).toBe(3);
    // The resumed turn's prompt carries the interrupted run's feedback.
    expect(prompts[0]).toContain('from the interrupted run');
    expect(prompts[0]).toContain('turn 2');
  });

  it('resume cannot exceed the until-delivered ceiling (hard cap across resumes)', async () => {
    const resumeFrom: LoopCheckpoint = {
      turn: 4,
      history: Array.from({ length: 4 }, (_, i) => ({
        turn: i + 1, passed: false, score: 0, gateResults: [], filesApplied: [], durationMs: 1,
      })),
      prevContext: {},
      bestSoFar: 0,
      bestAcceptance: -1,
      stagnantTurns: 0,
    };
    let liveTurns = 0;
    const loop = new ConvergenceLoop(
      {
        projectRoot: '/tmp',
        maxTurns: 5,
        maxTurnsCeiling: 6,
        untilDelivered: true,
        rungs: [RUNG],
        baselineCheck: false,
        resumeFrom,
      },
      async () => {
        liveTurns++;
        return '```file:a.txt\nx\n```';
      },
      {
        ladderRunner: () => ladder(false),
        applier: async () => ({ filesWritten: ['a.txt'], rejected: [] }),
      }
    );
    const result = await loop.deliver('do it');
    expect(result.success).toBe(false);
    // Budget would be 4+5=9 turns, but the ceiling (6) caps it: only 2 live turns.
    expect(liveTurns).toBe(2);
    expect(result.history.length).toBe(6);
  });

  it('regenerateSeeds never BOOTSTRAPS exploration on a non-explorer run', async () => {
    let executorCalls = 0;
    const loop = new ConvergenceLoop(
      {
        projectRoot: '/tmp',
        maxTurns: 2,
        rungs: [RUNG],
        baselineCheck: false,
        seedGenerator: async () => [
          { id: 'a', hint: 'STRATEGY: a' },
          { id: 'b', hint: 'STRATEGY: b' },
        ],
        onIteration: (r) => (r.turn === 1 ? { regenerateSeeds: true } : undefined),
      },
      async () => {
        executorCalls++;
        return '```file:a.txt\nx\n```';
      },
      {
        ladderRunner: () => ladder(false),
        applier: async () => ({ filesWritten: ['a.txt'], rejected: [] }),
      }
    );
    await loop.deliver('do it');
    // Two single-candidate turns — the reseed directive must NOT have spawned
    // a best-of-N explorer (which would multiply executor calls).
    expect(executorCalls).toBe(2);
  });

  it('checkpoints escalation state and restores it on resume (no silent de-escalation)', async () => {
    // Run 1: an onIteration directive escalates (widen + critic + model switch);
    // the next checkpoint must capture that state.
    const checkpoints: LoopCheckpoint[] = [];
    const strong = async (): Promise<string> => '```file:a.txt\nx\n```';
    const loop1 = new ConvergenceLoop(
      {
        projectRoot: '/tmp',
        maxTurns: 2,
        rungs: [RUNG],
        baselineCheck: false,
        criticFactory: () => async () => ({ fixList: ['fix it'] }),
        onIteration: (r) =>
          r.turn === 1 ? { setCandidates: 3, enableCritic: true, switchExecutor: strong } : undefined,
        onCheckpoint: (cp) => checkpoints.push(cp),
      },
      async () => '```file:a.txt\nx\n```',
      {
        ladderRunner: () => ladder(false),
        applier: async () => ({ filesWritten: ['a.txt'], rejected: [] }),
      }
    );
    await loop1.deliver('do it');
    const last = checkpoints[checkpoints.length - 1];
    expect(last.candidates).toBe(3);
    expect(last.criticEnabled).toBe(true);
    expect(last.modelEscalated).toBe(true);

    // Run 2 (resume): critic is re-enabled via the factory and the escalation
    // flags persist through the next checkpoint.
    let criticRebuilt = false;
    const checkpoints2: LoopCheckpoint[] = [];
    const loop2 = new ConvergenceLoop(
      {
        projectRoot: '/tmp',
        maxTurns: 1,
        rungs: [RUNG],
        baselineCheck: false,
        resumeFrom: last,
        criticFactory: () => {
          criticRebuilt = true;
          return async () => ({ fixList: [] });
        },
        onCheckpoint: (cp) => checkpoints2.push(cp),
      },
      async () => 'no file blocks here',
      {
        ladderRunner: () => ladder(false),
        applier: async () => ({ filesWritten: [], rejected: [] }),
      }
    );
    await loop2.deliver('do it');
    expect(criticRebuilt).toBe(true);
    expect(checkpoints2[checkpoints2.length - 1].modelEscalated).toBe(true);
  });
});

describe('round-3 run-state hardening', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uap-runstate-r3-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function makeState(overrides: Partial<DeliverRunState> = {}): DeliverRunState {
    return {
      runId: newRunId(),
      instruction: 'build the thing',
      presetId: 'test-model',
      projectRoot: dir,
      status: 'running',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...overrides,
    };
  }

  it('round-trips runnerKind and drops invalid values', () => {
    const base = makeState({ runnerKind: 'epic' });
    saveRunState(base);
    expect(loadRunState(dir, base.runId)?.runnerKind).toBe('epic');

    const bad = makeState({ runnerKind: 'hacked' as never });
    saveRunState(bad);
    expect(loadRunState(dir, bad.runId)?.runnerKind).toBeUndefined();
  });

  it('retains up to 20 phases (planner ceiling) — an 8-phase resume is no longer truncated to 5', () => {
    const phases = Array.from({ length: 8 }, (_, i) => ({ id: `p-${i}`, title: `P${i}`, goal: `g${i}` }));
    const st = makeState({ phases, phaseIndex: 6 });
    saveRunState(st);
    const loaded = loadRunState(dir, st.runId);
    expect(loaded?.phases).toHaveLength(8); // cursor 6 is executable again
  });

  it('round-trips deps/contracts/scaffold/criteria with re-validation', () => {
    const st = makeState({
      phases: [
        { id: 'contracts', title: 'C', goal: 'g', contracts: true, criteria: ['  compiles  ', 'x'.repeat(500)] },
        { id: 'impl', title: 'I', goal: 'g', deps: ['contracts', '../evil', 'contracts'], scaffold: true },
      ],
    });
    saveRunState(st);
    const loaded = loadRunState(dir, st.runId)!;
    expect(loaded.phases?.[0].contracts).toBe(true);
    expect(loaded.phases?.[0].criteria).toEqual(['compiles', 'x'.repeat(200)]);
    expect(loaded.phases?.[1].scaffold).toBe(true);
    expect(loaded.phases?.[1].deps).toEqual(['contracts', 'contracts']); // invalid id filtered
  });

  it('drops an out-of-range phaseIndex — a planted cursor must not skip the loop into vacuous success', () => {
    const phases = Array.from({ length: 3 }, (_, i) => ({ id: `p-${i}`, title: `P${i}`, goal: `g${i}` }));
    const st = makeState({ phases, phaseIndex: 999 });
    saveRunState(st);
    expect(loadRunState(dir, st.runId)?.phaseIndex).toBeUndefined();

    const neg = makeState({ phases, phaseIndex: -1 });
    saveRunState(neg);
    expect(loadRunState(dir, neg.runId)?.phaseIndex).toBeUndefined();

    const frac = makeState({ phases, phaseIndex: 1.5 });
    saveRunState(frac);
    expect(loadRunState(dir, frac.runId)?.phaseIndex).toBeUndefined();
  });

  it('keeps a valid in-range phaseIndex, and allows only 0 when no phase plan exists', () => {
    const phases = Array.from({ length: 3 }, (_, i) => ({ id: `p-${i}`, title: `P${i}`, goal: `g${i}` }));
    const st = makeState({ phases, phaseIndex: 2 });
    saveRunState(st);
    expect(loadRunState(dir, st.runId)?.phaseIndex).toBe(2);

    const noPlanOk = makeState({ phaseIndex: 0 });
    saveRunState(noPlanOk);
    expect(loadRunState(dir, noPlanOk.runId)?.phaseIndex).toBe(0);

    const noPlanBad = makeState({ phaseIndex: 2 });
    saveRunState(noPlanBad);
    expect(loadRunState(dir, noPlanBad.runId)?.phaseIndex).toBeUndefined();
  });

  it('round-trips completedEpicIds, filtering junk ids (epic resume skip set)', () => {
    const st = makeState({
      runnerKind: 'epic',
      completedEpicIds: ['auth', 'big.p1', '../evil', 'UPPER', 'x'.repeat(80)],
    } as never);
    saveRunState(st);
    const loaded = loadRunState(dir, st.runId)!;
    expect(loaded.completedEpicIds).toEqual(['auth', 'big.p1']);
  });
});
