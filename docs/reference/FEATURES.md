# Feature Catalog

> Universal Agent Protocol (UAP) v1.40.0

UAP is a universal AI-agent memory, coordination, and enforcement system. This
catalog groups its features by source subsystem under `src/`. Each entry is a
code-grounded summary of what the subsystem provides.

## Memory (`src/memory/`)

Hierarchical, tiered memory with semantic recall — the largest subsystem.

| Feature | Description |
|---------|-------------|
| Embedding service (`embeddings.ts`) | Multi-provider embeddings with priority order llama.cpp → Ollama → OpenAI → sentence-transformers → TF-IDF. Default nomic-embed-text (768-dim); MiniLM/TF-IDF fallback at 384. |
| Hierarchical memory (`hierarchical-memory.ts`) | Hot/warm/cold tiered memory with SQLite persistence and embeddings. |
| Short-term store (`short-term/`) | SQLite L1/L2 memory: memories, sessions, FTS5 search, knowledge-graph entities. |
| Model router w/ feedback (`model-router.ts`) | Routes to models using latency/success fingerprints. |
| Task classifier (`task-classifier.ts`) | Classifies task type/complexity to drive retrieval and routing. |
| Dynamic retrieval (`dynamic-retrieval.ts`) | Context-aware retrieval of relevant memories. |
| Adaptive context (`adaptive-context.ts`) | Context optimizations driven by historical task outcomes + semantic cache. |
| Semantic/context compression (`semantic-compression.ts`, `context-compressor.ts`, `context-pruner.ts`) | Compress/prune context to fit token budgets. |
| Speculative cache (`speculative-cache.ts`) | Pre-fetches likely-needed memory. |
| Consolidator / maintenance (`memory-consolidator.ts`, `memory-maintenance.ts`) | Consolidate and garbage-collect memory over time. |
| Write gate (`write-gate.ts`) | Quality filter for what gets written to memory. |
| Daily log (`daily-log.ts`) | Staging log with promotion (`gate_score`) to long-term memory. |
| Correction propagation (`correction-propagator.ts`) | Supersedes stale entries when corrections are made. |
| Predictive memory (`predictive-memory.ts`) | Learns query patterns to predict needed context. |
| Knowledge graph (`knowledge-graph.ts`) | L4 entity/relationship graph. |
| Ambiguity detector (`ambiguity-detector.ts`) | Implements P37 ambiguity detection. |
| Serverless Qdrant (`serverless-qdrant.ts`) | Lazy-local Docker Qdrant (`qdrant/qdrant:latest`, port 6333) or cloud. |
| Backends (`backends/`) | Pluggable long-term stores: Qdrant cloud, GitHub, factory selector. |
| Prepopulate (`prepopulate.ts`) | Seeds memory and discovers skills for CLAUDE.md generation. |
| Terminal-bench knowledge (`terminal-bench-knowledge.ts`) | Curated benchmark knowledge. |

## Models (`src/models/`)

Multi-model, two-tier (planner/executor) architecture.

| Feature | Description |
|---------|-------------|
| Router (`router.ts`, `unified-router.ts`) | Classifies tasks and selects models. |
| Planner (`planner.ts`) | Decomposes tasks into subtasks (`TaskPlanner`). |
| Executor (`executor.ts`) | Runs subtasks with retry/fallback (`TaskExecutor`, `MockModelClient`). |
| Plan validator (`plan-validator.ts`) | Validates plans before build. |
| Execution profiles (`execution-profiles.ts`, `profile-loader.ts`) | Named model profiles (`UAP_MODEL_PROFILE`). |
| Analytics (`analytics.ts`) | Per-task token/cost/outcome metrics (`model_analytics.db`). |
| OpenAI-compat client (`openai-compat-client.ts`) | OpenAI `/v1`-compatible client (default endpoint `http://localhost:4000/v1`). |

## Coordination (`src/coordination/`)

Multi-agent coordination layer.

| Feature | Description |
|---------|-------------|
| Database/service (`database.ts`, `service.ts`) | Agent registry, heartbeats, messages, work announcements/claims. |
| Deploy batcher (`deploy-batcher.ts`) | Batches commit/push/merge/deploy actions into windows. |
| Capability router (`capability-router.ts`) | Routes tasks to droids by capability. |
| Auto-agent (`auto-agent.ts`) | Auto-agent driver. |
| Pattern router (`pattern-router.ts`) | Matches tasks to execution patterns; always includes P12/P35. |
| Adaptive patterns (`adaptive-patterns.ts`) | Tracks pattern success outcomes to adapt selection. |
| Expert orchestrator (`expert-orchestrator.ts`) | Orchestrates parallel expert/droid review. |

## Tasks (`src/tasks/`)

Task management system (positioned as an alternative to Beads).

| Feature | Description |
|---------|-------------|
| Service (`service.ts`) | CRUD, dependencies, claim/release, board, stats. |
| Database (`database.ts`) | SQLite store (`.uap/tasks/tasks.db`) + JSONL mirror. |
| Coordination (`coordination.ts`) | Task ↔ agent coordination. |
| Decoder gate (`decoder-gate.ts`) | Full decoder-first (P35) validator. |
| Event bus (`event-bus.ts`) | `TaskEventBus` for task lifecycle events. |

## Policies (`src/policies/`)

DB-driven policy enforcement engine.

| Feature | Description |
|---------|-------------|
| Policy gate (`policy-gate.ts`) | `PolicyGate` + `PolicyViolationError` — the enforcement core. |
| Tool registry (`policy-tools.ts`) | `PolicyToolRegistry` of executable policy tools. |
| Policy memory (`policy-memory.ts`) | Persists policies (`policies.db`). |
| Enforced tool router (`enforced-tool-router.ts`) | Routes tool calls through the gate. |
| CLAUDE.md conversion (`convert-policy-to-claude.ts`) | Renders policies into CLAUDE.md. |
| Enforcers (`enforcers/`) | ~20 Python enforcers (worktree_required, test_gate, schema_diff_gate, memory_before_plan, coord_overlap, mcp_router_first, rtk_wrap, iac_parity, expert_review_required, etc.). |

## Delivery (`src/delivery/`)

Convergence loop that drives a model through execute → apply → verify → feedback
against real completion gates until "delivered".

| Feature | Description |
|---------|-------------|
| Convergence loop (`convergence-loop.ts`) | The main delivery loop. |
| Run coordinator (`run-coordinator.ts`) | Coordinates a delivery run. |
| Explorer (`explorer.ts`) | Best-of-N candidate generation. |
| Applier (`applier.ts`) | Applies file changes. |
| Verifier ladder (`verifier-ladder.ts`) | Build/typecheck/test/lint gate ladder. |
| Judge / critic (`judge.ts`, `critic.ts`) | Evaluate and critique turns. |
| Escalation (`escalation.ts`) | Stagnation escalation ladder. |
| Auto-optimizer (`auto-optimizer.ts`) | Dynamically enables aids. |
| Ideation / practice / spec-imports | Divergent strategy seeds, best-practice cards, curated project seeds. |
| HALO trace (`halo-trace.ts`) | Emits HALO spans. |
| Integrity (`integrity.ts`) | Test-protection / integrity guard. |

## MCP Router (`src/mcp-router/`)

Hierarchical MCP router that collapses 150+ MCP tools to 2
(`discover_tools`, `execute_tool`) for ~98% token reduction.

| Feature | Description |
|---------|-------------|
| Server (`server.ts`) | `McpRouter` + stdio server. |
| Output compressor (`output-compressor.ts`) | Compresses tool output. |
| Session stats (`session-stats.ts`) | Token-savings statistics. |
| Config parser (`config/parser.ts`) | Loads/merges `mcp.json` with path expansion. |
| Executor (`executor/client.ts`) | `McpClient` / `McpClientPool`. |
| Fuzzy search (`search/fuzzy.ts`) | `ToolSearchIndex`. |
| Experts (`experts/registry.ts`) | Expert-consult registry. |
| Tools (`tools/`) | `discover`, `execute`, `deliver` handlers. |

## Dashboard (`src/dashboard/`)

| Feature | Description |
|---------|-------------|
| Data service (`data-service.ts`) | Aggregates task/agent/memory/model/system data. |
| Event stream (`event-stream.ts`) | Real-time dashboard events. |
| Server (`server.ts`) | Web dashboard server (default port 3847). |
| Data seeder (`data-seeder.ts`) | Seeds demo/initial dashboard data. |

## Analyzers & Generators

| Subsystem | Description |
|-----------|-------------|
| Analyzers (`analyzers/`) | `analyzeProject(cwd)` builds a `ProjectAnalysis` (languages, frameworks, dirs) from `.uap.json`, git, package files. |
| Generators (`generators/claude-md.ts`) | Handlebars-based CLAUDE.md / web AGENT.md generation from analysis + discovered skills. |

## Observability & Telemetry

| Subsystem | Description |
|-----------|-------------|
| Observability (`observability/halo-exporter.ts`) | Emits agent/LLM/tool spans as OTLP/OpenInference JSONL for the HALO engine. Opt-in via `UAP_HALO_TRACE`; zero-overhead when off. |
| Telemetry (`telemetry/session-telemetry.ts`) | Session-level telemetry capture. |

## Browser & Benchmarks

| Subsystem | Description |
|-----------|-------------|
| Browser (`browser/web-browser.ts`) | `WebBrowser` automation wrapper for agents. |
| Benchmarks (`benchmarks/`) | Benchmark harness comparing a naive agent vs UAP-augmented agent; multi-turn loops, token throughput, speculative autotune. |

## Droids

The expert-droid roster lives as markdown-with-JSON-frontmatter files under
`.factory/droids/*.md`, discovered at runtime by `discoverDroids()` in
`src/uap-droids-strict.ts`. The strict plugin validates droids against a Zod
schema and exposes `uap_droid_list` / `uap_droid_invoke`, plus the
decoder-first (P35) and worktree gates. See `docs/reference/EXPERT_DROIDS.md`.

## Utilities (`src/utils/`)

Shared helpers: adaptive cache, concurrency pools (retry/timeout/fallback),
config loader, lazy imports, structured logger, CLAUDE.md merge, performance
monitor, query-complexity scoring, rate limiter, string similarity, and system
resource detection.

## CLI surface (`src/bin/cli.ts`)

The `uap` CLI exposes (top-level commands): `init`, `setup`, `analyze`,
`generate`, `memory`, `patterns`, `worktree`, `sync`, `droids`, `expert-route`,
`deliver`, `harness` (HALO), `ideate`, `coord`, `agent`, `deploy`, `task`,
`compliance`, `coordination`, `skill`, `update`, `dashboard` (alias `dash`),
`model`, `mcp-router`, `hooks`, `tool-calls`, `rtk`, `mcp-setup`, `schema-diff`,
`policy`, `uap-omp`.
