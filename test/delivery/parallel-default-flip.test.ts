/**
 * Parallel-default flip: the graph layer fans independent READY tasks out in
 * parallel BY DEFAULT (unset config/env resolves to DEFAULT_PARALLEL_TASKS),
 * the UAP_DELIVER_PARALLEL_TASKS=1 / config-1 escape hatch forces sequential,
 * and the safety predicate holds — without worktree isolation a run stays
 * sequential with a logged reason, even at the default fan-out.
 *
 * Resolution is tested at the resolveParallelTasks seam; dispatch behavior is
 * tested through runOrchestratedMission with faked seams (no model, no git),
 * mirroring orchestrated-mission.test.ts.
 */

import { describe, it, expect } from 'vitest';
import {
  runOrchestratedMission,
  type OrchestratedMissionDeps,
} from '../../src/delivery/orchestrated-mission.js';
import {
  resolveParallelTasks,
  DEFAULT_PARALLEL_TASKS,
  type TaskWorkspace,
  type TaskWorkspaceManager,
} from '../../src/delivery/task-workspace.js';
import type { DeliveryResult } from '../../src/delivery/convergence-loop.js';
import type { OrchestratorTask } from '../../src/delivery/task-orchestrator.js';

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

function fakeManager(): TaskWorkspaceManager & { acquired: string[] } {
  const acquired: string[] = [];
  return {
    acquired,
    acquire(taskId: string): TaskWorkspace | null {
      acquired.push(taskId);
      return {
        root: `/ws/${taskId}`,
        mergeBack: () => ({ ok: true, files: [`${taskId}.ts`] }),
        cleanup: () => undefined,
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

describe('resolveParallelTasks — the default flip', () => {
  it('unset config AND env resolves to the parallel default (>1)', () => {
    expect(DEFAULT_PARALLEL_TASKS).toBe(4);
    expect(resolveParallelTasks(undefined, {})).toBe(4);
  });

  it('UAP_DELIVER_PARALLEL_TASKS=1 forces sequential even when config asks for more', () => {
    expect(resolveParallelTasks(8, { UAP_DELIVER_PARALLEL_TASKS: '1' })).toBe(1);
    expect(resolveParallelTasks(undefined, { UAP_DELIVER_PARALLEL_TASKS: '1' })).toBe(1);
  });

  it('the env override retunes the cap and beats config; garbage env fails safe to sequential', () => {
    expect(resolveParallelTasks(undefined, { UAP_DELIVER_PARALLEL_TASKS: '6' })).toBe(6);
    expect(resolveParallelTasks(2, { UAP_DELIVER_PARALLEL_TASKS: '6' })).toBe(6);
    expect(resolveParallelTasks(undefined, { UAP_DELIVER_PARALLEL_TASKS: '99' })).toBe(8);
    expect(resolveParallelTasks(4, { UAP_DELIVER_PARALLEL_TASKS: 'junk' })).toBe(1);
    // An EMPTY env value is "unset" — config/default still apply.
    expect(resolveParallelTasks(3, { UAP_DELIVER_PARALLEL_TASKS: '  ' })).toBe(3);
    expect(resolveParallelTasks(undefined, { UAP_DELIVER_PARALLEL_TASKS: '' })).toBe(4);
  });
});

describe('default fan-out through the orchestrated mission', () => {
  it('(a) the DEFAULT-resolved fan-out makes independent READY tasks overlap in isolated worktrees', async () => {
    // Resolve exactly the way deliver.ts does for an unset config, then wire
    // the result in — this pins config default → resolution → dispatch.
    const parallelTasks = resolveParallelTasks(undefined, {});
    expect(parallelTasks).toBeGreaterThan(1);
    const manager = fakeManager();
    let inFlight = 0;
    let maxInFlight = 0;
    let release!: () => void;
    const gate = new Promise<void>((res) => {
      release = res;
    });
    const started: string[] = [];
    // Timed fallback: if the flip regressed to sequential, fail on the
    // maxInFlight assertion, not on a hung test.
    const gateOrTimeout = Promise.race([gate, new Promise<void>((res) => setTimeout(res, 1500))]);
    const r = await runOrchestratedMission(
      baseDeps({
        parallelTasks,
        workspaceManager: manager,
        runLoop: async ({ taskId, isolated }) => {
          expect(isolated).toBe(true);
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          started.push(taskId);
          if (started.length === 2) release();
          await gateOrTimeout;
          inFlight--;
          return loopResult();
        },
      })
    );
    expect(r.success).toBe(true);
    expect(maxInFlight).toBe(2); // both READY tasks in flight at once by default
    expect(manager.acquired.sort()).toEqual(['a', 'b']); // each in its own worktree
  });

  it('(b) the escape hatch (UAP_DELIVER_PARALLEL_TASKS=1) forces sequential in-tree execution', async () => {
    const parallelTasks = resolveParallelTasks(undefined, { UAP_DELIVER_PARALLEL_TASKS: '1' });
    expect(parallelTasks).toBe(1);
    const manager = fakeManager();
    const roots: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const r = await runOrchestratedMission(
      baseDeps({
        parallelTasks,
        workspaceManager: manager,
        runLoop: async ({ root, isolated }) => {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          roots.push(root);
          expect(isolated).toBe(false);
          await new Promise((res) => setTimeout(res, 5));
          inFlight--;
          return loopResult();
        },
      })
    );
    expect(r.success).toBe(true);
    expect(maxInFlight).toBe(1);
    expect(manager.acquired).toEqual([]); // isolation never engaged
    expect(roots).toEqual(['/main', '/main']);
  });

  it('(c) the default fan-out stays SEQUENTIAL with a logged reason when isolation is unavailable', async () => {
    const parallelTasks = resolveParallelTasks(undefined, {});
    const notes: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const order: string[] = [];
    const r = await runOrchestratedMission(
      baseDeps({
        parallelTasks,
        workspaceManager: null, // not a git repo / unborn HEAD
        note: (line) => notes.push(line),
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
    expect(r.success).toBe(true);
    expect(maxInFlight).toBe(1); // safety predicate: no isolation ⇒ no fan-out
    expect(order).toEqual(['a', 'b']);
    expect(notes.some((n) => n.includes('isolation unavailable') && n.includes('sequentially'))).toBe(true);
  });
});
