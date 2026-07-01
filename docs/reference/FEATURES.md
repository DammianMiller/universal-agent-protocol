# Feature Catalog

> Universal Agent Protocol (UAP) v1.91.0

> **🏭 Where this fits:** Every station on the line — this catalog is the parts list for the whole factory. **What it delivers:** each feature below is mapped to the stage of your [delivery pipeline](../guides/DELIVERY_PIPELINE.md) it protects, so you can see exactly where your agent's work stops being plausible-looking and starts being genuinely shippable.

Think of getting software out of an agent as a line in a factory. Raw intent
comes in one end; a working, shipped change comes out the other. Between those
two points sit eight stations, and typical agentic workflows break at
predictable ones — the agent forgets what it learned last session, edits the
wrong file, or (the big one) declares "done" on code that never ran.

UAP is the machinery bolted to that line: memory, coordination, and enforcement
that keep the work moving from station to station without silently shipping a
defect. The features below are grouped by source subsystem under `src/`, and
each entry names the pipeline stage it guards so you can see what it does *for
you*, not just what it is.

## The line at a glance

Every feature in this catalog serves one of eight stations. When your agent
"goes wrong," it is almost always because one of these stations had no guard:

1. **Intake** — understand the work. Agents forget past sessions and hallucinate
   scope; 4-tier memory, reactor per-prompt injection, and DESIGN.md keep intent
   grounded.
2. **Prep / Routing** — send the right job to the right station. Pattern router,
   query-complexity scoring, and multi-model routing stop over- and
   under-thinking.
3. **Isolation** — give each job its own bench. Worktree-per-feature, always-on
   file coordination, and the delivery gate keep agents off `main` and out of
   each other's files.
4. **Build** — make the thing. The deliver convergence loop, serving-layer
   recipes, and proxy/local-model guardrails turn plausible-but-wrong output
   into real files.
5. **QC / Verify** — prove it runs. **The station everyone skips.** Completion
   gates, execution/runtime verification, the acceptance judge, and a
   generator≠evaluator split mean "done" is checked by something other than the
   model that wrote the code.
6. **Line coordination** — many workers, one floor. The coordination DB, the
   collaboration board with challenge mode, model-slot concurrency, and deploy
   batching keep parallel agents from colliding or deadlocking.
7. **Shipping** — out the door safely. The worktree→PR flow, version/completion
   gates, the CI feedback watcher, and git-safety stop regressions and force-push
   disasters.
8. **Feedback** — the floor learns. Memory promotion, pattern reinforcement, and
   session analysis make sure the same mistake doesn't recur every session.

Two things run *across* every station: **policy gates** turn your rules into
executable checks enforced at each bench (not prose in a README), and the **MCP
router** keeps the context window lean so the line stays fast. It all works
across 9 agent harnesses.

## Memory (`src/memory/`) — Intake & Feedback

> **Stage: Intake / Feedback.** Your agent walks onto the floor every session
> with amnesia. This subsystem is its long-term memory of what the shop already
> learned, so it stops re-discovering the same facts and re-making the same
> mistakes.

Hierarchical, tiered memory with semantic recall — the largest subsystem, and
the reason a UAP agent picks up where the last one left off.

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
| Daily log (`daily-log.ts`) | Staging log with promotion (`gate_score`) to long-term memory — the Feedback path where a session's lessons graduate to permanent knowledge. |
| Correction propagation (`correction-propagator.ts`) | Supersedes stale entries when corrections are made. |
| Predictive memory (`predictive-memory.ts`) | Learns query patterns to predict needed context. |
| Knowledge graph (`knowledge-graph.ts`) | L4 entity/relationship graph. |
| Ambiguity detector (`ambiguity-detector.ts`) | Implements P37 ambiguity detection. |
| Serverless Qdrant (`serverless-qdrant.ts`) | Lazy-local Docker Qdrant (`qdrant/qdrant:latest`, port 6333) or cloud. |
| Backends (`backends/`) | Pluggable long-term stores: Qdrant cloud, GitHub, factory selector. |
| Prepopulate (`prepopulate.ts`) | Seeds memory and discovers skills for CLAUDE.md generation. |
| Terminal-bench knowledge (`terminal-bench-knowledge.ts`) | Curated benchmark knowledge. |

## Models (`src/models/`) — Prep / Routing

> **Stage: Prep / Routing.** The wrong worker on the wrong job wastes the whole
> shift. This subsystem sizes up each task and routes it to the right model and
> the right amount of thinking — no more over-planning a one-liner or
> under-powering a refactor.

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

## Coordination (`src/coordination/`) — Line coordination & Prep

> **Stage: Line coordination.** Put many agents on one floor and they collide,
> duplicate work, or deadlock. This layer is the shop foreman: it tracks who is
> doing what, routes work by capability, and batches shipping actions so nobody
> trips over anybody.

Multi-agent coordination layer.

| Feature | Description |
|---------|-------------|
| Database/service (`database.ts`, `service.ts`) | Agent registry, heartbeats, messages, work announcements/claims. |
| Deploy batcher (`deploy-batcher.ts`) | Batches commit/push/merge/deploy actions into windows. |
| Capability router (`capability-router.ts`) | Routes tasks to droids by capability. |
| Auto-agent (`auto-agent.ts`) | Auto-agent driver. |
| Pattern router (`pattern-router.ts`) | Matches tasks to execution patterns; always includes P12/P35. |
| Adaptive patterns (`adaptive-patterns.ts`) | Tracks pattern success outcomes to adapt selection — Feedback that makes routing smarter over time. |
| Expert orchestrator (`expert-orchestrator.ts`) | Orchestrates parallel expert/droid review. |

## Tasks (`src/tasks/`) — Intake & Line coordination

> **Stage: Intake / Line coordination.** Work that isn't written down gets
> dropped or done twice. This is the job ticket system — what needs doing, what
> blocks what, and who has claimed the bench.

Task management system (positioned as an alternative to Beads).

| Feature | Description |
|---------|-------------|
| Service (`service.ts`) | CRUD, dependencies, claim/release, board, stats. |
| Database (`database.ts`) | SQLite store (`.uap/tasks/tasks.db`) + JSONL mirror. |
| Coordination (`coordination.ts`) | Task ↔ agent coordination. |
| Decoder gate (`decoder-gate.ts`) | Full decoder-first (P35) validator. |
| Event bus (`event-bus.ts`) | `TaskEventBus` for task lifecycle events. |

## Policies (`src/policies/`) — Cross-cutting enforcement

> **Stage: Every station.** Rules written in a README are suggestions your agent
> ignores. This engine turns them into executable checks fired at each bench, so
> a policy actually *blocks* the wrong move instead of politely hoping.

DB-driven policy enforcement engine.

| Feature | Description |
|---------|-------------|
| Policy gate (`policy-gate.ts`) | `PolicyGate` + `PolicyViolationError` — the enforcement core. |
| Tool registry (`policy-tools.ts`) | `PolicyToolRegistry` of executable policy tools. |
| Policy memory (`policy-memory.ts`) | Persists policies (`policies.db`). |
| Enforced tool router (`enforced-tool-router.ts`) | Routes tool calls through the gate. |
| CLAUDE.md conversion (`convert-policy-to-claude.ts`) | Renders policies into CLAUDE.md. |
| Enforcers (`enforcers/`) | ~20 Python enforcers (worktree_required, test_gate, schema_diff_gate, memory_before_plan, coord_overlap, mcp_router_first, rtk_wrap, iac_parity, expert_review_required, etc.). |

## Delivery (`src/delivery/`) — Build & QC / Verify

> **Stage: Build → QC / Verify.** This is where the sausage actually gets made,
> and where the biggest agentic failure lives: declaring "done" on code that
> doesn't compile or run. The convergence loop drives a model through
> execute → apply → verify → feedback against your real completion gates until it
> is genuinely *delivered* — not just claimed.

A loop that keeps building and re-checking until the work passes the same gates
you'd run by hand.

| Feature | Description |
|---------|-------------|
| Convergence loop (`convergence-loop.ts`) | The main delivery loop. |
| Run coordinator (`run-coordinator.ts`) | Coordinates a delivery run. |
| Explorer (`explorer.ts`) | Best-of-N candidate generation. |
| Applier (`applier.ts`) | Applies file changes. |
| Verifier ladder (`verifier-ladder.ts`) | Build/typecheck/test/lint gate ladder — the QC checks that prove it runs. |
| Judge / critic (`judge.ts`, `critic.ts`) | Evaluate and critique turns with a grader distinct from the builder (generator≠evaluator). |
| Escalation (`escalation.ts`) | Stagnation escalation ladder. |
| Auto-optimizer (`auto-optimizer.ts`) | Dynamically enables aids. |
| Ideation / practice / spec-imports | Divergent strategy seeds, best-practice cards, curated project seeds. |
| HALO trace (`halo-trace.ts`) | Emits HALO spans. |
| Integrity (`integrity.ts`) | Test-protection / integrity guard — stops the model from gutting the tests to "pass." |

## MCP Router (`src/mcp-router/`) — Cross-cutting (lean context)

> **Stage: Every station.** A stuffed context window slows and confuses the whole
> line. This router keeps it lean so every station runs on the signal that
> matters.

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

## Dashboard (`src/dashboard/`) — Observability

> **Stage: Watching the floor.** You can't fix a line you can't see. The
> dashboard is the control-room view of tasks, agents, memory, and models.

| Feature | Description |
|---------|-------------|
| Data service (`data-service.ts`) | Aggregates task/agent/memory/model/system data. |
| Event stream (`event-stream.ts`) | Real-time dashboard events. |
| Server (`server.ts`) | Web dashboard server (default port 3847). |
| Data seeder (`data-seeder.ts`) | Seeds demo/initial dashboard data. |

## Analyzers & Generators — Intake

> **Stage: Intake.** Before the line can run, it has to understand the shop it's
> working in. These build a picture of your project and generate the agent
> context files from it.

| Subsystem | Description |
|-----------|-------------|
| Analyzers (`analyzers/`) | `analyzeProject(cwd)` builds a `ProjectAnalysis` (languages, frameworks, dirs) from `.uap.json`, git, package files. |
| Generators (`generators/claude-md.ts`) | Handlebars-based CLAUDE.md / web AGENT.md generation from analysis + discovered skills. |

## Observability & Telemetry — Feedback

> **Stage: Feedback.** Traces are how the floor learns *why* it stalled. Opt-in
> spans feed the HALO engine so systemic failures surface instead of repeating.

| Subsystem | Description |
|-----------|-------------|
| Observability (`observability/halo-exporter.ts`) | Emits agent/LLM/tool spans as OTLP/OpenInference JSONL for the HALO engine. Opt-in via `UAP_HALO_TRACE`; zero-overhead when off. |
| Telemetry (`telemetry/session-telemetry.ts`) | Session-level telemetry capture. |

## Browser & Benchmarks — QC / Verify

> **Stage: QC / Verify.** Real proof beats a confident claim. The browser wrapper
> lets an agent actually drive a page, and the benchmark harness measures a plain
> agent against a UAP-augmented one.

| Subsystem | Description |
|-----------|-------------|
| Browser (`browser/web-browser.ts`) | `WebBrowser` automation wrapper for agents. |
| Benchmarks (`benchmarks/`) | Benchmark harness comparing a naive agent vs UAP-augmented agent; multi-turn loops, token throughput, speculative autotune. |

## Droids — Line coordination

> **Stage: Line coordination.** Specialist reviewers on call. The expert-droid
> roster gives the orchestrator a bench of named experts to run in parallel.

The expert-droid roster lives as markdown-with-JSON-frontmatter files under
`.factory/droids/*.md`, discovered at runtime by `discoverDroids()` in
`src/uap-droids-strict.ts`. The strict plugin validates droids against a Zod
schema and exposes `uap_droid_list` / `uap_droid_invoke`, plus the
decoder-first (P35) and worktree gates. See `docs/reference/EXPERT_DROIDS.md`.

## Utilities (`src/utils/`) — Cross-cutting

Shared helpers that keep the rest of the line reliable: adaptive cache,
concurrency pools (retry/timeout/fallback), config loader, lazy imports,
structured logger, CLAUDE.md merge, performance monitor, query-complexity
scoring (the Prep-stage signal that sizes a task), rate limiter, string
similarity, and system resource detection.

## CLI surface (`src/bin/cli.ts`)

The `uap` CLI is the single door into the whole factory (top-level commands):
`init`, `setup`, `analyze`, `generate`, `memory`, `patterns`, `worktree`,
`sync`, `droids`, `expert-route`, `deliver`, `harness` (HALO), `ideate`,
`coord`, `agent`, `deploy`, `task`, `compliance`, `coordination`, `skill`,
`update`, `dashboard` (alias `dash`), `model`, `mcp-router`, `hooks`,
`tool-calls`, `rtk`, `mcp-setup`, `schema-diff`, `policy`, `uap-omp`.
