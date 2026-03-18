# Changelog

## v1.5.4 (2026-03-18)

- fix: embeddings tests mock all fetch calls for isAvailable (health + test embed)
- fix: version-bump script restores clean tree after test run
- test: improve embeddings test variable naming and add batch coverage
- fix: add missing WORKTREE WORKFLOW section and enforcement policy


## v1.5.3 (2026-03-18)

- fix: resolve inquirer.prompt TypeError in model select command


## v1.5.2 (2026-03-18)

- fix: worktree enforcement + null safety in session hooks
- feat: add completion gate policy + model routing + policy gate improvements
- fix: Qwen3.5 tool call optimization for 100% success rate
- chore: bump version to 1.4.4
- fix: v1.4.3 - fix tool-choice-proxy writeHead race condition and temperature cap
- fix: v1.4.2 - null safety, MCP compliance, FTS5 segfault prevention, performance optimizations
- fix: v1.4.1 - revert callTool content unwrapping that broke Qwen3.5 tool call reliability
- feat: v1.4.0 - MCP compliance, policy enforcement, and performance optimizations
- fix: v1.3.5 - eliminate null display across all UAP operations, fix OpenCode/OMP deep integration
- fix: v1.3.4 - restore tool_choice=required, fix chat_template tool call regression


## v5.0.0 (2026-03-13)

### Security & Performance

- **Async exec in DeployBatcher** — Replaced all `execSync` calls with async `execFile` using argument arrays. Eliminates shell injection risk (especially on commit messages and deploy commands) and stops blocking the event loop during git/gh operations.

### Features

- **Routing strategy differentiation** — `routingStrategy` config now actually changes behavior: `performance-first` always uses planner model, `cost-optimized` picks cheapest capable model, `balanced`/`adaptive` use priority-rule matching. Added `getRequiredCapability()` helper.
- **Task due dates** — Added `due_date` column to tasks schema with automatic migration for existing databases. `overdue` stats now query tasks past their due date. Create/update/list/JSONL all support `dueDate` field.
- **`uap sync` command** — Full implementation replacing the stub. Syncs droids/agents, skills, and commands between claude/factory/opencode/vscode platforms. Supports `--dry-run` mode.
- **`uap model --execute`** — Executes plans via MockModelClient with progress output and execution summary. Prints clear note that real execution requires API keys.

### Tests

- **66 new tests** — Added test suites for CoordinationService (agent lifecycle, work claims, announcements, messaging, status), TaskService (CRUD, queries, dependencies, statistics, overdue, history, JSONL, hierarchy), and DeployBatcher (batch windows, queue, batch creation, execution, retrieval). Total: 215 tests across 20 files.

## v4.8.2 (2026-03-13)

- Version bump only

## v4.8.1 (2026-03-13)

### Performance Optimizations

- **WAL mode for coordination DB** — Enable WAL journal mode, NORMAL synchronous, and 10s busy timeout on `CoordinationDatabase` and `TaskDatabase` for concurrent multi-agent read/write performance
- **LRU cache for embeddings** — Changed embedding cache from FIFO to LRU eviction, ensuring frequently-accessed embeddings stay cached
- **Connection pool round-robin** — Fixed `Date.now() % poolSize` to use a deterministic counter for even distribution across SQLite connection pool
- **Exponential backoff on executor retries** — Retry delays now double each attempt (1s, 2s, 4s) instead of fixed 1s

### Bug Fixes

- **GitHub backend date parsing** — Fixed `rawTimestamp.replace(/-/g, ':')` which corrupted date portions (YYYY-MM-DD became YYYY:MM:DD), causing `Invalid Date` and broken pruning
- **SQL injection in memory consolidator** — Replaced string-interpolated `ids.join(',')` with parameterized placeholders in DELETE query
- **Executor retry context** — `previousAttempts` in `ExecutionContext` is now populated between retries, enabling the retry-context prompt section to provide failure info to subsequent attempts
- **Exit handler leak in AutoAgentCoordinator** — Track and remove SIGINT/SIGTERM/exit handlers on cleanup to prevent listener accumulation across start/cleanup cycles
- **Plan validation timeout** — `validationTimeoutMs` is now enforced via `Promise.race()` (was previously stored but never used)

### Features

- **PatternRouter restored** — Replaced no-op stub with full implementation: loads patterns from `.factory/patterns/index.json`, keyword-based matching, enforcement checklist with always-included critical patterns (P12, P35), singleton with lazy init
- **Mandatory plan validation** — Validator now always runs on every plan at every complexity level (removed `skipIfTrivial: true` and conditional `enableAutoValidation` gate)

### Documentation

- **docs/FEATURES.md** — Complete rewrite with accurate implementation status, verified file:line references, and honest performance claims
- **PUBLISH_STATUS.md** — Updated to v4.8.1 with current pipeline status
- **CHANGELOG.md** — Replaced empty changelog with full history

## v4.8.0 (2026-03-13)

### Features

- Mandatory plan validation on every plan regardless of complexity level

## v4.7.0 (2026-03-13)

### Features

- **Multi-agent coordination system** — CoordinationService, AutoAgentCoordinator, TaskCoordinator with automatic registration, heartbeat, and graceful exit cleanup
- **PlanValidator** — Validates subtasks, dependencies, model assignments, constraints, cost estimates
- **Auto-validation in TaskPlanner** — `createPlan()` now async, always validates generated plans
- **CLI `uap agent auto` command** — Automatic agent registration from CLI

### Bug Fixes

- Converted `require()` to ES6 imports across codebase
- Fixed unused variables and stale `@ts-expect-error` directives
- Fixed async `createPlan()` callers in tests and CLI

## v4.6.0 (2026-03-13)

### Features

- Auto-validation for generated plans (PlanValidator class)
- Comprehensive validation: subtasks, dependencies, model assignments, constraints, cost estimates

## v4.3.1 and earlier

- Initial release through iterative development
- Memory system (4-layer: working, session, semantic, knowledge graph)
- Pattern Router (58 Terminal-Bench patterns)
- MCP Router with output compression
- Worktree system for isolated development
- Hooks system (session-start, pre-compact)
- Droid system with JSON schema validation
- Multi-model architecture (router, planner, executor)
- Deploy batching system
- Task management with DAG dependencies
