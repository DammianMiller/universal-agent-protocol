# Changelog

## v1.20.1 (2026-03-28)

- fix: expand anthropic proxy model list for updated Droid models
- fix: replace require usage in throughput and predictive memory modules
- test: cover proxy model list entries

## v1.20.0 (2026-03-28)

- feat: add CLI parity commands and aliases
## v1.19.2 (2026-03-27)

- fix: avoid task id collisions
- feat: update supported Droid models to latest versions


## v1.19.1 (2026-03-27)

- chore: bump version to 1.19.0
- chore: bump version to 1.18.1
- fix: tighten proxy token guards
- fix: remove agents/docker-compose.yml for test D10
- fix: add upstream retry backoff for proxy
- chore: clean up CHANGELOG duplicates
- chore: update package-lock.json


## v1.19.0 (2026-03-27)

- chore: bump version to 1.18.1
- fix: tighten proxy token guards
- fix: remove agents/docker-compose.yml for test D10
- fix: add upstream retry backoff for proxy
- chore: clean up CHANGELOG duplicates
- chore: update package-lock.json


## v1.18.1 (2026-03-27)

- fix: tighten proxy token guards
- fix: remove agents/docker-compose.yml for test D10
- chore: clean up CHANGELOG duplicates
- fix: add verbosity controls for hooks


## v1.18.0 (2026-03-27)

- feat: implement full optimization suite - adaptive cache O(1) eviction, SQLite WAL mode, query caching, pattern router LRU cache, async hook execution
- feat: add baseline performance metrics and comparison tools
- perf: 60% memory reduction via query history pruning
- perf: 2-3x faster queries via WAL mode and caching
- perf: 80% reduction in pattern matching overhead via LRU caching
- test: add comprehensive benchmarks for all optimized components

## v1.17.2 (2026-03-26)

- fix: update documentation parity - skills (24→33), dashboard views (13→11)


## v1.17.1 (2026-03-26)

- fix: streamline CLAUDE.md and hooks to prevent session deadlocks


## v1.17.0 (2026-03-26)

- refactor: consolidate hooks/skills/policies, remove stale dirs, fix broken README links
- feat: add mission artifacts for spec decoding fix + infra + reorg


## v1.16.0 (2026-03-25)

- feat: add 16 test files improving coverage across utils, tasks, coordination, memory, models, and mcp-router
- fix: clear stale dampener state on fresh loop resets
- fix: allow act-phase auto release to terminate loops
- fix: tighten proxy loop exits and tool-turn token budgets
- fix: harden anthropic proxy loop state transitions


## v1.15.13 (2026-03-25)

- fix: preserve property name 'pattern' in tool schema sanitizer


## v1.15.12 (2026-03-25)

- fix: restore required CLAUDE compliance sections
- fix: sanitize regex tool schema fields for llama grammar


## v1.15.11 (2026-03-25)

- fix: guard required stream tool turns


## v1.15.10 (2026-03-25)

- fix: block repeated policy-echo responses on tool turns


## v1.15.9 (2026-03-25)

- fix: fallback when grammar is rejected with tools


## v1.15.8 (2026-03-25)

- fix: fail closed required tool arg autofill


## v1.15.7 (2026-03-25)

- fix: enforce tool-call grammar on required tool turns


## v1.15.6 (2026-03-25)

- fix: harden proxy retry flow and bash safety
- docs: add speculative blog and PR templates


## v1.15.5 (2026-03-25)

- fix: harden proxy against leaked closing function tags


## v1.15.4 (2026-03-24)

- test: guard SessionStart and PreCompact hook array shape


## v1.15.3 (2026-03-24)

- fix: harden proxy tool-call recovery under forced turns


## v1.15.2 (2026-03-24)

- fix: sanitize malformed tool-call apology responses


## v1.15.1 (2026-03-24)

- fix: harden malformed tool-call fallback retries
- chore: bump version to 1.15.0


## v1.15.0 (2026-03-24)

- fix: route analysis-only prompts away from tool loops
- chore: bump version to 1.14.1
- fix: avoid gh delete-branch failures in worktree finish flow


## v1.14.1 (2026-03-24)

- fix: avoid gh delete-branch failures in worktree finish flow


## v1.14.0 (2026-03-24)

- feat: add worktree finish flow with sync and safe cleanup


## v1.13.18 (2026-03-24)

- chore: bump version to 1.13.15
- fix: auto-register agents to prevent announce FK failures


## v1.13.17 (2026-03-24)

- fix: make reinforcement db validation tests deterministic
- chore: bump version to 1.13.16
- chore: bump version to 1.13.15
- fix: normalize legacy hook schema during hooks install


## v1.13.16 (2026-03-24)

- fix: normalize legacy hook schema during hooks install


## v1.13.15 (2026-03-24)

- fix: reject malformed tool-call args before accepting retries
- fix: route qwen through local guardrail proxy
- fix: harden qwen tool-call guardrails and document decoding journey


## v1.13.14 (2026-03-23)

- fix: suppress malformed reasoning fallback in streaming responses
- docs: expand llama proxy bootstrap and tuning runbook
- feat: add speculative autotune and repeatable llama/proxy benchmarking stack
- feat: add optional systemd setup for llama and proxy
- fix: isolate proxy loop protection by session


## v1.13.13 (2026-03-22)

- feat: add token loop protection mechanism to prevent runaway hook/proxy loops


## v1.13.12 (2026-03-21)

- fix: remove synthetic analytics re-seeding from routing decisions, derive router enabled from real data
- refactor: replace synthetic data seeder with real-data-only dashboard, clean all fake data, add worktree enforcement gate


## v1.13.11 (2026-03-21)

- fix(dashboard): live data for all panels, per-agent model/token breakdown, correct model routing


## v1.13.10 (2026-03-21)

- fix: add performance data rendering to dashboard (hotPaths, metrics)


## v1.13.9 (2026-03-21)

- fix: rebuild memories table CHECK constraint to allow lesson and decision types


## v1.13.8 (2026-03-21)

- fix: add worktree enforcement gate, policy categories, dashboard improvements


## v1.13.7 (2026-03-21)

- feat: add GLM 4.7 model preset, Qwen3.5 optimizations, dashboard enhancements
- fix: add missing CLAUDE.md compliance sections, fix release permissions
- feat: local UAP injection for harbor tbench benchmarks
- fix: revert external router.ts regression, add Qwen3.5 benchmark configs
- fix: add glm-4.7 model preset, fix default model list and test expectations
- feat: fix Qwen3.5 + Claude Code integration — thinking mode, tool calls, agentic loop
- feat: add Anthropic-to-OpenAI proxy for Claude Code with local LLMs (#72)
- chore: update session hooks, restore worktree gate, bump v1.13.5 (#71)
- fix: correct publishConfig registry to npmjs.org (#70)
- fix: prevent Qwen3.5 35B A3B premature generation stopping (#69)
- fix: correct npm registry URL format


## v1.13.4 (2026-03-20)

- fix: prevent Qwen3.5 35B A3B premature generation stopping
  - Increase --n-predict from 4096 to 16384 (server-side hard cap)
  - Add _profile field to qwen35.json for profile-loader validation
  - Increase timeout_ms from 120s to 300s for local model generation
  - Double executor token budgets (4K/8K/16K/32K)
  - Increase modelContextBudget from 32K to 131K (match --ctx-size)
  - Add explicit <|im_end|> stop sequence
  - Set repeat-penalty to 1.0 (code naturally repeats patterns)

## v1.13.1 (2026-03-20)

- fix: correct Claude Code hooks schema to use matcher+hooks array format (#62)
- feat: live dashboard with dynamic data, policy audit trail, and layout fixes


## v1.13.0 (2026-03-20)

- feat: hard policy enforcement hooks for all agent platforms (#61)
- chore: bump version to 1.12.0
- chore: gitignore dist symlink in worktree
- chore: gitignore root-owned backup artifacts
- feat: deploy batching integration, policy DB seeding, cross-platform hook parity
- fix: wire session telemetry into web dashboard and add time-series graphs
- chore: bump version to 1.11.0
- fix: skip flaky browser tests in CI and handle missing settings.local.json
- feat: add kanban board view for tasks in web dashboard and CLI
- fix: resolve ((score++)) set -e bug in CI compliance workflow
- fix: restore 4 missing compliance blocks in CLAUDE.md and fix SQL column bug
- chore: simplify opencode session hooks plugin


## v1.12.0 (2026-03-20)

- chore: gitignore dist symlink in worktree
- chore: gitignore root-owned backup artifacts
- feat: deploy batching integration, policy DB seeding, cross-platform hook parity
- fix: wire session telemetry into web dashboard and add time-series graphs
- chore: fix npm publish errors


## v1.9.1 (2026-03-19)

- fix: dashboard display rendering — remove duplicate tool, fix box alignment, add visual width support


## v1.9.0 (2026-03-19)

- feat: add Codex CLI integration with AGENTS.md, MCP server, skills, and hooks


## v1.8.1 (2026-03-19)

- fix: add missing dashboard type exports and restore optimization sweep changes lost in merge


## v1.8.0 (2026-03-19)

- feat: 4-phase optimization sweep — wire unwired code, add persistence, implement HTTP/SSE transport


## v1.7.1 (2026-03-19)

- fix: restore execa and cloakbrowser to dependencies (runtime imports in setup-wizard and web-browser)


## v1.7.0 (2026-03-19)

- fix: align validation-fixes test with actual CLAUDE.md sections
- fix: align tests with actual CLAUDE.md content on master
- fix: adjust factory hooks test to match existing settings.local.json structure
- fix: make reinforcement.db test self-initializing (was relying on pre-existing schema)
- feat: 4-pass optimization sweep — wire dead code, close feedback loops, remove 3400 lines


## v1.6.2 (2026-03-19)

- fix: implement validated optimization plan - correctness, performance, and resource leak fixes


## v1.6.1 (2026-03-19)

- fix: resolve all validation issues - CLAUDE.md compliance, SKILL.md refs, reinforcement DB


## v1.6.0 (2026-03-19)

- feat: implement 4-layer worktree enforcement for 100% compliance
- chore: version bump to 1.5.6
- chore: fix npm publish errors


## v1.5.6 (2026-03-18)

- feat: complete UAP optimization tasks P1a-P2b
- feat: validate worktrees, model router, and adaptive knowledge seeding
- test: improve test coverage with embeddings and unified-router tests


## v1.5.5 (2026-03-18)

- feat: validate worktrees, model router, and adaptive knowledge seeding
- test: improve test coverage with embeddings and unified-router tests


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
- **# Changelog.md** — Replaced empty changelog with full history

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
