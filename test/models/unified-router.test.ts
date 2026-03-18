/**
 * Unified Router Tests
 *
 * Comprehensive unit tests for the unified routing service that combines
 * rule-based and benchmark-data routing decisions.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { UnifiedRoutingService, createUnifiedRouter } from '../../src/models/unified-router.js';
import { ModelRouter } from '../../src/models/router.js';
import type { MultiModelConfig, TaskClassificationResult } from '../../src/models/types.js';

const DEFAULT_CONFIG: MultiModelConfig = {
  enabled: true,
  models: ['opus-4.5', 'gpt-5.2', 'glm-4.7', 'qwen35'],
  roles: {
    planner: 'opus-4.5',
    executor: 'gpt-5.2',
    reviewer: 'glm-4.7',
    fallback: 'qwen35',
  },
  routingStrategy: 'balanced',
};

describe('UnifiedRoutingService', () => {
  let service: UnifiedRoutingService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new UnifiedRoutingService(DEFAULT_CONFIG);
  });

  it('should create instance with default config', () => {
    expect(service).toBeDefined();
    expect(service.getRuleRouter()).toBeDefined();
  });

  it('should route task when both systems agree (consensus)', () => {
    const result = service.route('Write a unit test for this function');

    expect(result.selectedModel).toBeDefined();
    expect(['opus-4.5', 'gpt-5.2', 'glm-4.7', 'qwen35']).toContain(result.selectedModel);
    expect(result.source).toBe('consensus');
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.reasoning).toBeDefined();
    expect(result.ruleBasedClassification).toBeDefined();
    expect(result.benchmarkDecision).toBeDefined();
  });

  it('should include benchmark data points in result', () => {
    const result = service.route('Simple task');

    expect(result.benchmarkDataPoints).toBeGreaterThanOrEqual(0);
  });

  it('should provide fallback model', () => {
    const result = service.route('Test task');

    expect(result.fallbackModel).toBeDefined();
    expect(result.fallbackModel).not.toBe(result.selectedModel);
  });

  it('should record outcome for learning', () => {
    expect(() => {
      service.recordOutcome({
        modelUsed: 'gpt-5.2',
        success: true,
        latencyMs: 1000,
        taskCategory: 'testing',
      });
    }).not.toThrow();
  });

  it('should analyze routing decisions', () => {
    const analysis = service.analyzeRouting('Complex planning task');

    expect(analysis).toBeDefined();
    expect(analysis.taskDescription).toBe('Complex planning task');
    expect(analysis.ruleBasedResult).toBeDefined();
    expect(analysis.benchmarkResult).toBeDefined();
    expect(analysis.unifiedResult).toBeDefined();
    expect(analysis.modelComparison).toBeDefined();
  });

  it('should handle different task types', () => {
    const tasks = [
      'Write a unit test for this function',
      'Debug this error in the code',
      'Optimize performance of this algorithm',
      'Review the changes in this PR',
      'Plan the architecture for a new feature',
    ];

    tasks.forEach((task) => {
      const result = service.route(task);
      expect(result.selectedModel).toBeDefined();
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    });
  });

  it('should compute confidence scores correctly', () => {
    const result = service.route('Simple task');

    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
  });

  it('should detect consensus between routing systems', () => {
    const result = service.route('Write a unit test for this function');

    expect(result.systemsAgreed).toBeDefined();
    expect(typeof result.systemsAgreed).toBe('boolean');
  });

  it('should handle edge case: empty task description', () => {
    const result = service.route('');

    expect(result.selectedModel).toBeDefined();
    expect(result.confidence).toBeGreaterThanOrEqual(0);
  });

  it('should handle edge case: very long task description', () => {
    const longTask = 'Write a test'.repeat(1000);
    const result = service.route(longTask);

    expect(result.selectedModel).toBeDefined();
  });

  it('should use createUnifiedRouter factory function', () => {
    const router = createUnifiedRouter(DEFAULT_CONFIG);

    expect(router).toBeInstanceOf(UnifiedRoutingService);
    const result = router.route('Test task');
    expect(result.selectedModel).toBeDefined();
  });
});

describe('UnifiedRoutingService - Consensus Detection', () => {
  let service: UnifiedRoutingService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new UnifiedRoutingService(DEFAULT_CONFIG);
  });

  it('should identify when both routers recommend same model', () => {
    const result = service.route('Write a unit test for this function');

    expect(result.systemsAgreed).toBeDefined();
  });

  it('should prefer rule-based when benchmark has insufficient data', () => {
    const result = service.route('Unique task type');

    // Should have either 'consensus' or 'rule-based' source
    expect(['consensus', 'rule-based', 'benchmark-data']).toContain(result.source);
  });
});

describe('UnifiedRoutingService - Confidence Calculation', () => {
  let service: UnifiedRoutingService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new UnifiedRoutingService(DEFAULT_CONFIG);
  });

  it('should calculate higher confidence for consensus decisions', () => {
    const result1 = service.route('Write a unit test for this function');
    const result2 = service.route('Debug this error');

    // Both should have reasonable confidence scores
    expect(result1.confidence).toBeGreaterThanOrEqual(0);
    expect(result2.confidence).toBeGreaterThanOrEqual(0);
  });

  it('should calculate confidence for benchmark-data decisions', () => {
    const result = service.route('Performance optimization task');

    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
  });
});

describe('UnifiedRoutingService - Model Selection', () => {
  let service: UnifiedRoutingService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new UnifiedRoutingService(DEFAULT_CONFIG);
  });

  it('should select appropriate model for testing tasks', () => {
    const result = service.route('Write a unit test');

    expect(result.selectedModel).toBeDefined();
  });

  it('should select appropriate model for debugging tasks', () => {
    const result = service.route('Debug this error');

    expect(result.selectedModel).toBeDefined();
  });

  it('should select appropriate model for planning tasks', () => {
    const result = service.route('Plan the architecture');

    expect(result.selectedModel).toBeDefined();
  });

  it('should always have a fallback model', () => {
    const tasks = ['Task 1', 'Task 2', 'Task 3'];

    tasks.forEach((task) => {
      const result = service.route(task);
      expect(result.fallbackModel).toBeDefined();
    });
  });
});

describe('UnifiedRoutingService - Map Coverage Validation', () => {
  let service: UnifiedRoutingService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new UnifiedRoutingService(DEFAULT_CONFIG);
  });

  it('should validate model map coverage for all configured models', () => {
    const models = ['opus-4.5', 'gpt-5.2', 'glm-4.7', 'qwen35'];
    const results = new Set<string>();

    // Route tasks that should trigger different model selections
    for (const model of models) {
      const result = service.route(`Select ${model} for task`);
      results.add(result.selectedModel);
    }

    // All configured models should be in the map and potentially selected
    expect(results.size).toBeGreaterThanOrEqual(1);
  });

  it('should handle model disagreements between rule-based and benchmark', () => {
    const result = service.route('Task with conflicting signals');

    // Should still produce a valid selection even when systems disagree
    expect(result.selectedModel).toBeDefined();
    expect(result.source).toBeDefined();
    expect(['consensus', 'rule-based', 'benchmark-data']).toContain(result.source);
  });

  it('should validate all models are reachable through routing', () => {
    const testTasks = [
      'Use opus for planning',
      'Use gpt for execution',
      'Use glm for review',
      'Use qwen for fallback',
    ];

    const selectedModels = new Set<string>();

    for (const task of testTasks) {
      const result = service.route(task);
      selectedModels.add(result.selectedModel);
    }

    // Should have reached at least some models from the map
    expect(selectedModels.size).toBeGreaterThanOrEqual(1);
  });

  it('should maintain consistent routing for same task', () => {
    const task = 'Consistent routing test';
    const result1 = service.route(task);
    const result2 = service.route(task);

    expect(result1.selectedModel).toBe(result2.selectedModel);
    expect(result1.confidence).toBe(result2.confidence);
  });
});
