import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ModelAnalytics, type TaskOutcome } from '../../src/models/analytics.js';
import { join } from 'path';
import { mkdirSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';

describe('ModelAnalytics', () => {
  let analytics: ModelAnalytics;
  const tmpDir = join(tmpdir(), 'uap-test-analytics-' + Date.now());
  const dbPath = join(tmpDir, 'test-analytics.db');

  beforeEach(() => {
    if (!existsSync(tmpDir)) {
      mkdirSync(tmpDir, { recursive: true });
    }
    analytics = new ModelAnalytics(dbPath);
  });

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  function createOutcome(overrides: Partial<TaskOutcome> = {}): TaskOutcome {
    return {
      modelId: 'gpt-4',
      taskType: 'coding',
      complexity: 'medium',
      success: true,
      durationMs: 1500,
      tokensUsed: { input: 500, output: 200 },
      cost: 0.05,
      ...overrides,
    };
  }

  describe('recordOutcome', () => {
    it('should record a task outcome', () => {
      expect(() => analytics.recordOutcome(createOutcome())).not.toThrow();
    });

    it('should record multiple outcomes', () => {
      analytics.recordOutcome(createOutcome({ success: true }));
      analytics.recordOutcome(createOutcome({ success: false }));
      analytics.recordOutcome(createOutcome({ modelId: 'claude' }));
      const metrics = analytics.getMetrics();
      expect(metrics.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('getMetrics', () => {
    it('should return metrics grouped by model and task type', () => {
      analytics.recordOutcome(createOutcome({ modelId: 'gpt-4', taskType: 'coding', success: true }));
      analytics.recordOutcome(createOutcome({ modelId: 'gpt-4', taskType: 'coding', success: false }));
      analytics.recordOutcome(createOutcome({ modelId: 'claude', taskType: 'review', success: true }));

      const metrics = analytics.getMetrics();
      expect(metrics.length).toBeGreaterThanOrEqual(2);
      const gpt4Coding = metrics.find(m => m.modelId === 'gpt-4' && m.taskType === 'coding');
      expect(gpt4Coding).toBeDefined();
      expect(gpt4Coding!.totalTasks).toBe(2);
      expect(gpt4Coding!.successes).toBe(1);
      expect(gpt4Coding!.failures).toBe(1);
      expect(gpt4Coding!.successRate).toBe(0.5);
    });
  });

  describe('getCostBreakdown', () => {
    it('should return cost per model', () => {
      analytics.recordOutcome(createOutcome({ modelId: 'gpt-4', cost: 0.05 }));
      analytics.recordOutcome(createOutcome({ modelId: 'gpt-4', cost: 0.10 }));
      analytics.recordOutcome(createOutcome({ modelId: 'claude', cost: 0.03 }));

      const breakdown = analytics.getCostBreakdown();
      const gpt4 = breakdown.find(b => b.modelId === 'gpt-4');
      expect(gpt4).toBeDefined();
      expect(gpt4!.totalCost).toBeCloseTo(0.15, 2);
      expect(gpt4!.taskCount).toBe(2);
    });
  });

  describe('getSessionUsage', () => {
    it('should return usage stats for current session', () => {
      analytics.recordOutcome(createOutcome({ modelId: 'gpt-4', success: true }));
      analytics.recordOutcome(createOutcome({ modelId: 'gpt-4', success: false }));

      const usage = analytics.getSessionUsage();
      expect(usage.length).toBeGreaterThan(0);
      const gpt4 = usage.find(u => u.modelId === 'gpt-4');
      expect(gpt4).toBeDefined();
      expect(gpt4!.taskCount).toBe(2);
    });
  });
});
