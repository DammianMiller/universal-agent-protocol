/**
 * Terminal-Bench Adapter for UAP
 *
 * Assumptions:
 * - Target: Compare UAP-enabled agents vs naive agents on terminal-style tasks
 * - Tasks require knowledge of project structure, past decisions, and patterns
 * - UAP provides persistent memory across task sessions
 *
 * What this handles:
 * - Benchmark task definitions
 * - Memory-enabled agent wrapper
 * - Performance comparison framework
 * - Results aggregation and reporting
 *
 * What this does NOT handle:
 * - Full Terminal-Bench framework integration (use tb run CLI for that)
 * - Real Docker environment sandboxing
 * - Multi-agent coordination (future enhancement)
 */

import { z } from 'zod';

// ============================================================================
// Task Types
// ============================================================================

export const BenchmarkTaskSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  instruction: z.string(),
  difficulty: z.enum(['easy', 'medium', 'hard']),
  category: z.enum([
    'memory',
    'coordination',
    'code-quality',
    'performance',
    'testing',
    'security',
    'debugging',
  ]),
  // Verification: checks if agent solved the task correctly
  verify: z.function().returns(
    z.promise(
      z.object({
        success: z.boolean(),
        details: z.record(z.any()).optional(),
      })
    )
  ),
  // Estimated time to complete
  estimatedMinutes: z.number().optional(),
});

export type BenchmarkTask = z.infer<typeof BenchmarkTaskSchema>;

// ============================================================================
// Agent Types
// ============================================================================

export const AgentExecutionSchema = z.object({
  taskId: z.string(),
  agent: z.string(),
  startTime: z.number(),
  endTime: z.number(),
  durationMs: z.number(),
  success: z.boolean(),
  attempts: z.number(),
  memoryQueries: z.number().optional(),
  tokensUsed: z.number().optional(),
  errors: z.array(z.string()),
});

export type AgentExecution = z.infer<typeof AgentExecutionSchema>;

// ============================================================================
// Benchmark Result Types
// ============================================================================

export const BenchmarkResultSchema = z.object({
  taskId: z.string(),
  taskName: z.string(),
  results: z.array(AgentExecutionSchema),
  summary: z.object({
    uapSuccessRate: z.number(),
    naiveSuccessRate: z.number(),
    uapAvgDuration: z.number(), // in seconds
    naiveAvgDuration: z.number(), // in seconds
    improvement: z.object({
      successDelta: z.number(), // percentage points
      speedup: z.number(), // ratio >1 means UAP is faster
      memoryQueries: z.number(),
    }),
  }),
});

export type BenchmarkResult = z.infer<typeof BenchmarkResultSchema>;

export const OverallBenchmarkStatsSchema = z.object({
  totalTasks: z.number(),
  uapSuccess: z.number(),
  naiveSuccess: z.number(),
  uapSuccessRate: z.number(),
  naiveSuccessRate: z.number(),
  uapAvgDuration: z.number(),
  naiveAvgDuration: z.number(),
  overallSpeedup: z.number(),
  byDifficulty: z.record(
    z.object({
      count: z.number(),
      uapSuccess: z.number(),
      naiveSuccess: z.number(),
    })
  ),
  byCategory: z.record(
    z.object({
      count: z.number(),
      uapSuccess: z.number(),
      naiveSuccess: z.number(),
    })
  ),
});

export type OverallBenchmarkStats = z.infer<typeof OverallBenchmarkStatsSchema>;

// ============================================================================
// Benchmark Configuration
// ============================================================================

export const BenchmarkConfigSchema = z.object({
  maxAttempts: z.number().default(3),
  timeoutMs: z.number().default(300000), // 5 minutes per task
  agents: z.array(z.string()).default(['uap-agent', 'naive-agent']),
  memoryEnabled: z.boolean().default(true),
  verbose: z.boolean().default(false),
  outputDir: z.string().default('./benchmarks/results'),
});

export type BenchmarkConfig = z.infer<typeof BenchmarkConfigSchema>;
