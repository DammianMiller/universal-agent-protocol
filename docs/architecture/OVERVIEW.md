# UAP Architecture Overview

`v1.40.0` · 168 TypeScript modules across 18 `src/` subsystems · 117 test suites

The Universal Agent Protocol (UAP) is a layer that sits **underneath** an AI
coding agent's harness — Claude Code, Factory, Cursor, OpenCode, Codex, and
others. It does not replace the model or the harness. Instead it installs
**hooks** that intercept the harness's tool calls, then mediates each call
through three services — memory injection, policy enforcement, and tool-output
compression — before handing control back. On top of that mediation layer it
ships a rich CLI for memory, delivery, worktrees, tasks, deployment, and
multi-model routing.

This document describes the system architecture. For the normative
harness↔UAP contract, see [PROTOCOL.md](PROTOCOL.md).

---

## The hook-mediation model

A bare agent harness calls a tool (Edit, Write, Bash, a spawned sub-agent, an
MCP tool) and the model sees the raw result. UAP inserts itself between the
harness and the tool by registering hooks at the harness's interception points:

- **Claude Code / VSCode / Factory / Cursor** — `PreToolUse` hooks
- **OpenCode** — the `tool.execute.before` plugin hook
- **Codex** — gating via the UAP MCP server (`execute_tool`)
- **Hermes** — the `pre_tool_call` event

The same logical lifecycle runs on every harness:

```
                          ┌──────────────────────────────────────┐
                          │            AGENT HARNESS              │
                          │   (Claude Code / Factory / OpenCode)  │
                          └───────────────┬──────────────────────┘
                                          │ tool call
                                          ▼
              ┌────────────────────── UAP HOOK LAYER ──────────────────────┐
              │                                                             │
   session    │   SessionStart hook                                        │
   start ─────┼─▶  • inject last-24h memory  (<uap-context> … )            │
              │    • clean stale agents / work claims                       │
              │                                                             │
   per tool   │   PreToolUse / tool.execute.before hook                     │
   call ──────┼─▶  ┌───────────┐   ┌────────────┐   ┌────────────────────┐ │
              │    │  MEMORY   │──▶│   POLICY   │──▶│     MCP ROUTER     │ │
              │    │ injection │   │   gates    │   │ token compression  │ │
              │    └───────────┘   └─────┬──────┘   └─────────┬──────────┘ │
              │                          │ deny (exit 2)      │            │
              │                          ▼                    ▼            │
              │                     BLOCK call          compressed result  │
              └─────────────────────────────────────────────┼────────────┘
                                          │ allow            │
                                          ▼                  ▼
                                   ┌──────────────────────────────┐
                                   │       THE ACTUAL TOOL        │
                                   │   (fs / shell / MCP server)  │
                                   └──────────────────────────────┘
```

Hooks are **fail-open for context** (memory injection never blocks) and
**fail-closed for safety** (a required policy violation returns exit code 2 and
the harness aborts the call). Hook scripts are generated and installed by
`uap hooks install` (`src/cli/hooks.ts`) from templates in `templates/hooks/`.

---

## Component map

```
src/
├── memory/         4-tier memory: working, session, semantic (Qdrant), graph
├── mcp-router/     hierarchical MCP router — tool hiding + FTS5 output compression
├── policies/       hook-based policy gates + 20 Python enforcers
├── delivery/       `uap deliver` convergence loop (15 modules)
├── coordination/   multi-agent registry, overlap detection, deploy batching
├── models/         multi-model routing, planning, execution profiles
├── tasks/          dependency-aware task tracker (SQLite, DAG)
├── dashboard/      live task / agent / memory / policy visualization
├── observability/  HALO / OpenInference span export for harness analysis
├── analyzers/      project structure analysis + metadata generation
├── generators/     CLAUDE.md / config generation
├── benchmarks/     Terminal-Bench harness + scoring
├── browser/        cloaked browser automation for agents
├── telemetry/      run telemetry
├── models/…        (see above)
├── bin/            CLI entry (cli.ts), policy bin, llama-server-optimize
├── cli/            ~35 command modules wired into bin/cli.ts
├── types/          shared types
└── utils/          logging and shared helpers
```

---

## Subsystems

### Memory (`src/memory/`)

A four-tier memory system that gives the agent persistent context across
sessions. The tiers (`src/memory/README.md`):

| Tier | Backend | Purpose |
|------|---------|---------|
| **L1 Working** | SQLite `memories` table (~50 cap, FTS5) | recent actions |
| **L2 Session** | SQLite `session_memories` table (FTS5) | current-session context, "open loops" |
| **L3 Semantic** | Qdrant, 768-dim vectors | long-term learnings, semantic recall |
| **L4 Knowledge** | SQLite entity/relationship graph | entity relationships, N-hop traversal |

Embeddings (`src/memory/embeddings.ts`) use **`nomic-embed-text-v2-moe`
(768-dim)** via a llama-server `--embeddings` endpoint, with fallbacks down a
chain (Ollama `nomic-embed-text` → OpenAI `text-embedding-3-small` → local
`all-MiniLM-L6-v2` → TF-IDF). The provider is pluggable and cached
(SHA-256-keyed LRU).

Key modules:

- `hierarchical-memory.ts` — in-memory hot/warm/cold tier manager with
  auto promote/demote, time-decay importance, and token-budget enforcement,
  persisted to its own SQLite DB.
- `dynamic-retrieval.ts` — the per-task orchestrator: classifies the task,
  sets adaptive retrieval depth + token budget, queries all sources, dedups,
  compresses, and formats the final context block.
- `memory-consolidator.ts` — summarizes working entries into session memory,
  extracts lessons, and dedups by content hash + embedding similarity.
- `write-gate.ts` — a quality filter that scores candidate memories and only
  persists those above threshold (prevents memory pollution).
- `knowledge-graph.ts` — the L4 graph: upsert entities, strengthen
  relationships, recursive-CTE traversal.
- `context-compressor.ts` / `semantic-compression.ts` — token budgeting and
  distillation of context into atomic typed facts.
- `predictive-memory.ts` / `speculative-cache.ts` — prefetch likely-needed
  memories before they are queried.
- `task-classifier.ts` — classifies an instruction to drive retrieval hints.
- `model-router.ts` — benchmark-fingerprint LLM routing with feedback learning
  (consumed by `src/models/unified-router.ts`).

### MCP Router (`src/mcp-router/`)

A hierarchical Model Context Protocol router that achieves large token savings
by two independent mechanisms (`src/mcp-router/server.ts`,
`output-compressor.ts`):

1. **Tool hiding.** Instead of exposing 150+ downstream MCP tool schemas
   (~500 tokens each) to the model, the router exposes just three meta-tools —
   `discover_tools`, `execute_tool`, `deliver`. The model issues a
   natural-language `discover_tools` query, gets back matching tool paths, then
   calls `execute_tool({path, args})`. Downstream tools live in an in-memory
   fuzzy search index and are never surfaced as definitions.
2. **Output compression (FTS5).** `execute_tool` accepts an `intent`. Large
   tool output is chunked, indexed into an in-memory SQLite **FTS5** virtual
   table, queried with the intent using **BM25 ranking**, and only the top
   matching snippets (plus a searchable-vocabulary footer) are returned. Small
   outputs pass through unchanged; very large outputs without an intent are
   head+tail truncated.

The design target documented in source is ~75,000 tokens of tool definitions
collapsed to ~700 (98%+). Per-output FTS5 savings are computed live per call.
See [../integrations/MCP_ROUTER.md](../integrations/MCP_ROUTER.md) for setup.

### Policies (`src/policies/`)

Project guidelines expressed as **executable hook gates** rather than prose.
Two layers:

- **TypeScript middleware** — `policy-gate.ts` (`PolicyGate.executeWithGates`)
  is the in-process gate used by the MCP server's `execute_tool`. It loads
  REQUIRED policies from a SQLite store (`policies.db`), evaluates keyword /
  anti-pattern rules against the operation, and throws `PolicyViolationError`
  on a REQUIRED violation. Stages: `pre-exec | post-exec | review | always`;
  completion/merge/deploy operations auto-force a `review` stage.
- **Shell gate + Python enforcers** — `templates/hooks/uap-policy-gate.sh`
  binds to harness hook events and invokes the ~20 enforcers in
  `src/policies/enforcers/`. A blocked verdict is **exit code 2** (hard block).

Enforcers cover the worktree gate (`worktree_required.py`), task discipline
(`task_required.py`), delivery routing (`delivery_enforcement.py`), test deltas
(`test_gate.py`), expert review (`expert_review_required.py`), schema diffs
(`schema_diff_gate.py`), memory-before-plan, MCP-router-first, RTK wrapping, and
more. Levels: **REQUIRED** blocks, **RECOMMENDED** logs, **OPTIONAL** informs.

### Delivery — `uap deliver` (`src/delivery/`)

A 15-module convergence loop that drives an underlying model against the
project's **real** completion gates until the work actually passes — the
mechanism behind UAP's "agents stop declaring victory on broken code." See the
[deliver flow](#how-uap-deliver-orchestrates) below.

### Coordination (`src/coordination/`)

Lets multiple agents work the same repo without colliding. A singleton SQLite
DB (`database.ts`) backs an agent registry, work announcements, work claims,
inter-agent messages, and a deploy queue. The DB is **shared across all
worktrees** (resolved via `git --git-common-dir` to the main worktree), so agents
in different `.worktrees/` see each other. Coordination is **always-on, not
advisory**: `session-start.sh` auto-registers every agent (+ heartbeat), and the
pre-edit hook (`coordinate-file.sh`) announces each file edit and **blocks** when
another *live* agent (heartbeat < 120s) is editing the same repo-relative path,
warning + self-healing stale announcements otherwise; `session-end.sh` reaps only
stale state so one agent ending never wipes live peers. `service.ts` detects
**overlap** when agents announce work on the same files and suggests merge order;
`deploy-batcher.ts` queues git/CI actions with per-type batch windows
(commit 30s, push 5s, merge 10s, deploy 60s), folds/squashes similar pending
actions, and executes batches sequentially or in parallel.
`expert-orchestrator.ts` builds an ordered expert-droid chain across the
`plan → design → implement → review → release` lifecycle, drawing implement
droids from `capability-router.ts`. `pattern-router.ts` matches tasks to
Terminal-Bench patterns (always enforcing **P12** Output Existence and
**P35** Decoder-First).

### Models (`src/models/`)

Multi-model routing. `router.ts` classifies a task (complexity + type from
keyword scoring) and `selectModel()` picks a model per the routing strategy —
`performance-first`, `cost-optimized`, `adaptive`, or `balanced` (default,
which walks priority-ordered routing rules). `unified-router.ts` layers a
benchmark signal on top: it returns a consensus when the rule-based and
benchmark routers agree, otherwise trusts the benchmark router only when it has
enough data. `planner.ts` decomposes a task into a subtask DAG and assigns a
model per subtask; `executor.ts` runs the plan level-by-level with retries and
fallback; `execution-profiles.ts` tunes *how* the chosen model runs
(temperature, budgets); `analytics.ts` records outcomes so routing improves.

### Tasks (`src/tasks/`)

A dependency-aware task tracker (a Beads alternative) backed by SQLite
(`tasks`, `task_dependencies`, `task_history`, `task_activity`,
`task_summaries`). Tasks form a DAG; closing a task transitions its dependents
from `blocked` to `open` and emits events on an in-process bus (`event-bus.ts`).
`coordination.ts` bridges tasks to the multi-agent coordination layer (claim /
release with overlap detection); `decoder-gate.ts` implements the P35
Decoder-First pre-execution validator (droid schema, tool availability,
claim conflicts, worktree requirement, ambiguity).

### Dashboard (`src/dashboard/`)

A live visualization layer (`uap dashboard`) over tasks, agents, memory,
policies, models, and benchmark/session history, with an event stream for
real-time updates.

### Observability (`src/observability/`)

Emits HALO / OpenInference spans for delivery runs and tool calls, consumed by
`uap harness analyze` to optimize agent execution from real traces.

### Benchmark harness (`src/benchmarks/paired/`)

A controlled paired-A/B harness (`uap bench paired`) for measuring UAP's impact
without confounds. It holds the base model + agent constant and toggles **only**
the UAP scaffold over the same real-gate task suite and seeds, reporting a vector
of paired deltas (correctness + tokens/turns/latency) with bootstrap confidence
intervals, a McNemar gate-value 2×2, and per-component leave-one-out ablation.
Pluggable `AgentAdapter`s drive the agent under test: `opencode`/`claude`
subprocess adapters, a deterministic `mock`, and a non-agentic `raw`
single-shot-vs-gate-loop adapter that isolates gate value. Ground truth is a
deterministic per-task `verifyCmd` (no LLM judge). The headline result lives in
[benchmarks/PAIRED_FINDINGS.md](../benchmarks/PAIRED_FINDINGS.md): UAP gate value
is **+20pp** over a non-agentic baseline and **~0pp** over an agentic one.

---

## How a tool call flows: memory → policy → MCP Router

For a representative `execute_tool` call routed through the UAP MCP server:

```
1. Tool call arrives at the PreToolUse hook.

2. MEMORY  — On session start, recent memory is injected as <uap-context>.
             Per task, dynamic-retrieval has already surfaced relevant
             long-term learnings into the prompt. (Read/Query stage.)

3. POLICY  — PolicyGate.executeWithGates loads REQUIRED policies and checks
             the operation + args. A REQUIRED violation → PolicyViolationError
             (or exit 2 from the shell enforcer) → the harness ABORTS the call.
             Otherwise the call proceeds.

4. ROUTER  — execute_tool resolves the tool path, dispatches to the downstream
             MCP client (or an expert droid), and captures the raw result.

5. COMPRESS— output-compressor indexes large output into FTS5 and returns only
             the top BM25 snippets for the call's `intent`, plus a vocabulary
             footer. The model sees a compact result, not the full payload.

6. RECORD  — The agent records the observation to short-term memory; the
             consolidator later promotes significant lessons to long-term
             memory through the write-gate. (Record/Promote stage.)
```

The four-stage **read → query → act → record → promote** loop is the agent
decision loop defined normatively in [PROTOCOL.md](PROTOCOL.md#agent-decision-loop).

---

## How `uap deliver` orchestrates

`uap deliver "<instruction>"` runs `ConvergenceLoop.deliver()`
(`src/delivery/convergence-loop.ts`). The staged flow:

```
detect gates ──▶ baseline check ──▶ protect files ──▶ ╔═════ turn loop ═════╗
(verifier-       (already green?    (snapshot tests/   ║  build prompt       ║
 ladder reads     skip, no model    oracle + integrity ║  EXECUTE model      ║
 package.json)    call)             guard)             ║  APPLY file blocks  ║
                                                       ║  VERIFY (ladder)    ║
                                                       ║  passed? ─▶ done    ║
                                                       ║  else: CRITIC +     ║
                                                       ║        ESCALATE     ║
                                                       ╚═════════╤═══════════╝
                                                                 │ repeat until
                                                                 ▼ gates pass or
                                                                   budget spent
```

- **Verifier ladder** (`verifier-ladder.ts`) — derives gate rungs from
  `package.json` scripts (build → typecheck via `tsc --noEmit` → test → lint),
  runs each as a real command in a secret-stripped env, fails fast on required
  rungs. "Delivered" means all *required* rungs pass; lint is optional.
- **Explorer + ideation** (`explorer.ts`, `ideation.ts`) — best-of-N: generate
  N candidates with distinct strategy seeds, apply/verify/rollback each on the
  same baseline, commit only the winner. A model **judge** (`judge.ts`)
  tie-breaks candidates with equal gate scores.
- **Critic** (`critic.ts`) — turns a failed turn's gate output into a
  file-scoped repair plan fed into the next turn (not a raw compiler dump).
- **Escalation** (`escalation.ts`) — on score stagnation, climbs a cost ladder:
  widen exploration → enable critic → switch to a stronger model + raise budget.
- **Protection** (`spec-imports.ts`, `integrity.ts`, `applier.ts`) — protects
  pre-existing test/spec files and their transitive oracle imports, and
  byte-verifies protected files after each gate run, so the model can't satisfy
  a spec by rewriting what it asserts against.
- **Auto / optimize** (`auto-optimizer.ts`) — by default, the run classifies
  task complexity and enables the matching aids automatically; `--optimize`
  enables every aid at once.
- **Coordination + observability** (`run-coordinator.ts`, `halo-trace.ts`) —
  optionally registers the run as a coordination agent, heartbeats, queues
  applied files into the deploy batcher, and emits HALO spans.

The default model preset is `qwen35-a3b`; `--until-delivered` (on by default)
keeps extending the turn budget while the best score is improving, up to a
ceiling (default 30, hard cap 50), and stops once progress stalls.

---

## See also

- [PROTOCOL.md](PROTOCOL.md) — the harness↔UAP contract and agent loop
- [../integrations/MCP_ROUTER.md](../integrations/MCP_ROUTER.md) — MCP Router setup
- [../integrations/RTK.md](../integrations/RTK.md) — RTK (Rust Token Killer)
- [../../CONTRIBUTING.md](../../CONTRIBUTING.md) — development workflow
