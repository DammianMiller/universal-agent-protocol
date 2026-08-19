/**
 * Complexity-tier routing: presets route the EXECUTION model by task
 * complexity (cost/speed control), coherently with the lifecycle roles.
 */

import { describe, it, expect } from 'vitest';
import {
  RoutingPresets,
  tiersToRoutingMatrix,
  resolvePresetModel,
} from '../../src/models/types.js';

describe('complexity-tier routing presets', () => {
  it('ships cost-tiered and speed-tiered presets with a full tier map', () => {
    const cost = RoutingPresets['cost-tiered'];
    expect(cost.tiers).toMatchObject({ low: 'qwen38-27b', high: 'opus-4.8', critical: 'opus-4.8' });
    const speed = RoutingPresets['speed-tiered'];
    expect(speed.tiers).toMatchObject({ low: 'haiku-4.5', high: 'fable-5', critical: 'opus-4.8' });
  });

  it('tiersToRoutingMatrix materializes a single-model-per-tier map (router form)', () => {
    const m = tiersToRoutingMatrix(RoutingPresets['cost-tiered']);
    expect(m).toEqual({ low: 'qwen38-27b', medium: 'qwen38-27b', high: 'opus-4.8', critical: 'opus-4.8' });
    // a preset without tiers yields undefined -> router falls back to roles
    expect(tiersToRoutingMatrix(RoutingPresets['fable-local-opus'])).toBeUndefined();
  });

  it('resolvePresetModel: complexity tier wins for execution, role otherwise', () => {
    const cost = RoutingPresets['cost-tiered'];
    // trivial/low task -> cheapest local model, NOT the executor-by-role
    expect(resolvePresetModel(cost, { complexity: 'low' })).toBe('qwen38-27b');
    // hard task -> escalates to the strong model
    expect(resolvePresetModel(cost, { complexity: 'high' })).toBe('opus-4.8');
    // no complexity -> executor role
    expect(resolvePresetModel(cost, {})).toBe('qwen38-27b');
    // explicit role (review) is honored regardless of tiers
    expect(resolvePresetModel(cost, { role: 'reviewer' })).toBe('opus-4.8');
  });

  it('coherence: a tier absent from the map falls back to the executor role', () => {
    // synthesize a partial-tier preset
    const partial = { ...RoutingPresets['cost-tiered'], tiers: { critical: 'opus-4.8' } };
    expect(resolvePresetModel(partial, { complexity: 'low' })).toBe(partial.roles.executor);
    expect(resolvePresetModel(partial, { complexity: 'critical' })).toBe('opus-4.8');
  });
});
