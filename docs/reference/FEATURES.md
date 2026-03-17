# Universal Agent Protocol (UAP) - Feature Inventory & Status

**npm Version:** 7.0.2
**Last Updated:** 2026-03-14
**Tests:** 267 passing (23 files)

---

## Feature Status Legend

| Status  | Meaning                              |
| ------- | ------------------------------------ |
| ENABLED | Fully implemented, tested, optimized |
| PARTIAL | Implemented but with known gaps      |
| STUB    | Interface exists but no real logic   |
| PLANNED | Not yet implemented                  |

---

## 1. Memory System

### 1.1 Working Memory (L1) — ENABLED

**Source:** `src/memory/` (SQLite via better-sqlite3)
**Storage:** `agents/data/memory/short_term.db`
**Tables:** `memories` with FTS5 index (`memories_fts`)

| Setting        | Value                        |
| -------------- | ---------------------------- |
| Max entries    | 50                           |
| Access latency | <1ms (in-memory)             |
| Write gate     | 5-criteria scoring (min 0.3) |

**Write Gate** (`src/memory/write-gate.ts:94`): Evaluates 5 criteria before storing:

- `behavioral_change`, `commitment`, `decision_rationale`, `stable_fact`, `explicit_request`
- Noise pattern rejection (greetings, acknowledgments, status updates)
- Score: 0.4 first match + 0.15 per additional + length bonus

**CLI:** `uap memory store`, `uap memory query`, `uap memory status`

### 1.2 Session Memories (L2) — ENABLED

**Source:** Same SQLite DB, `session_memories` table
**Threshold:** importance >= 7
**Promotion:** Via `uap memory promote` or automatic from daily log

### 1.3 Semantic Memory (L3) — ENABLED

**Source:** Qdrant vector database (`src/memory/backends/`)
**Backends:** Qdrant Cloud (`qdrant-cloud.test.ts`), GitHub (`github.ts`)
**Embedding:** Deterministic SHA-256 hash vectors (CLI) or sentence-transformers (Python)
**Cache:** LRU eviction policy (`src/memory/embeddings.ts:598`)

| Setting         | Value                   |
| --------------- | ----------------------- |
| Vector size     | 384                     |
| Score threshold | 0.35                    |
| Embedding cache | LRU, max 10,000 entries |

**Note:** CLI uses deterministic hash-based pseudo-random vectors. For real semantic search, use the Python sentence-transformers pipeline (`uap patterns index`).

### 1.4 Knowledge Graph (L4) — ENABLED

**Source:** SQLite `entities` and `relationships` tables
**Algorithm:** Dijkstra shortest path (`src/utils/dijkstra.ts:17`)

### 1.5 Memory Tiering — ENABLED

**Tiers:** HOT (10) / WARM (50) / COLD (500)
**Adaptive Context:** `src/memory/adaptive-context.ts`
**DB Pool:** 5 SQLite connections, round-robin selection, WAL mode

| Setting      | Value         |
| ------------ | ------------- |
| Pool size    | 5 connections |
| Journal mode | WAL           |
| Synchronous  | NORMAL        |
| Busy timeout | 10,000ms      |

### 1.6 Daily Log — ENABLED

**Source:** `src/memory/daily-log.ts:47`
**Purpose:** Staging area for memories before promotion
**Promotion threshold:** score >= 0.6

### 1.7 Correction Propagator — ENABLED

**Source:** `src/memory/correction-propagator.ts:59`
**Purpose:** Cross-tier correction propagation with superseded history tracking
**Corrected entry importance:** 8

### 1.8 Agent-Scoped Memory — ENABLED

**Source:** `src/memory/agent-scoped-memory.ts:52`
**Purpose:** Per-agent memory isolation with sharing capability
**Indexed on:** agent_id, shared, importance

### 1.9 Memory Consolidator — ENABLED

**Source:** `src/memory/memory-consolidator.ts`
**Security:** Parameterized SQL queries (SQL injection fixed in v4.8.1)

---

## 2. Multi-Model Architecture

### 2.1 Model Router — ENABLED

**Source:** `src/models/router.ts:89`
**Purpose:** Classifies tasks by complexity/type, selects optimal model via priority-sorted routing rules

| Setting          | Default                                                                 |
| ---------------- | ----------------------------------------------------------------------- |
| Strategy         | `balanced` (3 of 4 strategies differentiated; `adaptive` == `balanced`) |
| Default planner  | `opus-4.5`                                                              |
| Default executor | `glm-4.7`                                                               |
| Default fallback | `opus-4.5`                                                              |
| Routing rules    | 11 default rules, priority 30-100                                       |

**Model Presets** (6): `opus-4.5`, `deepseek-v3.2`, `deepseek-v3.2-exp`, `glm-4.7`, `gpt-5.2`, `qwen35-a3b`

**Known Gap:** `routingStrategy` `adaptive` is accepted but behaves identically to `balanced`. The other 3 strategies (`cost-optimized`, `performance-first`, `balanced`) are differentiated.

### 2.2 Task Planner — ENABLED

**Source:** `src/models/planner.ts:42`
**Purpose:** Decomposes tasks into dependency-aware subtasks with model assignment

| Setting         | Default                         |
| --------------- | ------------------------------- |
| Max subtasks    | 10                              |
| Max depth       | 3                               |
| Parallelization | enabled                         |
| Auto-validation | always (mandatory since v4.8.0) |

**Decomposition:** Keyword-based heuristic (not LLM-driven). Phases: Analysis, Design, Implementation, Testing, Security Review, Documentation.

### 2.3 Task Executor — ENABLED

**Source:** `src/models/executor.ts:69`
**Purpose:** Executes plans with retry logic, fallback, and parallel batching

| Setting      | Default                                  |
| ------------ | ---------------------------------------- |
| Max retries  | 2                                        |
| Retry delay  | Exponential backoff (1s, 2s, 4s)         |
| Step timeout | 120,000ms (2 min)                        |
| Fallback     | enabled                                  |
| Max parallel | 3                                        |
| Token limits | low=2K, medium=4K, high=8K, critical=12K |

**Improvements in v4.8.1:**

- `previousAttempts` now populated between retries (enables retry-context prompts)
- Exponential backoff replaces fixed 1s delay

**Known Gap:** No real `ModelClient` implementation — only `MockModelClient` for testing. CLI execution prints "not implemented yet."

### 2.4 Plan Validator — ENABLED

**Source:** `src/models/plan-validator.ts:24`
**Purpose:** Validates every plan for structural integrity

| Check             | What it validates                                         |
| ----------------- | --------------------------------------------------------- |
| Subtasks          | Titles, descriptions, complexity, types, duplicates       |
| Dependencies      | Cycle detection (DFS), non-existent references            |
| Model assignments | Every subtask has a model                                 |
| Constraints       | Security/performance-sensitive tasks flagged              |
| Cost estimates    | Negative values (error), >$1000 (warning), >24h (warning) |

| Setting      | Default                                        |
| ------------ | ---------------------------------------------- |
| Timeout      | 300,000ms (5 min), enforced via Promise.race() |
| Strict mode  | false                                          |
| Skip trivial | false (mandatory validation since v4.8.0)      |

### 2.5 Benchmark-Data Model Router — ENABLED

**Source:** `src/memory/model-router.ts:68`
**Purpose:** Separate routing system using real Terminal-Bench benchmark data with SQLite-persisted fingerprints and adaptive learning (EMA)

| Setting             | Value                       |
| ------------------- | --------------------------- |
| DB pool             | 5 connections, WAL mode     |
| EMA alpha (success) | 0.1                         |
| EMA alpha (latency) | 0.2                         |
| Fingerprint blend   | 70% persisted / 30% default |
| Max cost/task       | $0.05                       |
| Max latency         | 120s                        |

**Note:** This is independent from `src/models/router.ts`. The two routing systems are not yet integrated.

---

## 3. Multi-Agent Coordination

### 3.1 Coordination Database — ENABLED

**Source:** `src/coordination/database.ts:5`
**Storage:** `./agents/data/coordination/coordination.db`
**Tables:** 6 (agent_registry, agent_messages, work_announcements, work_claims, deploy_queue, deploy_batches)

| Setting      | Value                   |
| ------------ | ----------------------- |
| Journal mode | WAL (added v4.8.1)      |
| Synchronous  | NORMAL (added v4.8.1)   |
| Busy timeout | 10,000ms (added v4.8.1) |

### 3.2 Coordination Service — ENABLED

**Source:** `src/coordination/service.ts:31`
**Purpose:** Agent lifecycle, resource claiming, work announcements, messaging, deploy queue, overlap detection, conflict risk assessment

| Setting              | Default                     |
| -------------------- | --------------------------- |
| Heartbeat interval   | 30,000ms (30s)              |
| Claim expiry         | 300,000ms (5 min)           |
| Stale agent cutoff   | 3x heartbeat interval (90s) |
| Message retention    | 24 hours                    |
| Deploy default delay | 30,000ms (30s)              |

**Overlap Detection:** Same-file, same-directory, overlapping-files conflicts
**Conflict Risk:** `none` / `low` / `medium` / `high` / `critical`

### 3.3 Auto Agent Coordinator — ENABLED

**Source:** `src/coordination/auto-agent.ts:22`
**Purpose:** Automatic agent registration, heartbeat, graceful exit cleanup

| Setting            | Default                                              |
| ------------------ | ---------------------------------------------------- |
| Heartbeat interval | 30,000ms                                             |
| Exit handlers      | SIGINT, SIGTERM, exit (tracked + removed on cleanup) |

**Improvements in v4.8.1:**

- Idempotent cleanup (safe to call multiple times)
- Exit handlers tracked and removed to prevent listener leaks

### 3.4 Capability Router — ENABLED

**Source:** `src/coordination/capability-router.ts:159`
**Purpose:** Routes tasks to droids/skills by file patterns, task types, keywords

| Setting                   | Value                                                                            |
| ------------------------- | -------------------------------------------------------------------------------- |
| Default mappings          | 12 (TS, JS, CLI, security, perf, docs, review, testing, infra, Python, Rust, Go) |
| Max recommended droids    | 3                                                                                |
| Max recommended skills    | 2                                                                                |
| Always-included reviewers | code-quality-guardian, security-auditor                                          |

### 3.5 Pattern Router — ENABLED (restored in v4.8.1)

**Source:** `src/coordination/pattern-router.ts`
**Purpose:** Loads Terminal-Bench patterns from `.factory/patterns/index.json`, keyword matching, enforcement checklists

**Was a no-op stub prior to v4.8.1.** Now fully implemented with:

- Pattern loading from project directory
- Keyword-based matching
- Always-included critical patterns (P12 Output Existence, P35 Decoder-First)
- Singleton with lazy initialization

### 3.6 Deploy Batcher — ENABLED

**Source:** `src/coordination/deploy-batcher.ts:47`
**Purpose:** Intelligent deployment batching with squashing, deduplication, parallel execution

| Action   | Normal Window | Urgent Window |
| -------- | ------------- | ------------- |
| commit   | 30s           | 2s            |
| push     | 5s            | 1s            |
| merge    | 10s           | 2s            |
| workflow | 5s            | 1s            |
| deploy   | 60s           | 5s            |

| Setting              | Default |
| -------------------- | ------- |
| Max batch size       | 20      |
| Parallel execution   | enabled |
| Max parallel actions | 5       |

**Fixed in v5.0.0:** Replaced `execSync` with async `execFile` using argument arrays. Eliminates shell injection risk and event loop blocking.

---

## 4. Task Management

### 4.1 Task Database — ENABLED

**Source:** `src/tasks/database.ts:5`
**Storage:** `./.uap/tasks/tasks.db`
**Tables:** 5 (tasks, task_dependencies, task_history, task_activity, task_summaries)

| Setting      | Value                   |
| ------------ | ----------------------- |
| Journal mode | WAL (added v4.8.1)      |
| Synchronous  | NORMAL (added v4.8.1)   |
| Busy timeout | 10,000ms (added v4.8.1) |

### 4.2 Task Service — ENABLED

**Source:** `src/tasks/service.ts:31`
**Purpose:** Full CRUD, dependency DAG with cycle detection (BFS), history/audit trail, JSONL sync, compaction

| Setting        | Default                    |
| -------------- | -------------------------- |
| JSONL path     | `./.uap/tasks/tasks.jsonl` |
| Compact cutoff | 90 days                    |

**Fixed in v5.0.0:** Added `due_date` column with migration for existing DBs. `overdue` stats now query tasks past due date that aren't closed.

### 4.3 Task Coordinator — ENABLED

**Source:** `src/tasks/coordination.ts:31`
**Purpose:** Bridge between task system and coordination system

**Scoring for `suggestNextTask()`:**

- Priority weight: `(4 - priority) * 10` (P0=40, P4=0)
- No-overlap bonus: +20
- No-dependencies bonus: +5
- Unblocks-others bonus: +3 per blocked task

---

## 5. CLI Commands

### Fully Implemented (20+)

| Command          | Source                             | Purpose                                |
| ---------------- | ---------------------------------- | -------------------------------------- |
| `uap init`       | `src/cli/init.ts`                  | Project initialization                 |
| `uap setup`      | `src/cli/setup.ts`                 | Full setup chain                       |
| `uap memory`     | `src/cli/memory.ts`                | Memory management (10 subcommands)     |
| `uap task`       | `src/cli/task.ts`                  | Task CRUD + workflow (14 subcommands)  |
| `uap agent`      | `src/cli/agent.ts`                 | Agent lifecycle (11 subcommands)       |
| `uap deploy`     | `src/cli/deploy.ts`                | Deploy batching (8 subcommands)        |
| `uap worktree`   | `src/cli/worktree.ts`              | Git worktree management                |
| `uap droids`     | `src/cli/droids.ts`                | Droid management                       |
| `uap coord`      | `src/cli/coord.ts`                 | Coordination status/flush/cleanup      |
| `uap model`      | `src/cli/model.ts`                 | Model routing/planning (4 subcommands) |
| `uap dashboard`  | `src/cli/dashboard.ts`             | Rich visualization (6 sub-dashboards)  |
| `uap patterns`   | `src/cli/patterns.ts`              | Pattern RAG management                 |
| `uap hooks`      | `src/cli/hooks.ts`                 | Hook installer (6 platforms)           |
| `uap compliance` | `src/cli/compliance.ts`            | Protocol compliance (12 gates)         |
| `uap generate`   | `src/cli/generate.ts`              | CLAUDE.md generation                   |
| `uap analyze`    | `src/cli/analyze.ts`               | Project structure analysis             |
| `uap mcp-router` | `src/cli/mcp-router.ts`            | MCP Router management                  |
| `uap update`     | `src/cli/update.ts`                | System update                          |
| `uap rtk`        | `src/cli/rtk.ts`                   | RTK integration                        |
| `llama-optimize` | `src/bin/llama-server-optimize.ts` | llama.cpp parameter optimization       |

### Stubs

| Command           | Source                   | Status                            |
| ----------------- | ------------------------ | --------------------------------- |
| `uap schema-diff` | `src/cli/schema-diff.ts` | Prints "disabled in this version" |

### Implemented in v5.0.0

| Command               | Source             | Status                                                                |
| --------------------- | ------------------ | --------------------------------------------------------------------- |
| `uap sync`            | `src/cli/sync.ts`  | Syncs droids, skills, commands between claude/factory/opencode/vscode |
| `uap model --execute` | `src/cli/model.ts` | Executes plans via MockModelClient (dry-run mode)                     |

---

## 6. Hooks System

| Hook         | Source                             | Status                                      |
| ------------ | ---------------------------------- | ------------------------------------------- |
| SessionStart | `templates/hooks/session-start.sh` | ENABLED — Injects compliance checklist      |
| PreCompact   | `templates/hooks/pre-compact.sh`   | ENABLED — DB optimization before compaction |
| PreToolUse   | Pattern injection                  | ENABLED — Via hook system                   |
| PostToolUse  | Memory persistence                 | ENABLED — Via hook system                   |

**Platforms:** Claude Code, Factory.AI, VSCode, Cursor, OpenCode, ForgeCode

---

## 7. Droid System

**Source:** `src/uap-droids-strict.ts:35` (schema), `:183` (plugin entry)
**Storage:** `.factory/droids/*.md` (JSON frontmatter + markdown body)
**Validation:** Zod schema (`DROID_SCHEMA`), decoder-first gate

**Built-in Templates:** code-reviewer, security-reviewer, performance-reviewer, test-writer

---

## 8. Utilities

| Utility           | Source                             | Status                                   |
| ----------------- | ---------------------------------- | ---------------------------------------- |
| CLAUDE.md Merger  | `src/utils/merge-claude-md.ts:325` | ENABLED                                  |
| JSON Validator    | `src/utils/validate-json.ts:73`    | ENABLED                                  |
| String Similarity | `src/utils/string-similarity.ts`   | ENABLED                                  |
| Config Manager    | `src/utils/config-manager.ts:4`    | ENABLED                                  |
| Fetch with Retry  | `src/utils/fetch-with-retry.ts:1`  | ENABLED (3 retries, exponential backoff) |
| Rate Limiter      | `src/utils/rate-limiter.ts:16`     | ENABLED (sliding window, Zod validated)  |
| Dijkstra          | `src/utils/dijkstra.ts:17`         | ENABLED                                  |

---

## 9. Test Coverage

| Test File                                           | Tests   | What's Covered                        |
| --------------------------------------------------- | ------- | ------------------------------------- |
| `test/tasks.test.ts`                                | 30      | Task CRUD, dependencies, sync, stats  |
| `test/models.test.ts`                               | 26      | Router, planner, executor, presets    |
| `src/memory/optimization.test.ts`                   | 21      | Memory optimization                   |
| `test/coordination.test.ts`                         | 20      | Agent lifecycle, claims, messaging    |
| `test/deploy-batcher.test.ts`                       | 16      | Deploy batching, squashing, execution |
| `test/write-gate.test.ts`                           | 14      | Write gate criteria and scoring       |
| `benchmark-env/src/utils/__tests__/helpers.test.ts` | 13      | Benchmark helpers                     |
| `src/tests/uap-strict-droids.test.ts`               | 12      | Droid schema validation, decoder gate |
| `test/agent-scoped-memory.test.ts`                  | 8       | Agent memory isolation                |
| `test/session-stats.test.ts`                        | 8       | Session statistics                    |
| `src/memory/short-term/indexeddb.test.ts`           | 8       | IndexedDB short-term memory           |
| `test/hooks.test.ts`                                | 7       | Hook system                           |
| `test/mcp-router-output-compressor.test.ts`         | 7       | Output compression                    |
| `test/daily-log.test.ts`                            | 6       | Daily log staging                     |
| `src/memory/backends/github.test.ts`                | 6       | GitHub backend                        |
| `test/memory-maintenance.test.ts`                   | 6       | Memory maintenance                    |
| `test/correction-propagator.test.ts`                | 5       | Correction propagation                |
| `test/mcp-router-filter.test.ts`                    | 5       | MCP router filtering                  |
| `src/memory/backends/qdrant-cloud.test.ts`          | 5       | Qdrant backend                        |
| `src/utils/merge-claude-md.test.ts`                 | 4       | CLAUDE.md merging                     |
| `src/tests/droids-parallel.test.ts`                 | 1       | Parallel droid execution              |
| **Total**                                           | **228** | **21 files, 100% pass rate**          |

---

## 10. Known Gaps & Future Work

| Gap                                        | Impact                                                                           | Effort | Status           |
| ------------------------------------------ | -------------------------------------------------------------------------------- | ------ | ---------------- |
| No real `ModelClient` implementation       | High — executor only works with mock                                             | High   | Fixed in v1.0.0 |
| Two routing systems not integrated         | Medium — `src/models/router.ts` and `src/memory/model-router.ts` are independent | Medium | Fixed in v1.0.0 |
| `task_sync_meta` table unused              | Low — created but never populated                                                | Low    | Fixed in v1.0.0 |
| `routingStrategy` `adaptive` == `balanced` | Low — 3 of 4 strategies differentiated                                           | Low    | Fixed in v1.0.0 |
| `routingStrategy` 3/4 differentiated       | Medium — `cost-optimized`, `performance-first`, `balanced` work                  | N/A    | Fixed in v8.0.0  |
| `execSync` in DeployBatcher                | Medium — blocks event loop, shell injection risk                                 | Medium | Fixed in v5.0.0  |
| Shell injection in embeddings/prepopulate  | High — user text in shell commands                                               | Medium | Fixed in v8.0.0  |
| Race condition in exclusive claims         | High — concurrent agents could both acquire exclusive lock                       | Low    | Fixed in v8.0.0  |
| L4 schema missing columns                  | Medium — `description` and `strength` columns missing from base schema           | Low    | Fixed in v8.0.0  |
| Embedding cache key collisions             | Low — `text.slice(0,500)` caused collisions for long texts                       | Low    | Fixed in v8.0.0  |
| No tests for coordination/task subsystems  | High — ~2,600 lines untested                                                     | High   | Fixed in v5.0.0  |
| `uap sync` not implemented                 | Low — planned for v0.9.0                                                         | Medium | Fixed in v5.0.0  |
| `uap model --execute` not implemented      | Medium — plan execution only via API                                             | Medium | Fixed in v5.0.0  |
| Task `overdue` stats unimplemented         | Low — no due_date column                                                         | Low    | Fixed in v5.0.0  |
| MCP Router CLI setup placeholder           | Medium — CLI setup not functional                                                | Low    | Fixed in v1.0.0 |
| `uap uninstall` not implemented            | Low — no cleanup command                                                         | Low    | Fixed in v1.0.0 |
| Plugin install only for 2 harnesses        | Medium — 13+ harnesses unsupported                                               | Medium | Fixed in v1.0.0 |
| Deploy batch config not persistent         | Medium — settings lost on restart                                                | Low    | Fixed in v1.0.0 |
| No droid schema validation                 | Medium — invalid droids not caught                                               | Medium | Fixed in v1.0.0 |
| No decoder gate                            | Medium — no input/output validation                                              | Medium | Fixed in v1.0.0 |
| No dynamic compression                     | Low — static compression only                                                    | Medium | Fixed in v1.0.0 |
| No context pruning                         | Low — no intelligent context removal                                             | Medium | Fixed in v1.0.0 |
| No adaptive patterns                       | Low — patterns don't self-tune                                                   | Medium | Fixed in v1.0.0 |
| No predictive memory                       | Low — no context prefetching                                                     | High   | Fixed in v1.0.0 |
| No multi-turn agent loop                   | Medium — no error recovery loop                                                  | High   | Fixed in v1.0.0 |
| PATH_MIGRATIONS TODO in code               | Low — dead TODO comment                                                          | Low    | Fixed in v1.0.0 |

---

**Last Updated:** 2026-03-17
**npm Package:** @miller-tech/uap v1.0.0
**Build:** 0 errors | **Tests:** 258 passing (23 files) | **Lint:** 0 errors
