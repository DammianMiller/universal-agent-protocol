import { z } from 'zod';

export const PlatformSchema = z.object({
  enabled: z.boolean().default(true),
  // Per-platform memory budget overrides (for small-context models)
  shortTermMax: z.number().optional(),    // Override ShortTermMemory.maxEntries
  searchResults: z.number().optional(),   // Max semantic search results to inject
  sessionMax: z.number().optional(),      // Max session memory entries to retain
  patternRag: z.boolean().optional(),     // Enable pattern RAG for this platform
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
  lazyLocal: z.object({
    dockerImage: z.string().default('qdrant/qdrant:latest'),
    port: z.number().default(6333),
    dataDir: z.string().default('./agents/data/qdrant'),
    autoStart: z.boolean().default(true),
    autoStop: z.boolean().default(true),
    idleTimeoutMs: z.number().default(300000), // 5 minutes
    healthCheckIntervalMs: z.number().default(30000), // 30 seconds
  }).optional(),
  // Cloud serverless settings
  cloudServerless: z.object({
    provider: z.enum(['qdrant-cloud', 'aws-lambda', 'cloudflare-workers']).default('qdrant-cloud'),
    url: z.string().optional(),
    apiKey: z.string().optional(),
    region: z.string().default('us-east-1'),
    // Cold start optimization
    keepWarm: z.boolean().default(false),
    warmIntervalMs: z.number().default(240000), // 4 minutes
  }).optional(),
  // Hybrid mode: use local for dev, cloud for prod
  hybrid: z.object({
    useLocalInDev: z.boolean().default(true),
    useCloudInProd: z.boolean().default(true),
    envDetection: z.enum(['NODE_ENV', 'UAM_ENV', 'auto']).default('auto'),
  }).optional(),
  // Fallback to in-memory if all backends fail
  fallbackToMemory: z.boolean().default(true),
});

export const LongTermMemorySchema = z.object({
  enabled: z.boolean().default(true),
  // Legacy local provider (keep for backward compatibility)
  provider: z.enum(['qdrant', 'chroma', 'pinecone', 'github', 'qdrant-cloud', 'serverless', 'none']).default('qdrant'),
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
  // Source file for pattern extraction
  sourceFile: z.string().default('CLAUDE.md'),
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
  tokenBudget: z.object({
    maxTemplateTokens: z.number().default(8000),
    maxMemoryQueryTokens: z.number().default(2000),
    maxContextTokens: z.number().default(12000),
    warningThreshold: z.number().default(0.8), // Warn at 80% usage
  }).optional(),
  // Embedding batch optimization
  embeddingBatching: z.object({
    enabled: z.boolean().default(true),
    batchSize: z.number().default(10),
    maxDelayMs: z.number().default(5000),
  }).optional(),
  // LLM call reduction
  llmCallReduction: z.object({
    cacheResponses: z.boolean().default(true),
    cacheTtlMs: z.number().default(3600000), // 1 hour
    deduplicateQueries: z.boolean().default(true),
  }).optional(),
});

/**
 * NEW: Time optimization settings for deployments.
 */
export const TimeOptimizationSchema = z.object({
  enabled: z.boolean().default(true),
  // Dynamic batch windows
  batchWindows: z.object({
    commit: z.number().default(30000),
    push: z.number().default(5000),
    merge: z.number().default(10000),
    workflow: z.number().default(5000),
    deploy: z.number().default(60000),
  }).optional(),
  // Parallel execution
  parallelExecution: z.object({
    enabled: z.boolean().default(true),
    maxParallelDroids: z.number().default(4),
    maxParallelWorkflows: z.number().default(3),
  }).optional(),
  // Pre-warming
  prewarming: z.object({
    enabled: z.boolean().default(false),
    prewarmServices: z.array(z.string()).default(['qdrant']),
  }).optional(),
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
  taskType: z.enum(['planning', 'coding', 'refactoring', 'bug-fix', 'review', 'documentation']).optional(),
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
  models: z.array(z.union([
    z.string(),
    ModelConfigSchema,
  ])).default(['opus-4.5']),
  
  // Role assignments - which model handles which role
  roles: z.object({
    planner: z.string().default('opus-4.5'),
    executor: z.string().default('glm-4.7'),
    reviewer: z.string().optional(),
    fallback: z.string().default('opus-4.5'),
  }).optional(),
  
  // Custom routing rules (optional - uses defaults if not specified)
  routing: z.array(RoutingRuleSchema).optional(),
  
  // Routing strategy
  routingStrategy: z.enum([
    'cost-optimized',     // Minimize cost, use cheapest capable model
    'performance-first', // Maximize quality, use best model
    'balanced',          // Balance cost and performance
    'adaptive',          // Learn from task results
  ]).default('balanced'),
  
  // Cost optimization settings
  costOptimization: z.object({
    enabled: z.boolean().default(true),
    targetReduction: z.number().default(90),
    maxPerformanceDegradation: z.number().default(20),
    fallbackThreshold: z.number().default(3),
  }).optional(),
  
  // Planner-specific settings
  plannerSettings: z.object({
    complexityThreshold: z.enum(['low', 'medium', 'high']).default('medium'),
    maxPlanningTokens: z.number().default(10000),
    enableDecomposition: z.boolean().default(true),
  }).optional(),
  
  // Executor settings
  executorSettings: z.object({
    retryWithFallback: z.boolean().default(true),
    maxRetries: z.number().default(2),
    stepTimeout: z.number().default(120000),
  }).optional(),
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
});

export type AgentContextConfig = z.infer<typeof AgentContextConfigSchema>;
export type MultiModelConfig = z.infer<typeof MultiModelSchema>;
export type Platform = 'claudeCode' | 'factory' | 'vscode' | 'opencode' | 'claudeWeb' | 'factoryWeb';
export type Droid = z.infer<typeof DroidSchema>;
export type Command = z.infer<typeof CommandSchema>;
export type QdrantServerlessConfig = z.infer<typeof QdrantServerlessSchema>;
export type PatternRagConfig = z.infer<typeof PatternRagSchema>;
export type CostOptimizationConfig = z.infer<typeof CostOptimizationSchema>;
export type TimeOptimizationConfig = z.infer<typeof TimeOptimizationSchema>;
