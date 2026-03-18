import { z } from 'zod';

export const PlatformSchema = z.object({
  enabled: z.boolean().default(true),
  // Per-platform memory budget overrides (for small-context models)
  shortTermMax: z.number().optional(), // Override ShortTermMemory.maxEntries
  searchResults: z.number().optional(), // Max semantic search results to inject
  sessionMax: z.number().optional(), // Max session memory entries to retain
  patternRag: z.boolean().optional(), // Enable pattern RAG for this platform
});

export const ShortTermMemorySchema = z.object({
  enabled: z.boolean().default(true),
  // Desktop: SQLite path
  path: z.string().default('./agents/data/memory/short_term.db'),
  // Web: IndexedDB database name (optional - if set, uses web template)
  webDatabase: z.string().optional(),
  maxEntries: z.number().default(50),
  // Force desktop mode even if webDatabase is set
  forceDesktop: z.boolean().optional(),
});

export const GitHubMemoryBackendSchema = z.object({
  enabled: z.boolean().default(false),
  repo: z.string().optional(), // e.g., "owner/repo"
  token: z.string().optional(), // GitHub PAT (can also use GITHUB_TOKEN env var)
  path: z.string().default('.uap/memory'), // Path in repo
  branch: z.string().default('main'),
});

export const QdrantCloudBackendSchema = z.object({
  enabled: z.boolean().default(false),
  url: z.string().optional(), // e.g., "https://xyz.qdrant.io"
  apiKey: z.string().optional(), // Can also use QDRANT_API_KEY env var
  collection: z.string().default('agent_memory'),
});

/**
 * NEW: Serverless Qdrant configuration for cost optimization.
 * Supports lazy-start local instance or cloud serverless.
 */
export const QdrantServerlessSchema = z.object({
  enabled: z.boolean().default(false),
  mode: z.enum(['lazy-local', 'cloud-serverless', 'hybrid']).default('lazy-local'),
  // Lazy-local settings
  lazyLocal: z
    .object({
      dockerImage: z.string().default('qdrant/qdrant:latest'),
      port: z.number().default(6333),
      dataDir: z.string().default('./agents/data/qdrant'),
      autoStart: z.boolean().default(true),
      autoStop: z.boolean().default(true),
      idleTimeoutMs: z.number().default(300000), // 5 minutes
      healthCheckIntervalMs: z.number().default(30000), // 30 seconds
    })
    .optional(),
  // Cloud serverless settings
  cloudServerless: z
    .object({
      provider: z
        .enum(['qdrant-cloud', 'aws-lambda', 'cloudflare-workers'])
        .default('qdrant-cloud'),
      url: z.string().optional(),
      apiKey: z.string().optional(),
      region: z.string().default('us-east-1'),
      // Cold start optimization
      keepWarm: z.boolean().default(false),
      warmIntervalMs: z.number().default(240000), // 4 minutes
    })
    .optional(),
  // Hybrid mode: use local for dev, cloud for prod
  hybrid: z
    .object({
      useLocalInDev: z.boolean().default(true),
      useCloudInProd: z.boolean().default(true),
      envDetection: z.enum(['NODE_ENV', 'UAP_ENV', 'auto']).default('auto'),
    })
    .optional(),
  // Fallback to in-memory if all backends fail
  fallbackToMemory: z.boolean().default(true),
});

export const LongTermMemorySchema = z.object({
  enabled: z.boolean().default(true),
  // Legacy local provider (keep for backward compatibility)
  provider: z
    .enum(['qdrant', 'chroma', 'pinecone', 'github', 'qdrant-cloud', 'serverless', 'none'])
    .default('qdrant'),
  endpoint: z.string().optional(),
  collection: z.string().default('agent_memory'),
  embeddingModel: z.string().default('all-MiniLM-L6-v2'),
  // New backend-specific configs
  github: GitHubMemoryBackendSchema.optional(),
  qdrantCloud: QdrantCloudBackendSchema.optional(),
  // NEW: Serverless config
  serverless: QdrantServerlessSchema.optional(),
});

/**
 * Pattern RAG configuration.
 * Instead of embedding all patterns statically in CLAUDE.md (~12K tokens),
 * indexes them in a Qdrant collection and queries on-demand per task,
 * injecting only the top-N relevant patterns (~800 tokens).
 */
export const PatternRagSchema = z.object({
  enabled: z.boolean().default(false),
  collection: z.string().default('agent_patterns'),
  embeddingModel: z.string().default('all-MiniLM-L6-v2'),
  vectorSize: z.number().default(384),
  scoreThreshold: z.number().default(0.35),
  topK: z.number().default(2),
  // Script paths for indexing/querying
  indexScript: z.string().default('./agents/scripts/index_patterns_to_qdrant.py'),
  queryScript: z.string().default('./agents/scripts/query_patterns.py'),
  // Source file for pattern extraction (backward compat)
  sourceFile: z.string().default('CLAUDE.md'),
  // Additional source files to scan (AGENTS.md, etc.)
  sourceFiles: z.array(z.string()).optional(),
  // Directory containing skill files to scan (e.g. .claude/skills)
  skillsDir: z.string().optional(),
  // Max body chars to inject per pattern (token budget control)
  maxBodyChars: z.number().default(400),
});

export const MemorySchema = z.object({
  shortTerm: ShortTermMemorySchema.optional(),
  longTerm: LongTermMemorySchema.optional(),
  patternRag: PatternRagSchema.optional(),
});

export const WorktreeSchema = z.object({
  enabled: z.boolean().default(true),
  directory: z.string().default('.worktrees'),
  branchPrefix: z.string().default('feature/'),
  autoCleanup: z.boolean().default(true),
});

export const DroidSchema = z.object({
  name: z.string(),
  template: z.string().optional(),
  description: z.string().optional(),
  model: z.string().default('inherit'),
  tools: z.union([z.string(), z.array(z.string())]).optional(),
});

export const CommandSchema = z.object({
  name: z.string(),
  template: z.string().optional(),
  description: z.string().optional(),
  argumentHint: z.string().optional(),
});

export const TemplateSectionsSchema = z.object({
  memorySystem: z.boolean().default(true),
  browserUsage: z.boolean().default(true),
  decisionLoop: z.boolean().default(true),
  worktreeWorkflow: z.boolean().default(true),
  troubleshooting: z.boolean().default(true),
  augmentedCapabilities: z.boolean().default(true),
  pipelineOnly: z.boolean().default(false), // Enforce pipeline-only infrastructure policy
  benchmark: z.boolean().default(false), // Enable benchmark mode with domain-specific patterns
});

export const TemplateSchema = z.object({
  extends: z.string().default('default'),
  sections: TemplateSectionsSchema.optional(),
});

export const ProjectSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  defaultBranch: z.string().default('main'),
});

/**
 * NEW: Cost optimization settings.
 */
export const CostOptimizationSchema = z.object({
  enabled: z.boolean().default(true),
  // Token budget management
  tokenBudget: z
    .object({
      maxTemplateTokens: z.number().default(8000),
      maxMemoryQueryTokens: z.number().default(2000),
      maxContextTokens: z.number().default(12000),
      warningThreshold: z.number().default(0.8), // Warn at 80% usage
    })
    .optional(),
  // Embedding batch optimization
  embeddingBatching: z
    .object({
      enabled: z.boolean().default(true),
      batchSize: z.number().default(10),
      maxDelayMs: z.number().default(5000),
    })
    .optional(),
  // LLM call reduction
  llmCallReduction: z
    .object({
      cacheResponses: z.boolean().default(true),
      cacheTtlMs: z.number().default(3600000), // 1 hour
      deduplicateQueries: z.boolean().default(true),
    })
    .optional(),
});

/**
 * NEW: Time optimization settings for deployments.
 */
export const TimeOptimizationSchema = z.object({
  enabled: z.boolean().default(true),
  // Dynamic batch windows
  batchWindows: z
    .object({
      commit: z.number().default(30000),
      push: z.number().default(5000),
      merge: z.number().default(10000),
      workflow: z.number().default(5000),
      deploy: z.number().default(60000),
    })
    .optional(),
  // Parallel execution
  parallelExecution: z
    .object({
      enabled: z.boolean().default(true),
      maxParallelDroids: z.number().default(4),
      maxParallelWorkflows: z.number().default(3),
    })
    .optional(),
  // Pre-warming
  prewarming: z
    .object({
      enabled: z.boolean().default(false),
      prewarmServices: z.array(z.string()).default(['qdrant']),
    })
    .optional(),
});

/**
 * Model configuration for multi-model architecture
 */
export const ModelConfigSchema = z.object({
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
});

/**
 * Routing rule for task-to-model mapping
 */
export const RoutingRuleSchema = z.object({
  complexity: z.enum(['low', 'medium', 'high', 'critical']).optional(),
  keywords: z.array(z.string()).optional(),
  taskType: z
    .enum(['planning', 'coding', 'refactoring', 'bug-fix', 'review', 'documentation'])
    .optional(),
  targetRole: z.enum(['planner', 'executor', 'reviewer', 'fallback']),
  priority: z.number().default(0),
});

/**
 * NEW: Multi-Model Architecture configuration.
 * Enables two-tier agentic architecture with separate planner and executor models.
 */
export const MultiModelSchema = z.object({
  enabled: z.boolean().default(false),

  // Model definitions (can use preset IDs or custom configs)
  // Preset IDs: 'opus-4.5', 'deepseek-v3.2', 'deepseek-v3.2-exp', 'glm-4.7', 'gpt-5.2'
  models: z.array(z.union([z.string(), ModelConfigSchema])).default(['opus-4.5']),

  // Role assignments - which model handles which role
  roles: z
    .object({
      planner: z.string().default('opus-4.5'),
      executor: z.string().default('glm-4.7'),
      reviewer: z.string().optional(),
      fallback: z.string().default('opus-4.5'),
    })
    .optional(),

  // Custom routing rules (optional - uses defaults if not specified)
  routing: z.array(RoutingRuleSchema).optional(),

  // Routing strategy
  routingStrategy: z
    .enum([
      'cost-optimized', // Minimize cost, use cheapest capable model
      'performance-first', // Maximize quality, use best model
      'balanced', // Balance cost and performance
      'adaptive', // Learn from task results
    ])
    .default('balanced'),

  // Cost optimization settings
  costOptimization: z
    .object({
      enabled: z.boolean().default(true),
      targetReduction: z.number().default(90),
      maxPerformanceDegradation: z.number().default(20),
      fallbackThreshold: z.number().default(3),
    })
    .optional(),

  // Planner-specific settings
  plannerSettings: z
    .object({
      complexityThreshold: z.enum(['low', 'medium', 'high']).default('medium'),
      maxPlanningTokens: z.number().default(10000),
      enableDecomposition: z.boolean().default(true),
    })
    .optional(),

  // Executor settings
  executorSettings: z
    .object({
      retryWithFallback: z.boolean().default(true),
      maxRetries: z.number().default(2),
      stepTimeout: z.number().default(120000),
    })
    .optional(),
});

/**
 * Agent Execution Feature Flags.
 *
 * Each feature was trialled in Harbor Terminal-Bench benchmarks with Qwen3.5 35B/3B.
 * Defaults are set to the proven-effective subset. Features marked as harmful for
 * small models are disabled by default but can be enabled for larger models.
 *
 * Evidence-based defaults (13 benchmark runs, 10 tasks each):
 *   EFFECTIVE (default ON):
 *     - domainHints: +20% pass rate (biggest single lever)
 *     - prependNotReplaceLoopBreaker: +10% vs replace-style breaker
 *     - preExecutionHooks: +10% (file backups, tool installs)
 *     - lowTemperature: reduces stochastic variation
 *     - gccFlagMutation: transparent fix, no regression
 *
 *   NEUTRAL/SITUATIONAL (default OFF):
 *     - webSearch: 0% value measured, wastes tool budget (49 calls, 0 attributable passes)
 *     - preExecWebResearch: search results never read by agent
 *     - verifierAwareTesting: marginal, adds instruction length
 *
 *   HARMFUL FOR SMALL MODELS (default OFF):
 *     - reflectionCheckpoints: regressed 40% -> 20% (confuses small models)
 *     - progressiveBudgetPressure: regressed (adds noise to conversation)
 *     - outputDiffStrategySwitch: regressed (injects strategy text)
 *     - cwdInjection: broke bash commands (echo prefix interferes)
 */
export const AgentExecutionSchema = z.object({
  // === PROVEN EFFECTIVE (default ON) ===

  /** Domain-specific hints in CLAUDE.md routed by task classification.
   *  Biggest single lever: +20% pass rate. */
  domainHints: z.boolean().default(true),

  /** Loop breaker that PREPENDS warnings but never replaces commands.
   *  Agent's work always executes. +10% vs replace-style. */
  prependNotReplaceLoopBreaker: z.boolean().default(true),

  /** Pre-execution hooks: file backups, tool installs, state protection.
   *  Runs before agent starts. +10% pass rate. */
  preExecutionHooks: z.boolean().default(true),

  /** Low temperature (0.15) for deterministic results.
   *  Reduces stochastic variation between runs. */
  lowTemperature: z.boolean().default(true),

  /** Temperature value when lowTemperature is enabled. */
  temperature: z.number().default(0.15),

  /** Proxy-level gcc flag reordering (-lm after source files).
   *  Transparent to model, no regression risk. */
  gccFlagMutation: z.boolean().default(true),

  /** Escape hatch: reset loop detection after N consecutive warnings.
   *  Prevents the loop breaker from permanently blocking productive work. */
  loopEscapeHatch: z.boolean().default(true),

  /** Number of consecutive loop warnings before escape hatch triggers. */
  loopEscapeThreshold: z.number().default(3),

  // === NEUTRAL / SITUATIONAL (default OFF) ===

  /** Web search via SearXNG when agent is stuck.
   *  Measured: 49 search calls across 4 runs, 0 attributable passes.
   *  The model uses search as procrastination, not learning.
   *  Enable for larger models (70B+) that can synthesize search results. */
  webSearch: z.boolean().default(false),

  /** SearXNG endpoint URL for web search. */
  webSearchEndpoint: z.string().default('http://192.168.1.165:8888'),

  /** Pre-execution web research: search online before agent starts.
   *  Results cached in /app/tmp/web_research.txt.
   *  Measured: agent rarely reads the file. Enable for larger models. */
  preExecWebResearch: z.boolean().default(false),

  /** Extract verifier test assertions and save for agent to read.
   *  Marginal value, adds instruction length. Enable for complex tasks. */
  verifierAwareTesting: z.boolean().default(false),

  // === HARMFUL FOR SMALL MODELS (default OFF) ===
  // Enable these ONLY for models with 13B+ active parameters.

  /** Inject reflection checkpoints every N calls into conversation.
   *  HARMFUL: regressed Qwen3.5 from 40% to 20%. Confuses small models. */
  reflectionCheckpoints: z.boolean().default(false),

  /** Reflection interval (calls between checkpoints). */
  reflectionInterval: z.number().default(15),

  /** Progressive budget phases (exploration/execution/verification/emergency).
   *  HARMFUL: adds noise to conversation for small models. */
  progressiveBudgetPressure: z.boolean().default(false),

  /** Inject strategy alternatives when output-diff detected.
   *  HARMFUL: small models lose task context from injected text. */
  outputDiffStrategySwitch: z.boolean().default(false),

  /** Prepend [CWD: /path] to every bash call.
   *  HARMFUL: echo prefix breaks command chaining in some containers. */
  cwdInjection: z.boolean().default(false),

  // === BUDGET SETTINGS ===

  /** Soft budget: stop forcing tool_choice after this many calls. */
  softBudget: z.number().default(35),

  /** Hard budget: strip tools entirely after this many calls. */
  hardBudget: z.number().default(50),

  /** tool_choice value to force during normal operation. */
  toolChoiceForce: z.enum(['required', 'auto', 'none']).default('required'),
});

export const AgentContextConfigSchema = z.object({
  $schema: z.string().optional(),
  version: z.string().default('1.0.0'),
  project: ProjectSchema,
  platforms: z
    .object({
      claudeCode: PlatformSchema.optional(),
      factory: PlatformSchema.optional(),
      vscode: PlatformSchema.optional(),
      opencode: PlatformSchema.optional(),
    })
    .optional(),
  memory: MemorySchema.optional(),
  worktrees: WorktreeSchema.optional(),
  droids: z.array(DroidSchema).optional(),
  commands: z.array(CommandSchema).optional(),
  template: TemplateSchema.optional(),
  // NEW: Optimization settings
  costOptimization: CostOptimizationSchema.optional(),
  timeOptimization: TimeOptimizationSchema.optional(),
  // NEW: Multi-model architecture settings
  multiModel: MultiModelSchema.optional(),
  // Agent execution feature flags (benchmark-proven defaults)
  agentExecution: AgentExecutionSchema.optional(),
});

export type AgentContextConfig = z.infer<typeof AgentContextConfigSchema>;
export type MultiModelConfig = z.infer<typeof MultiModelSchema>;
export type Platform =
  | 'claudeCode'
  | 'factory'
  | 'vscode'
  | 'opencode'
  | 'claudeWeb'
  | 'factoryWeb';
export type Droid = z.infer<typeof DroidSchema>;
export type Command = z.infer<typeof CommandSchema>;
export type QdrantServerlessConfig = z.infer<typeof QdrantServerlessSchema>;
export type PatternRagConfig = z.infer<typeof PatternRagSchema>;
export type CostOptimizationConfig = z.infer<typeof CostOptimizationSchema>;
export type TimeOptimizationConfig = z.infer<typeof TimeOptimizationSchema>;
export type AgentExecutionConfig = z.infer<typeof AgentExecutionSchema>;
