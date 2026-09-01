# UAP Programmatic API Reference

> Public API of the `@miller-tech/uap` package. Version v1.224.0.

> **🏭 Where this fits:** Cross-cutting — the machine parts behind the line.
> **What it delivers:** when the `uap` CLI isn't the right shape for your job,
> these exports let you wire UAP's memory, routing, coordination, and MCP
> stations straight into your own tools and drive the [delivery pipeline](../guides/DELIVERY_PIPELINE.md)
> from your own code.

If the CLI is the control panel, this is the parts bin — the same subsystems,
exposed so you can bolt them into your own harness. Install and import:

```bash
npm install @miller-tech/uap
```

```ts
import { analyzeProject, getHierarchicalMemoryManager, McpRouter } from '@miller-tech/uap';
```

The package entry point is `dist/index.js` (`main`). Everything documented here
is re-exported from the package root unless noted otherwise.

> **Note on the delivery loop.** The convergence engine that powers
> `uap deliver` (`ConvergenceLoop`) lives in `src/delivery/` and is **not**
> re-exported from the package root, and the package defines no subpath
> `exports`. Drive the delivery loop through the [`uap deliver`](./CLI.md#deliver)
> CLI rather than importing it programmatically.

## Contents

- [Project analysis & generation](#project-analysis--generation)
- [Multi-model architecture](#multi-model-architecture)
- [Memory system](#memory-system)
- [Knowledge graph (L4)](#knowledge-graph-l4)
- [MCP router](#mcp-router)
- [Coordination](#coordination)
- [Tasks](#tasks)
- [Utilities](#utilities)
- [Type modules](#type-modules)

---

## Project analysis & generation

```ts
function analyzeProject(projectPath?: string): Promise<ProjectAnalysis>;
function generateClaudeMd(analysis: ProjectAnalysis, options?: GenerateOptions): string;
```

- `analyzeProject` — inspect a project directory and return structured metadata
  (languages, frameworks, structure) used to drive context generation.
- `generateClaudeMd` — render a CLAUDE.md document from an analysis result.

---

## Multi-model architecture

Imported from the package root (originating in `src/models/`). Routes tasks to
models by complexity, plans multi-step work, and executes plans with
retry/fallback.

### Factory functions

```ts
function createRouter(config: MultiModelConfig): ModelRouter;
function createCostOptimizedRouter(): ModelRouter;
function createPerformanceRouter(): ModelRouter;
function createPlanner(router: ModelRouter, config: MultiModelConfig, options?: PlannerOptions): TaskPlanner;
function createExecutor(router: ModelRouter, config: MultiModelConfig, client: ModelClient, options?: ExecutorOptions): TaskExecutor;
function createUnifiedRouter(config: MultiModelConfig, benchmarkConfig?: Partial<RoutingConfig>): UnifiedRoutingService;
function createPlanValidator(config?: PlanValidationConfig): PlanValidator;
function getModelAnalytics(): ModelAnalytics;   // singleton
```

### `ModelRouter`

Classifies tasks and selects models per role.

```ts
class ModelRouter {
  constructor(config: MultiModelConfig);
  classifyTask(taskDescription: string): TaskClassificationResult;
  selectModel(complexity: TaskComplexity, taskType: string, keywords: string[]): ModelSelection;
  estimateCost(model: ModelConfig, inputTokens: number, outputTokens: number): number;
  getModel(modelId: string): ModelConfig | undefined;
  getModelForRole(role: ModelRole): ModelConfig | undefined;
  getAllModels(): ModelConfig[];
  analyzeRouting(taskDescription: string): { classification: TaskClassificationResult; matchedRules: unknown[]; costComparison: Array<{ model: string; cost: number }> };
}
```

### `TaskPlanner`

Decomposes a task into an `ExecutionPlan`.

```ts
class TaskPlanner {
  constructor(router: ModelRouter, config: MultiModelConfig, options?: PlannerOptions);
  createPlan(taskDescription: string): Promise<ExecutionPlan>;
  getExecutionOrder(plan: ExecutionPlan): string[][];
  visualizePlan(plan: ExecutionPlan): string;
}
```

### `TaskExecutor`

Executes a plan's subtasks against a `ModelClient`.

```ts
class TaskExecutor {
  constructor(router: ModelRouter, config: MultiModelConfig, client: ModelClient, options?: ExecutorOptions);
  executePlan(plan: ExecutionPlan, planner: TaskPlanner, onResult?: (r: ExecutionResult) => void): Promise<ExecutionResult[]>;
  executeSubtask(subtask: Subtask, plan: ExecutionPlan): Promise<ExecutionResult>;
  getResults(planId: string): ExecutionResult[] | undefined;
  getTotalCost(planId: string): number;
  getSuccessRate(planId: string): number;
  generateSummary(planId: string): string;
}
```

### `ModelClient` and `MockModelClient`

The seam executors call to reach an LLM.

```ts
interface ModelClient {
  complete(
    model: ModelConfig,
    prompt: string,
    options?: { maxTokens?: number; timeout?: number; temperature?: number }
  ): Promise<{ content: string; tokensUsed: { input: number; output: number }; latencyMs: number }>;
}

class MockModelClient implements ModelClient {
  constructor(responses?: Record<string, string>, latency?: number);
}
```

### `ModelPresets`

A lookup record of built-in model configs (not a function), keyed by preset id
(e.g. `'opus-4.6'`, `'qwen35-a3b'`, `'haiku'`, `'gpt-5.4'`).

```ts
const ModelPresets: Record<string, ModelConfig>;
```

### Execution profiles

```ts
function getExecutionProfile(profileId: string): ExecutionProfile | undefined;
function detectExecutionProfile(modelName: string): ExecutionProfile;
function getExecutionConfig(modelName: string, userOverrides?: Partial<AgentExecutionConfig>): { profile: ExecutionProfile; config: AgentExecutionConfig };
function listExecutionProfiles(): ExecutionProfile[];
```

### `PlanValidator` and `ModelAnalytics`

```ts
class PlanValidator {
  constructor(config?: PlanValidationConfig);
  validatePlan(plan: ExecutionPlan): Promise<PlanValidationResult>;
  getConfig(): PlanValidationConfig;
  updateConfig(config: PlanValidationConfig): void;
}

class ModelAnalytics {
  constructor(dbPath?: string);
  recordOutcome(outcome: TaskOutcome): void;
  getSuccessRate(modelId: string, taskType?: string): number;
  getAvgLatency(modelId: string, taskType?: string): number;
  getMetrics(modelId?: string): ModelMetrics[];
  getCostBreakdown(since?: Date): CostBreakdown[];
  getSessionUsage(): SessionModelUsage[];
  getOptimalRouting(): Record<string, string>;
  getTotalCost(): number;
  close(): void;
}
```

### Example

```ts
import { createRouter, createPlanner, createExecutor, MockModelClient, ModelPresets } from '@miller-tech/uap';

const config = {
  enabled: true,
  models: ['opus-4.6', 'qwen35-a3b'],
  roles: { planner: 'opus-4.6', executor: 'qwen35-a3b', fallback: 'qwen35-a3b' },
  routingStrategy: 'balanced' as const,
};

const router = createRouter(config);
const planner = createPlanner(router, config);
const plan = await planner.createPlan('Add OAuth2 login with JWT and tests');

const executor = createExecutor(router, config, new MockModelClient());
const results = await executor.executePlan(plan, planner);
console.log(executor.generateSummary(plan.id));
```

---

## Memory system

### Embeddings

```ts
function getEmbeddingService(): EmbeddingService;        // honors UAP_EMBEDDING_ENDPOINT
function generateEmbedding(text: string): Promise<number[]>;
function generateEmbeddings(texts: string[]): Promise<number[][]>;

class OllamaEmbeddingProvider {
  constructor(endpoint?: string, model?: string);  // defaults: localhost:11434, nomic-embed-text (768-dim)
}
```

### Hierarchical (tiered) memory

Hot/warm/cold tiered store with automatic promotion, demotion, decay, and a
token budget.

```ts
class HierarchicalMemoryManager {
  constructor(config?: Partial<HierarchicalConfig>);
  add(entry: Omit<MemoryEntry, 'accessCount' | 'lastAccessed' | 'tier'>): void;
  access(id: string): MemoryEntry | null;
  query(queryText: string, limit?: number): Promise<MemoryEntry[]>;
  getHotContext(): { entries: MemoryEntry[]; tokens: number };
  consolidate(): Promise<void>;
  pruneStale(): number;
  enforceTokenBudget(): number;
  getStats(): { hot: { count: number; tokens: number }; warm: { count: number; tokens: number }; cold: { count: number; tokens: number }; total: { count: number; tokens: number } };
  export(): TieredMemory;
  import(data: TieredMemory): void;
}

function getHierarchicalMemoryManager(config?: Partial<HierarchicalConfig>, dbPath?: string): HierarchicalMemoryManager;
function saveHierarchicalMemory(dbPath?: string): void;
function persistToSQLite(manager: HierarchicalMemoryManager, dbPath: string): void;
function loadFromSQLite(dbPath: string): TieredMemory | null;
function calculateEffectiveImportance(entry: MemoryEntry, decayRate?: number): number;
```

```ts
interface MemoryEntry {
  id: string;
  content: string;
  type: 'action' | 'observation' | 'thought' | 'goal';
  timestamp: string;
  importance: number;
  accessCount: number;
  lastAccessed: string;
  embedding?: number[];
  compressed?: string;
  tier?: 'hot' | 'warm' | 'cold';
}

interface TieredMemory { hot: MemoryEntry[]; warm: MemoryEntry[]; cold: MemoryEntry[]; }
```

### Dynamic retrieval

```ts
function retrieveDynamicMemoryContext(
  taskInstruction: string,
  projectRoot?: string,
  options?: { maxTokens?: number; useSemanticCompression?: boolean; taskMetadata?: TaskMetadata }
): Promise<DynamicMemoryContext>;
```

Returns a token-budget-bounded memory context scaled to query complexity.

### Write gate

Quality filter that decides whether a candidate memory is worth persisting.

```ts
function evaluateWriteGate(content: string, config?: WriteGateConfig): WriteGateResult;
function formatGateResult(result: WriteGateResult): string;

interface WriteGateResult { passed: boolean; score: number; criteria: GateCriteria[]; rejectionReason?: string; }
interface WriteGateConfig { minScore: number; enableFuzzyMatching: boolean; }  // default { minScore: 0.3, enableFuzzyMatching: true }
```

### Other memory exports

| Symbol | Kind | Purpose |
|--------|------|---------|
| `classifyTask`, `extractTaskEntities`, `getSuggestedMemoryQueries` | functions | Classify a task and derive memory queries |
| `compressMemoryEntry`, `compressMemoryBatch`, `summarizeMemories`, `estimateTokens`, `ContextBudget` | functions/class | Context compression and token budgeting |
| `extractAtomicFacts`, `compressToSemanticUnits`, `createSemanticUnit`, `serializeSemanticUnit` | functions | Semantic compression |
| `calculateEntropy`, `calculateInformationDensity` | functions | Entropy-aware compression metrics |
| `SpeculativeCache`, `getSpeculativeCache` | class/fn | Prefetch cache for likely-next memories |
| `MemoryConsolidator`, `getMemoryConsolidator`, `autoStartConsolidation` | class/fns | Background consolidation |
| `ServerlessQdrantManager`, `getServerlessQdrantManager`, `initServerlessQdrant` | class/fns | Embedded Qdrant management |
| `DailyLog`, `ensureDailyLogSchema` | class/fn | Staging area for memory writes |
| `propagateCorrection`, `getSupersededHistory` | functions | Correction propagation across tiers |
| `runMaintenance`, `getHealthSummary` | functions | Decay / prune / archive / dedupe |
| `PredictiveMemoryService`, `getPredictiveMemoryService` | class/fn | Predictive prefetch + learning |
| `ContextPruner` | class | Token-budget-aware context pruning |
| `detectAmbiguity`, `formatAmbiguityForContext` | functions | Ambiguity detection (P37 pattern) |
| `routeTaskToModel`, `recordTaskOutcome`, `explainRouting` | functions | Memory-layer model router with feedback |

---

## Knowledge graph (L4)

SQLite-backed entity/relationship graph.

```ts
class KnowledgeGraph {
  constructor(dbPath: string);
  upsertEntity(type: string, name: string, description?: string): Entity;
  getEntity(type: string, name: string): Entity | null;
  getEntitiesByType(type: string, limit?: number): Entity[];
  searchEntities(query: string, limit?: number): Entity[];
  deleteEntity(id: number): boolean;
  addRelationship(sourceId: number, targetId: number, relation: string, strength?: number): Relationship;
  getRelationships(entityId: number): Relationship[];
  queryEntityGraph(type: string, name: string): GraphQueryResult | null;
  traverseGraph(entityId: number, maxDepth?: number): Entity[];
  getStats(): { entityCount: number; relationshipCount: number; entityTypes: string[] };
  close(): void;
}
```

---

## MCP router

Hierarchical router exposing two meta-tools (discover + execute) for 98%+ token
reduction versus exposing every server's full tool list.

```ts
class McpRouter {
  constructor(options?: RouterOptions);          // { configPath?, autoDiscover?, verbose? }
  loadTools(): Promise<void>;
  getToolDefinitions(): Array<ToolDefinition>;
  handleToolCall(name: string, args: unknown): Promise<unknown>;
  getStats(): RouterStats;
  getConfig(): McpConfig;
  shutdown(): Promise<void>;
}

function runStdioServer(options?: RouterOptions): Promise<void>;
function loadConfigFromPaths(): McpConfig;        // merges known platform config paths
function loadConfigFromFile(path: string): McpConfig;
function mergeConfigs(...configs: McpConfig[]): McpConfig;
function handleDiscoverTools(args: DiscoverToolsArgs, searchIndex: ToolSearchIndex): { tools: ToolSearchResult[]; hint: string };
function handleExecuteTool(args: ExecuteToolArgs, searchIndex: ToolSearchIndex, clientPool: McpClientPool): Promise<unknown>;
```

Also exported: `ToolSearchIndex`, `McpClient`, `McpClientPool`,
`DISCOVER_TOOLS_DEFINITION`, `EXECUTE_TOOL_DEFINITION`,
`estimateDiscoverToolsTokens`, `estimateExecuteToolTokens`.

```ts
import { runStdioServer } from '@miller-tech/uap';
await runStdioServer({ configPath: './mcp.json', verbose: true });
```

---

## Coordination

Imported from the package root (originating in `src/coordination/`). The main
class is `CoordinationService` — agent registry, resource claims, work
announcements, messaging, and deploy batching, all backed by SQLite.

```ts
class CoordinationService {
  constructor(config?: CoordinationServiceConfig);

  // lifecycle
  register(name: string, capabilities?: string[], worktreeBranch?: string, id?: string): string;
  heartbeat(agentId: string): void;
  updateStatus(agentId: string, status: AgentStatus, currentTask?: string): void;
  deregister(agentId: string): void;
  getActiveAgents(): AgentRegistryEntry[];
  cleanupStaleAgents(): number;

  // resource claims
  claimResource(agentId: string, resource: string, claimType?: ClaimType): boolean;
  releaseResource(agentId: string, resource: string): void;
  isResourceClaimed(resource: string): string | null;

  // work announcements & overlap
  announceWork(...): void;
  completeWork(agentId: string, resource: string): void;
  getActiveWork(): WorkAnnouncement[];
  detectOverlaps(resource: string, excludeAgentId?: string): WorkOverlap[];

  // messaging
  broadcast(...): void;
  send(fromAgent: string, toAgent: string, payload: MessagePayload, priority?: number): void;
  receive(agentId: string, channel?: MessageChannel, markAsRead?: boolean): AgentMessage[];

  // deploy batching
  queueDeploy(...): void;
  getReadyDeploys(): DeployAction[];
  flushDeploys(options?: { dryRun?: boolean }): Promise<{ executed: number; failed: number }>;

  getStatus(): CoordinationStatus;
  cleanup(): void;
}
```

The coordination module also exports the deploy batcher, capability router,
auto-agent, and pattern router helpers (see `src/coordination/index.ts`).

---

## Tasks

Imported from the package root (originating in `src/tasks/`). The main class is
`TaskService`.

```ts
class TaskService {
  constructor(config?: TaskServiceConfig);
  create(input: CreateTaskInput): Task;
  get(id: string): Task | null;
  getWithRelations(id: string): TaskWithRelations | null;
  update(id: string, input: UpdateTaskInput): Task | null;
  close(id: string, reason?: string): Task | null;
  delete(id: string): boolean;
  list(filter?: TaskFilter): Task[];
  ready(): TaskWithRelations[];
  blocked(): TaskWithRelations[];
  addDependency(...): void;
  removeDependency(fromTask: string, toTask: string): boolean;
  getBlockers(taskId: string): Task[];
  getHistory(taskId: string): TaskHistoryEntry[];
  getStats(): TaskStats;
  exportToJSONL(): string;
  saveToJSONL(): void;
  importFromJSONL(): number;
  compact(olderThanDays?: number): TaskSummary | null;
}
```

### Task event bus

Pub/sub for task lifecycle events.

```ts
class TaskEventBus {
  on(type: TaskEventType, handler: TaskEventHandler): () => void;
  onAny(handler: TaskEventHandler): () => void;
  emit(event: TaskEvent): Promise<void>;
  clear(): void;
  listenerCount(type?: TaskEventType): number;
}

function getTaskEventBus(): TaskEventBus;   // singleton
```

---

## Utilities

| Symbol | Kind | Purpose |
|--------|------|---------|
| `jaccardSimilarity`, `cosineSimilarity`, `textSimilarity`, `fuzzyKeywordMatch`, `contentHash`, `simpleStem`, `estimateTokensAccurate` | functions | String / vector similarity helpers |
| `AdaptiveCache`, `createPatternCache` | class/fn | Adaptive TTL cache |
| `RateLimiter` | class | Token-bucket rate limiting |
| `PerformanceMonitor`, `getPerformanceMonitor`, `monitorFunction` | class/fns | Performance instrumentation |
| `retry`, `withTimeout`, `parallelWithFallback`, `concurrentMap`, `concurrentMapSettled` | functions | Concurrency helpers |
| `createLogger`, `logger`, `setLogLevel`, `getLogLevel` | fns/obj | Structured logging |
| `isPathInsideWorktree`, `isExemptFromWorktree` | functions | Worktree guard utilities |
| `WebBrowser`, `createWebBrowser` | class/fn | Browser automation wrapper |
| `getDashboardData`, `startDashboardServer` | functions | Dashboard data service + server |

---

## Type modules

The package re-exports its full type surface. Key barrels:

- `export * from './types/index.js'` — core config and domain types.
- `export * from './telemetry/index.js'` — telemetry types and helpers.
- `export * from './policies/index.js'` — policy enforcement (`getPolicyGate`,
  `getPolicyMemoryManager`, `getPolicyToolRegistry`, and policy types).

Multi-model types available from the root include `MultiModelConfig`,
`ModelRole`, `TaskComplexity`, `TaskClassificationResult`, `ExecutionPlan`,
`Subtask`, `ExecutionResult`, `ModelSelection`, `PlannerOptions`,
`ExecutorOptions`, `ExecutionProfile`, `ModelMetrics`, `CostBreakdown`, and
`SessionModelUsage`.
