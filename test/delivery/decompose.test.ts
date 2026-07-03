/**
 * Mission decomposition: phase-plan parsing, auto-decompose policy, and the
 * per-phase instruction composition.
 */

import { describe, it, expect } from 'vitest';
import {
  parsePhaseArray,
  planDeliveryPhases,
  phaseInstruction,
  shouldDecompose,
} from '../../src/delivery/decompose.js';

describe('parsePhaseArray', () => {
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

  it('drops malformed entries, dedupes slugs, and caps at 5 phases', () => {
    const entries = Array.from({ length: 8 }, (_, i) => ({
      id: i < 2 ? 'same' : `p${i}`,
      title: `T${i}`,
      goal: `G${i}`,
    }));
    const raw = JSON.stringify([{ id: 'bad' }, ...entries]);
    const phases = parsePhaseArray(raw);
    expect(phases.length).toBe(5);
    expect(new Set(phases.map((p) => p.id)).size).toBe(5);
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
