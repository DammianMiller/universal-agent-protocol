/**
 * Mission decomposition: phase-plan parsing, auto-decompose policy, and the
 * per-phase instruction composition.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  appendGapClosurePhase,
  GAP_CLOSURE_ID,
  parsePhaseArray,
  planDeliveryPhases,
  phaseInstruction,
  shouldDecompose,
} from '../../src/delivery/decompose.js';

describe('parsePhaseArray', () => {
  it('carries the contracts flag through (and drops non-true values)', () => {
    const raw = JSON.stringify([
      { id: 'contracts', title: 'Shared Contracts', goal: 'define the shared types', contracts: true },
      { id: 'impl', title: 'Implementation', goal: 'build against the contracts', deps: ['contracts'], contracts: 'yes' },
    ]);
    const phases = parsePhaseArray(raw);
    expect(phases[0].contracts).toBe(true);
    expect(phases[1].contracts).toBeUndefined();
  });

  it('carries the scaffold flag through', () => {
    const raw = JSON.stringify([
      { id: 'skel', title: 'Module Skeleton', goal: 'signatures + todo bodies', scaffold: true },
      { id: 'fill', title: 'Implement', goal: 'fill the bodies', deps: ['skel'] },
    ]);
    const phases = parsePhaseArray(raw);
    expect(phases[0].scaffold).toBe(true);
    expect(phases[1].scaffold).toBeUndefined();
  });

  it('extracts a valid phase plan from noisy model output', () => {
    const raw = [
      'Here is the plan:',
      '[{"id": "scaffold", "title": "Scaffold", "goal": "Create the module skeleton"},',
      ' {"id": "impl", "title": "Implement", "goal": "Implement the core logic"},',
      ' {"id": "tests", "title": "Tests", "goal": "Add tests so gates pass"}]',
      'done.',
    ].join('\n');
    const phases = parsePhaseArray(raw);
    expect(phases.map((p) => p.id)).toEqual(['scaffold', 'impl', 'tests']);
    expect(phases[1].goal).toBe('Implement the core logic');
  });

  it('drops malformed entries and dedupes slugs (default cap 8)', () => {
    const entries = Array.from({ length: 8 }, (_, i) => ({
      id: i < 2 ? 'same' : `p${i}`,
      title: `T${i}`,
      goal: `G${i}`,
    }));
    // 8 entries, first two share the slug 'same' -> 7 unique, all within the
    // default cap of 8, and the malformed {id:'bad'} entry is dropped.
    const raw = JSON.stringify([{ id: 'bad' }, ...entries]);
    const phases = parsePhaseArray(raw);
    expect(phases.length).toBe(7);
    expect(new Set(phases.map((p) => p.id)).size).toBe(7);
  });

  it('returns [] on garbage', () => {
    expect(parsePhaseArray('no json here')).toEqual([]);
    expect(parsePhaseArray('[1, 2, 3]')).toEqual([]);
  });
});

describe('shouldDecompose', () => {
  const epic = 'x'.repeat(250);
  it('only fires for complex-classified, epic-length instructions', () => {
    expect(shouldDecompose(epic, 'complex')).toBe(true);
    expect(shouldDecompose(epic, 'moderate')).toBe(false);
    expect(shouldDecompose('short but complex', 'complex')).toBe(false);
  });
});

describe('planDeliveryPhases', () => {
  it('fails soft to [] on executor error or degenerate plans', async () => {
    expect(
      await planDeliveryPhases('task', async () => {
        throw new Error('model down');
      })
    ).toEqual([]);
    expect(
      await planDeliveryPhases('task', async () => '[{"id":"only","title":"One","goal":"g"}]')
    ).toEqual([]);
  });

  it('retries the planner ONCE on an unparseable plan, then falls back loudly', async () => {
    let calls = 0;
    const phases = await planDeliveryPhases('big multi-part mission', async () => {
      calls++;
      return calls === 1
        ? 'sorry, here is prose instead of JSON'
        : '[{"id":"a","title":"A","goal":"ga"},{"id":"b","title":"B","goal":"gb"},{"id":"c","title":"C","goal":"gc"}]';
    });
    expect(phases.length).toBeGreaterThanOrEqual(2);
    expect(calls).toBeGreaterThanOrEqual(2);

    let calls2 = 0;
    const none = await planDeliveryPhases('mission', async () => {
      calls2++;
      return 'still not json';
    });
    expect(none).toEqual([]); // degenerate after both attempts
    expect(calls2).toBe(2); // exactly one retry — bounded
  });

  it('returns the parsed plan when the model produces one', async () => {
    const phases = await planDeliveryPhases(
      'task',
      async () => '[{"id":"a","title":"A","goal":"ga"},{"id":"b","title":"B","goal":"gb"}]'
    );
    expect(phases.length).toBe(2);
  });
});

describe('planDeliveryPhases pre-execution validation (ATG thought experiment)', () => {
  const PLAN2 = '[{"id":"a","title":"A","goal":"ga"},{"id":"b","title":"B","goal":"gb"}]';
  const PLAN3 = '[{"id":"a","title":"A","goal":"ga"},{"id":"m","title":"M","goal":"gm"},{"id":"b","title":"B","goal":"gb"}]';

  it('keeps the plan when the thought experiment passes (plan call + one verdict call)', async () => {
    const prompts: string[] = [];
    const phases = await planDeliveryPhases('mission', async (pr) => {
      prompts.push(pr);
      return prompts.length === 1 ? PLAN2 : '{"verdict":"pass","findings":[]}';
    });
    expect(phases.length).toBe(2);
    expect(prompts.length).toBe(2);
    expect(prompts[1]).toContain('plan validator'); // second call is the judge
  });

  it('re-plans ONCE with the findings when the verdict fails', async () => {
    const prompts: string[] = [];
    const phases = await planDeliveryPhases('mission', async (pr) => {
      prompts.push(pr);
      if (prompts.length === 1) return PLAN2;
      if (prompts.length === 2) return '{"verdict":"fail","findings":["missing migration phase"]}';
      return PLAN3; // the re-plan
    });
    expect(prompts.length).toBe(3);
    expect(prompts[2]).toContain('PLAN REVIEW FINDINGS');
    expect(prompts[2]).toContain('missing migration phase');
    expect(phases.length).toBe(3); // the repaired plan won
  });

  it('appends the gap-closure phase when the re-plan is unusable (review findings must not be dropped)', async () => {
    const prompts: string[] = [];
    const phases = await planDeliveryPhases('mission', async (pr) => {
      prompts.push(pr);
      if (prompts.length === 1) return PLAN2;
      if (prompts.length === 2) return '{"verdict":"fail","findings":["x"]}';
      return 'garbage — no plan here';
    });
    // Original phases stand, PLUS a final gap-closure phase carrying the
    // findings — a reviewed-incomplete set of phases no longer proceeds as-is.
    expect(phases.length).toBe(3);
    expect(phases[2].id).toBe('plan-gap-closure');
    expect(phases[2].goal).toContain('x');
    expect(phases[2].deps).toEqual(phases.slice(0, 2).map((p) => p.id));
  });

  it('honors the opts.thoughtExperiment=false kill switch (single call)', async () => {
    let calls = 0;
    const phases = await planDeliveryPhases(
      'mission',
      async () => {
        calls++;
        return PLAN2;
      },
      undefined,
      { thoughtExperiment: false }
    );
    expect(phases.length).toBe(2);
    expect(calls).toBe(1);
  });

  it('honors UAP_DELIVER_PLAN_CHECK=0 (single call)', async () => {
    process.env.UAP_DELIVER_PLAN_CHECK = '0';
    try {
      let calls = 0;
      await planDeliveryPhases('mission', async () => {
        calls++;
        return PLAN2;
      });
      expect(calls).toBe(1);
    } finally {
      delete process.env.UAP_DELIVER_PLAN_CHECK;
    }
  });

  it('a STRUCTURAL defect (dependency cycle) triggers the re-plan without a judge call', async () => {
    const CYCLIC = '[{"id":"a","title":"A","goal":"ga","deps":["b"]},{"id":"b","title":"B","goal":"gb","deps":["a"]}]';
    const prompts: string[] = [];
    const phases = await planDeliveryPhases('mission', async (pr) => {
      prompts.push(pr);
      return prompts.length === 1 ? CYCLIC : PLAN3;
    });
    expect(prompts.length).toBe(2); // plan + re-plan; NO thought-experiment call
    expect(prompts[1]).toContain('PLAN REVIEW FINDINGS');
    expect(prompts[1]).toContain('cycle');
    expect(phases.length).toBe(3); // the structurally-clean re-plan won
  });

  it('a structurally-INVALID re-plan is rejected — original phases stand, gap-closure appended', async () => {
    const CYCLIC = '[{"id":"a","title":"A","goal":"ga","deps":["b"]},{"id":"b","title":"B","goal":"gb","deps":["a"]}]';
    const prompts: string[] = [];
    const phases = await planDeliveryPhases('mission', async (pr) => {
      prompts.push(pr);
      if (prompts.length === 1) return PLAN2;
      if (prompts.length === 2) return '{"verdict":"fail","findings":["x"]}';
      return CYCLIC; // re-plan is itself defective
    });
    // The defective re-plan is never adopted; the original phases stand and the
    // review findings ride in a final gap-closure phase instead of vanishing.
    expect(phases.slice(0, 2).map((p) => p.id).sort()).toEqual(['a', 'b']);
    expect(phases[2]?.id).toBe('plan-gap-closure');
  });

  it('a STRUCTURAL failure with an unusable re-plan keeps the original untouched (no gap phase)', async () => {
    const CYCLIC = '[{"id":"a","title":"A","goal":"ga","deps":["b"]},{"id":"b","title":"B","goal":"gb","deps":["a"]}]';
    const prompts: string[] = [];
    const phases = await planDeliveryPhases('mission', async (pr) => {
      prompts.push(pr);
      return prompts.length === 1 ? CYCLIC : 'garbage — no plan here';
    });
    // A cycle is not closable by an extra phase — structural failures keep the
    // original so downstream skip-handling stays deterministic.
    expect(phases.map((p) => p.id).sort()).toEqual(['a', 'b']);
    expect(phases.some((p) => p.id === 'plan-gap-closure')).toBe(false);
  });
});

describe('phaseInstruction', () => {
  it('carries mission context, the phase goal, and prior-phase summaries', () => {
    const phases = [
      { id: 'a', title: 'A', goal: 'do a' },
      { id: 'b', title: 'B', goal: 'do b' },
    ];
    const text = phaseInstruction('the mission', phases, 1, ['A: done in 2 turns']);
    expect(text).toContain('FULL MISSION');
    expect(text).toContain('the mission');
    expect(text).toContain('CURRENT PHASE 2/2 — B');
    expect(text).toContain('do b');
    expect(text).toContain('A: done in 2 turns');
  });
});


describe('configurable phase cap (UAP_DELIVER_MAX_PHASES)', () => {
  const mk = (n: number) =>
    JSON.stringify(
      Array.from({ length: n }, (_, i) => ({ id: `p${i}`, title: `Phase ${i}`, goal: `do ${i}` }))
    );

  afterEach(() => {
    delete process.env.UAP_DELIVER_MAX_PHASES;
  });

  it('defaults to allowing more than the old 5-phase ceiling', () => {
    // 7 well-formed phases — the old cap was 5; the new default (8) keeps all 7.
    expect(parsePhaseArray(mk(7))).toHaveLength(7);
  });

  it('honors an explicit UAP_DELIVER_MAX_PHASES override', () => {
    process.env.UAP_DELIVER_MAX_PHASES = '3';
    expect(parsePhaseArray(mk(9))).toHaveLength(3);
  });

  it('clamps a runaway override to the hard ceiling (20)', () => {
    process.env.UAP_DELIVER_MAX_PHASES = '999';
    expect(parsePhaseArray(mk(25))).toHaveLength(20);
  });
});

describe('phase acceptance criteria (PR #519 follow-up)', () => {
  it('parsePhaseArray carries criteria through, filtered and capped', () => {
    const raw = JSON.stringify([
      { id: 'a', title: 'A', goal: 'ga', criteria: ['  saves the record  ', 42, '', 'x'.repeat(500)] },
      { id: 'b', title: 'B', goal: 'gb' },
    ]);
    const phases = parsePhaseArray(raw);
    expect(phases[0].criteria).toEqual(['saves the record', 'x'.repeat(200)]);
    expect(phases[1].criteria).toBeUndefined();
  });

  it('caps criteria at six entries', () => {
    const raw = JSON.stringify([
      { id: 'a', title: 'A', goal: 'ga', criteria: Array.from({ length: 9 }, (_, i) => `c${i}`) },
      { id: 'b', title: 'B', goal: 'gb' },
    ]);
    expect(parsePhaseArray(raw)[0].criteria).toHaveLength(6);
  });
});

describe('appendGapClosurePhase', () => {
  const base = [
    { id: 'contracts', title: 'C', goal: 'g' },
    { id: 'impl', title: 'I', goal: 'g', deps: ['contracts'] },
  ];

  it('appends a final phase depending on every existing phase, carrying the findings', () => {
    const out = appendGapClosurePhase(base, ['Missing UI implementation phase', 'Missing README phase']);
    expect(out).not.toBeNull();
    const gap = out![out!.length - 1];
    expect(gap.id).toBe(GAP_CLOSURE_ID);
    expect(gap.deps).toEqual(['contracts', 'impl']); // topologically last ⇒ final epic ⇒ whole-mission gates run there
    expect(gap.goal).toContain('Missing UI implementation phase');
    expect(gap.goal).toContain('Missing README phase');
    expect(out!.slice(0, -1)).toEqual(base); // existing phases untouched
  });

  it('returns null on id collision or empty input (never corrupts the graph)', () => {
    expect(appendGapClosurePhase([], ['x'])).toBeNull();
    const withGap = appendGapClosurePhase(base, ['x'])!;
    expect(appendGapClosurePhase(withGap, ['y'])).toBeNull(); // already present
  });
});
