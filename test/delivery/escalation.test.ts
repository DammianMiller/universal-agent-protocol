import { describe, it, expect } from 'vitest';
import { createEscalationController } from '../../src/delivery/escalation.js';
import type { IterationRecord } from '../../src/delivery/convergence-loop.js';

function record(turn: number, score: number, passed = false): IterationRecord {
  return { turn, passed, score, gateResults: [], filesApplied: [], durationMs: 1 };
}

describe('escalation controller', () => {
  it('does not escalate while the score keeps improving', () => {
    const ctrl = createEscalationController({
      tiers: [{ label: 't1', setCandidates: 3 }],
      stagnationTurns: 2,
    });
    expect(ctrl.onIteration(record(1, 0.2))).toEqual({});
    expect(ctrl.onIteration(record(2, 0.4))).toEqual({});
    expect(ctrl.onIteration(record(3, 0.6))).toEqual({});
    expect(ctrl.tierIndex()).toBe(0);
  });

  it('advances one tier after the configured stagnation window', () => {
    const escalated: string[] = [];
    const ctrl = createEscalationController({
      tiers: [
        { label: 'widen', setCandidates: 3 },
        { label: 'critic', enableCritic: true },
      ],
      stagnationTurns: 2,
      onEscalate: (tier) => escalated.push(tier.label),
    });

    expect(ctrl.onIteration(record(1, 0.5))).toEqual({}); // new best
    expect(ctrl.onIteration(record(2, 0.5))).toEqual({}); // stagnant 1
    const d = ctrl.onIteration(record(3, 0.5)); // stagnant 2 → escalate
    expect(d.setCandidates).toBe(3);
    expect(d.note).toContain('widen');
    expect(escalated).toEqual(['widen']);
    expect(ctrl.tierIndex()).toBe(1);
  });

  it('climbs through tiers and then stops escalating when exhausted', () => {
    const switchExecutor = async (): Promise<string> => 'x';
    const ctrl = createEscalationController({
      tiers: [
        { label: 'widen', setCandidates: 3 },
        { label: 'critic', enableCritic: true },
        { label: 'model', switchExecutor, raiseMaxTurns: 8 },
      ],
      stagnationTurns: 1,
    });

    // Each stagnant turn (no improvement past 0.5) advances one tier
    expect(ctrl.onIteration(record(1, 0.5))).toEqual({}); // sets best
    expect(ctrl.onIteration(record(2, 0.5)).setCandidates).toBe(3); // tier 0
    expect(ctrl.onIteration(record(3, 0.5)).enableCritic).toBe(true); // tier 1
    const t3 = ctrl.onIteration(record(4, 0.5)); // tier 2
    expect(t3.switchExecutor).toBe(switchExecutor);
    expect(t3.raiseMaxTurns).toBe(8);
    // Exhausted — no further directives
    expect(ctrl.onIteration(record(5, 0.5))).toEqual({});
    expect(ctrl.tierIndex()).toBe(3);
  });

  it('never escalates on a passing turn', () => {
    const ctrl = createEscalationController({
      tiers: [{ label: 't', setCandidates: 3 }],
      stagnationTurns: 1,
    });
    expect(ctrl.onIteration(record(1, 1, true))).toEqual({});
    expect(ctrl.tierIndex()).toBe(0);
  });
});

describe('defaultEscalationLadder exploration gating', () => {
  it('includes widen + reseed tiers by default', async () => {
    const { defaultEscalationLadder } = await import('../../src/delivery/escalation.js');
    const tiers = defaultEscalationLadder({});
    expect(tiers.some((t) => t.setCandidates !== undefined)).toBe(true);
    expect(tiers.some((t) => t.regenerateSeeds)).toBe(true);
  });

  it('omits ALL exploration tiers for agentic runs (includeExploration: false)', async () => {
    const { defaultEscalationLadder } = await import('../../src/delivery/escalation.js');
    const strong = async (): Promise<string> => 'x';
    const tiers = defaultEscalationLadder({
      includeExploration: false,
      escalateExecutor: strong,
    });
    expect(tiers.some((t) => t.setCandidates !== undefined)).toBe(false);
    expect(tiers.some((t) => t.regenerateSeeds)).toBe(false);
    // critic + model-switch tiers remain
    expect(tiers.some((t) => t.enableCritic)).toBe(true);
    expect(tiers.some((t) => t.switchExecutor === strong)).toBe(true);
  });
});

