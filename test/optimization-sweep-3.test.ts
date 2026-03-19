/**
 * Tests for third-pass optimization sweep:
 * 1: .unref() on setInterval (adaptive-cache, serverless-qdrant, memory-consolidator)
 * 2: Deferred loadPersistedFingerprints in model-router
 * 3: Simplified model-router pool-of-1
 * 4: autoStartConsolidation called from setup
 * 5: DailyLog.autoPromote called from setup
 * 7: concurrentMapWithBackpressure removed
 * 8: createQueryCache removed
 * 9: TemplateLoader removed
 * 10: validateDecoderFirst consolidated
 * 11: Dependencies moved to devDeps
 * 12: Workflow defaults fixed
 * 13: EnforcedToolRouter wired into MCP client pool
 * 14: KnowledgeGraph wired into cli/memory.ts
 * 15: PerformanceData rendered in dashboard.html
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';

// ── 1: .unref() on setInterval ──

describe('1: Interval .unref()', () => {
  it('adaptive-cache should call .unref() on eviction interval', () => {
    const source = readFileSync('src/utils/adaptive-cache.ts', 'utf-8');
    expect(source).toContain('.unref()');
  });

  it('serverless-qdrant should call .unref() on health/idle intervals', () => {
    const source = readFileSync('src/memory/serverless-qdrant.ts', 'utf-8');
    const unrefCount = (source.match(/\.unref\(\)/g) || []).length;
    expect(unrefCount).toBeGreaterThanOrEqual(2);
  });

  it('memory-consolidator should call .unref() on background interval', () => {
    const source = readFileSync('src/memory/memory-consolidator.ts', 'utf-8');
    expect(source).toContain('.unref()');
  });
});

// ── 2+3: Deferred fingerprints + simplified pool ──

describe('2+3: Model router deferred init + simplified pool', () => {
  it('should NOT have loadPersistedFingerprints() at module level', () => {
    const source = readFileSync('src/memory/model-router.ts', 'utf-8');
    // Should NOT have bare top-level call
    expect(source).not.toMatch(/^loadPersistedFingerprints\(\);$/m);
    // Should have deferred version
    expect(source).toContain('ensureFingerprintsLoaded');
  });

  it('should NOT have DB_POOL_SIZE or round-robin', () => {
    const source = readFileSync('src/memory/model-router.ts', 'utf-8');
    expect(source).not.toContain('DB_POOL_SIZE');
    expect(source).not.toContain('poolRoundRobinIndex');
    expect(source).not.toContain('getFingerprintDbFromPool');
  });

  it('should use simple single-connection pattern', () => {
    const source = readFileSync('src/memory/model-router.ts', 'utf-8');
    expect(source).toContain('let _fingerprintDb: Database.Database | null = null');
  });

  it('should use structured logger instead of console.warn', () => {
    const source = readFileSync('src/memory/model-router.ts', 'utf-8');
    expect(source).toContain('import { createLogger }');
    expect(source).not.toContain('console.warn');
  });
});

// ── 4+5: autoStartConsolidation + autoPromote in setup ──

describe('4+5: Setup wires consolidation and promotion', () => {
  it('setup.ts should call autoStartConsolidation', () => {
    const source = readFileSync('src/cli/setup.ts', 'utf-8');
    expect(source).toContain('autoStartConsolidation');
  });

  it('setup.ts should call autoPromote', () => {
    const source = readFileSync('src/cli/setup.ts', 'utf-8');
    expect(source).toContain('autoPromote');
  });
});

// ── 7: concurrentMapWithBackpressure removed ──

describe('7: Dead code removed - concurrentMapWithBackpressure', () => {
  it('should NOT export concurrentMapWithBackpressure', () => {
    const source = readFileSync('src/utils/concurrency.ts', 'utf-8');
    expect(source).not.toContain('concurrentMapWithBackpressure');
  });

  it('should still export retry, withTimeout, parallelWithFallback', async () => {
    const mod = await import('../src/utils/concurrency.js');
    expect(typeof mod.retry).toBe('function');
    expect(typeof mod.withTimeout).toBe('function');
    expect(typeof mod.parallelWithFallback).toBe('function');
  });
});

// ── 8: createQueryCache removed ──

describe('8: Dead code removed - createQueryCache', () => {
  it('should NOT export createQueryCache from adaptive-cache', () => {
    const source = readFileSync('src/utils/adaptive-cache.ts', 'utf-8');
    expect(source).not.toContain('createQueryCache');
  });

  it('should NOT export createQueryCache from index.ts', () => {
    const source = readFileSync('src/index.ts', 'utf-8');
    expect(source).not.toContain('createQueryCache');
  });
});

// ── 9: TemplateLoader removed ──

describe('9: Dead code removed - TemplateLoader', () => {
  it('should NOT have template-loader.ts', () => {
    expect(existsSync('src/generators/template-loader.ts')).toBe(false);
  });
});

// ── 10: validateDecoderFirst consolidated ──

describe('10: Consolidated validateDecoderFirst', () => {
  it('should re-export validateDecoderFirstFull from decoder-gate.ts', () => {
    const source = readFileSync('src/uap-droids-strict.ts', 'utf-8');
    expect(source).toContain('export { validateDecoderFirst as validateDecoderFirstFull }');
    expect(source).toContain("from './tasks/decoder-gate.js'");
  });

  it('should still export the simple validateDecoderFirst', async () => {
    const mod = await import('../src/uap-droids-strict.js');
    expect(typeof mod.validateDecoderFirst).toBe('function');
    expect(typeof mod.validateDecoderFirstFull).toBe('function');
  });
});

// ── 11: Dependencies moved ──

describe('11: Dependencies cleaned up', () => {
  it('execa and cloakbrowser should be in dependencies (runtime imports)', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf-8'));
    expect(pkg.dependencies).toHaveProperty('execa');
    expect(pkg.dependencies).toHaveProperty('cloakbrowser');
  });

  it('glob and playwright-core should be in devDependencies (not imported in src/)', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf-8'));
    expect(pkg.devDependencies).toHaveProperty('glob');
    expect(pkg.devDependencies).toHaveProperty('playwright-core');
  });

  it('should NOT have @types/chalk in devDependencies', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf-8'));
    expect(pkg.devDependencies).not.toHaveProperty('@types/chalk');
  });
});

// ── 12: Workflow defaults fixed ──

describe('12: Workflow defaults fixed', () => {
  it('npm-publish-manual should have current version default', () => {
    const source = readFileSync('.github/workflows/npm-publish-manual.yml', 'utf-8');
    expect(source).not.toContain('4.4.0');
    expect(source).toContain('1.7.0');
  });

  it('deploy-publish should have dynamic release body', () => {
    const source = readFileSync('.github/workflows/deploy-publish.yml', 'utf-8');
    expect(source).not.toContain('Validation toggle enabled');
    expect(source).toContain('CHANGELOG.md');
  });
});

// ── 13: EnforcedToolRouter wired ──

describe('13: EnforcedToolRouter wired into MCP client pool', () => {
  it('should use PolicyGate in execute.ts instead of executeToolWithPolicy', () => {
    // executeToolWithPolicy was removed — policy enforcement is handled by PolicyGate in execute.ts
    const source = readFileSync('src/mcp-router/tools/execute.ts', 'utf-8');
    expect(source).toContain('PolicyGate');
  });

  it('McpClientPool should NOT have executeToolWithPolicy (removed dead code)', async () => {
    const { McpClientPool } = await import('../src/mcp-router/executor/client.js');
    const pool = new McpClientPool();
    expect(typeof (pool as unknown as Record<string, unknown>).executeToolWithPolicy).toBe(
      'undefined'
    );
  });
});

// ── 14: KnowledgeGraph wired into cli/memory.ts ──

describe('14: KnowledgeGraph wired into cli/memory.ts', () => {
  it('should use KnowledgeGraph class in storeKnowledgeGraph', () => {
    const source = readFileSync('src/cli/memory.ts', 'utf-8');
    expect(source).toContain('KnowledgeGraph');
    expect(source).toContain('graph.upsertEntity');
    expect(source).toContain('graph.addRelationship');
  });

  it('should NOT have inline upsertEntity/insertRelationship functions', () => {
    const source = readFileSync('src/cli/memory.ts', 'utf-8');
    expect(source).not.toMatch(/^function upsertEntity\(/m);
    expect(source).not.toMatch(/^function insertRelationship\(/m);
  });
});

// ── 15: PerformanceData in dashboard ──

describe('15: PerformanceData rendered in dashboard', () => {
  it('dashboard.html should have performance data handling', () => {
    const source = readFileSync('web/dashboard.html', 'utf-8');
    expect(source).toContain('data.performance');
    expect(source).toContain('hotPaths');
  });
});
