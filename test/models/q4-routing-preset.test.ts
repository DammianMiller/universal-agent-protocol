import { describe, it, expect } from 'vitest';
import { createRouter, type MultiModelConfig } from '../../src/models/index.js';

// Q4-full: when a routingPreset is persisted, the router selects from the
// canonical per-phase source (resolvePhaseChain), not the flat routingMatrix.
describe('router selectModel — Q4 canonical preset path', () => {
  it('routes via the preset per-phase chain when routingPreset is set', () => {
    const config: MultiModelConfig = {
      enabled: true,
      models: ['qwen38-27b', 'sonnet-5', 'opus-4.8'],
      roles: { planner: 'sonnet-5', executor: 'qwen38-27b', reviewer: 'sonnet-5', fallback: 'opus-4.8' },
      routingStrategy: 'adaptive',
      routingPreset: 'adaptive-tiered',
    };
    const router = createRouter(config);
    // adaptive-tiered high.execute primary = sonnet-5
    const high = router.selectModel('high', 'coding', []);
    expect(high.model.id).toBe('sonnet-5');
    expect(high.reasoning).toContain('canonical per-phase');
    // low.execute primary = qwen38-27b
    const low = router.selectModel('low', 'coding', []);
    expect(low.model.id).toBe('qwen38-27b');
  });

  it('falls back to the flat routingMatrix when no routingPreset is set (legacy)', () => {
    const config: MultiModelConfig = {
      enabled: true,
      models: ['qwen38-27b', 'opus-4.8'],
      roles: { planner: 'opus-4.8', executor: 'qwen38-27b', reviewer: 'opus-4.8', fallback: 'qwen38-27b' },
      routingStrategy: 'cost-optimized',
      routingMatrix: { low: 'qwen38-27b', high: 'opus-4.8' },
    };
    const router = createRouter(config);
    const high = router.selectModel('high', 'coding', []);
    expect(high.model.id).toBe('opus-4.8');
    expect(high.reasoning).toContain('routingMatrix'); // legacy path
  });

  it('does NOT engage the canonical branch for a TIER-LESS preset (keeps role escalation)', () => {
    const config: MultiModelConfig = {
      enabled: true,
      models: ['fable-5', 'qwen38-27b', 'opus-4.8'],
      roles: { planner: 'fable-5', executor: 'qwen38-27b', reviewer: 'opus-4.8', fallback: 'qwen38-27b' },
      routingStrategy: 'balanced',
      routingPreset: 'fable-local-opus', // tier-less — no per-complexity tiers
    };
    const router = createRouter(config);
    const high = router.selectModel('high', 'coding', []);
    // canonical per-phase branch must be SKIPPED (would have pinned executor for all tiers)
    expect(high.reasoning).not.toContain('canonical per-phase');
  });

  it('ignores an unknown routingPreset and falls through to the matrix/strategy', () => {
    const config: MultiModelConfig = {
      enabled: true,
      models: ['qwen38-27b', 'opus-4.8'],
      roles: { planner: 'opus-4.8', executor: 'qwen38-27b', reviewer: 'opus-4.8', fallback: 'qwen38-27b' },
      routingStrategy: 'cost-optimized',
      routingPreset: 'no-such-preset',
      routingMatrix: { high: 'opus-4.8' },
    };
    const router = createRouter(config);
    const high = router.selectModel('high', 'coding', []);
    expect(high.model.id).toBe('opus-4.8'); // fell through to matrix
  });
});
