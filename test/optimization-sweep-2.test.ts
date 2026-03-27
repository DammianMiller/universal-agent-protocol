/**
 * Tests for second-pass optimization sweep:
 * T1: recordTaskFeedback wired into TaskCoordinator
 * T2: Semantic cache wired into decideContextLevel
 * T3: recordTaskOutcome wired into executor
 * T4: getAdaptedPatterns wired into pattern-router
 * T5: costOptimization.tokenBudget wired into dynamic-retrieval
 * T6: agentExecution config wired into execution-profiles
 * T7: timeOptimization wired into deploy-batcher
 * T8: autoStartConsolidation
 * T9: DailyLog.autoPromote
 * T10: Factory hooks registered
 * T11: npm run bench script
 * T12: Dead files removed
 * T14: Structured logger
 * T15: DB pool simplified
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { existsSync, readFileSync } from 'fs';

// ── T1: recordTaskFeedback wired into TaskCoordinator ──

describe('T1: recordTaskFeedback in TaskCoordinator', () => {
  it('should import recordTaskFeedback in tasks/coordination.ts', async () => {
    const source = readFileSync('src/tasks/coordination.ts', 'utf-8');
    expect(source).toContain('import { recordTaskFeedback }');
    expect(source).toContain('recordTaskFeedback({');
  });

  it('recordTaskFeedback should be callable', async () => {
    const { recordTaskFeedback } = await import('../src/memory/dynamic-retrieval.js');
    expect(typeof recordTaskFeedback).toBe('function');
    // Should not throw when called with valid args
    expect(() =>
      recordTaskFeedback({
        instruction: 'test task',
        success: true,
        durationMs: 1000,
      })
    ).not.toThrow();
  });
});

// ── T2: Semantic cache in decideContextLevel ──

describe('T2: Semantic cache in decideContextLevel', () => {
  it('should call lookupSemanticCache in decideContextLevel', async () => {
    const source = readFileSync('src/memory/adaptive-context.ts', 'utf-8');
    // Extract the decideContextLevel function body
    const fnStart = source.indexOf('export function decideContextLevel(');
    expect(fnStart).toBeGreaterThan(-1);
    const fnBody = source.slice(fnStart, fnStart + 500);
    // Verify lookup is called within the function
    expect(fnBody).toContain('lookupSemanticCache(instructionHash)');
  });

  it('should call storeSemanticCache after making a decision', async () => {
    const source = readFileSync('src/memory/adaptive-context.ts', 'utf-8');
    expect(source).toContain('storeSemanticCache(cacheKey, instructionHash, fullDecision');
  });

  it('decideContextLevel should return a valid decision', async () => {
    const { decideContextLevel } = await import('../src/memory/adaptive-context.js');
    const decision = decideContextLevel('fix a security vulnerability in the auth module');
    expect(decision).toHaveProperty('level');
    expect(decision).toHaveProperty('sections');
    expect(decision).toHaveProperty('taskType');
    expect(['none', 'minimal', 'full']).toContain(decision.level);
  });
});

// ── T3: recordTaskOutcome in executor ──

describe('T3: recordTaskOutcome in executor', () => {
  it('should import recordModelRouterOutcome in executor.ts', async () => {
    const source = readFileSync('src/models/executor.ts', 'utf-8');
    expect(source).toContain('import { recordTaskOutcome as recordModelRouterOutcome }');
    expect(source).toContain('recordModelRouterOutcome(');
  });
});

// ── T4: getAdaptedPatterns in pattern-router ──

describe('T4: Adaptive patterns in pattern-router', () => {
  it('should accept taskCategory parameter in getEnforcementChecklist', async () => {
    const { PatternRouter } = await import('../src/coordination/pattern-router.js');
    const router = new PatternRouter();
    router.loadPatterns(process.cwd());

    // Should work with and without taskCategory
    const withoutCategory = router.getEnforcementChecklist('fix security bug');
    const withCategory = router.getEnforcementChecklist('fix security bug', 'security');

    expect(Array.isArray(withoutCategory)).toBe(true);
    expect(Array.isArray(withCategory)).toBe(true);
  });

  it('should sort patterns by success rate when category provided', async () => {
    const { getAdaptivePatternEngine } = await import('../src/coordination/adaptive-patterns.js');
    const engine = getAdaptivePatternEngine();

    // Record some outcomes
    engine.recordPatternOutcome('P12', true, 'security');
    engine.recordPatternOutcome('P12', true, 'security');
    engine.recordPatternOutcome('P35', false, 'security');

    // P12 should have higher success rate than P35
    const adapted = engine.getAdaptedPatterns('security');
    expect(adapted.length).toBeGreaterThan(0);
    if (adapted.length >= 2) {
      expect(adapted[0].successRate).toBeGreaterThanOrEqual(adapted[1].successRate);
    }
  });
});

// ── T5: costOptimization.tokenBudget ──

describe('T5: Config-driven token budget', () => {
  it('should read costOptimization.tokenBudget from config in dynamic-retrieval', async () => {
    const source = readFileSync('src/memory/dynamic-retrieval.ts', 'utf-8');
    expect(source).toContain('costOptimization');
    expect(source).toContain('tokenBudget');
    expect(source).toContain('maxContextTokens');
  });
});

// ── T6: agentExecution config loading ──

describe('T6: Agent execution config loading', () => {
  it('should export loadAgentExecutionOverrides', async () => {
    const { loadAgentExecutionOverrides } = await import('../src/models/execution-profiles.js');
    expect(typeof loadAgentExecutionOverrides).toBe('function');
  });

  it('should export getExecutionConfigWithProjectOverrides', async () => {
    const { getExecutionConfigWithProjectOverrides } =
      await import('../src/models/execution-profiles.js');
    expect(typeof getExecutionConfigWithProjectOverrides).toBe('function');

    // Should return a valid config for any model
    const result = getExecutionConfigWithProjectOverrides('claude-opus-4.6');
    expect(result).toHaveProperty('profile');
    expect(result).toHaveProperty('config');
    expect(result.profile.id).toBe('claude');
  });

  it('should return undefined for non-existent project dir', async () => {
    const { loadAgentExecutionOverrides } = await import('../src/models/execution-profiles.js');
    const result = loadAgentExecutionOverrides('/tmp/nonexistent-' + Date.now());
    expect(result).toBeUndefined();
  });
});

// ── T7: timeOptimization in deploy-batcher ──

describe('T7: Config-driven batch windows', () => {
  it('should read timeOptimization.batchWindows from .uap.json', async () => {
    const source = readFileSync('src/coordination/deploy-batcher.ts', 'utf-8');
    expect(source).toContain('timeOptimization');
    expect(source).toContain('batchWindows');
  });
});

// ── T8: Auto-start consolidation ──

describe('T8: Auto-start consolidation', () => {
  it('should export autoStartConsolidation', async () => {
    const { autoStartConsolidation } = await import('../src/memory/memory-consolidator.js');
    expect(typeof autoStartConsolidation).toBe('function');
  });

  it('should return false for non-existent DB path', async () => {
    const { autoStartConsolidation } = await import('../src/memory/memory-consolidator.js');
    const result = autoStartConsolidation('/tmp/nonexistent-' + Date.now() + '.db');
    expect(result).toBe(false);
  });
});

// ── T9: DailyLog.autoPromote ──

describe('T9: DailyLog auto-promote', () => {
  it('should have autoPromote method on DailyLog', async () => {
    const { DailyLog } = await import('../src/memory/daily-log.js');
    expect(DailyLog.prototype.autoPromote).toBeDefined();
    expect(typeof DailyLog.prototype.autoPromote).toBe('function');
  });
});

// ── T10: Factory hooks registered ──

describe('T10: Factory hooks registration', () => {
  it('should have .factory/settings.local.json with hook registrations', () => {
    const settingsPath = '.factory/settings.local.json';
    // settings.local.json is a local-only file created by `uap hooks install --target factory`.
    // It does not exist in CI or fresh clones — skip gracefully.
    if (!existsSync(settingsPath)) {
      return; // Skip in CI / fresh environments where hooks haven't been installed
    }

    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
    expect(settings.hooks).toBeDefined();
    expect(settings.hooks.SessionStart).toBeDefined();
    expect(settings.hooks.PreCompact).toBeDefined();
  });
});

// ── T11: npm run bench script ──

describe('T11: Benchmark npm script', () => {
  it('should have bench script in package.json', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf-8'));
    expect(pkg.scripts.bench).toBeDefined();
    expect(pkg.scripts.bench).toContain('vitest.bench.config.ts');
  });
});

// ── T12: Dead files removed ──

describe('T12: Dead files removed', () => {
  it('should not have config-manager.ts', () => {
    expect(existsSync('src/utils/config-manager.ts')).toBe(false);
  });

  it('should not have fetch-with-retry.ts', () => {
    expect(existsSync('src/utils/fetch-with-retry.ts')).toBe(false);
  });

  it('should not have file-discovery.ts', () => {
    expect(existsSync('src/utils/file-discovery.ts')).toBe(false);
  });

  it('should not have validate-json.ts', () => {
    expect(existsSync('src/utils/validate-json.ts')).toBe(false);
  });

  it('should not have generic-uap-patterns.ts', () => {
    expect(existsSync('src/memory/generic-uap-patterns.ts')).toBe(false);
  });
});

// ── T14: Structured logger ──

describe('T14: Structured logger', () => {
  it('should export createLogger and logger', async () => {
    const mod = await import('../src/utils/logger.js');
    expect(typeof mod.createLogger).toBe('function');
    expect(mod.logger).toBeDefined();
    expect(typeof mod.logger.error).toBe('function');
    expect(typeof mod.logger.warn).toBe('function');
    expect(typeof mod.logger.info).toBe('function');
    expect(typeof mod.logger.debug).toBe('function');
  });

  it('should respect log level settings', async () => {
    const { setLogLevel, getLogLevel } = await import('../src/utils/logger.js');
    const original = getLogLevel();

    setLogLevel('silent');
    expect(getLogLevel()).toBe('silent');

    setLogLevel('debug');
    expect(getLogLevel()).toBe('debug');

    // Restore
    setLogLevel(original);
  });

  it('should create module-scoped loggers', async () => {
    const { createLogger } = await import('../src/utils/logger.js');
    const testLogger = createLogger('test-module');
    expect(testLogger).toBeDefined();
    expect(typeof testLogger.error).toBe('function');
    // Should not throw
    expect(() => testLogger.info('test message')).not.toThrow();
  });

  it('should be used in adaptive-context.ts instead of console.warn', () => {
    const source = readFileSync('src/memory/adaptive-context.ts', 'utf-8');
    expect(source).toContain('import { createLogger }');
    expect(source).toContain('log.warn(');
    // Should NOT have bare console.warn calls
    expect(source).not.toContain('console.warn(');
  });
});

// ── T15: DB pool simplified ──

describe('T15: DB pool simplified', () => {
  it('should not have DB_POOL_SIZE or round-robin in adaptive-context.ts', () => {
    const source = readFileSync('src/memory/adaptive-context.ts', 'utf-8');
    expect(source).not.toContain('DB_POOL_SIZE');
    expect(source).not.toContain('poolRoundRobinIndex');
    expect(source).not.toContain('getHistoricalDbFromPool');
  });

  it('should use simple single-connection pattern', () => {
    const source = readFileSync('src/memory/adaptive-context.ts', 'utf-8');
    expect(source).toContain('let _historicalDb: Database.Database | null = null');
  });
});

// ── Integration: New exports from index.ts ──

describe('New exports from index.ts', () => {
  it('should export logger utilities', async () => {
    const mod = await import('../src/index.js');
    expect(typeof mod.createLogger).toBe('function');
    expect(mod.logger).toBeDefined();
    expect(typeof mod.setLogLevel).toBe('function');
  });

  it('should export autoStartConsolidation', async () => {
    const mod = await import('../src/index.js');
    expect(typeof mod.autoStartConsolidation).toBe('function');
  });

  it('should export config loading helpers', async () => {
    const mod = await import('../src/index.js');
    expect(typeof mod.loadAgentExecutionOverrides).toBe('function');
    expect(typeof mod.getExecutionConfigWithProjectOverrides).toBe('function');
  });

  it('should export recordTaskFeedback', async () => {
    const mod = await import('../src/index.js');
    expect(typeof mod.recordTaskFeedback).toBe('function');
  });
});
