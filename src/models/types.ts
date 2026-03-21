/**
 * Multi-Model Architecture Types
 *
 * Defines types for the two-tier agentic architecture:
 * - Tier 1 (Planner): High-level reasoning and task decomposition
 * - Tier 2 (Executor): Concrete implementation following planner specs
 */

import { z } from 'zod';

// Model provider identifiers
export type ModelProvider = 'anthropic' | 'deepseek' | 'openai' | 'zhipu' | 'ollama' | 'custom';

// Model role in the architecture
export type ModelRole = 'planner' | 'executor' | 'reviewer' | 'fallback' | 'task';

// Task complexity levels for routing
export type TaskComplexity = 'low' | 'medium' | 'high' | 'critical';

/**
 * Model configuration for a specific provider/model combination
 */
export const ModelConfigSchemaModels = z.object({
  id: z.string(),
  name: z.string(),
  provider: z.enum(['anthropic', 'deepseek', 'openai', 'zhipu', 'ollama', 'custom']),
  apiModel: z.string(),
  endpoint: z.string().optional(),
  apiKeyEnvVar: z.string().optional(),
  maxContextTokens: z.number().default(128000),
  costPer1MInput: z.number().optional(),
  costPer1MOutput: z.number().optional(),
  capabilities: z.array(z.string()).default([]),
  modelContextBudget: z.number().optional(), // Effective context sweet spot (may be less than maxContextTokens)
});

export type ModelConfig = z.infer<typeof ModelConfigSchemaModels>;

/**
 * Pre-defined model presets for common configurations
 */
export const ModelPresets: Record<string, ModelConfig> = {
  'opus-4.5': {
    id: 'opus-4.5',
    name: 'Claude Opus 4.5',
    provider: 'anthropic',
    apiModel: 'claude-opus-4-5-20251101',
    apiKeyEnvVar: 'ANTHROPIC_API_KEY',
    maxContextTokens: 200000,
    costPer1MInput: 5.0,
    costPer1MOutput: 25.0,
    capabilities: ['planning', 'complex-reasoning', 'code-generation', 'review'],
  },
  'opus-4.6': {
    id: 'opus-4.6',
    name: 'Claude Opus 4.6',
    provider: 'anthropic',
    apiModel: 'claude-opus-4-6-20260101',
    apiKeyEnvVar: 'ANTHROPIC_API_KEY',
    maxContextTokens: 200000,
    costPer1MInput: 7.5,
    costPer1MOutput: 37.5,
    capabilities: [
      'planning',
      'complex-reasoning',
      'code-generation',
      'review',
      'advanced-planning',
    ],
    modelContextBudget: 180000,
  },
   'deepseek-v3.2': {
    id: 'deepseek-v3.2',
    name: 'DeepSeek V3.2 Speciale',
    provider: 'deepseek',
    apiModel: 'deepseek-chat',
    apiKeyEnvVar: 'DEEPSEEK_API_KEY',
    maxContextTokens: 164000,
    costPer1MInput: 0.25,
    costPer1MOutput: 0.38,
    capabilities: ['planning', 'code-generation', 'complex-reasoning'],
  },
  'deepseek-v3.2-exp': {
    id: 'deepseek-v3.2-exp',
    name: 'DeepSeek V3.2 Experimental',
    provider: 'deepseek',
    apiModel: 'deepseek-coder',
    apiKeyEnvVar: 'DEEPSEEK_API_KEY',
    maxContextTokens: 164000,
    costPer1MInput: 0.21,
    costPer1MOutput: 0.32,
    capabilities: ['code-generation', 'execution'],
  },
  'gpt-5.2': {
    id: 'gpt-5.2',
    name: 'GPT 5.2',
    provider: 'openai',
    apiModel: 'gpt-5.2',
    apiKeyEnvVar: 'OPENAI_API_KEY',
    maxContextTokens: 128000,
    costPer1MInput: 2.5,
    costPer1MOutput: 10.0,
    capabilities: ['planning', 'code-generation', 'complex-reasoning'],
  },
  'claude-opus-4': {
    id: 'claude-opus-4',
    name: 'Claude Opus 4',
    provider: 'anthropic',
    apiModel: 'claude-opus-4-20250514',
    apiKeyEnvVar: 'ANTHROPIC_API_KEY',
    maxContextTokens: 200000,
    costPer1MInput: 15.0,
    costPer1MOutput: 75.0,
    capabilities: ['planning', 'complex-reasoning', 'code-generation', 'review', 'agentic'],
  },
  'claude-sonnet-4': {
    id: 'claude-sonnet-4',
    name: 'Claude Sonnet 4',
    provider: 'anthropic',
    apiModel: 'claude-sonnet-4-20250514',
    apiKeyEnvVar: 'ANTHROPIC_API_KEY',
    maxContextTokens: 200000,
    costPer1MInput: 3.0,
    costPer1MOutput: 15.0,
    capabilities: ['code-generation', 'execution', 'review', 'agentic'],
  },
  'qwen35-a3b': {
    id: 'qwen35-a3b',
    name: 'Qwen 3.5 35B A3B (llama.cpp)',
    provider: 'custom',
    apiModel: 'qwen35-a3b-iq4xs',
    endpoint: 'http://192.168.1.165:8080/v1',
    maxContextTokens: 262144,
    costPer1MInput: 0,
    costPer1MOutput: 0,
    capabilities: ['code-generation', 'execution', 'planning', 'simple-tasks'],
    modelContextBudget: 131072,
  },
  'glm-4.7': {
    id: 'glm-4.7',
    name: 'GLM 4.7',
    provider: 'zhipu',
    apiModel: 'glm-4.7',
    apiKeyEnvVar: 'ZHIPU_API_KEY',
    maxContextTokens: 128000,
    costPer1MInput: 0.10,
    costPer1MOutput: 0.10,
    capabilities: ['code-generation', 'execution', 'simple-tasks'],
  },
  qwen35: {
    id: 'qwen35',
    name: 'Qwen 3.5 35B A3B (iq4xs)',
    provider: 'custom',
    apiModel: 'qwen35-a3b-iq4xs',
    endpoint: 'http://localhost:8080/v1',
    maxContextTokens: 262144,
    costPer1MInput: 0,
    costPer1MOutput: 0,
    capabilities: ['code-generation', 'execution', 'planning'],
    modelContextBudget: 131072,
  },
};

export type ModelPresetId = keyof typeof ModelPresets;

/**
 * Role assignment configuration - maps roles to models
 */
export const RoleAssignmentSchema = z.object({
  role: z.enum(['planner', 'executor', 'reviewer', 'fallback']),
  modelId: z.string(),
  // Optional constraints for this role
  maxTokensPerRequest: z.number().optional(),
  timeout: z.number().default(300000), // 5 min default
});

export type RoleAssignment = z.infer<typeof RoleAssignmentSchema>;

/**
 * Routing rule for task-to-model mapping
 */
export const RoutingRuleSchema = z.object({
  // Condition matching
  complexity: z.enum(['low', 'medium', 'high', 'critical']).optional(),
  keywords: z.array(z.string()).optional(),
  taskType: z
    .enum(['planning', 'coding', 'refactoring', 'bug-fix', 'review', 'documentation'])
    .optional(),
  // Target model
  targetRole: z.enum(['planner', 'executor', 'reviewer', 'fallback']),
  // Priority (higher = evaluated first)
  priority: z.number().default(0),
});

export type RoutingRule = z.infer<typeof RoutingRuleSchema>;

/**
 * Multi-Model Architecture configuration schema for .uap.json
 */
export const MultiModelConfigSchema = z.object({
  enabled: z.boolean().default(false),

  // Model definitions (can use presets or custom)
  models: z
    .array(
      z.union([
        z.string(), // Preset ID like 'opus-4.5'
        ModelConfigSchemaModels, // Full custom config
      ])
    )
    .default(['opus-4.6', 'qwen35']),

  // Role assignments
  roles: z
    .object({
      planner: z.string().default('opus-4.6'),
      executor: z.string().default('qwen35'),
      reviewer: z.string().optional(),
      fallback: z.string().default('qwen35'),
    })
    .optional(),

  // Routing rules (optional - uses defaults if not specified)
  routing: z.array(RoutingRuleSchema).optional(),

  // Cost optimization settings
  costOptimization: z
    .object({
      enabled: z.boolean().default(true),
      // Target cost reduction percentage
      targetReduction: z.number().default(90),
      // Max performance degradation allowed
      maxPerformanceDegradation: z.number().default(20),
      // Auto-fallback threshold (failures before escalating)
      fallbackThreshold: z.number().default(3),
    })
    .optional(),

  // Custom routing matrix override
  routingMatrix: z
    .record(
      z.enum(['low', 'medium', 'high', 'critical']),
      z.object({
        planner: z.string(),
        executor: z.string(),
      })
    )
    .optional(),

  // Routing behavior
  routingStrategy: z
    .enum([
      'cost-optimized', // Minimize cost, use cheapest capable model
      'performance-first', // Maximize quality, use best model
      'balanced', // Balance cost and performance
      'adaptive', // Learn from task results
    ])
    .default('balanced'),

  // Planner-specific settings
  plannerSettings: z
    .object({
      // When to invoke planner vs direct execution
      complexityThreshold: z.enum(['low', 'medium', 'high']).default('medium'),
      // Max tokens for planning phase
      maxPlanningTokens: z.number().default(10000),
      // Decompose tasks into subtasks
      enableDecomposition: z.boolean().default(true),
    })
    .optional(),

  // Executor settings
  executorSettings: z
    .object({
      // Retry failed executions with fallback model
      retryWithFallback: z.boolean().default(true),
      // Max retries before escalating
      maxRetries: z.number().default(2),
      // Timeout per execution step
      stepTimeout: z.number().default(120000), // 2 min
    })
    .optional(),
});

export type MultiModelConfig = z.infer<typeof MultiModelConfigSchema>;

/**
 * Task classification result from the router
 */
export interface TaskClassificationResult {
  complexity: TaskComplexity;
  taskType: 'planning' | 'coding' | 'refactoring' | 'bug-fix' | 'review' | 'documentation';
  keywords: string[];
  estimatedTokens: number;
  requiresPlanning: boolean;
  suggestedModel: string;
  fallbackModel: string;
  reasoning: string;
}

/**
 * Execution plan from the planner
 */
export interface ExecutionPlan {
  id: string;
  originalTask: string;
  subtasks: Subtask[];
  dependencies: Map<string, string[]>; // subtaskId -> dependsOn[]
  modelAssignments: Map<string, string>; // subtaskId -> modelId
  estimatedCost: number;
  estimatedDuration: number;
  created: Date;
}

export interface Subtask {
  id: string;
  title: string;
  description: string;
  type: 'planning' | 'coding' | 'refactoring' | 'bug-fix' | 'review' | 'documentation';
  complexity: TaskComplexity;
  inputs: string[];
  outputs: string[];
  constraints: string[];
}

/**
 * Execution result for tracking
 */
export interface ExecutionResult {
  planId: string;
  subtaskId: string;
  modelUsed: string;
  success: boolean;
  output: string;
  error?: string;
  tokensUsed: {
    input: number;
    output: number;
  };
  cost: number;
  duration: number;
  retryCount: number;
}

/**
 * Model selection result from the router
 */
export interface ModelSelection {
  model: ModelConfig;
  fallback?: ModelConfig;
  role: ModelRole;
  reasoning: string;
  estimatedCost: number;
}

// Default routing rules
export const DEFAULT_ROUTING_RULES: RoutingRule[] = [
  // Critical tasks always use planner + fallback
  { complexity: 'critical', targetRole: 'planner', priority: 100 },
  {
    keywords: ['security', 'authentication', 'deployment', 'migration'],
    targetRole: 'planner',
    priority: 90,
  },

  // High complexity uses planner
  { complexity: 'high', targetRole: 'planner', priority: 80 },
  { keywords: ['architecture', 'design', 'refactor'], targetRole: 'planner', priority: 70 },
  { taskType: 'planning', targetRole: 'planner', priority: 70 },

  // Medium complexity can go to executor directly
  { complexity: 'medium', targetRole: 'executor', priority: 50 },
  { taskType: 'coding', targetRole: 'executor', priority: 50 },
  { taskType: 'bug-fix', targetRole: 'executor', priority: 50 },

  // Low complexity always executor
  { complexity: 'low', targetRole: 'executor', priority: 30 },
  { taskType: 'documentation', targetRole: 'executor', priority: 30 },

  // Review tasks use reviewer or planner
  { taskType: 'review', targetRole: 'reviewer', priority: 60 },
];
