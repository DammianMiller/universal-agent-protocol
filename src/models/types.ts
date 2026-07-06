/**
 * Multi-Model Architecture Types
 *
 * Defines types for the two-tier agentic architecture:
 * - Tier 1 (Planner): High-level reasoning and task decomposition
 * - Tier 2 (Executor): Concrete implementation following planner specs
 */

import { z } from 'zod';

// Model provider identifiers
export type ModelProvider = 'anthropic' | 'openai' | 'ollama' | 'custom';

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
  provider: z.enum(['anthropic', 'openai', 'ollama', 'custom']),
  apiModel: z.string(),
  endpoint: z.string().optional(),
  apiKeyEnvVar: z.string().optional(),
  maxContextTokens: z.number().default(128000),
  costPer1MInput: z.number().optional(),
  costPer1MOutput: z.number().optional(),
  capabilities: z.array(z.string()).default([]),
  modelContextBudget: z.number().optional(), // Effective context sweet spot (may be less than maxContextTokens)
  // Reasoning/thinking effort for models that support it. 'xhigh' is UAP's
  // maximum; it maps to provider 'high' on OpenAI-compatible wires.
  reasoningEffort: z.enum(['low', 'medium', 'high', 'xhigh']).optional(),
});

export type ModelConfig = z.infer<typeof ModelConfigSchemaModels>;

/**
 * Pre-defined model presets for common configurations
 */
export const ModelPresets: Record<string, ModelConfig> = {
  'opus-4.8': {
    id: 'opus-4.8',
    name: 'Claude Opus 4.8',
    provider: 'anthropic',
    apiModel: 'claude-opus-4-8',
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
    reasoningEffort: 'xhigh',
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
  'sonnet-4.6': {
    id: 'sonnet-4.6',
    name: 'Claude Sonnet 4.6',
    provider: 'anthropic',
    apiModel: 'claude-sonnet-4-6-20250514',
    apiKeyEnvVar: 'ANTHROPIC_API_KEY',
    maxContextTokens: 200000,
    costPer1MInput: 3.0,
    costPer1MOutput: 15.0,
    capabilities: ['code-generation', 'execution', 'review', 'agentic'],
    modelContextBudget: 180000,
  },
  haiku: {
    id: 'haiku',
    name: 'Claude Haiku (Latest)',
    provider: 'anthropic',
    apiModel: 'claude-3-5-haiku-20241022',
    apiKeyEnvVar: 'ANTHROPIC_API_KEY',
    maxContextTokens: 200000,
    costPer1MInput: 0.8,
    costPer1MOutput: 4.0,
    capabilities: ['code-generation', 'execution', 'simple-tasks'],
  },
  'qwen35-a3b': {
    id: 'qwen35-a3b',
    name: 'Qwen 3.5 35B A3B (llama.cpp)',
    provider: 'custom',
    apiModel: 'qwen35-a3b-iq4xs',
    // Route through the anthropic-proxy (:4000), NOT llama :8080 directly. The
    // proxy strips Qwen's <think> blocks and applies the tool/finalize guardrails.
    // Hitting :8080 raw under `--reasoning auto` let reasoning leak into
    // `uap deliver`-authored gate scripts (verify.sh became an unclosed <think>
    // block -> bash syntax error -> unsatisfiable gate -> infinite verify loop).
    endpoint: 'http://192.168.1.165:4000/v1',
    maxContextTokens: 262144,
    costPer1MInput: 0,
    costPer1MOutput: 0,
    capabilities: ['code-generation', 'execution', 'planning', 'simple-tasks'],
    modelContextBudget: 131072,
  },
  'gpt-5.4': {
    id: 'gpt-5.4',
    name: 'GPT 5.4',
    provider: 'openai',
    apiModel: 'gpt-5.4',
    apiKeyEnvVar: 'OPENAI_API_KEY',
    maxContextTokens: 128000,
    costPer1MInput: 2.5,
    costPer1MOutput: 10.0,
    capabilities: ['planning', 'code-generation', 'complex-reasoning'],
  },
  'gpt-5.3-codex': {
    id: 'gpt-5.3-codex',
    name: 'GPT 5.3 Codex',
    provider: 'openai',
    apiModel: 'gpt-5.3-codex',
    apiKeyEnvVar: 'OPENAI_API_KEY',
    maxContextTokens: 192000,
    costPer1MInput: 3.0,
    costPer1MOutput: 12.0,
    capabilities: ['code-generation', 'execution', 'complex-reasoning', 'agentic'],
  },
  'fable-5': {
    id: 'fable-5',
    name: 'Claude Fable 5',
    provider: 'anthropic',
    apiModel: 'claude-fable-5',
    apiKeyEnvVar: 'ANTHROPIC_API_KEY',
    maxContextTokens: 200000,
    costPer1MInput: 5.0,
    costPer1MOutput: 25.0,
    capabilities: ['planning', 'complex-reasoning', 'code-generation', 'advanced-planning'],
    modelContextBudget: 180000,
  },
  'sonnet-5': {
    id: 'sonnet-5',
    name: 'Claude Sonnet 5',
    provider: 'anthropic',
    apiModel: 'claude-sonnet-5-20250514',
    apiKeyEnvVar: 'ANTHROPIC_API_KEY',
    maxContextTokens: 200000,
    costPer1MInput: 3.75,
    costPer1MOutput: 18.75,
    capabilities: [
      'planning',
      'code-generation',
      'execution',
      'review',
      'agentic',
      'complex-reasoning',
    ],
    modelContextBudget: 180000,
  },
  'haiku-4.5': {
    id: 'haiku-4.5',
    name: 'Claude Haiku 4.5',
    provider: 'anthropic',
    apiModel: 'claude-haiku-4-5-20251001',
    apiKeyEnvVar: 'ANTHROPIC_API_KEY',
    maxContextTokens: 200000,
    costPer1MInput: 1.0,
    costPer1MOutput: 5.0,
    capabilities: ['code-generation', 'execution', 'simple-tasks', 'agentic'],
    modelContextBudget: 180000,
  },
  'qwen36-a3b': {
    id: 'qwen36-a3b',
    name: 'Qwen 3.6 35B A3B (llama.cpp, local)',
    provider: 'custom',
    apiModel: 'qwen36-35b-a3b-iq4xs',
    // Route through the anthropic-proxy (:4000) for <think>-stripping + tool/finalize
    // guardrails (same rationale as qwen35-a3b), not llama :8080 raw.
    endpoint: 'http://192.168.1.165:4000/v1',
    maxContextTokens: 262144,
    costPer1MInput: 0,
    costPer1MOutput: 0,
    capabilities: ['code-generation', 'execution', 'planning', 'simple-tasks'],
    modelContextBudget: 131072,
  },
};

export type ModelPresetId = keyof typeof ModelPresets;

/**
 * Named multi-model ROUTING options — role bundles you can pick with
 * `uap model routing use <id>`, which writes the roles into `.uap.json`.
 * Each role references a ModelPresets id. Cloud roles (planner/reviewer) run
 * against Anthropic and work with a Claude Max plan via the proxy's OAuth
 * passthrough; local roles run free on llama.cpp.
 */
export interface RoutingPreset {
  id: string;
  name: string;
  description: string;
  roles: { planner: string; executor: string; reviewer: string; fallback: string };
  /**
   * Per-task-complexity model routing (cost/speed control, orthogonal to the
   * lifecycle roles above). When present, a task's classified complexity picks
   * the EXECUTION model directly — trivial work runs on the cheapest/fastest
   * model, hard work escalates — instead of collapsing onto the executor role.
   * Any tier left unset falls back to the executor role model, so a partial
   * map stays coherent. Consumed by `uap model routing use`, which materializes
   * it into the router's routingMatrix.
   */
  tiers?: Partial<Record<TaskComplexity, string>>;
  models: string[];
  routingStrategy?: string;
}

export const RoutingPresets: Record<string, RoutingPreset> = {
  'fable-local-opus': {
    id: 'fable-local-opus',
    name: 'Fable plan / local execute / Opus review',
    description:
      'Plan with Claude Fable 5, execute on local Qwen 3.6, review with Claude Opus 4.8, ' +
      'fall back to local Qwen 3.6. Cloud is used only for planning and review (Max-plan ' +
      'friendly); execution stays free and local.',
    roles: {
      planner: 'fable-5',
      executor: 'qwen36-a3b',
      reviewer: 'opus-4.8',
      fallback: 'qwen36-a3b',
    },
    models: ['fable-5', 'qwen36-a3b', 'opus-4.8'],
    routingStrategy: 'balanced',
  },
  'fable-haiku-opus': {
    id: 'fable-haiku-opus',
    name: 'Fable plan / Haiku execute / Opus review',
    description:
      'Plan with Claude Fable 5, execute with Claude Haiku 4.5 (fast cloud), review with ' +
      'Claude Opus 4.8, fall back to local Qwen 3.6. All-cloud hot path with a free local ' +
      'safety net.',
    roles: {
      planner: 'fable-5',
      executor: 'haiku-4.5',
      reviewer: 'opus-4.8',
      fallback: 'qwen36-a3b',
    },
    models: ['fable-5', 'haiku-4.5', 'opus-4.8', 'qwen36-a3b'],
    routingStrategy: 'performance-first',
  },
  'cost-tiered': {
    id: 'cost-tiered',
    name: 'Cost-tiered (local-first, escalate by complexity)',
    description:
      'Minimize cost: trivial/low tasks run FREE on local Qwen 3.6; medium adds a fast ' +
      'cloud model (Haiku) only when needed; high/critical escalate to Opus 4.8. Plan on ' +
      'Fable, review on Opus. Cheapest capable model per complexity.',
    roles: {
      planner: 'fable-5',
      executor: 'qwen36-a3b',
      reviewer: 'opus-4.8',
      fallback: 'qwen36-a3b',
    },
    tiers: {
      low: 'qwen36-a3b',
      medium: 'qwen36-a3b',
      high: 'opus-4.8',
      critical: 'opus-4.8',
    },
    models: ['fable-5', 'qwen36-a3b', 'haiku-4.5', 'opus-4.8'],
    routingStrategy: 'cost-optimized',
  },
  'speed-tiered': {
    id: 'speed-tiered',
    name: 'Speed-tiered (fast cloud, escalate quality by complexity)',
    description:
      'Maximize speed: low/medium tasks run on Haiku 4.5 (fast cloud); high on Fable 5; ' +
      'critical on Opus 4.8. Plan on Fable, review on Opus, free local fallback. Fastest ' +
      'model that still clears the complexity bar.',
    roles: {
      planner: 'fable-5',
      executor: 'haiku-4.5',
      reviewer: 'opus-4.8',
      fallback: 'qwen36-a3b',
    },
    tiers: {
      low: 'haiku-4.5',
      medium: 'haiku-4.5',
      high: 'fable-5',
      critical: 'opus-4.8',
    },
    models: ['fable-5', 'haiku-4.5', 'opus-4.8', 'qwen36-a3b'],
    routingStrategy: 'performance-first',
  },
  'sonnet-5-tiered': {
    id: 'sonnet-5-tiered',
    name: 'Sonnet 5 primary (balanced speed/quality, escalate to Opus)',
    description:
      'Use Sonnet 5 as the primary model for most tasks (excellent balance of speed and ' +
      'quality); escalate to Opus 4.8 for critical/high complexity. Plan on Sonnet 5, ' +
      'review on Opus 4.8, free local fallback. Best value for everyday agentic work.',
    roles: {
      planner: 'sonnet-5',
      executor: 'sonnet-5',
      reviewer: 'opus-4.8',
      fallback: 'qwen36-a3b',
    },
    tiers: {
      low: 'sonnet-5',
      medium: 'sonnet-5',
      high: 'opus-4.8',
      critical: 'opus-4.8',
    },
    models: ['sonnet-5', 'opus-4.8', 'qwen36-a3b'],
    routingStrategy: 'balanced',
  },
};

/**
 * Materialize a preset's complexity tiers into the router's routingMatrix
 * (single-model-per-tier form). Tiers absent from the preset are omitted, so
 * the router falls back to the executor role for them — coherent by default.
 * Exported + pure for testing and for `uap model routing use`.
 */
export function tiersToRoutingMatrix(
  preset: RoutingPreset
): Record<string, string> | undefined {
  if (!preset.tiers) return undefined;
  const matrix: Record<string, string> = {};
  for (const [complexity, modelId] of Object.entries(preset.tiers)) {
    if (modelId) matrix[complexity] = modelId;
  }
  return Object.keys(matrix).length > 0 ? matrix : undefined;
}

/**
 * Resolve the model for a (complexity, role) pair against a preset: the
 * complexity tier wins for the execution path; otherwise the role model.
 * Pure — the single source of truth for "which model does this task get".
 */
export function resolvePresetModel(
  preset: RoutingPreset,
  opts: { complexity?: TaskComplexity; role?: keyof RoutingPreset['roles'] }
): string {
  const { complexity, role = 'executor' } = opts;
  if (complexity && preset.tiers?.[complexity]) return preset.tiers[complexity] as string;
  return preset.roles[role];
}

export type RoutingPresetId = keyof typeof RoutingPresets;

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
        z.string(), // Preset ID like 'opus-4.6'
        ModelConfigSchemaModels, // Full custom config
      ])
    )
    .default(['opus-4.6', 'qwen35-a3b']),

  // Role assignments
  roles: z
    .object({
      planner: z.string().default('opus-4.6'),
      executor: z.string().default('qwen35-a3b'),
      reviewer: z.string().optional(),
      fallback: z.string().default('qwen35-a3b'),
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
      z.union([
        z.string(), // new: one model id for this complexity tier
        z.object({ planner: z.string(), executor: z.string() }), // legacy form
      ])
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
  /** Suggested expert droids for this subtask, in execution order. Optional. */
  suggestedDroids?: string[];
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
