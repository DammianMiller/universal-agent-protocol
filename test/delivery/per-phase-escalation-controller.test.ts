import { describe, it, expect } from 'vitest';
import { createPerPhaseEscalationController } from '../../src/delivery/per-phase-escalation-controller.js';
import { RoutingPresets } from '../../src/models/types.js';
import type { IterationRecord } from '../../src/delivery/convergence-loop.js';

const adaptive = RoutingPresets['adaptive-tiered'];

function rec(turn: number, score: number, passed = false): IterationRecord {
  // a VERIFIED-but-failing turn populates gateResults (an inconclusive turn does not)
  return {
    turn,
    passed,
    score,
    gateResults: [{ id: 'g', name: 'g', passed, skipped: false, exitCode: passed ? 0 : 1, durationMs: 1, outputTail: '' }],
    filesApplied: ['f.ts'],
  };
}

function makeController(scope: Parameters<typeof createPerPhaseEscalationController>[0]['scope'] = 'all') {
  const escalations: Array<{ rung: number; model: string; policy: string }> = [];
  const ctrl = createPerPhaseEscalationController({
    preset: adaptive,
    complexity: 'high', // high.execute = [sonnet-5, opus-4.8]
    scope,
    bindExecutor: (id) => async () => `bound:${id}`,
    stagnationTurns: 2,
    onEscalate: (i) => escalations.push(i),
  });
  return { ctrl, escalations };
}

describe('createPerPhaseEscalationController', () => {
  it('walks the execute chain then the capability ceiling on repeated stagnation', () => {
    const { ctrl, escalations } = makeController();
    // turn 1 sets the baseline; two subsequent non-improving turns → first
    // escalation (rung 1 = the chain's next entry = opus-4.8).
    ctrl.onIteration(rec(1, 0.5)); // baseline
    ctrl.onIteration(rec(2, 0.5)); // stagnant 1
    const d1 = ctrl.onIteration(rec(3, 0.5)); // stagnant 2 → escalate
    expect(d1.switchExecutor).toBeDefined();
    expect(ctrl.rung()).toBe(1);
    expect(escalations[0]).toMatchObject({ rung: 1, model: 'opus-4.8', policy: 'fixed' });

    // two more non-improving → rung 2 = past chain (len 2) → capability ceiling
    ctrl.onIteration(rec(4, 0.5)); // stagnant 1
    ctrl.onIteration(rec(5, 0.5)); // stagnant 2 → escalate
    expect(ctrl.rung()).toBe(2);
    expect(escalations[1]).toMatchObject({ rung: 2, policy: 'capability' });
    expect(escalations[1].model).toBe(adaptive.roles.fallback); // opus-4.8 ceiling
  });

  it('does nothing on a passing turn', () => {
    const { ctrl } = makeController();
    const d = ctrl.onIteration(rec(1, 1.0, true));
    expect(d.switchExecutor).toBeUndefined();
    expect(ctrl.rung()).toBe(0);
  });

  it('resets stagnation when the score improves', () => {
    const { ctrl, escalations } = makeController();
    ctrl.onIteration(rec(1, 0.3));
    ctrl.onIteration(rec(2, 0.6)); // improvement → reset
    ctrl.onIteration(rec(3, 0.6)); // stagnant 1
    expect(ctrl.rung()).toBe(0); // not yet at stagnationTurns=2 after the reset
    expect(escalations.length).toBe(0);
  });

  it('does not count infra-flaky turns (executor error / no gates) toward stagnation', () => {
    const { ctrl, escalations } = makeController();
    // two executor-error turns must NOT trigger escalation
    ctrl.onIteration({ turn: 1, passed: false, score: 0, gateResults: [], filesApplied: [], executorError: '429' });
    ctrl.onIteration({ turn: 2, passed: false, score: 0, gateResults: [], filesApplied: [], executorError: '503' });
    expect(ctrl.rung()).toBe(0);
    expect(escalations.length).toBe(0);
  });

  it('stops re-emitting switches once the capability ceiling is reached', () => {
    const { ctrl, escalations } = makeController();
    // drive well past the chain length (2) to reach + exceed the ceiling
    for (let t = 1; t <= 12; t++) ctrl.onIteration(rec(t, 0.5));
    // chain len 2 → rung 1 (fixed), rung 2 (capability, ceiling) → then stops
    expect(escalations.length).toBe(2);
    expect(escalations[1].policy).toBe('capability');
  });

  it('does not escalate execute when the effort scope forbids it', () => {
    const { ctrl } = makeController('fallback'); // execute may NOT escalate under fallback-only
    ctrl.onIteration(rec(1, 0.5));
    const d = ctrl.onIteration(rec(2, 0.5));
    expect(d.switchExecutor).toBeUndefined();
    expect(ctrl.rung()).toBe(0);
  });
});
