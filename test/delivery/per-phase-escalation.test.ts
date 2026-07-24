import { describe, it, expect } from 'vitest';
import {
  resolveEscalation,
  phaseMayEscalate,
  defaultCapabilityPick,
} from '../../src/delivery/per-phase-escalation.js';
import { RoutingPresets } from '../../src/models/types.js';

const adaptive = RoutingPresets['adaptive-tiered'];

describe('resolveEscalation — hybrid policy', () => {
  it('walks the fixed chain rung by rung (execute: high = [sonnet, opus])', () => {
    const r0 = resolveEscalation({ preset: adaptive, complexity: 'high', phase: 'execute', rung: 0 });
    const r1 = resolveEscalation({ preset: adaptive, complexity: 'high', phase: 'execute', rung: 1 });
    expect(r0).toMatchObject({ model: 'sonnet-5', policy: 'fixed', exhausted: false });
    expect(r1).toMatchObject({ model: 'opus-4.8', policy: 'fixed', exhausted: false });
  });

  it('defers to the capability ceiling once the fixed chain is exhausted', () => {
    // high.execute has 2 entries; rung 2 is past it → capability
    const r2 = resolveEscalation({ preset: adaptive, complexity: 'high', phase: 'execute', rung: 2 });
    expect(r2.policy).toBe('capability');
    expect(r2.exhausted).toBe(true);
    expect(r2.model).toBe(defaultCapabilityPick(adaptive)); // fallback role = opus-4.8
  });

  it('each phase escalates on its OWN ladder (execute ≠ review)', () => {
    const exec = resolveEscalation({ preset: adaptive, complexity: 'high', phase: 'execute', rung: 0 });
    const review = resolveEscalation({ preset: adaptive, complexity: 'high', phase: 'review', rung: 0 });
    // both start at sonnet here, but advancing execute must not change review
    const execNext = resolveEscalation({ preset: adaptive, complexity: 'high', phase: 'execute', rung: 1 });
    expect(execNext.model).toBe('opus-4.8');
    expect(review.model).toBe('sonnet-5');
    expect(exec.model).toBe('sonnet-5');
  });

  it('honors an injected capability picker for the final rung', () => {
    const r = resolveEscalation({
      preset: adaptive,
      complexity: 'low',
      phase: 'execute',
      rung: 99,
      capabilityPick: () => 'custom-ceiling',
    });
    expect(r).toMatchObject({ model: 'custom-ceiling', policy: 'capability', exhausted: true });
  });

  it('clamps negative rungs to the primary', () => {
    const r = resolveEscalation({ preset: adaptive, complexity: 'high', phase: 'execute', rung: -5 });
    expect(r.model).toBe('sonnet-5');
    expect(r.rung).toBe(0);
  });

  it('a string-tier preset escalates execute then hits the ceiling', () => {
    const cost = RoutingPresets['cost-tiered']; // string tiers
    const r0 = resolveEscalation({ preset: cost, complexity: 'high', phase: 'execute', rung: 0 });
    const r1 = resolveEscalation({ preset: cost, complexity: 'high', phase: 'execute', rung: 1 });
    expect(r0).toMatchObject({ model: 'opus-4.8', policy: 'fixed' }); // string tier = single execute model
    expect(r1.policy).toBe('capability'); // chain length 1 → rung 1 is capability
  });
});

describe('phaseMayEscalate — effort scope gating', () => {
  it('execute escalates under everything but the fallback-only scope', () => {
    expect(phaseMayEscalate('execute', 'execute')).toBe(true);
    expect(phaseMayEscalate('execute', 'all')).toBe(true);
    expect(phaseMayEscalate('execute', 'fallback')).toBe(false);
  });
  it('plan only escalates at plan+execute and above', () => {
    expect(phaseMayEscalate('plan', 'execute')).toBe(false);
    expect(phaseMayEscalate('plan', 'plan+execute')).toBe(true);
    expect(phaseMayEscalate('plan', 'all')).toBe(true);
  });
  it('review/reflect only escalate at all / all+fallback', () => {
    expect(phaseMayEscalate('review', 'plan+execute')).toBe(false);
    expect(phaseMayEscalate('review', 'all')).toBe(true);
    expect(phaseMayEscalate('reflect', 'all+fallback')).toBe(true);
  });
});
