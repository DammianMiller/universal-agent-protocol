import { describe, it, expect } from 'vitest';
import { createRouter, type MultiModelConfig } from '../../src/models/index.js';

// Q4-full: when a routingPreset is persisted, the router selects from the
// canonical per-phase source (resolvePhaseChain), not the flat routingMatrix.
describe('router selectModel — Q4 canonical preset path', () => {
  it('routes via the preset per-phase chain when routingPreset is set', () => {
    const config: MultiModelConfig = {
      enabled: true,
      models: ['qwen36-a3b', 'sonnet-5', 'opus-4.8'],
      roles: { planner: 'sonnet-5', executor: 'qwen36-a3b', reviewer: 'sonnet-5', fallback: 'opus-4.8' },
      routingStrategy: 'adaptive',
      routingPreset: 'adaptive-tiered',
    };
    const router = createRouter(config);
    // adaptive-tiered high.execute primary = sonnet-5
    const high = router.selectModel('high', 'coding', []);
    expect(high.model.id).toBe('sonnet-5');
    expect(high.reasoning).toContain('canonical per-phase');
    // low.execute primary = qwen36-a3b
    const low = router.selectModel('low', 'coding', []);
    expect(low.model.id).toBe('qwen36-a3b');
  });

  it('falls back to the flat routingMatrix when no routingPreset is set (legacy)', () => {
    const config: MultiModelConfig = {
      enabled: true,
      models: ['qwen36-a3b', 'opus-4.8'],
      roles: { planner: 'opus-4.8', executor: 'qwen36-a3b', reviewer: 'opus-4.8', fallback: 'qwen36-a3b' },
      routingStrategy: 'cost-optimized',
      routingMatrix: { low: 'qwen36-a3b', high: 'opus-4.8' },
    };
    const router = createRouter(config);
    const high = router.selectModel('high', 'coding', []);
    expect(high.model.id).toBe('opus-4.8');
    expect(high.reasoning).toContain('routingMatrix'); // legacy path
  });

  it('ignores an unknown routingPreset and falls through to the matrix/strategy', () => {
    const config: MultiModelConfig = {
      enabled: true,
      models: ['qwen36-a3b', 'opus-4.8'],
      roles: { planner: 'opus-4.8', executor: 'qwen36-a3b', reviewer: 'opus-4.8', fallback: 'qwen36-a3b' },
      routingStrategy: 'cost-optimized',
      routingPreset: 'no-such-preset',
      routingMatrix: { high: 'opus-4.8' },
    };
    const router = createRouter(config);
    const high = router.selectModel('high', 'coding', []);
    expect(high.model.id).toBe('opus-4.8'); // fell through to matrix
  });
});
