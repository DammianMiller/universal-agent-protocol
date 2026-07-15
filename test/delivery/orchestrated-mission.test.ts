/**
 * Orchestrated-mission runner (extracted from deliver.ts): THE wiring tests
 * the PR #516 review demanded — config-to-concurrency flow is now observable
 * (two READY tasks genuinely overlap), plus workspace lifecycle, merge
 * conflict → ATG repair convergence, fallback serialization, and post-merge
 * verification. All seams faked: no model, no git.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  runOrchestratedMission,
  foldDeliveryResult,
  type OrchestratedMissionDeps,
} from '../../src/delivery/orchestrated-mission.js';
import type { DeliveryResult } from '../../src/delivery/convergence-loop.js';
import type { TaskWorkspace, TaskWorkspaceManager } from '../../src/delivery/task-workspace.js';
import type { OrchestratorTask } from '../../src/delivery/task-orchestrator.js';

beforeEach(() => {
  delete process.env.UAP_ORCH_TASK_REPAIRS;
});
afterEach(() => {
  delete process.env.UAP_ORCH_TASK_REPAIRS;
});

const task = (id: string, deps?: string[]): OrchestratorTask => ({
  id,
  title: id,
  goal: `build ${id}`,
  ...(deps ? { deps } : {}),
});

const loopResult = (over: Partial<DeliveryResult> = {}): DeliveryResult => ({
  success: true,
  alreadyDelivered: false,
  turns: 1,
  bestScore: 1,
  bestTurn: 1,
  history: [],
  finalFeedback: '',
  finalOutput: '',
  totalDurationMs: 1,
  ...over,
});

interface FakeManagerState {
  acquired: string[];
  merges: string[];
  cleanups: string[];
  mergeOk: (taskId: string, call: number) => boolean;
  lastBlockedProbe?: string[];
}

function fakeManager(state: FakeManagerState): TaskWorkspaceManager {
  const mergeCalls = new Map<string, number>();
  return {
    acquire(taskId: string): TaskWorkspace | null {
      state.acquired.push(taskId);
      const root = `/ws/${taskId}/${state.acquired.length}`;
      return {
        root,
        mergeBack(isBlocked) {
          const call = (mergeCalls.get(taskId) ?? 0) + 1;
          mergeCalls.set(taskId, call);
          state.merges.push(taskId);
          if (isBlocked) {
            // Record that the boundary predicate reached the workspace.
            state.lastBlockedProbe = ['probe.ts'].filter((f) => isBlocked(f));
          }
          return state.mergeOk(taskId, call)
            ? { ok: true, files: ['out.ts'] }
            : { ok: false, files: [], reason: 'simulated conflict' };
        },
        cleanup() {
          state.cleanups.push(taskId);
        },
      };
    },
  };
}

function baseDeps(over: Partial<OrchestratedMissionDeps>): OrchestratedMissionDeps {
  return {
    instruction: 'mission',
    projectRoot: '/main',
    tasks: [task('a'), task('b')],
    parallelTasks: 1,
    workspaceManager: null,
    runLoop: async () => loopResult(),
    ...over,
  };
}

describe('config-to-concurrency wiring (the PR #516 regression)', () => {
  it('parallelTasks=2 with a workspace manager makes two READY tasks OVERLAP', async () => {
    const state: FakeManagerState = { acquired: [], merges: [], cleanups: [], mergeOk: () => true };
    const started: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    let release!: () => void;
    const gate = new Promise<void>((res) => {
      release = res;
    });
    // Timed fallback: if concurrency regresses to sequential, the gate never
    // releases — fail on the maxInFlight ASSERTION below, not a 5s hang.
    const gateOrTimeout = Promise.race([gate, new Promise<void>((res) => setTimeout(res, 1500))]);
    const r = await runOrchestratedMission(
      baseDeps({
        tasks: [task('a'), task('b'), task('join', ['a', 'b'])],
        parallelTasks: 2,
        workspaceManager: fakeManager(state),
        runLoop: async ({ taskId }) => {
          if (taskId !== 'join') {
            inFlight++;
            maxInFlight = Math.max(maxInFlight, inFlight);
            started.push(taskId);
            if (started.length === 2) release(); // both in flight AT ONCE
            await gateOrTimeout; // neither finishes until both started (or the fallback fires)
            inFlight--;
          } else {
            // the dependent only runs after BOTH deps merged
            expect(started.sort()).toEqual(['a', 'b']);
          }
          return loopResult();
        },
      })
    );
    expect(r.success).toBe(true);
    expect(maxInFlight).toBe(2); // THE #516 regression assertion
    // every isolated workspace merged and was cleaned up
    expect(state.merges.sort()).toEqual(['a', 'b', 'join']);
    expect(state.cleanups.length).toBe(3);
  });

  it('parallelTasks=1 never touches the workspace manager and runs in the project root', async () => {
    const state: FakeManagerState = { acquired: [], merges: [], cleanups: [], mergeOk: () => true };
    const roots: string[] = [];
    await runOrchestratedMission(
      baseDeps({
        parallelTasks: 1,
        workspaceManager: fakeManager(state),
        runLoop: async ({ root, isolated }) => {
          roots.push(root);
          expect(isolated).toBe(false);
          return loopResult();
        },
      })
    );
    expect(state.acquired).toEqual([]);
    expect(roots).toEqual(['/main', '/main']);
  });

  it('parallelTasks>1 WITHOUT a manager degrades to sequential in-tree', async () => {
    const order: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    await runOrchestratedMission(
      baseDeps({
        parallelTasks: 4,
        workspaceManager: null,
        runLoop: async ({ taskId, root }) => {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          order.push(taskId);
          expect(root).toBe('/main');
          await new Promise((res) => setTimeout(res, 5));
          inFlight--;
          return loopResult();
        },
      })
    );
    expect(maxInFlight).toBe(1);
    expect(order).toEqual(['a', 'b']);
  });
});

describe('workspace lifecycle', () => {
  it('a failed acquire falls back to SERIALIZED in-tree execution', async () => {
    const manager: TaskWorkspaceManager = { acquire: () => null };
    let inFlight = 0;
    let maxInFlight = 0;
    const r = await runOrchestratedMission(
      baseDeps({
        parallelTasks: 2,
        workspaceManager: manager,
        runLoop: async ({ root, isolated }) => {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          expect(root).toBe('/main');
          expect(isolated).toBe(false);
          await new Promise((res) => setTimeout(res, 5));
          inFlight--;
          return loopResult();
        },
      })
    );
    expect(r.success).toBe(true);
    expect(maxInFlight).toBe(1); // the merge lock serialized the fallback
  });

  it('a merge CONFLICT fails the task and ATG repair retries it in a FRESH workspace', async () => {
    const state: FakeManagerState = {
      acquired: [],
      merges: [],
      cleanups: [],
      // task a's first merge conflicts; its retry merges clean
      mergeOk: (taskId, call) => !(taskId === 'a' && call === 1),
    };
    const prompts: string[] = [];
    const r = await runOrchestratedMission(
      baseDeps({
        tasks: [task('a'), task('after', ['a'])],
        parallelTasks: 2,
        workspaceManager: fakeManager(state),
        runLoop: async ({ prompt }) => {
          prompts.push(prompt);
          return loopResult();
        },
      })
    );
    expect(r.success).toBe(true);
    // acquired: a (conflict), a again (repair retry), after
    expect(state.acquired.filter((t) => t === 'a').length).toBe(2);
    // the repair retry's context carried the conflict explanation
    expect(prompts.some((p) => p.includes('tree changed underneath'))).toBe(true);
    expect(state.cleanups.length).toBe(3);
  });

  it('passes the merge-boundary predicate through to the workspace', async () => {
    const state: FakeManagerState = { acquired: [], merges: [], cleanups: [], mergeOk: () => true };
    await runOrchestratedMission(
      baseDeps({
        tasks: [task('a')],
        parallelTasks: 2,
        workspaceManager: fakeManager(state),
        isMergeBlocked: (f) => f === 'probe.ts',
      })
    );
    expect(state.lastBlockedProbe).toEqual(['probe.ts']);
  });
});

describe('spec bookkeeping + post-merge verification', () => {
  it('begins/ends the acceptance spec per workspace root', async () => {
    const state: FakeManagerState = { acquired: [], merges: [], cleanups: [], mergeOk: () => true };
    const began: string[] = [];
    const ended: string[] = [];
    await runOrchestratedMission(
      baseDeps({
        tasks: [task('a')],
        parallelTasks: 2,
        workspaceManager: fakeManager(state),
        beginTaskSpec: (root, spec) => {
          began.push(root);
          expect(spec).toContain('build a');
        },
        endTaskSpec: (root) => ended.push(root),
      })
    );
    expect(began).toEqual(ended);
    expect(began[0]).toContain('/ws/a/');
  });

  it('a failed post-merge verification fails the mission', async () => {
    const state: FakeManagerState = { acquired: [], merges: [], cleanups: [], mergeOk: () => true };
    const r = await runOrchestratedMission(
      baseDeps({
        parallelTasks: 2,
        workspaceManager: fakeManager(state),
        verifyCombined: async () => ({ passed: false, feedback: 'combined tree broke the build' }),
      })
    );
    expect(r.success).toBe(false);
    expect(r.finalFeedback).toContain('post-merge verification FAILED');
    expect(r.finalFeedback).toContain('combined tree broke the build');
  });

  it('post-merge verification is skipped when isolation was not active', async () => {
    let verified = false;
    const r = await runOrchestratedMission(
      baseDeps({
        parallelTasks: 1,
        verifyCombined: async () => {
          verified = true;
          return { passed: false, feedback: 'must not be consulted' };
        },
      })
    );
    expect(r.success).toBe(true);
    expect(verified).toBe(false);
  });
});

describe('P5 re-planning + aggregation', () => {
  it('a NEW_TASKS marker in a task output folds follow-up tasks into the DAG', async () => {
    const ran: string[] = [];
    await runOrchestratedMission(
      baseDeps({
        tasks: [task('root')],
        runLoop: async ({ taskId }) => {
          ran.push(taskId);
          return loopResult(
            taskId === 'root'
              ? { finalOutput: 'NEW_TASKS: [{"id":"child","title":"Child","goal":"finish","deps":["root"]}]' }
              : {}
          );
        },
      })
    );
    expect(ran).toEqual(['root', 'child']);
  });

  it('ignores a NEW_TASKS marker not directly followed by an array (prose + stray JSON)', async () => {
    const ran: string[] = [];
    await runOrchestratedMission(
      baseDeps({
        tasks: [task('root')],
        runLoop: async ({ taskId }) => {
          ran.push(taskId);
          return loopResult({
            finalOutput:
              'NEW_TASKS: none needed here.\nUnrelated sample data: [{"id":"x","title":"Not a task","goal":"noise"}]',
          });
        },
      })
    );
    expect(ran).toEqual(['root']); // the stray array never became a task
  });

  it('foldDeliveryResult aggregates turns/history and keeps the best score', () => {
    const target: DeliveryResult = loopResult({ turns: 2, bestScore: 0.5, bestTurn: 1 });
    foldDeliveryResult(target, loopResult({ turns: 3, bestScore: 0.9, bestTurn: 4, finalFeedback: 'latest' }));
    expect(target.turns).toBe(5);
    expect(target.bestScore).toBe(0.9);
    expect(target.bestTurn).toBe(4);
    expect(target.finalFeedback).toBe('latest');
  });
});
