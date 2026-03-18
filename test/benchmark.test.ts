/**
 * Tests for benchmark.ts
 * Tests benchmark task types, schemas, and configuration
 */

import { describe, it, expect } from 'vitest';
import {
  BenchmarkTaskSchema,
  AgentExecutionSchema,
  BenchmarkResultSchema,
  OverallBenchmarkStatsSchema,
  BenchmarkConfigSchema,
} from '../src/benchmarks/benchmark.js';
import type {
  BenchmarkTask,
  AgentExecution,
  BenchmarkConfig,
} from '../src/benchmarks/benchmark.js';

import { z } from 'zod';

describe('Benchmark Task Types', () => {
  describe('BenchmarkTaskSchema validation', () => {
    it('should validate a complete benchmark task', () => {
      const mockVerify = async (): Promise<{
        success: boolean;
        details?: Record<string, unknown>;
      }> => ({ success: true });

      const task: BenchmarkTask = {
        id: 'test-task-1',
        name: 'Test Task',
        description: 'A test task for benchmarking',
        instruction: 'Complete this task',
        difficulty: 'medium',
        category: 'memory',
        verify: mockVerify,
        estimatedMinutes: 10,
      };

      const result = BenchmarkTaskSchema.safeParse(task);
      expect(result.success).toBe(true);
    });

    it('should reject task without required fields', () => {
      const invalidTask = {
        id: 'test-task-1',
        // Missing name, description, instruction, difficulty, category, verify
      };

      const result = BenchmarkTaskSchema.safeParse(invalidTask);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.errors.length).toBeGreaterThan(0);
      }
    });

    it('should validate all difficulty options', () => {
      const difficulties: ('easy' | 'medium' | 'hard')[] = ['easy', 'medium', 'hard'];

      for (const difficulty of difficulties) {
        const task = createValidTask(difficulty);
        const result = BenchmarkTaskSchema.safeParse(task);
        expect(result.success).toBe(true);
      }
    });

    it('should validate all category options', () => {
      const categories: Array<
        | 'memory'
        | 'coordination'
        | 'code-quality'
        | 'performance'
        | 'testing'
        | 'security'
        | 'debugging'
      > = [
        'memory',
        'coordination',
        'code-quality',
        'performance',
        'testing',
        'security',
        'debugging',
      ];

      for (const category of categories) {
        const task = createValidTask('medium', category);
        const result = BenchmarkTaskSchema.safeParse(task);
        expect(result.success).toBe(true);
      }
    });

    it('should reject invalid difficulty value', () => {
      const task = createValidTask('invalid' as any);
      const result = BenchmarkTaskSchema.safeParse(task);
      expect(result.success).toBe(false);
    });

    it('should reject invalid category value', () => {
      const task = createValidTask('medium', 'invalid' as any);
      const result = BenchmarkTaskSchema.safeParse(task);
      expect(result.success).toBe(false);
    });

    it('should handle optional estimatedMinutes field', () => {
      const taskWithoutEstimate: BenchmarkTask = {
        id: 'test-task-1',
        name: 'Test Task',
        description: 'A test task for benchmarking',
        instruction: 'Complete this task',
        difficulty: 'medium',
        category: 'memory',
        verify: async () => ({ success: true }),
      };

      const result = BenchmarkTaskSchema.safeParse(taskWithoutEstimate);
      expect(result.success).toBe(true);
    });
  });

  describe('AgentExecutionSchema validation', () => {
    it('should validate a complete agent execution record', () => {
      const execution: AgentExecution = {
        taskId: 'test-task-1',
        agent: 'uap-agent',
        startTime: Date.now(),
        endTime: Date.now() + 10000,
        durationMs: 10000,
        success: true,
        attempts: 1,
        memoryQueries: 42,
        tokensUsed: 1500,
        errors: [],
      };

      const result = AgentExecutionSchema.safeParse(execution);
      expect(result.success).toBe(true);
    });

    it('should allow optional memoryQueries and tokensUsed', () => {
      const executionWithoutMetrics: AgentExecution = {
        taskId: 'test-task-1',
        agent: 'uap-agent',
        startTime: Date.now(),
        endTime: Date.now() + 10000,
        durationMs: 10000,
        success: true,
        attempts: 1,
        errors: [],
      };

      const result = AgentExecutionSchema.safeParse(executionWithoutMetrics);
      expect(result.success).toBe(true);
    });

    it('should handle multiple errors', () => {
      const executionWithErrors: AgentExecution = {
        taskId: 'test-task-1',
        agent: 'uap-agent',
        startTime: Date.now(),
        endTime: Date.now() + 10000,
        durationMs: 10000,
        success: false,
        attempts: 3,
        errors: ['Error 1', 'Error 2', 'Error 3'],
      };

      const result = AgentExecutionSchema.safeParse(executionWithErrors);
      expect(result.success).toBe(true);
    });

    it('should reject execution without required fields', () => {
      const invalidExecution = {
        taskId: 'test-task-1',
        // Missing agent, startTime, endTime, durationMs, success, attempts, errors
      };

      const result = AgentExecutionSchema.safeParse(invalidExecution);
      expect(result.success).toBe(false);
    });
  });
});

describe('Benchmark Result Types', () => {
  describe('BenchmarkResultSchema validation', () => {
    it('should validate a complete benchmark result', () => {
      const result: z.infer<typeof BenchmarkResultSchema> = {
        taskId: 'test-task-1',
        taskName: 'Test Task',
        results: [
          {
            taskId: 'test-task-1',
            agent: 'uap-agent',
            startTime: Date.now(),
            endTime: Date.now() + 10000,
            durationMs: 10000,
            success: true,
            attempts: 1,
            memoryQueries: 42,
            tokensUsed: 1500,
            errors: [],
          },
        ],
        summary: {
          uapSuccessRate: 100,
          naiveSuccessRate: 100,
          uapAvgDuration: 10,
          naiveAvgDuration: 15,
          improvement: {
            successDelta: 0,
            speedup: 1.5,
            memoryQueries: 42,
          },
        },
      };

      const parsed = BenchmarkResultSchema.safeParse(result);
      expect(parsed.success).toBe(true);
    });

    it('should validate with multiple agent results', () => {
      const result: z.infer<typeof BenchmarkResultSchema> = {
        taskId: 'test-task-1',
        taskName: 'Test Task',
        results: [
          {
            taskId: 'test-task-1',
            agent: 'uap-agent',
            startTime: Date.now(),
            endTime: Date.now() + 10000,
            durationMs: 10000,
            success: true,
            attempts: 1,
            errors: [],
          },
          {
            taskId: 'test-task-1',
            agent: 'naive-agent',
            startTime: Date.now(),
            endTime: Date.now() + 20000,
            durationMs: 20000,
            success: false,
            attempts: 3,
            errors: ['Error 1'],
          },
        ],
        summary: {
          uapSuccessRate: 100,
          naiveSuccessRate: 0,
          uapAvgDuration: 10,
          naiveAvgDuration: 20,
          improvement: {
            successDelta: 100,
            speedup: 2,
            memoryQueries: 42,
          },
        },
      };

      const parsed = BenchmarkResultSchema.safeParse(result);
      expect(parsed.success).toBe(true);
    });

    it('should reject invalid benchmark result', () => {
      const invalidResult = {
        taskId: 'test-task-1',
        taskName: 'Test Task',
        results: [],
        summary: {
          // Missing required fields in summary
        },
      };

      const parsed = BenchmarkResultSchema.safeParse(invalidResult);
      expect(parsed.success).toBe(false);
    });
  });

  describe('OverallBenchmarkStatsSchema validation', () => {
    it('should validate overall benchmark stats with difficulty breakdown', () => {
      const stats: z.infer<typeof OverallBenchmarkStatsSchema> = {
        totalTasks: 10,
        uapSuccess: 8,
        naiveSuccess: 5,
        uapSuccessRate: 80,
        naiveSuccessRate: 50,
        uapAvgDuration: 15,
        naiveAvgDuration: 25,
        overallSpeedup: 1.67,
        byDifficulty: {
          easy: { count: 3, uapSuccess: 3, naiveSuccess: 2 },
          medium: { count: 5, uapSuccess: 4, naiveSuccess: 2 },
          hard: { count: 2, uapSuccess: 1, naiveSuccess: 1 },
        },
        byCategory: {
          memory: { count: 3, uapSuccess: 3, naiveSuccess: 2 },
          performance: { count: 4, uapSuccess: 3, naiveSuccess: 2 },
          testing: { count: 3, uapSuccess: 2, naiveSuccess: 1 },
        },
      };

      const parsed = OverallBenchmarkStatsSchema.safeParse(stats);
      expect(parsed.success).toBe(true);
    });

    it('should validate with empty difficulty/category breakdowns', () => {
      const stats: z.infer<typeof OverallBenchmarkStatsSchema> = {
        totalTasks: 0,
        uapSuccess: 0,
        naiveSuccess: 0,
        uapSuccessRate: 0,
        naiveSuccessRate: 0,
        uapAvgDuration: 0,
        naiveAvgDuration: 0,
        overallSpeedup: 1,
        byDifficulty: {},
        byCategory: {},
      };

      const parsed = OverallBenchmarkStatsSchema.safeParse(stats);
      expect(parsed.success).toBe(true);
    });
  });
});

describe('BenchmarkConfigSchema', () => {
  describe('Configuration validation', () => {
    it('should validate with default values', () => {
      const config: Partial<BenchmarkConfig> = {};

      const result = BenchmarkConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.maxAttempts).toBe(3);
        expect(result.data.timeoutMs).toBe(300000);
        expect(result.data.agents).toEqual(['uap-agent', 'naive-agent']);
        expect(result.data.memoryEnabled).toBe(true);
        expect(result.data.verbose).toBe(false);
        expect(result.data.outputDir).toBe('./benchmarks/results');
      }
    });

    it('should validate with custom configuration', () => {
      const config: BenchmarkConfig = {
        maxAttempts: 5,
        timeoutMs: 600000,
        agents: ['custom-agent'],
        memoryEnabled: false,
        verbose: true,
        outputDir: './custom-results',
      };

      const result = BenchmarkConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.maxAttempts).toBe(5);
        expect(result.data.timeoutMs).toBe(600000);
        expect(result.data.agents).toEqual(['custom-agent']);
        expect(result.data.memoryEnabled).toBe(false);
        expect(result.data.verbose).toBe(true);
        expect(result.data.outputDir).toBe('./custom-results');
      }
    });

    it('should handle partial configuration', () => {
      const config: Partial<BenchmarkConfig> = {
        maxAttempts: 10,
        verbose: true,
      };

      const result = BenchmarkConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.maxAttempts).toBe(10);
        expect(result.data.verbose).toBe(true);
        // Check defaults for other fields
        expect(result.data.timeoutMs).toBe(300000);
        expect(result.data.memoryEnabled).toBe(true);
      }
    });
  });
});

// Helper function to create a valid task
function createValidTask(
  difficulty: 'easy' | 'medium' | 'hard' = 'medium',
  category: BenchmarkTask['category'] = 'memory'
): BenchmarkTask {
  return {
    id: 'test-task-1',
    name: 'Test Task',
    description: 'A test task for benchmarking',
    instruction: 'Complete this task',
    difficulty,
    category,
    verify: async () => ({ success: true }),
    estimatedMinutes: 10,
  };
}
