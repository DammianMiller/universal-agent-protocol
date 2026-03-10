export * from './types/index.js';
export { analyzeProject } from './analyzers/index.js';
export { generateClaudeMd } from './generators/claude-md.js';
export * from './coordination/index.js';
export * from './tasks/index.js';

// Multi-Model Architecture (explicit exports to avoid conflicts with types)
export {
  ModelRouter,
  createRouter,
  createCostOptimizedRouter,
  createPerformanceRouter,
  TaskPlanner,
  createPlanner,
  TaskExecutor,
  createExecutor,
  MockModelClient,
  ModelPresets,
  DEFAULT_ROUTING_RULES,
} from './models/index.js';
export type {
  ModelConfig as MultiModelModelConfig,
  MultiModelConfig,
  ModelRole,
  TaskComplexity,
  TaskClassificationResult,
  ExecutionPlan,
  Subtask,
  ExecutionResult,
  ModelSelection,
  RoutingRule as MultiModelRoutingRule,
  PlannerOptions,
  ModelClient,
  ExecutionContext,
  ExecutorOptions,
} from './models/index.js';

// Memory system exports
export { getEmbeddingService, generateEmbedding, generateEmbeddings } from './memory/embeddings.js';
export { classifyTask, extractTaskEntities, getSuggestedMemoryQueries } from './memory/task-classifier.js';
export { retrieveDynamicMemoryContext, measureQueryComplexity, getRetrievalDepth } from './memory/dynamic-retrieval.js';
export type { TaskClassification } from './memory/task-classifier.js';
export type { DynamicMemoryContext, RetrievedMemory, QueryComplexity } from './memory/dynamic-retrieval.js';

// Semantic compression
export {
  extractAtomicFacts,
  createSemanticUnit,
  compressToSemanticUnits,
  serializeSemanticUnit,
} from './memory/semantic-compression.js';
export type { AtomicFact, SemanticUnit, SemanticCompressionConfig } from './memory/semantic-compression.js';

// Ollama embedding support
export { OllamaEmbeddingProvider } from './memory/embeddings.js';

// New optimization modules
export {
  compressMemoryEntry,
  compressMemoryBatch,
  summarizeMemories,
  estimateTokens,
  ContextBudget,
} from './memory/context-compressor.js';
export type { CompressionResult, CompressorConfig } from './memory/context-compressor.js';

export {
  HierarchicalMemoryManager,
  getHierarchicalMemoryManager,
  calculateEffectiveImportance,
  persistToSQLite,
  loadFromSQLite,
  saveHierarchicalMemory,
} from './memory/hierarchical-memory.js';
export type { MemoryEntry, TieredMemory, HierarchicalConfig } from './memory/hierarchical-memory.js';

export {
  SpeculativeCache,
  getSpeculativeCache,
  initializeCacheFromDb,
  autoWarmCache,
} from './memory/speculative-cache.js';
export type { CacheEntry, CacheConfig } from './memory/speculative-cache.js';

export {
  MemoryConsolidator,
  getMemoryConsolidator,
} from './memory/memory-consolidator.js';
export type { ConsolidationConfig, ConsolidationResult } from './memory/memory-consolidator.js';

// Serverless Qdrant
export {
  ServerlessQdrantManager,
  getServerlessQdrantManager,
  initServerlessQdrant,
} from './memory/serverless-qdrant.js';

// Multi-view memory with ENGRAM typing
export {
  MultiViewMemoryManager,
  getMultiViewMemoryManager,
  classifyENGRAMType,
  extractTemporalBucket,
} from './memory/multi-view-memory.js';
export type {
  ENGRAMMemoryType,
  MultiViewMemory,
  MultiViewIndex,
} from './memory/multi-view-memory.js';

// Entropy-aware compression
export { calculateEntropy, calculateInformationDensity } from './memory/semantic-compression.js';

// Write Gate - quality filter for memory writes
export {
  evaluateWriteGate,
  formatGateResult,
} from './memory/write-gate.js';
export type {
  WriteGateResult,
  GateCriteria,
  WriteGateConfig,
} from './memory/write-gate.js';

// Daily Log - staging area for memory writes
export { DailyLog, ensureDailyLogSchema } from './memory/daily-log.js';
export type { DailyLogEntry, PromotionCandidate } from './memory/daily-log.js';

// Correction Propagation
export { propagateCorrection, getSupersededHistory, ensureSupersededSchema } from './memory/correction-propagator.js';
export type { CorrectionResult, SupersededEntry } from './memory/correction-propagator.js';

// Memory Maintenance
export { runMaintenance, getHealthSummary } from './memory/memory-maintenance.js';
export type { MaintenanceResult, MaintenanceConfig } from './memory/memory-maintenance.js';

// Agent-Scoped Memory (per-agent isolation)
export { AgentScopedMemory, ensureAgentScopedSchema } from './memory/agent-scoped-memory.js';
export type { AgentMemoryPartition, AgentScopedEntry } from './memory/agent-scoped-memory.js';

// String similarity utilities
export {
  jaccardSimilarity,
  contentHash,
  estimateTokensAccurate,
  simpleStem,
  fuzzyKeywordMatch,
  textSimilarity,
} from './utils/string-similarity.js';

// Model router with feedback loop (memory-layer)
export {
  routeTask as routeTaskToModel,
  recordTaskOutcome,
  explainRouting,
  getFailureHandler as getModelFailureHandler,
  getModelFingerprint,
  getAllModelFingerprints,
  updateModelFingerprint,
  ModelRouter as MemoryModelRouter,
} from './memory/model-router.js';
export type { ModelId, ModelFingerprint, RoutingDecision, RoutingConfig } from './memory/model-router.js';

// Adaptive context system (OPTIMIZATION 7 + v1.9.0 10 Optimizations)
export {
  HybridAdaptiveContext,
  decideContextLevel,
  generateContext,
  assessTimePressure,
  getHistoricalBenefit,
  recordOutcome as recordAdaptiveOutcome,
  selectRelevantSections,
  getProgressiveContextLevels,
  exportConfigForPython,
  // OPT 9: Multi-category classification
  classifyTaskMultiCategory,
  // OPT 7: Error-to-section mapping
  getSectionsForError,
  // OPT 6: Task-type patterns
  getRelevantPatterns,
  // OPT 10: Semantic caching
  lookupSemanticCache,
  storeSemanticCache,
  // OPT 8: Model fingerprint integration
  getModelFingerprintForTask,
  // Cleanup
  closeHistoricalDb,
} from './memory/adaptive-context.js';
export type { 
  ContextDecision, 
  ContextLevel, 
  TimePressure, 
  TaskMetadata, 
  HistoricalData,
  // OPT 9: Multi-category result
  MultiCategoryClassification,
} from './memory/adaptive-context.js';

// Terminal-Bench domain knowledge
export {
  getRelevantKnowledge,
  formatKnowledgeForContext,
  recordKnowledgeOutcome,
  TERMINAL_BENCH_KNOWLEDGE,
} from './memory/terminal-bench-knowledge.js';
export type { DomainKnowledge } from './memory/terminal-bench-knowledge.js';

// MCP Router - Lightweight hierarchical router for 98%+ token reduction
export {
  McpRouter,
  runStdioServer,
  loadConfigFromPaths,
  loadConfigFromFile,
  mergeConfigs,
  ToolSearchIndex,
  McpClient,
  McpClientPool,
  DISCOVER_TOOLS_DEFINITION,
  EXECUTE_TOOL_DEFINITION,
  handleDiscoverTools,
  handleExecuteTool,
  estimateDiscoverToolsTokens,
  estimateExecuteToolTokens,
} from './mcp-router/index.js';
export type {
  McpConfig,
  McpServerConfig,
  ToolDefinition,
  ToolSearchResult,
  DiscoverToolsArgs,
  ExecuteToolArgs,
  ToolRegistry,
  RouterStats,
  RouterOptions,
} from './mcp-router/index.js';
