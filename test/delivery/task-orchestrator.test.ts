/**
 * Blackboard orchestrator (P1) + minimal context assembler (P2): graph
 * execution, dependency gating, and the crux — a task's context includes ONLY
 * its direct dependencies' outputs, not the whole mission or every prior task.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  orchestrate,
  assembleTaskContext,
  governContext,
  type OrchestratorTask,
  type TaskOutcome,
} from '../../src/delivery/task-orchestrator.js';

// Default-dependent tests must not flake when the env knob leaks into the
// test shell (this repo has had exactly this class of incident before).
beforeEach(() => {
  delete process.env.UAP_ORCH_TASK_REPAIRS;
});
afterEach(() => {
  delete process.env.UAP_ORCH_TASK_REPAIRS;
});

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
      maxRepairsPerTask: 0, // isolate the skip semantics from minimal repair
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

  it('P5: a spawned task depending on an already-FAILED task is skipped, not run', async () => {
    const ran: string[] = [];
    const r = await orchestrate({
      mission: 'm',
      tasks: [task('bad'), task('ok')],
      maxRepairsPerTask: 0,
      runTask: async (_c, t) => {
        ran.push(t.id);
        return {
          taskId: t.id, success: t.id !== 'bad', summary: t.id, turns: 1,
          // ok spawns a follow-up that (incorrectly) builds on the failed task
          ...(t.id === 'ok' ? { newTasks: [{ id: 'on-bad', title: 'x', goal: 'g', deps: ['bad'] }] } : {}),
        };
      },
    });
    expect(ran.sort()).toEqual(['bad', 'ok']); // on-bad never ran
    expect(r.failed).toContain('on-bad');
  });
});

describe('orchestrate minimal node repair (ATG)', () => {
  it('re-executes ONLY the failed node with the failure fed back — dependents then run', async () => {
    const attempts: string[] = [];
    let midRetryPrompt = '';
    const r = await orchestrate({
      mission: 'm',
      tasks: [task('base'), task('mid', ['base']), task('leaf', ['mid'])],
      maxRepairsPerTask: 1,
      runTask: async (ctx, t) => {
        attempts.push(t.id);
        // mid fails on its FIRST attempt only
        const firstMid = t.id === 'mid' && attempts.filter((a) => a === 'mid').length === 1;
        if (t.id === 'mid' && !firstMid) midRetryPrompt = ctx.prompt;
        return { taskId: t.id, success: !firstMid, summary: `${t.id} ${firstMid ? 'broke: missing export' : 'done'}`, turns: 1 };
      },
    });
    expect(attempts).toEqual(['base', 'mid', 'mid', 'leaf']); // only mid re-ran
    expect(midRetryPrompt).toContain('PREVIOUS ATTEMPT FAILED');
    expect(midRetryPrompt).toContain('missing export');
    expect(r.success).toBe(true);
    expect(r.completed.sort()).toEqual(['base', 'leaf', 'mid']);
  });

  it('honors maxRepairsPerTask: 0 (fail-fast, no retry)', async () => {
    const attempts: string[] = [];
    const r = await orchestrate({
      mission: 'm',
      tasks: [task('a')],
      maxRepairsPerTask: 0,
      runTask: async (_c, t) => {
        attempts.push(t.id);
        return { taskId: t.id, success: false, summary: 'nope', turns: 1 };
      },
    });
    expect(attempts).toEqual(['a']);
    expect(r.success).toBe(false);
  });

  it('defaults to exactly ONE retry with no config (the production behavior)', async () => {
    let attempts = 0;
    await orchestrate({
      mission: 'm',
      tasks: [task('a')],
      runTask: async () => {
        attempts++;
        return { taskId: 'a', success: false, summary: 'always broken', turns: 1 };
      },
    });
    expect(attempts).toBe(2); // first attempt + one default repair
  });

  it('honors UAP_ORCH_TASK_REPAIRS env, hard-ceilinged at 5', async () => {
    process.env.UAP_ORCH_TASK_REPAIRS = '0';
    let attempts = 0;
    const runTask = async (): Promise<TaskOutcome> => {
      attempts++;
      return { taskId: 'a', success: false, summary: 'broken', turns: 1 };
    };
    await orchestrate({ mission: 'm', tasks: [task('a')], runTask });
    expect(attempts).toBe(1); // env 0 = fail-fast

    process.env.UAP_ORCH_TASK_REPAIRS = '99';
    attempts = 0;
    await orchestrate({ mission: 'm', tasks: [task('a')], runTask });
    expect(attempts).toBe(6); // first attempt + ceiling of 5 repairs, not 99

    process.env.UAP_ORCH_TASK_REPAIRS = ''; // empty string = unset, not 0
    attempts = 0;
    await orchestrate({ mission: 'm', tasks: [task('a')], runTask });
    expect(attempts).toBe(2); // fallback default of 1 repair
  });

  it('a throwing runTask settles as a failed outcome instead of abandoning the graph', async () => {
    const r = await orchestrate({
      mission: 'm',
      tasks: [task('boom'), task('after', ['boom'])],
      maxRepairsPerTask: 0,
      runTask: async (_c, t) => {
        if (t.id === 'boom') throw new Error('executor exploded');
        return { taskId: t.id, success: true, summary: t.id, turns: 1 };
      },
    });
    expect(r.success).toBe(false);
    expect(r.failed.sort()).toEqual(['after', 'boom']);
    const boom = r.outcomes.find((o) => o.taskId === 'boom');
    expect(boom?.summary).toContain('task execution error: executor exploded');
  });

  it('repairTask chain replaces the failed node and CREDITS the original id for dependents', async () => {
    const ran: string[] = [];
    const r = await orchestrate({
      mission: 'm',
      tasks: [task('store'), task('ui', ['store'])],
      maxRepairsPerTask: 0, // go straight to the re-plan chain
      repairTask: async (t, failure) => {
        expect(t.id).toBe('store');
        expect(failure.summary).toContain('too big');
        return [
          { id: 'schema', title: 'schema', goal: 'define the schema' },
          { id: 'impl', title: 'impl', goal: 'implement the store' },
        ];
      },
      runTask: async (ctx, t) => {
        ran.push(t.id);
        if (t.id === 'store') return { taskId: t.id, success: false, summary: 'too big', turns: 1 };
        return {
          taskId: t.id, success: true, summary: `${t.id} done`, turns: 1,
          ...(t.id.endsWith('impl') ? { contract: 'export function put(k,v)' } : {}),
        };
      },
    });
    // chain ran namespaced under the original id, then the dependent ran
    expect(ran).toEqual(['store', 'store.r0-schema', 'store.r1-impl', 'ui']);
    expect(r.success).toBe(true);
    expect(r.completed).toContain('store'); // original id credited
    // the dependent saw the chain's final contract under the ORIGINAL dep id
    const uiOutcome = r.outcomes.find((o) => o.taskId === 'ui');
    expect(uiOutcome?.success).toBe(true);
  });

  it('a declined repair (null) still blocks dependents', async () => {
    const ran: string[] = [];
    const r = await orchestrate({
      mission: 'm',
      tasks: [task('a'), task('b', ['a'])],
      maxRepairsPerTask: 0,
      repairTask: async () => null,
      runTask: async (_c, t) => {
        ran.push(t.id);
        return { taskId: t.id, success: false, summary: 'broken', turns: 1 };
      },
    });
    expect(ran).toEqual(['a']);
    expect(r.failed.sort()).toEqual(['a', 'b']);
  });
});

describe('orchestrate dependency-aware parallel dispatch', () => {
  it('runs independent ready tasks concurrently up to the concurrency cap', async () => {
    const started: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((res) => { release = res; });
    const r = await orchestrate({
      mission: 'm',
      tasks: [task('a'), task('b'), task('join', ['a', 'b'])],
      concurrency: 2,
      runTask: async (_c, t) => {
        if (t.id !== 'join') {
          started.push(t.id);
          if (started.length === 2) release(); // both independent tasks in flight AT ONCE
          await gate; // neither finishes until both have started
        } else {
          // the dependent only runs after BOTH deps completed
          expect(started.sort()).toEqual(['a', 'b']);
        }
        return { taskId: t.id, success: true, summary: t.id, turns: 1 };
      },
    });
    expect(r.success).toBe(true);
    expect(r.completed.sort()).toEqual(['a', 'b', 'join']);
  });

  it('concurrency 1 (default) preserves strict sequential topo order', async () => {
    const ran: string[] = [];
    await orchestrate({
      mission: 'm',
      tasks: [task('c', ['a', 'b']), task('a'), task('b', ['a'])],
      runTask: async (_c, t) => {
        ran.push(t.id);
        return { taskId: t.id, success: true, summary: t.id, turns: 1 };
      },
    });
    expect(ran).toEqual(['a', 'b', 'c']);
  });

  it('a failed wave member only blocks ITS dependents — the sibling branch completes', async () => {
    const ran: string[] = [];
    const r = await orchestrate({
      mission: 'm',
      tasks: [task('a'), task('b'), task('a-child', ['a']), task('b-child', ['b'])],
      concurrency: 2,
      maxRepairsPerTask: 0,
      runTask: async (_c, t) => {
        ran.push(t.id);
        return { taskId: t.id, success: t.id !== 'a', summary: t.id, turns: 1 };
      },
    });
    expect(ran.sort()).toEqual(['a', 'b', 'b-child']); // a-child never ran
    expect(r.failed.sort()).toEqual(['a', 'a-child']);
    expect(r.completed.sort()).toEqual(['b', 'b-child']);
  });

  it('an unsatisfiable remainder (dependency cycle) is skipped, never wedged', async () => {
    const ran: string[] = [];
    const r = await orchestrate({
      mission: 'm',
      tasks: [task('free'), task('x', ['y']), task('y', ['x'])],
      runTask: async (_c, t) => {
        ran.push(t.id);
        return { taskId: t.id, success: true, summary: t.id, turns: 1 };
      },
    });
    expect(ran).toEqual(['free']); // only the acyclic task ran
    expect(r.success).toBe(false);
    expect(r.failed.sort()).toEqual(['x', 'y']);
    const skipped = r.outcomes.find((o) => o.taskId === 'x');
    expect(skipped?.summary).toContain('unmet dependency');
  });
});
