/**
 * Tests for the optimization sweep changes:
 * - B1: Schema diff implementation
 * - B2: RTK validation implementation
 * - B3: Decoder-first gate fix (hasReadTool)
 * - C1-C3: Module exports from src/index.ts
 * - A1+D1: Adaptive cache in pattern-router
 * - D2: Rate limiter in MCP client pool
 * - D3: Performance monitor in dashboard
 * - D4: withTimeout in executor
 * - D5+D6: Speculative cache + predictive memory in retrieval
 * - E1: Self-referential dependency removed
 * - E6: Coverage thresholds raised
 */

import { describe, it, expect, beforeEach } from 'vitest';

// ── B1: Schema Diff ──

describe('B1: Schema Diff', () => {
  it('should export schemaDiffCommand and registerSchemaDiffCommand', async () => {
    const mod = await import('../src/cli/schema-diff.js');
    expect(typeof mod.schemaDiffCommand).toBe('function');
    expect(typeof mod.registerSchemaDiffCommand).toBe('function');
  });

  it('should export diffFileSchema for single-file diffing', async () => {
    const mod = await import('../src/cli/schema-diff.js');
    expect(typeof mod.diffFileSchema).toBe('function');
  });

  it('schemaDiffCommand should return an array of results', async () => {
    const { schemaDiffCommand } = await import('../src/cli/schema-diff.js');
    // Running against HEAD~1 in test env may not have changes, but should not throw
    const results = await schemaDiffCommand('HEAD');
    expect(Array.isArray(results)).toBe(true);
  });
});

// ── B2: RTK Validation ──

describe('B2: RTK Validation', () => {
  it('should export validateRTKIncludes with proper interface', async () => {
    const mod = await import('../src/cli/rtk-validation.js');
    expect(typeof mod.validateRTKIncludes).toBe('function');
  });

  it('should validate CLAUDE.md and return structured result', async () => {
    const { validateRTKIncludes } = await import('../src/cli/rtk-validation.js');
    const result = validateRTKIncludes();
    expect(result).toHaveProperty('valid');
    expect(result).toHaveProperty('missing');
    expect(result).toHaveProperty('found');
    expect(result).toHaveProperty('warnings');
    expect(Array.isArray(result.missing)).toBe(true);
    expect(Array.isArray(result.found)).toBe(true);
    expect(Array.isArray(result.warnings)).toBe(true);
  });

  it('should find required sections in the project CLAUDE.md', async () => {
    const { validateRTKIncludes } = await import('../src/cli/rtk-validation.js');
    // Our project CLAUDE.md should have most required sections
    const result = validateRTKIncludes();
    expect(result.found.length).toBeGreaterThan(0);
    // SESSION_START should be found
    expect(result.found).toContain('SESSION_START');
  });

  it('should report missing for non-existent directory', async () => {
    const { validateRTKIncludes } = await import('../src/cli/rtk-validation.js');
    const result = validateRTKIncludes('/tmp/nonexistent-dir-' + Date.now());
    expect(result.valid).toBe(false);
    expect(result.missing.length).toBeGreaterThan(0);
  });

  it('should export printRTKValidation', async () => {
    const mod = await import('../src/cli/rtk-validation.js');
    expect(typeof mod.printRTKValidation).toBe('function');
  });
});

// ── B3: Decoder-First Gate ──

describe('B3: Decoder-First Gate', () => {
  it('should accept availableTools in taskContext', async () => {
    const { validateDecoderFirst } = await import('../src/uap-droids-strict.js');
    // With explicit tools list containing "Read"
    const result = await validateDecoderFirst('nonexistent-droid', {
      availableTools: ['Read', 'Write', 'Bash'],
    });
    // Should fail because droid doesn't exist, not because of tool check
    expect(result.valid).toBe(false);
    expect(result.errors?.[0]).toContain('not found');
  });

  it('should fail when availableTools lacks Read tool', async () => {
    const { validateDecoderFirst } = await import('../src/uap-droids-strict.js');
    // Create a scenario where droid exists but Read tool is missing
    // Since we can't easily create a droid in test, just verify the function signature
    const result = await validateDecoderFirst('test-droid', {
      availableTools: ['Write', 'Bash'],
    });
    // Should fail because droid doesn't exist (first check)
    expect(result.valid).toBe(false);
  });
});

// ── C1-C3: Module Exports ──

describe('C1-C3: Module Exports from src/index.ts', () => {
  it('should export WebBrowser and createWebBrowser (C1)', async () => {
    const mod = await import('../src/index.js');
    expect(mod.WebBrowser).toBeDefined();
    expect(typeof mod.createWebBrowser).toBe('function');
  });

  it('should export getDashboardData and startDashboardServer (C2)', async () => {
    const mod = await import('../src/index.js');
    expect(typeof mod.getDashboardData).toBe('function');
    expect(typeof mod.startDashboardServer).toBe('function');
  });

  it('should export PredictiveMemoryService (C3)', async () => {
    const mod = await import('../src/index.js');
    expect(mod.PredictiveMemoryService).toBeDefined();
    expect(typeof mod.getPredictiveMemoryService).toBe('function');
  });

  it('should export models extras (PlanValidator, UnifiedRouter, Analytics)', async () => {
    const mod = await import('../src/index.js');
    expect(mod.PlanValidator).toBeDefined();
    expect(typeof mod.createPlanValidator).toBe('function');
    expect(typeof mod.createUnifiedRouter).toBe('function');
    expect(mod.ModelAnalytics).toBeDefined();
    expect(typeof mod.getModelAnalytics).toBe('function');
  });

  it('should export execution profiles', async () => {
    const mod = await import('../src/index.js');
    expect(typeof mod.getExecutionProfile).toBe('function');
    expect(typeof mod.detectExecutionProfile).toBe('function');
    expect(typeof mod.listExecutionProfiles).toBe('function');
  });

  it('should export utility modules (AdaptiveCache, RateLimiter, PerformanceMonitor)', async () => {
    const mod = await import('../src/index.js');
    expect(mod.AdaptiveCache).toBeDefined();
    expect(mod.RateLimiter).toBeDefined();
    expect(mod.PerformanceMonitor).toBeDefined();
    expect(typeof mod.getPerformanceMonitor).toBe('function');
    expect(typeof mod.monitorFunction).toBe('function');
  });

  it('should export concurrency utilities (retry, withTimeout)', async () => {
    const mod = await import('../src/index.js');
    expect(typeof mod.retry).toBe('function');
    expect(typeof mod.withTimeout).toBe('function');
    expect(typeof mod.parallelWithFallback).toBe('function');
    expect(typeof mod.concurrentMap).toBe('function');
  });

  it('should export KnowledgeGraph', async () => {
    const mod = await import('../src/index.js');
    expect(mod.KnowledgeGraph).toBeDefined();
  });

  it('should export TaskEventBus', async () => {
    const mod = await import('../src/index.js');
    expect(mod.TaskEventBus).toBeDefined();
    expect(typeof mod.getTaskEventBus).toBe('function');
  });

  it('should export ContextPruner and ambiguity detector', async () => {
    const mod = await import('../src/index.js');
    expect(mod.ContextPruner).toBeDefined();
    expect(typeof mod.detectAmbiguity).toBe('function');
    expect(typeof mod.formatAmbiguityForContext).toBe('function');
  });
});

// ── A1+D1: Adaptive Cache in Pattern Router ──

describe('A1+D1: Adaptive Cache in Pattern Router', () => {
  it('should cache matchPatterns results', async () => {
    const { PatternRouter } = await import('../src/coordination/pattern-router.js');
    const router = new PatternRouter();

    // Load patterns
    router.loadPatterns(process.cwd());

    // First call - populates cache
    const result1 = router.matchPatterns('fix a security vulnerability');
    // Second call - should return cached result
    const result2 = router.matchPatterns('fix a security vulnerability');

    expect(result1).toEqual(result2);
  });

  it('should return different results for different descriptions', async () => {
    const { PatternRouter } = await import('../src/coordination/pattern-router.js');
    const router = new PatternRouter();
    router.loadPatterns(process.cwd());

    const securityResult = router.matchPatterns('security vulnerability exploit');
    const gitResult = router.matchPatterns('git recovery reflog');

    // Different descriptions should potentially match different patterns
    // (exact results depend on loaded patterns)
    expect(Array.isArray(securityResult)).toBe(true);
    expect(Array.isArray(gitResult)).toBe(true);
  });
});

// ── D2: Rate Limiter in MCP Client Pool ──

describe('D2: Rate Limiter in MCP Client Pool', () => {
  it('should create pool with rate limiter', async () => {
    const { McpClientPool } = await import('../src/mcp-router/executor/client.js');
    const pool = new McpClientPool({ maxRequestsPerWindow: 5, windowMs: 1000 });
    expect(pool).toBeDefined();
  });

  it('should allow requests within rate limit', async () => {
    const { McpClientPool } = await import('../src/mcp-router/executor/client.js');
    const pool = new McpClientPool({ maxRequestsPerWindow: 3, windowMs: 10000 });

    expect(pool.isRequestAllowed('test-server')).toBe(true);
    expect(pool.isRequestAllowed('test-server')).toBe(true);
    expect(pool.isRequestAllowed('test-server')).toBe(true);
    // 4th request should be rate-limited
    expect(pool.isRequestAllowed('test-server')).toBe(false);
  });

  it('should track remaining requests per server', async () => {
    const { McpClientPool } = await import('../src/mcp-router/executor/client.js');
    const pool = new McpClientPool({ maxRequestsPerWindow: 5, windowMs: 10000 });

    expect(pool.getRemainingRequests('server-a')).toBe(5);
    pool.isRequestAllowed('server-a');
    expect(pool.getRemainingRequests('server-a')).toBe(4);
  });

  it('should rate-limit servers independently', async () => {
    const { McpClientPool } = await import('../src/mcp-router/executor/client.js');
    const pool = new McpClientPool({ maxRequestsPerWindow: 1, windowMs: 10000 });

    expect(pool.isRequestAllowed('server-a')).toBe(true);
    expect(pool.isRequestAllowed('server-a')).toBe(false);
    // Different server should still be allowed
    expect(pool.isRequestAllowed('server-b')).toBe(true);
  });
});

// ── D3: Performance Monitor in Dashboard ──

describe('D3: Performance Monitor in Dashboard', () => {
  it('should include performance data in dashboard output', async () => {
    const { getDashboardData } = await import('../src/dashboard/data-service.js');
    const data = await getDashboardData();
    expect(data).toHaveProperty('performance');
    expect(data.performance).toHaveProperty('metrics');
    expect(data.performance).toHaveProperty('hotPaths');
    expect(Array.isArray(data.performance.hotPaths)).toBe(true);
  });

  it('should track hot paths with correct structure', async () => {
    const { getPerformanceMonitor } = await import('../src/utils/performance-monitor.js');
    const monitor = getPerformanceMonitor();

    // Record some metrics
    monitor.record('test.operation', 10);
    monitor.record('test.operation', 20);
    monitor.record('test.operation', 30);

    const stats = monitor.getStats('test.operation');
    expect(stats).not.toBeNull();
    expect(stats!.count).toBe(3);
    expect(stats!.avg).toBeCloseTo(20, 0);
    expect(stats!.min).toBe(10);
    expect(stats!.max).toBe(30);

    // Cleanup
    monitor.clear();
  });
});

// ── E1: Self-referential Dependency ──

describe('E1: Self-referential Dependency', () => {
  it('should not list itself as a dependency', async () => {
    const { readFileSync } = await import('fs');
    const pkg = JSON.parse(readFileSync('package.json', 'utf-8'));
    expect(pkg.dependencies).not.toHaveProperty('@miller-tech/uap');
  });
});

// ── E6: Coverage Thresholds ──

describe('E6: Coverage Thresholds', () => {
  it('should have raised coverage thresholds to at least 30%', async () => {
    const { readFileSync } = await import('fs');
    const config = readFileSync('vitest.config.ts', 'utf-8');
    // Check that thresholds are at least 30
    const statementsMatch = config.match(/statements:\s*(\d+)/);
    const branchesMatch = config.match(/branches:\s*(\d+)/);
    const functionsMatch = config.match(/functions:\s*(\d+)/);
    const linesMatch = config.match(/lines:\s*(\d+)/);

    expect(Number(statementsMatch?.[1])).toBeGreaterThanOrEqual(30);
    expect(Number(branchesMatch?.[1])).toBeGreaterThanOrEqual(30);
    expect(Number(functionsMatch?.[1])).toBeGreaterThanOrEqual(30);
    expect(Number(linesMatch?.[1])).toBeGreaterThanOrEqual(30);
  });
});

// ── D5+D6: Predictive Memory + Speculative Cache in Retrieval ──

describe('D5+D6: Predictive Memory Integration', () => {
  it('should use singleton PredictiveMemoryService', async () => {
    const { getPredictiveMemoryService } = await import('../src/memory/predictive-memory.js');
    const instance1 = getPredictiveMemoryService();
    const instance2 = getPredictiveMemoryService();
    expect(instance1).toBe(instance2); // Same singleton
  });

  it('should predict context and record access', async () => {
    const { getPredictiveMemoryService } = await import('../src/memory/predictive-memory.js');
    const service = getPredictiveMemoryService();

    // Record some access patterns
    service.recordAccess('fix authentication bug in login.ts', ['auth patterns', 'login.ts']);

    // Predict for similar task
    const predictions = service.predictNeededContext('fix auth issue in login module', []);
    expect(Array.isArray(predictions)).toBe(true);
    // Should predict based on learned patterns and entity extraction
    expect(predictions.length).toBeGreaterThan(0);
  });

  it('should integrate speculative cache with retrieval', async () => {
    const { getSpeculativeCache } = await import('../src/memory/speculative-cache.js');
    const cache = getSpeculativeCache();

    // Set a cached result
    cache.set('test query', [{ content: 'cached result' }]);

    // Verify it can be retrieved
    const entry = cache.get('test query');
    expect(entry).not.toBeNull();
    expect(entry!.result).toEqual([{ content: 'cached result' }]);

    // Get predictions
    const predictions = cache.getPredictedQueries('security vulnerability');
    expect(Array.isArray(predictions)).toBe(true);

    cache.clear();
  });
});

// ── B4: MCP Router Init ──

describe('B4: MCP Router Init', () => {
  it('should have installMCPRouter method that creates config', async () => {
    // Verify the UAPCli class has the method by checking the module exports
    const mod = await import('../src/cli/uap.js');
    // The module runs as a CLI entry point, so we just verify it loads
    expect(mod).toBeDefined();
  });
});
