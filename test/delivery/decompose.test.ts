/**
 * Mission decomposition: phase-plan parsing, auto-decompose policy, and the
 * per-phase instruction composition.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
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

  it('returns the parsed plan when the model produces one', async () => {
    const phases = await planDeliveryPhases(
      'task',
      async () => '[{"id":"a","title":"A","goal":"ga"},{"id":"b","title":"B","goal":"gb"}]'
    );
    expect(phases.length).toBe(2);
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
