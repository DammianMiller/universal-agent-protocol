/**
 * Blackboard orchestrator (P1) + minimal context assembler (P2): graph
 * execution, dependency gating, and the crux — a task's context includes ONLY
 * its direct dependencies' outputs, not the whole mission or every prior task.
 */

import { describe, it, expect } from 'vitest';
import {
  orchestrate,
  assembleTaskContext,
  governContext,
  type OrchestratorTask,
  type TaskOutcome,
} from '../../src/delivery/task-orchestrator.js';

const task = (id: string, deps?: string[], extra: Partial<OrchestratorTask> = {}): OrchestratorTask => ({
  id,
  title: id,
  goal: `build ${id}`,
  ...(deps ? { deps } : {}),
  ...extra,
});

describe('assembleTaskContext (P2 — minimal context)', () => {
  it('includes ONLY direct-dependency outputs, not the whole mission or siblings', () => {
    const bb = new Map<string, TaskOutcome>([
      ['store', { taskId: 'store', success: true, summary: 'store exposes append()/stateAt()', turns: 2 }],
      ['unrelated', { taskId: 'unrelated', success: true, summary: 'SECRET should not appear', turns: 1 }],
    ]);
    const hugeMission = 'X'.repeat(5000);
    const ctx = assembleTaskContext(
      task('query', ['store'], { files: ['query.js'], criteria: ['select() filters by type'] }),
      hugeMission,
      bb
    );
    // direct dep included…
    expect(ctx.includedDeps).toEqual(['store']);
    expect(ctx.prompt).toContain('store exposes append()/stateAt()');
    // …non-dependency NOT leaked…
    expect(ctx.prompt).not.toContain('SECRET should not appear');
    // …the full mission is a snippet, not the 5000-char dump…
    expect(ctx.prompt.length).toBeLessThan(1200);
    // …task's own files + criteria present.
    expect(ctx.prompt).toContain('query.js');
    expect(ctx.prompt).toContain('select() filters by type');
  });

  it('prefers a dependency contract over its summary when present', () => {
    const bb = new Map<string, TaskOutcome>([
      ['api', { taskId: 'api', success: true, summary: 'long prose summary', turns: 1, contract: 'export function f(x:number):number' }],
    ]);
    const ctx = assembleTaskContext(task('ui', ['api']), 'm', bb);
    expect(ctx.prompt).toContain('export function f(x:number):number');
    expect(ctx.prompt).not.toContain('long prose summary');
  });
});

describe('orchestrate (P1 — blackboard graph execution)', () => {
  it('runs tasks in dependency order, publishing each outcome to the blackboard', async () => {
    const seen: Array<{ id: string; deps: string[] }> = [];
    const r = await orchestrate({
      mission: 'build the thing',
      tasks: [task('c', ['a', 'b']), task('a'), task('b', ['a'])],
      runTask: async (ctx, t) => {
        seen.push({ id: t.id, deps: ctx.includedDeps });
        return { taskId: t.id, success: true, summary: `${t.id} done`, turns: 1 };
      },
    });
    expect(r.success).toBe(true);
    expect(seen.map((s) => s.id)).toEqual(['a', 'b', 'c']); // topo order
    // c saw BOTH its deps' outputs from the blackboard
    expect(seen.find((s) => s.id === 'c')!.deps.sort()).toEqual(['a', 'b']);
    expect(r.completed.sort()).toEqual(['a', 'b', 'c']);
    expect(r.turns).toBe(3);
  });

  it('skips a task whose dependency failed — never builds on a broken base', async () => {
    const ran: string[] = [];
    const r = await orchestrate({
      mission: 'm',
      tasks: [task('base'), task('mid', ['base']), task('leaf', ['mid'])],
      runTask: async (_ctx, t) => {
        ran.push(t.id);
        return { taskId: t.id, success: t.id !== 'base', summary: `${t.id}`, turns: 1 };
      },
    });
    expect(ran).toEqual(['base']); // base fails -> mid & leaf never run
    expect(r.success).toBe(false);
    expect(r.failed.sort()).toEqual(['base', 'leaf', 'mid']);
  });

  it('publishes completed outcomes to durable memory (fail-soft)', async () => {
    const published: string[] = [];
    await orchestrate({
      mission: 'm',
      tasks: [task('x')],
      runTask: async (_c, t) => ({ taskId: t.id, success: true, summary: 'x', turns: 1 }),
      publish: (o) => { published.push(o.taskId); throw new Error('memory down'); },
    });
    expect(published).toEqual(['x']); // called, and the throw did not break the run
  });
});

describe('governContext (P6 — enforced budget)', () => {
  it('drops furthest dependency lines to fit the budget, noting the elision', () => {
    const deps = Array.from({ length: 5 }, (_, i) => `- dep${i}: ${'x'.repeat(100)}`).join('\n');
    const prompt = `TASK: build\nALREADY BUILT:\n${deps}`;
    const g = governContext(prompt, 5, 300);
    expect(g.prompt.length).toBeLessThanOrEqual(400);
    expect(g.droppedDeps).toBeGreaterThan(0);
    expect(g.prompt).toContain('context governor: elided');
  });
  it('leaves an already-small context untouched', () => {
    const g = governContext('short', 0, 6000);
    expect(g).toEqual({ prompt: 'short', droppedDeps: 0 });
  });
});

describe('orchestrate re-planning + design + budget (P3/P5/P6)', () => {
  it('P5: a task can spawn new subtasks that then execute', async () => {
    const ran: string[] = [];
    const r = await orchestrate({
      mission: 'm',
      tasks: [{ id: 'root', title: 'root', goal: 'g' }],
      runTask: async (_c, t) => {
        ran.push(t.id);
        return {
          taskId: t.id, success: true, summary: t.id, turns: 1,
          ...(t.id === 'root' ? { newTasks: [{ id: 'child', title: 'child', goal: 'g', deps: ['root'] }] } : {}),
        };
      },
    });
    expect(ran).toEqual(['root', 'child']);
    expect(r.completed.sort()).toEqual(['child', 'root']);
  });

  it('P3: retrieved design lines are injected into the task context', async () => {
    let seenPrompt = '';
    await orchestrate({
      mission: 'm',
      tasks: [{ id: 'a', title: 'a', goal: 'g' }],
      retrieveDesign: () => ['use the repository pattern', 'no external deps'],
      runTask: async (ctx) => { seenPrompt = ctx.prompt; return { taskId: 'a', success: true, summary: 'a', turns: 1 }; },
    });
    expect(seenPrompt).toContain('DESIGN CONTEXT');
    expect(seenPrompt).toContain('repository pattern');
  });

  it('P5: re-planning is bounded by maxTasks', async () => {
    const ran: string[] = [];
    await orchestrate({
      mission: 'm', maxTasks: 2,
      tasks: [{ id: 't0', title: 't0', goal: 'g' }],
      runTask: async (_c, t) => {
        ran.push(t.id);
        // always tries to spawn another — cap must stop it
        return { taskId: t.id, success: true, summary: t.id, turns: 1, newTasks: [{ id: `${t.id}-x`, title: 'x', goal: 'g' }] };
      },
    });
    expect(ran.length).toBeLessThanOrEqual(2);
  });
});
