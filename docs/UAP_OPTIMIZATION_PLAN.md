# UAP Optimization & Dashboard Overlay Plan (Validated)

> Validated against codebase on 2026-03-17. All references point to real files, types, and services.

## Validation Summary

### What exists today

- **Policy system**: Full CRUD + enforcement gate + audit trail (`src/policies/`), SQLite-backed, 3 enforcement levels (REQUIRED/RECOMMENDED/OPTIONAL), `togglePolicy()` already on `PolicyMemoryManager`
- **Memory system**: 4-tier (L1-L4), 26 files in `src/memory/`, adaptive context, dynamic retrieval, predictive pre-fetch
- **Model router**: Rule-based (`src/models/router.ts`) + benchmark-data (`src/memory/model-router.ts`) + unified consensus (`src/models/unified-router.ts`), execution profiles per model family (`src/models/execution-profiles.ts`)
- **Dashboard**: 1830-line terminal dashboard (`src/cli/dashboard.ts`) with 8 views, 424-line viz library (`src/cli/visualize.ts`), session telemetry (`src/telemetry/session-telemetry.ts`)
- **No web dashboard exists**. All visualization is chalk-based terminal output.
- **No enforcement stage concept exists** on policies. Policies have `level` (REQUIRED/RECOMMENDED/OPTIONAL) and `isActive` (boolean) but no stage gating.

### What the original plan got wrong

1. Proposed `ink`/`blessed` TUI -- unnecessary. The existing chalk-based dashboard + visualize.ts primitives already work and are battle-tested. New panels should extend the existing system.
2. Proposed web React dashboard from scratch -- premature. Option 3 (embedded) is correct: extend the existing `uap dashboard` CLI with new panels first, add a lightweight HTTP/WebSocket server later.
3. Missed that `PolicyMemoryManager.togglePolicy()` already exists at `src/policies/policy-memory.ts:91`.
4. Missed that `unified-router.ts` model maps need updating for opus-4.6 and qwen35.
5. Missed that the session dashboard already shows policies but only as hardcoded bullet items (`dashboard.ts:1305-1317`), not from the database.

### Codebase gaps that must be fixed before dashboard work

1. `src/models/unified-router.ts:35-49` -- `BENCHMARK_TO_RULE_MODEL_MAP` and `RULE_TO_BENCHMARK_MODEL_MAP` are missing entries for `opus-4.6` and `qwen35`
2. `src/cli/model.ts:44-59` -- `getMultiModelConfig()` defaults still reference `opus-4.5` as fallback
3. `src/cli/dashboard.ts:1305-1317` -- Policies section is hardcoded, not reading from `PolicyMemoryManager`

---

## Part 1: Model Optimization

### A. Immediate Fixes (Prerequisite)

#### 1.1 Update unified-router model maps

**File**: `src/models/unified-router.ts:35-49`

```typescript
const BENCHMARK_TO_RULE_MODEL_MAP: Record<string, string> = {
  'claude-opus-4.5': 'opus-4.5',
  'claude-opus-4.6': 'opus-4.6', // ADD
  'gpt-5.2': 'gpt-5.2',
  'glm-4.7': 'glm-4.7',
  'gpt-5.2-codex': 'gpt-5.2',
  qwen35: 'qwen35', // ADD
};

const RULE_TO_BENCHMARK_MODEL_MAP: Record<string, ModelId> = {
  'opus-4.5': 'claude-opus-4.5',
  'opus-4.6': 'claude-opus-4.6', // ADD
  'gpt-5.2': 'gpt-5.2',
  'glm-4.7': 'glm-4.7',
  'deepseek-v3.2': 'gpt-5.2',
  'deepseek-v3.2-exp': 'gpt-5.2',
  'qwen35-a3b': 'glm-4.7',
  qwen35: 'qwen35', // ADD
};
```

#### 1.2 Update CLI model defaults

**File**: `src/cli/model.ts:44-59`

Change `getMultiModelConfig()` fallback to use `ModelRouter.getDefaultUAPConfig()` instead of hardcoded opus-4.5 defaults.

#### 1.3 Add benchmark fingerprint for opus-4.6 and qwen35

**File**: `src/memory/model-router.ts`

Add `MODEL_FINGERPRINTS` entries for `claude-opus-4.6` and `qwen35` so the benchmark-data router can track them.

### B. Qwen 3.5 Optimizations

#### 2.1 Dynamic quantization switching

**Where**: New function in `src/models/execution-profiles.ts`

The `SMALL_MOE_PROFILE` already covers qwen3.5 correctly. Enhancement: add a `quantizationHint` field to `ExecutionProfile` so the llama.cpp server can be told which quant to load.

```typescript
// Add to ExecutionProfile interface
quantizationHint?: {
  low: string;    // e.g. 'iq2_xs' for simple tasks
  medium: string; // e.g. 'iq4_xs' for standard tasks
  high: string;   // e.g. 'q5_k_m' for complex tasks
};
```

The router already classifies complexity. Wire the quant hint into the `ModelSelection` result so the agent runner can pass it to the llama.cpp endpoint.

#### 2.2 Context window management

**Where**: Extend `src/memory/context-compressor.ts` and `src/memory/adaptive-context.ts`

These already exist and handle token budgets. Enhancement:

- Add a `modelContextBudget` field to `ModelConfig` in `src/models/types.ts` (distinct from `maxContextTokens`) representing the _effective_ context the model handles well
- For qwen35: `maxContextTokens: 262144` but `modelContextBudget: 32768` (sweet spot for 3B active params)
- `AdaptiveContext` already selects context level by task type -- wire it to respect `modelContextBudget`

#### 2.3 Prompt token budget tracking

**Where**: `src/memory/context-compressor.ts` already has `SemanticCompressor` with entropy-aware compression

Enhancement: expose a per-session token counter that the dashboard can read. Add to `globalSessionStats` in `src/mcp-router/session-stats.ts`:

```typescript
// Already exists: totalContextBytes, totalRawBytes, savingsRatio
// Add:
modelTokenBudget: number; // from modelContextBudget
modelTokensConsumed: number; // running total
compressionEvents: number; // how many times compressor fired
```

### C. Multi-Model Routing Enhancements

#### 3.1 Complexity-based routing matrix

**Where**: `src/models/router.ts` -- `selectAdaptiveModel()` already implements this logic

Current behavior (validated):

- `critical`/`high` -> planner (opus-4.6)
- `medium` -> executor (qwen35)
- `low` -> cheapest model (qwen35, $0/1M)

This is correct. No change needed for the matrix itself.

Enhancement: add a `routingMatrix` config option to `MultiModelConfig` so users can override per-complexity routing without editing code:

```typescript
// Add to MultiModelConfig in src/models/types.ts
routingMatrix?: Record<TaskComplexity, { planner: string; executor: string }>;
```

#### 3.2 Performance analytics module

**Where**: New file `src/models/analytics.ts`

```typescript
export interface TaskOutcome {
  modelId: string;
  taskType: string;
  complexity: TaskComplexity;
  success: boolean;
  durationMs: number;
  tokensUsed: { input: number; output: number };
  cost: number;
  timestamp: string;
}

export class ModelAnalytics {
  private db: Database; // SQLite, same pattern as other DBs

  recordOutcome(outcome: TaskOutcome): void;
  getSuccessRate(modelId: string, taskType?: string): number;
  getAvgLatency(modelId: string, taskType?: string): number;
  getOptimalRouting(): Record<string, string>; // taskType -> modelId
  getCostBreakdown(since?: Date): CostBreakdown[];
}
```

This feeds into the dashboard cost tracker panel.

---

## Part 2: Dashboard -- Policies / Memories / Model Active Panels

### A. Architecture Decision

**Extend the existing `src/cli/dashboard.ts`** with new panels and a new `uap dashboard policies` view. Do NOT build a separate TUI framework. The existing chalk + visualize.ts primitives cover everything needed.

For the web overlay (Phase 3), add a thin HTTP + WebSocket server that serves JSON from the same data sources the CLI dashboard reads. A single-page HTML file (like the existing `web/generator.html` pattern) consumes it.

### B. New Dashboard Panels

#### Panel 1: Policies Active

**CLI command**: `uap dashboard policies`

Reads from `PolicyMemoryManager.getAllPolicies()` and `PolicyGate.getAuditTrail()`.

```
  UAP Policies Dashboard
  ──────────────────────────────────────────────────────

  Active Policies (3)
  ──────────────────────────────────────────────────────
  Name                      Level        Category   Stage      Status
  ─────────────────────────────────────────────────────────────────────
  IaC State Parity          REQUIRED     code       pre-exec   ON
  Mandatory File Backup     REQUIRED     code       pre-exec   ON
  Image Asset Verification  RECOMMENDED  image      pre-exec   ON

  Enforcement Stages
  ──────────────────────────────────────────────────────
  pre-exec   ████████████████████ 3 policies
  post-exec  ░░░░░░░░░░░░░░░░░░░ 0 policies
  review     ░░░░░░░░░░░░░░░░░░░ 0 policies

  Recent Audit Trail (last 10)
  ──────────────────────────────────────────────────────
  2026-03-17 14:23  IaC State Parity       web_browser  ALLOWED
  2026-03-17 14:22  Mandatory File Backup  file_write   ALLOWED
  2026-03-17 14:20  IaC State Parity       terraform    BLOCKED  "No state file"

  Toggle: uap policy toggle <id> --off
  Stage:  uap policy stage <id> --stage post-exec
  Level:  uap policy level <id> --level OPTIONAL
```

#### Panel 2: Memories Active

**CLI command**: `uap dashboard memories`

Extends the existing memory section in `showSessionDashboard()` (`dashboard.ts:1217-1247`).

```
  UAP Memories Dashboard
  ──────────────────────────────────────────────────────

  Memory Tiers
  ──────────────────────────────────────────────────────
  L1 Working    ████████░░░░░░░░░░░░  42/50 entries   12 KB
  L2 Session    ██░░░░░░░░░░░░░░░░░░  8 entries       3 KB
  L3 Semantic   Qdrant: Running (Up 4h 23m)  1,247 vectors
  L4 Knowledge  23 entities  47 relationships

  Active Memories This Session (by type)
  ──────────────────────────────────────────────────────
  decision     ████████████  12
  observation  ████████      8
  pattern      ██████        6
  correction   ██            2

  Open Loops (3)
  ──────────────────────────────────────────────────────
  > TODO: wire dashboard WebSocket to session-stats
  > BLOCKED: Qdrant cloud migration pending API key
  > REVIEW: memory consolidation threshold too aggressive

  Compression Stats
  ──────────────────────────────────────────────────────
  Token budget:    32,768 / 262,144 (12.5%)
  Compressions:    4 this session
  Savings ratio:   73.2%
```

#### Panel 3: Model Active Per Task

**CLI command**: `uap dashboard models`

Reads from `ModelRouter`, `UnifiedRoutingService`, and the new `ModelAnalytics`.

```
  UAP Model Dashboard
  ──────────────────────────────────────────────────────

  Active Configuration
  ──────────────────────────────────────────────────────
  Planner:   opus-4.6    Claude Opus 4.6    $7.50/$37.50 per 1M
  Executor:  qwen35      Qwen 3.5 (local)   $0.00/$0.00
  Reviewer:  opus-4.6    Claude Opus 4.6
  Fallback:  qwen35      Qwen 3.5 (local)
  Strategy:  balanced

  Routing Matrix
  ──────────────────────────────────────────────────────
  Complexity   Planner     Executor
  low          qwen35      qwen35       $0.00
  medium       opus-4.6    qwen35       $0.04
  high         opus-4.6    opus-4.6     $0.22
  critical     opus-4.6    opus-4.6     $0.22

  Session Usage
  ──────────────────────────────────────────────────────
  Model        Tasks  Tokens In  Tokens Out  Cost     Success
  opus-4.6     3      4,521      2,103       $0.11    100%
  qwen35       12     18,432     9,876       $0.00    91.7%

  Execution Profile: small-moe (Qwen 3.5)
  ──────────────────────────────────────────────────────
  domainHints: ON   webSearch: OFF   reflectionCheckpoints: OFF
  temperature: 0.15  loopEscapeThreshold: 3  toolChoiceForce: required
  softBudget: 35    hardBudget: 50

  Unified Router Consensus
  ──────────────────────────────────────────────────────
  Last 10 decisions: 8 consensus, 1 rule-based, 1 benchmark-data
  Avg confidence: 0.82
```

### C. Policy Enforcement Stages & Toggling

#### Schema Changes

**File**: `src/policies/schemas/policy.ts`

Add `enforcementStage` to the policy schema:

```typescript
export const PolicySchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  category: z.enum(['image', 'code', 'security', 'testing', 'ui', 'automation', 'custom']),
  level: z.enum(['REQUIRED', 'RECOMMENDED', 'OPTIONAL']),
  enforcementStage: z.enum(['pre-exec', 'post-exec', 'review', 'always']).default('pre-exec'), // NEW
  rawMarkdown: z.string(),
  convertedFormat: z.string().optional(),
  executableTools: z.array(z.string()).optional(),
  tags: z.array(z.string()),
  createdAt: z
    .string()
    .refine((d) => !Number.isNaN(Date.parse(d)), { message: 'Invalid ISO date string' }),
  updatedAt: z
    .string()
    .refine((d) => !Number.isNaN(Date.parse(d)), { message: 'Invalid ISO date string' }),
  version: z.number(),
  isActive: z.boolean(),
  priority: z.number().default(50),
});
```

**File**: `src/policies/database-manager.ts`

Add column to `policies` table:

```sql
ALTER TABLE policies ADD COLUMN enforcementStage TEXT NOT NULL DEFAULT 'pre-exec';
```

Use a migration check pattern (check if column exists before adding).

#### PolicyGate Changes

**File**: `src/policies/policy-gate.ts`

Add stage-aware enforcement:

```typescript
async executeWithGates<T>(
  operation: string,
  args: Record<string, unknown>,
  executor: () => Promise<T>,
  stage: 'pre-exec' | 'post-exec' | 'review' = 'pre-exec'  // NEW param
): Promise<T> {
  const gateResult = await this.checkPolicies(operation, args, stage);
  // ... existing logic, but only check policies matching this stage
}

async checkPolicies(
  operation: string,
  args: Record<string, unknown>,
  stage: 'pre-exec' | 'post-exec' | 'review' | 'always' = 'pre-exec'
): Promise<GateResult> {
  const allPolicies = await this.memory.getAllPolicies();
  // Filter to policies matching this stage or 'always'
  const stagePolicies = allPolicies.filter(
    p => p.enforcementStage === stage || p.enforcementStage === 'always'
  );
  // ... evaluate only stagePolicies
}
```

#### CLI Commands for Toggling

**File**: `src/bin/policy.ts` (extend existing)

```
uap policy toggle <id> [--on|--off]     # Uses existing PolicyMemoryManager.togglePolicy()
uap policy stage <id> --stage <stage>    # New: change enforcement stage
uap policy level <id> --level <level>    # New: change REQUIRED/RECOMMENDED/OPTIONAL
uap policy list                          # New: list all with status/stage/level
uap policy audit [--policy-id <id>]      # New: show audit trail
```

Implementation: `togglePolicy()` already exists. Add `setEnforcementStage()` and `setLevel()` to `PolicyMemoryManager`:

```typescript
// src/policies/policy-memory.ts
async setEnforcementStage(id: string, stage: 'pre-exec' | 'post-exec' | 'review' | 'always'): Promise<void> {
  this.db.updatePolicy({ id }, { enforcementStage: stage, updatedAt: new Date().toISOString() });
}

async setLevel(id: string, level: 'REQUIRED' | 'RECOMMENDED' | 'OPTIONAL'): Promise<void> {
  this.db.updatePolicy({ id }, { level, updatedAt: new Date().toISOString() });
}
```

### D. Grouping: Per-Task vs Grouped Display

The dashboard supports both views:

1. **Grouped view** (default for `uap dashboard policies`, `uap dashboard models`): Shows aggregate state -- all active policies, all model assignments, memory tier health.

2. **Per-task view** (when a task ID is provided): Shows what was active _for that specific task_.

```
uap dashboard policies                    # Grouped: all policies, stages, audit
uap dashboard policies --task <task-id>   # Per-task: which policies fired for this task
uap dashboard models                      # Grouped: all model assignments, session totals
uap dashboard models --task <task-id>     # Per-task: which model handled this task, tokens, cost
uap dashboard memories --task <task-id>   # Per-task: memories retrieved/stored for this task
```

Per-task view requires linking `policy_executions` and `ModelAnalytics.TaskOutcome` to task IDs. Add a `taskId` column to both:

- `policy_executions` table: `taskId TEXT` (nullable, for backward compat)
- `ModelAnalytics` outcomes table: `taskId TEXT`

---

## Part 3: Phase 3 -- Advanced Features

### A. Web Overlay (Option 3: Embedded)

Architecture: The CLI dashboard functions already compute all the data. Extract the data-gathering logic into shared service functions, then expose via a lightweight HTTP server.

#### 3.1 Data service layer

**New file**: `src/dashboard/data-service.ts`

```typescript
export interface DashboardData {
  policies: PolicyDashboardData;
  memories: MemoryDashboardData;
  models: ModelDashboardData;
  tasks: TaskDashboardData;
  coordination: CoordinationDashboardData;
}

export async function getDashboardData(): Promise<DashboardData> {
  // Reuse the same DB queries from dashboard.ts but return structured data
  // instead of printing to console
}
```

#### 3.2 Embedded HTTP + WebSocket server

**New file**: `src/dashboard/server.ts`

```typescript
import { createServer } from 'http';
import { WebSocketServer } from 'ws'; // ws package, already common in Node ecosystem
import { getDashboardData } from './data-service.js';

export function startDashboardServer(port: number = 3847): void {
  const server = createServer(async (req, res) => {
    if (req.url === '/api/dashboard') {
      const data = await getDashboardData();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    }
    if (req.url === '/') {
      // Serve the single-page dashboard HTML (like web/generator.html pattern)
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(DASHBOARD_HTML); // Inline or read from file
    }
  });

  const wss = new WebSocketServer({ server });
  // Push updates every 2s
  setInterval(async () => {
    const data = await getDashboardData();
    for (const client of wss.clients) {
      client.send(JSON.stringify(data));
    }
  }, 2000);

  server.listen(port);
}
```

#### 3.3 CLI integration

**File**: `src/cli/dashboard.ts`

```
uap dashboard serve [--port 3847]   # Start embedded web dashboard
```

Launches as foreground process. When opencode/claude-code exits, the server dies with it (child process of the same shell).

#### 3.4 Single-page HTML dashboard

**New file**: `web/dashboard.html`

Self-contained HTML + CSS + vanilla JS (no build step, same pattern as `web/generator.html`). Connects to `ws://localhost:3847`, renders:

- Policy table with toggle buttons (POST to `/api/policy/:id/toggle`)
- Memory tier gauges
- Model routing live view
- Cost tracker
- Task timeline

### B. Historical session comparison

Store session snapshots in SQLite (`agents/data/memory/sessions.db`):

```sql
CREATE TABLE session_snapshots (
  id TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL,
  data TEXT NOT NULL,  -- JSON blob from getDashboardData()
  duration_ms INTEGER,
  total_cost REAL,
  tasks_completed INTEGER,
  models_used TEXT     -- JSON array
);
```

CLI: `uap dashboard history [--last 10]`

### C. Export

`uap dashboard export [--format json|csv] [--output file]`

Dumps current dashboard data. JSON is the `DashboardData` object. CSV flattens the key tables (policies, model usage, task outcomes).

---

## Part 4: Implementation Roadmap

### Phase 1: Foundation (Week 1-2)

| #   | Task                                                             | File(s)                                                              | Status |
| --- | ---------------------------------------------------------------- | -------------------------------------------------------------------- | ------ |
| 1   | Update unified-router model maps for opus-4.6/qwen35             | `src/models/unified-router.ts`                                       | Ready  |
| 2   | Update CLI model defaults                                        | `src/cli/model.ts`                                                   | Ready  |
| 3   | Add benchmark fingerprints for new models                        | `src/memory/model-router.ts`                                         | Ready  |
| 4   | Add `enforcementStage` to policy schema + DB migration           | `src/policies/schemas/policy.ts`, `src/policies/database-manager.ts` | Ready  |
| 5   | Add `setEnforcementStage()`, `setLevel()` to PolicyMemoryManager | `src/policies/policy-memory.ts`                                      | Ready  |
| 6   | Add stage-aware filtering to PolicyGate                          | `src/policies/policy-gate.ts`                                        | Ready  |
| 7   | Add policy CLI commands (toggle/stage/level/list/audit)          | `src/bin/policy.ts`                                                  | Ready  |

### Phase 2: Dashboard Panels (Week 3-4)

| #   | Task                                                    | File(s)                                          | Status |
| --- | ------------------------------------------------------- | ------------------------------------------------ | ------ |
| 8   | Replace hardcoded policies section with DB-driven panel | `src/cli/dashboard.ts:1305-1317`                 | Ready  |
| 9   | Build `showPoliciesDashboard()` panel                   | `src/cli/dashboard.ts`                           | Ready  |
| 10  | Build `showModelsDashboard()` panel                     | `src/cli/dashboard.ts`                           | Ready  |
| 11  | Extend `showMemoryDashboard()` with compression stats   | `src/cli/dashboard.ts`                           | Ready  |
| 12  | Add `--task <id>` per-task filtering to all panels      | `src/cli/dashboard.ts`                           | Ready  |
| 13  | Create `ModelAnalytics` module                          | `src/models/analytics.ts`                        | Ready  |
| 14  | Wire `ModelAnalytics` into router + executor            | `src/models/router.ts`, `src/models/executor.ts` | Ready  |

### Phase 3: Web Overlay + Advanced (Week 5-6)

| #   | Task                                         | File(s)                         | Status |
| --- | -------------------------------------------- | ------------------------------- | ------ |
| 15  | Extract data-service layer from dashboard.ts | `src/dashboard/data-service.ts` | Ready  |
| 16  | Build embedded HTTP + WebSocket server       | `src/dashboard/server.ts`       | Ready  |
| 17  | Build single-page HTML dashboard             | `web/dashboard.html`            | Ready  |
| 18  | Add `uap dashboard serve` command            | `src/cli/dashboard.ts`          | Ready  |
| 19  | Add policy toggle/stage/level API endpoints  | `src/dashboard/server.ts`       | Ready  |
| 20  | Session snapshot storage + history view      | `src/dashboard/data-service.ts` | Ready  |
| 21  | Export command (JSON/CSV)                    | `src/cli/dashboard.ts`          | Ready  |

### Phase 4: Model Optimization (Week 7-8)

| #   | Task                                                | File(s)                                       | Status |
| --- | --------------------------------------------------- | --------------------------------------------- | ------ |
| 22  | Add `quantizationHint` to ExecutionProfile          | `src/models/execution-profiles.ts`            | Ready  |
| 23  | Add `modelContextBudget` to ModelConfig             | `src/models/types.ts`                         | Ready  |
| 24  | Wire adaptive context to respect modelContextBudget | `src/memory/adaptive-context.ts`              | Ready  |
| 25  | Add token counter to globalSessionStats             | `src/mcp-router/session-stats.ts`             | Ready  |
| 26  | Add `routingMatrix` config option                   | `src/models/types.ts`, `src/models/router.ts` | Ready  |
| 27  | Training data collection script                     | `scripts/collect-training-data.py`            | Ready  |

---

## Part 5: Dependency Graph

```
Phase 1 (foundation)
  [1,2,3] unified-router + CLI + fingerprints  (parallel, no deps)
  [4,5,6] policy schema + memory + gate         (sequential: 4 -> 5 -> 6)
  [7] policy CLI commands                        (depends on 5,6)

Phase 2 (dashboard panels)
  [8,9] policies dashboard                       (depends on 5,6)
  [10] models dashboard                          (depends on 1,2,3)
  [11] memory dashboard                          (no deps)
  [12] per-task filtering                        (depends on 13)
  [13,14] ModelAnalytics                         (depends on 1)

Phase 3 (web overlay)
  [15] data-service extraction                   (depends on 8,9,10,11)
  [16,17,18] server + HTML + CLI                 (depends on 15)
  [19] policy API endpoints                      (depends on 16, 5,6)
  [20,21] history + export                       (depends on 15)

Phase 4 (model optimization)
  [22-27] all independent of Phase 3, can run in parallel with Phase 2-3
```

---

## Part 6: Risk Assessment

| Risk                                                    | Impact | Mitigation                                                                           |
| ------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------ |
| Policy DB migration breaks existing data                | High   | Use `ALTER TABLE ADD COLUMN ... DEFAULT` -- backward compatible                      |
| WebSocket server port conflicts                         | Low    | Configurable port, default 3847 (unlikely to conflict)                               |
| Dashboard overhead slows agent execution                | Medium | Data-service reads are read-only SQLite queries (<5ms each), WebSocket push is async |
| Qwen 3.5 quantization switching requires server restart | Medium | Document as limitation; future: llama.cpp hot-swap support                           |
| Unified router model map drift                          | Low    | Add test that validates all ModelPresets have map entries                            |

---

## Part 7: Test Strategy

### Unit tests needed

```
test/policies/enforcement-stage.test.ts    -- stage filtering in PolicyGate
test/policies/policy-toggle.test.ts        -- toggle/level/stage mutations
test/models/unified-router-maps.test.ts    -- all presets have map entries
test/models/analytics.test.ts              -- outcome recording + queries
test/dashboard/data-service.test.ts        -- structured data output
```

### Integration tests

```
test/dashboard/policies-panel.test.ts      -- end-to-end: store policy -> toggle -> verify dashboard output
test/dashboard/models-panel.test.ts        -- route task -> verify model usage in dashboard
test/dashboard/web-server.test.ts          -- HTTP + WebSocket connectivity
```

### Validation command

```bash
npm test -- --grep "enforcement-stage|unified-router-maps|analytics"
```
