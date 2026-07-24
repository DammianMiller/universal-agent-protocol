import { describe, it, expect } from 'vitest';
import {
  RoutingPresets,
  resolvePhaseChain,
  resolvePresetModel,
  tiersToRoutingMatrix,
  selectPhaseModel,
  type RoutingPreset,
} from '../../src/models/types.js';

// S3 — per-phase × per-tier routing matrix. resolvePhaseChain is the new pure
// seam; these lock the union (string tier vs PhaseModels) + backward compat.

const legacy = RoutingPresets['cost-tiered']; // string tiers
const adaptive = RoutingPresets['adaptive-tiered']; // PhaseModels tiers

describe('resolvePhaseChain — legacy string tiers', () => {
  it('a string tier is the EXECUTE model; execute→[tier]', () => {
    expect(resolvePhaseChain(legacy, { complexity: 'high', phase: 'execute' })).toEqual(['opus-4.8']);
  });
  it('non-execute phases fall to the role model for a string tier', () => {
    expect(resolvePhaseChain(legacy, { complexity: 'high', phase: 'review' })).toEqual([legacy.roles.reviewer]);
    expect(resolvePhaseChain(legacy, { complexity: 'high', phase: 'plan' })).toEqual([legacy.roles.planner]);
  });
  it('no complexity → the role model', () => {
    expect(resolvePhaseChain(legacy, { phase: 'execute' })).toEqual([legacy.roles.executor]);
  });
});

describe('resolvePhaseChain — PhaseModels tiers (adaptive-tiered)', () => {
  it('returns the full escalation chain for a defined phase', () => {
    expect(resolvePhaseChain(adaptive, { complexity: 'high', phase: 'execute' })).toEqual([
      'sonnet-5',
      'opus-4.8',
    ]);
    expect(resolvePhaseChain(adaptive, { complexity: 'high', phase: 'review' })).toEqual(['sonnet-5', 'opus-4.8']);
  });

  it('an omitted phase falls to the role model by default', () => {
    // low tier omits plan+review
    expect(resolvePhaseChain(adaptive, { complexity: 'low', phase: 'plan' })).toEqual([adaptive.roles.planner]);
  });

  it('an omitted phase is SKIPPED (empty chain) when allowSkip is set', () => {
    expect(resolvePhaseChain(adaptive, { complexity: 'low', phase: 'plan', allowSkip: true })).toEqual([]);
    expect(resolvePhaseChain(adaptive, { complexity: 'low', phase: 'review', allowSkip: true })).toEqual([]);
    // execute is defined at low, so it is never skipped
    expect(resolvePhaseChain(adaptive, { complexity: 'low', phase: 'execute', allowSkip: true })).toEqual([
      'qwen36-a3b',
      'sonnet-5',
    ]);
  });

  it('returns a copy, not the internal array', () => {
    const c = resolvePhaseChain(adaptive, { complexity: 'high', phase: 'execute' });
    c.push('mutated');
    expect(resolvePhaseChain(adaptive, { complexity: 'high', phase: 'execute' })).toEqual([
      'sonnet-5',
      'opus-4.8',
    ]);
  });
});

describe('resolvePresetModel — primary == chain[0], back-compat', () => {
  it('string tier still returns the tier model for the executor role', () => {
    expect(resolvePresetModel(legacy, { complexity: 'high', role: 'executor' })).toBe('opus-4.8');
    expect(resolvePresetModel(legacy, { complexity: 'low' })).toBe('qwen36-a3b');
  });
  it('PhaseModels tier returns the primary of the requested phase chain', () => {
    expect(resolvePresetModel(adaptive, { complexity: 'high', phase: 'execute' })).toBe('sonnet-5');
    expect(resolvePresetModel(adaptive, { complexity: 'high', phase: 'review' })).toBe('sonnet-5');
  });
  it('primary equals the first element of the chain', () => {
    const chain = resolvePhaseChain(adaptive, { complexity: 'critical', phase: 'execute' });
    expect(resolvePresetModel(adaptive, { complexity: 'critical', phase: 'execute' })).toBe(chain[0]);
  });
});

describe('tiersToRoutingMatrix — both tier forms', () => {
  it('string tiers pass through unchanged', () => {
    expect(tiersToRoutingMatrix(legacy)).toEqual({
      low: 'qwen36-a3b',
      medium: 'qwen36-a3b',
      high: 'opus-4.8',
      critical: 'opus-4.8',
    });
  });
  it('PhaseModels tiers contribute their execute primary (monotonic, no inversion)', () => {
    const m = tiersToRoutingMatrix(adaptive);
    expect(m).toEqual({
      low: 'qwen36-a3b',
      medium: 'sonnet-5',
      high: 'sonnet-5',
      critical: 'sonnet-5',
    });
  });
  it('a preset without tiers yields undefined', () => {
    const noTiers: RoutingPreset = { ...RoutingPresets['fable-local-opus'] };
    expect(tiersToRoutingMatrix(noTiers)).toBeUndefined();
  });
});

describe('selectPhaseModel — Q4 canonical selector', () => {
  it('returns the primary of the phase chain (= resolvePhaseChain[0])', () => {
    expect(selectPhaseModel(adaptive, { complexity: 'high', phase: 'execute' })).toBe(
      resolvePhaseChain(adaptive, { complexity: 'high', phase: 'execute' })[0]
    );
    expect(selectPhaseModel(adaptive, { complexity: 'high', phase: 'review' })).toBe('sonnet-5');
  });
  it('falls back to the executor role when a phase resolves empty', () => {
    // legacy string tier, plan phase → role model (planner), never empty
    expect(selectPhaseModel(legacy, { complexity: 'high', phase: 'plan' })).toBe(legacy.roles.planner);
  });
});
