/**
 * Epic-mission runner (extracted from deliver.ts): the default delivery
 * path's previously-untestable policy — contracts/scaffold steering, epic
 * spec assembly, ledger lifecycle, retry feedback, split re-planning,
 * parallel-branch selection, and epic-level acceptance parity — now pinned
 * with every seam faked (no model, no git, no epic-controller shortcuts:
 * the real runEpics drives attempts and splits).
 */

import { describe, it, expect } from 'vitest';
import { runEpicMission, type EpicMissionDeps } from '../../src/delivery/epic-mission.js';
import type { DeliveryResult } from '../../src/delivery/convergence-loop.js';
import type { DeliveryPhase } from '../../src/delivery/decompose.js';
import { CONTEXT_BUDGET_MARKER } from '../../src/delivery/context-budget.js';

const phase = (id: string, extra: Partial<DeliveryPhase> = {}): DeliveryPhase => ({
  id,
  title: id,
  goal: `deliver ${id}`,
  ...extra,
});

const ok = (over: Partial<DeliveryResult> = {}): DeliveryResult => ({
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

function baseDeps(over: Partial<EpicMissionDeps>): EpicMissionDeps {
  return {
    instruction: 'build the platform',
    planEpics: async () => [phase('a'), phase('b')],
    planSplit: async () => [],
    planEpicTasks: async () => [],
    epicParallelTasks: 1,
    runOrchestrated: async () => ok(),
    runEpicLoop: async () => ok(),
    setEpicSpec: () => undefined,
    judgeEpic: null,
    lockedContracts: () => [],
    lockContracts: () => [],
    maxAttemptsPerEpic: 2,
    splitDepth: 1,
    splitOnAnyFailure: false,
    ...over,
  };
}

describe('epic planning + fallback', () => {
  it('a degenerate epic decomposition falls back to ONE mission epic', async () => {
    const scopes: string[] = [];
    const r = await runEpicMission(
      baseDeps({
        planEpics: async () => [],
        runEpicLoop: async (scoped) => {
          scopes.push(scoped);
          return ok();
        },
      })
    );
    expect(r.success).toBe(true);
    expect(scopes.length).toBe(1);
    expect(scopes[0]).toContain('build the platform');
    expect(scopes[0]).toContain('Deliver ONLY this epic');
  });

  it('initializes the completion ledger with the epic ids and marks outcomes', async () => {
    const inits: string[][] = [];
    const marks: Array<[string, string]> = [];
    await runEpicMission(
      baseDeps({
        planEpics: async () => [phase('a'), phase('b', { deps: ['a'] })],
        runEpicLoop: async (scoped) => ok({ success: !scoped.includes('deliver b') }),
        ledgerInit: (items) => inits.push(items.map((i) => i.id)),
        ledgerMark: (id, status) => marks.push([id, status]),
      })
    );
    expect(inits).toEqual([['a', 'b']]);
    expect(marks).toContainEqual(['a', 'done']);
    expect(marks.filter(([id]) => id === 'b').every(([, s]) => s === 'failed')).toBe(true);
  });
});

describe('scoped prompt + epic spec composition', () => {
  it('CONTRACTS epic gets the frozen-API instruction; later epics see LOCKED CONTRACTS', async () => {
    const scopes = new Map<string, string>();
    let locked: string[] = [];
    await runEpicMission(
      baseDeps({
        planEpics: async () => [phase('contracts', { contracts: true }), phase('impl', { deps: ['contracts'] })],
        runEpicLoop: async (scoped) => {
          const id = scoped.includes('CONTRACTS epic') ? 'contracts' : 'impl';
          scopes.set(id, scoped);
          return ok({ history: [{ filesApplied: ['src/types.ts'] } as never] });
        },
        lockedContracts: () => locked,
        lockContracts: (files) => {
          locked = files;
          return files;
        },
      })
    );
    expect(scopes.get('contracts')).toContain('FROZEN for the rest of the mission');
    expect(scopes.get('impl')).toContain('LOCKED CONTRACTS');
    expect(scopes.get('impl')).toContain('src/types.ts');
  });

  it('SCAFFOLD and FILL epics get their steering notes and spec clauses', async () => {
    const specs: string[] = [];
    const scopes: string[] = [];
    await runEpicMission(
      baseDeps({
        planEpics: async () => [phase('skel', { scaffold: true }), phase('fill', { deps: ['skel'] })],
        setEpicSpec: (spec) => specs.push(spec),
        runEpicLoop: async (scoped) => {
          scopes.push(scoped);
          return ok();
        },
      })
    );
    expect(scopes[0]).toContain('SCAFFOLD epic');
    expect(scopes[1]).toContain('FILL epic');
    expect(specs[0]).toContain('stub bodies are the DELIVERABLE');
    expect(specs[1]).toContain('no todo!()');
  });

  it('a retry carries the previous failure into the scoped prompt', async () => {
    const scopes: string[] = [];
    await runEpicMission(
      baseDeps({
        planEpics: async () => [phase('a')],
        maxAttemptsPerEpic: 2,
        runEpicLoop: async (scoped) => {
          scopes.push(scoped);
          return ok({ success: scopes.length > 1, finalFeedback: 'tests exploded' });
        },
      })
    );
    expect(scopes.length).toBe(2);
    expect(scopes[0]).not.toContain('PREVIOUS ATTEMPT FEEDBACK');
    expect(scopes[1]).toContain('PREVIOUS ATTEMPT FEEDBACK');
  });

  it('prior epic summaries reach later epics as ALREADY BUILT context', async () => {
    const scopes: string[] = [];
    await runEpicMission(
      baseDeps({
        planEpics: async () => [phase('a'), phase('b', { deps: ['a'] })],
        runEpicLoop: async (scoped) => {
          scopes.push(scoped);
          return ok();
        },
      })
    );
    expect(scopes[1]).toContain('ALREADY BUILT (prior epics');
  });
});

describe('split re-planning', () => {
  it('an exhausted epic consults planSplit with a reactive sub-goal', async () => {
    const splitGoals: string[] = [];
    const r = await runEpicMission(
      baseDeps({
        planEpics: async () => [phase('big')],
        maxAttemptsPerEpic: 1,
        splitOnAnyFailure: true,
        splitDepth: 1,
        planSplit: async (subGoal) => {
          splitGoals.push(subGoal);
          return [phase('piece-1'), phase('piece-2')];
        },
        runEpicLoop: async (scoped) =>
          // the whole (fallback 'Mission') epic fails; its split pieces succeed
          ok({ success: !scoped.includes('EPIC — Mission:') }),
      })
    );
    expect(splitGoals.length).toBe(1);
    expect(splitGoals[0]).toContain('The previous attempt did not complete');
    expect(r.success).toBe(true); // the pieces landed
  });

  it('a budget-stopped epic surfaces the CONTEXT_BUDGET_MARKER to the controller', async () => {
    const splitGoals: string[] = [];
    await runEpicMission(
      baseDeps({
        planEpics: async () => [phase('big')],
        maxAttemptsPerEpic: 1,
        splitDepth: 1,
        planSplit: async (g) => {
          splitGoals.push(g);
          return [phase('p1'), phase('p2')];
        },
        runEpicLoop: async (scoped) =>
          scoped.includes('EPIC — Mission:')
            ? ok({ success: false, history: [{ filesApplied: [], budgetStopped: true } as never] })
            : ok(),
      })
    );
    // splitOnAnyFailure=false here — the split fired via the budget marker.
    expect(splitGoals.length).toBe(1);
    expect(splitGoals[0]).toContain(CONTEXT_BUDGET_MARKER);
  });
});

describe('parallel branch + acceptance parity', () => {
  it('epicParallelTasks>1 with a decomposable epic routes through runOrchestrated (classic loop untouched)', async () => {
    const orchestrated: string[] = [];
    let classicRan = false;
    const r = await runEpicMission(
      baseDeps({
        planEpics: async () => [phase('a')],
        epicParallelTasks: 3,
        planEpicTasks: async () => [phase('t1'), phase('t2')],
        runOrchestrated: async (missionText) => {
          orchestrated.push(missionText);
          return ok();
        },
        runEpicLoop: async () => {
          classicRan = true;
          return ok();
        },
      })
    );
    expect(r.success).toBe(true);
    expect(orchestrated.length).toBe(1);
    expect(orchestrated[0].startsWith('EPIC — Mission: build the platform')).toBe(true);
    expect(classicRan).toBe(false);
  });

  it('an undecomposable epic under parallel mode falls back to the classic loop', async () => {
    let classicRan = false;
    await runEpicMission(
      baseDeps({
        planEpics: async () => [phase('a')],
        epicParallelTasks: 2,
        planEpicTasks: async () => [phase('only-one')],
        runEpicLoop: async () => {
          classicRan = true;
          return ok();
        },
      })
    );
    expect(classicRan).toBe(true);
  });

  it('a retry under parallel mode feeds the failure into the task decomposition', async () => {
    const planGoals: string[] = [];
    await runEpicMission(
      baseDeps({
        planEpics: async () => [phase('a')],
        epicParallelTasks: 2,
        maxAttemptsPerEpic: 2,
        planEpicTasks: async (goal) => {
          planGoals.push(goal);
          return [phase('t1'), phase('t2')];
        },
        runOrchestrated: async () => ok({ success: planGoals.length > 1 }),
      })
    );
    expect(planGoals.length).toBe(2);
    expect(planGoals[0]).not.toContain('previous attempt');
    expect(planGoals[1]).toContain('The previous attempt did not complete');
  });

  it('EPIC acceptance parity: a green orchestrated run failing the epic judge fails the attempt', async () => {
    const judgedSpecs: string[] = [];
    let attempts = 0;
    const r = await runEpicMission(
      baseDeps({
        planEpics: async () => [phase('fill-epic', { deps: [] })],
        epicParallelTasks: 2,
        maxAttemptsPerEpic: 1,
        planEpicTasks: async () => [phase('t1'), phase('t2')],
        runOrchestrated: async () => {
          attempts++;
          return ok();
        },
        judgeEpic: async (spec) => {
          judgedSpecs.push(spec);
          return { passed: false, feedback: 'stub markers remain' };
        },
      })
    );
    expect(attempts).toBe(1);
    expect(judgedSpecs.length).toBe(1);
    expect(judgedSpecs[0]).toContain('EPIC — Mission');
    expect(r.success).toBe(false);
    expect(r.finalFeedback).toContain('failed epic(s)');
  });

  it('a null judge resolution (unavailable) lets the objective verdict stand — and says so', async () => {
    const notes: string[] = [];
    const r = await runEpicMission(
      baseDeps({
        planEpics: async () => [phase('a')],
        epicParallelTasks: 2,
        planEpicTasks: async () => [phase('t1'), phase('t2')],
        judgeEpic: async () => null,
        note: (line) => notes.push(line),
      })
    );
    expect(r.success).toBe(true);
    // the fail-open is never invisible
    expect(notes.some((n) => n.includes('acceptance judge unavailable'))).toBe(true);
  });

  it('a judge-rejected attempt completes its task record as FAILED, not done', async () => {
    const completions: boolean[] = [];
    await runEpicMission(
      baseDeps({
        planEpics: async () => [phase('a')],
        epicParallelTasks: 2,
        maxAttemptsPerEpic: 1,
        planEpicTasks: async () => [phase('t1'), phase('t2')],
        judgeEpic: async () => ({ passed: false, feedback: 'incomplete' }),
        openTask: async () => ({ id: 't-1' }) as never,
        completeTask: (_record, r) => completions.push(r.success),
      })
    );
    expect(completions).toEqual([false]); // record reflects the JUDGED outcome
  });

  it('a runOrchestrated exception PROPAGATES — never a silent classic restart', async () => {
    let attempts = 0;
    await expect(
      runEpicMission(
        baseDeps({
          planEpics: async () => [phase('a')],
          epicParallelTasks: 2,
          maxAttemptsPerEpic: 3,
          planEpicTasks: async () => [phase('t1'), phase('t2')],
          runOrchestrated: async () => {
            attempts++;
            throw new Error('partial merge then crash');
          },
        })
      )
    ).rejects.toThrow('partial merge then crash');
    expect(attempts).toBe(1); // no retry on a partially-merged tree
  });

  it('a FAILED contracts epic locks nothing', async () => {
    const locks: string[][] = [];
    await runEpicMission(
      baseDeps({
        planEpics: async () => [phase('contracts', { contracts: true }), phase('impl', { deps: ['contracts'] })],
        maxAttemptsPerEpic: 1,
        runEpicLoop: async () =>
          ok({ success: false, history: [{ filesApplied: ['src/types.ts'] } as never] }),
        lockContracts: (files) => {
          locks.push(files);
          return files;
        },
      })
    );
    expect(locks).toEqual([]); // only an ACCEPTED contracts epic locks
  });
});

describe('PR #519 follow-up behaviors', () => {
  it('a CONTRACTS epic accepted VIA SPLIT still locks — each piece carries the flag', async () => {
    const locks: string[][] = [];
    const r = await runEpicMission(
      baseDeps({
        planEpics: async () => [phase('contracts', { contracts: true }), phase('impl', { deps: ['contracts'] })],
        maxAttemptsPerEpic: 1,
        splitOnAnyFailure: true,
        splitDepth: 1,
        planSplit: async () => [phase('c-piece-1'), phase('c-piece-2')],
        runEpicLoop: async (scoped) =>
          scoped.includes('EPIC — contracts')
            ? ok({ success: false }) // the whole contracts epic fails -> split
            : ok({
                success: true,
                // Discriminate on the EPIC header — piece names also appear in
                // the second piece's ALREADY BUILT priors.
                history: [{ filesApplied: [scoped.includes('EPIC — c-piece-2') ? 'src/b.ts' : 'src/a.ts'] } as never],
              }),
        lockContracts: (files) => {
          locks.push(files);
          return files;
        },
      })
    );
    expect(r.success).toBe(true);
    // each accepted contracts PIECE locked its own files (previously: nothing)
    expect(locks.length).toBeGreaterThanOrEqual(2);
    expect(locks.flat()).toContain('src/a.ts');
    expect(locks.flat()).toContain('src/b.ts');
  });

  it('planner-emitted criteria reach the epic spec judge clause (previously dead)', async () => {
    const specs: string[] = [];
    await runEpicMission(
      baseDeps({
        planEpics: async () => [
          { ...phase('a'), criteria: ['clicking Save persists the record'] },
          phase('b', { deps: ['a'] }),
        ],
        setEpicSpec: (spec) => specs.push(spec),
      })
    );
    expect(specs[0]).toContain('Acceptance criteria:');
    expect(specs[0]).toContain('clicking Save persists the record');
    expect(specs[1]).not.toContain('Acceptance criteria:');
  });

  it('a budget-stopped attempt reports the STRUCTURED field to the controller', async () => {
    const splitCalls: string[] = [];
    await runEpicMission(
      baseDeps({
        planEpics: async () => [phase('big'), phase('other')],
        maxAttemptsPerEpic: 1,
        splitDepth: 1,
        planSplit: async (g) => {
          splitCalls.push(g);
          return [phase('p1'), phase('p2')];
        },
        runEpicLoop: async (scoped) =>
          scoped.includes('EPIC — big')
            ? ok({ success: false, history: [{ filesApplied: [], budgetStopped: true } as never] })
            : ok(),
      })
    );
    // split fired via the structured signal (splitOnAnyFailure is false here)
    expect(splitCalls.length).toBe(1);
  });
});
