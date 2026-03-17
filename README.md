# Universal Agent Protocol (UAP) v8.7.0

[![npm version](https://img.shields.io/npm/v/universal-agent-protocol.svg)](https://www.npmjs.com/package/universal-agent-protocol)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

<div align="center">

### AI agents that learn, remember, and coordinate

**Every lesson, every pattern, every memory preserved across sessions.**

_Not just in one conversation -- but forever._

</div>

---

## Quick Start (30 seconds)

```bash
npm install -g universal-agent-protocol
cd your-project
uap init
uap setup -p all
```

---

## Table of Contents

- [Feature Overview](#feature-overview)
- [Memory System](#1-memory-system-23-components)
- [Multi-Agent Coordination](#2-multi-agent-coordination)
- [Deploy Batching](#3-deploy-batching)
- [Policy Enforcement](#4-policy-enforcement-system)
- [Browser Automation](#5-browser-automation-cloakbrowser)
- [MCP Router](#6-mcp-router-98-token-reduction)
- [Multi-Model Architecture](#7-multi-model-architecture)
- [Pattern System](#8-pattern-system-22-patterns)
- [Droids and Skills](#9-droids--skills)
- [Task Management](#10-task-management)
- [Worktree System](#11-worktree-system)
- [Hooks System](#12-hooks-system)
- [CLI Reference](#13-cli-reference-20-commands)
- [Benchmarking](#14-benchmarking-system)
- [Qwen3.5 / Local LLM](#15-qwen35--local-llm-optimization)
- [RTK Token Compression](#16-rtk-rust-token-killer)
- [Platform Integrations](#17-platform-integrations)
- [Harness Feature Matrix](#18-harness-feature-matrix)
- [Guardrails](#guardrails)
- [Scaling Guide](#scaling-more-devs-more-agents)
- [Configuration](#configuration)
- [Testing](#testing--quality)

---

## Feature Overview

| Category           | Components   | Purpose                                                                 |
| ------------------ | ------------ | ----------------------------------------------------------------------- |
| Memory             | 23 modules   | 4-layer persistent memory with embeddings, knowledge graph, compression |
| Coordination       | 6 modules    | Multi-agent lifecycle, work claims, messaging, overlap detection        |
| Deploy Batching    | 1 module     | Squash, merge, parallelize deploy actions across agents                 |
| Policy Enforcement | 6 modules    | Store, evaluate, and enforce operational policies with audit trail      |
| Browser            | 1 module     | Stealth web automation via CloakBrowser (Playwright drop-in)            |
| MCP Router         | 6 modules    | 2-tool meta-router replacing N tool definitions (98% token savings)     |
| Models             | 4 modules    | Multi-model routing, planning, execution, validation                    |
| Patterns           | 22 patterns  | Battle-tested workflows from Terminal-Bench 2.0                         |
| Droids             | 8+ experts   | Specialized agents for security, performance, docs, testing             |
| Skills             | 27 skills    | Reusable domain expertise (chess, polyglot, compression, etc.)          |
| Tasks              | 4 modules    | Full task lifecycle with dependencies, claims, JSONL sync               |
| Worktrees          | 1 module     | Isolated git branches per agent, auto-numbered                          |
| Hooks              | 2 hooks      | Session start (memory injection) and pre-compact (preservation)         |
| CLI                | 20+ commands | Full system management with rich dashboard visualization                |
| Benchmarks         | 10+ modules  | Terminal-Bench adapter, Harbor integration, A/B comparison              |
| LLM Optimization   | 5 modules    | Qwen3.5 tool call fixes, llama.cpp optimizer, LoRA training             |
| RTK                | 1 module     | 60-90% token savings on command outputs                                 |
| Platforms          | 6 platforms  | Claude, Factory, OpenCode, ForgeCode, VSCode, Cursor                    |

---

## 1. Memory System (23 Components)

### Architecture: 4 Layers

```
+-------------------------------------------------------------------+
|  L1: WORKING       | Recent actions        | 50 max  | SQLite    |
|  L2: SESSION        | Current session       | Per run | SQLite    |
|  L3: SEMANTIC       | Long-term learnings   | Qdrant  | Vectors   |
|  L4: KNOWLEDGE      | Entity relationships  | SQLite  | Graph     |
+-------------------------------------------------------------------+
```

### Hierarchical Tiers (Hot/Warm/Cold)

| Tier | Entries | Access Time | Behavior             |
| ---- | ------- | ----------- | -------------------- |
| Hot  | 10      | <1ms        | Always in context    |
| Warm | 50      | <5ms        | Promoted on access   |
| Cold | 500     | ~50ms       | Semantic search only |

Time-decay formula: `effective_importance = importance * decayRate^daysSinceAccess`

### Memory Components

| Component              | File                                  | Purpose                                                                            |
| ---------------------- | ------------------------------------- | ---------------------------------------------------------------------------------- |
| Short-Term (SQLite)    | `src/memory/short-term/sqlite.ts`     | FTS5 full-text search, WAL mode, speculative cache                                 |
| Short-Term (IndexedDB) | `src/memory/short-term/indexeddb.ts`  | Browser environment backend                                                        |
| Hierarchical Memory    | `src/memory/hierarchical-memory.ts`   | Hot/warm/cold tiering with auto-promotion/demotion                                 |
| Embedding Service      | `src/memory/embeddings.ts`            | 4 providers: Ollama, OpenAI, sentence-transformers, TF-IDF fallback                |
| GitHub Backend         | `src/memory/backends/github.ts`       | Store memories as JSON files in a GitHub repo                                      |
| Qdrant Backend         | `src/memory/backends/qdrant-cloud.ts` | Vector search with project-isolated collections                                    |
| Serverless Qdrant      | `src/memory/serverless-qdrant.ts`     | Auto-start/stop Docker, cloud fallback, idle shutdown                              |
| Write Gate             | `src/memory/write-gate.ts`            | Quality filter: behavioral change, commitment, decision, stable fact, user request |
| Daily Log              | `src/memory/daily-log.ts`             | Staging area -- all writes land here first, user promotes                          |
| Correction Propagation | `src/memory/correction-propagator.ts` | Cross-tier updates, old claims marked [superseded]                                 |
| Memory Maintenance     | `src/memory/memory-maintenance.ts`    | Prune, decay, archive, deduplicate (similarity > 0.92)                             |
| Agent-Scoped Memory    | `src/memory/agent-scoped-memory.ts`   | Per-agent partitions, explicit cross-agent sharing                                 |
| Memory Consolidation   | `src/memory/memory-consolidator.ts`   | Triggers every 10 entries, recursive summarization                                 |
| Context Compression    | `src/memory/context-compressor.ts`    | 3 levels (light/medium/aggressive), token budgets                                  |
| Semantic Compression   | `src/memory/semantic-compression.ts`  | SimpleMem-style atomic facts, 30x token reduction                                  |
| Multi-View (ENGRAM)    | `src/memory/multi-view-memory.ts`     | Episodic/semantic/procedural typing, multi-index                                   |
| Speculative Cache      | `src/memory/speculative-cache.ts`     | Pre-computes likely queries, LRU with TTL                                          |
| Knowledge Graph        | `src/memory/knowledge-graph.ts`       | Entities + relationships in SQLite, <20ms access                                   |
| Dynamic Retrieval      | `src/memory/dynamic-retrieval.ts`     | Adaptive depth based on query complexity                                           |
| Adaptive Context       | `src/memory/adaptive-context.ts`      | 21 optimizations, historical benefit tracking                                      |
| Task Classifier        | `src/memory/task-classifier.ts`       | Classifies into 9 categories, suggests droids                                      |
| Model Router           | `src/memory/model-router.ts`          | Routes to optimal model by task type and cost                                      |
| Prepopulation          | `src/memory/prepopulate.ts`           | Import from docs (markdown) and git history                                        |

---

## 2. Multi-Agent Coordination

### How Agents Work Together Without Collisions

```
Agent A                    Agent B                    Agent C
   |                          |                          |
   v                          v                          v
[Register]              [Register]               [Register]
   |                          |                          |
   v                          v                          v
[Heartbeat 30s]         [Heartbeat 30s]          [Heartbeat 30s]
   |                          |                          |
   v                          v                          v
[Announce: src/auth/]   [Announce: src/api/]     [Announce: src/ui/]
   |                          |                          |
   v                          v                          v
[Overlap Check]         [Overlap Check]          [Overlap Check]
   |                          |                          |
   v                          v                          v
[Worktree: 001-auth]    [Worktree: 002-api]      [Worktree: 003-ui]
   |                          |                          |
   v                          v                          v
[Work in isolation]     [Work in isolation]      [Work in isolation]
   |                          |                          |
   v                          v                          v
[Queue deploy]          [Queue deploy]           [Queue deploy]
   |                          |                          |
   +----------+---------------+----------+---------------+
              |                          |
              v                          v
        [Deploy Batcher]           [Squash & Execute]
```

### Coordination Components

| Component             | File                                    | Purpose                                                           |
| --------------------- | --------------------------------------- | ----------------------------------------------------------------- |
| Coordination Service  | `src/coordination/service.ts`           | Agent lifecycle, work claims, announcements, messaging            |
| Coordination Database | `src/coordination/database.ts`          | SQLite with WAL: agents, claims, announcements, messages, deploys |
| Capability Router     | `src/coordination/capability-router.ts` | Routes tasks to droids by 18 capability types                     |
| Auto-Agent            | `src/coordination/auto-agent.ts`        | Automatic registration, heartbeat, graceful shutdown              |
| Pattern Router        | `src/coordination/pattern-router.ts`    | Loads Terminal-Bench patterns, always includes critical ones      |

### Overlap Detection

Conflict risk levels: `none` | `low` | `medium` | `high` | `critical`

Detection checks:

- File-level overlap (same files modified)
- Directory-level overlap (same directories)
- Collaboration suggestions (merge order, sequential vs parallel)

### Messaging

- **Broadcast** -- all agents
- **Direct** -- specific agent
- **Channels** -- broadcast, deploy, review, coordination
- **Priority** -- normal, high, urgent
- **Read receipts** -- delivery confirmation

---

## 3. Deploy Batching

Prevents deploy storms when multiple agents finish work simultaneously.

### How It Works

```
Agent A queues: commit -> push
Agent B queues: commit -> push
Agent C queues: commit -> push
                    |
                    v
            [Deploy Batcher]
                    |
                    v
        Squash 3 commits into 1
        Single push to remote
```

### Batch Windows (per action type)

| Action   | Default Window | Urgent Window |
| -------- | -------------- | ------------- |
| commit   | 30s            | 3s            |
| push     | 5s             | 1s            |
| merge    | 10s            | 2s            |
| workflow | 5s             | 1s            |
| deploy   | 60s            | 5s            |

### Features

- **Squashing** -- Multiple commits to same target become one
- **Merging** -- Similar pending actions deduplicated
- **Parallel execution** -- Independent workflows run concurrently
- **Sequential safety** -- State-dependent actions (commit, push, merge) run in order
- **Timeout protection** -- 300s default, prevents hung processes
- **Dry run** -- Preview mode before execution
- **Urgent mode** -- Reduces all windows to minimum

### CLI

```bash
uap deploy queue --action commit --target main --message "feat: add auth"
uap deploy batch                    # Group pending actions
uap deploy execute                  # Run the batch
uap deploy status                   # View queue
uap deploy flush                    # Force-execute all pending
uap deploy config                   # View batch config
uap deploy set-config --urgent      # Enable urgent mode
```

---

## 4. Policy Enforcement System

### Architecture (3 Layers)

```
                    Tool Call
                        |
                        v
              [EnforcedToolRouter]
                        |
                        v
                  [PolicyGate]
                   /    |    \
                  v     v     v
             [Policy] [Policy] [Policy]
              REQUIRED  RECOMMENDED  OPTIONAL
                  |
                  v
            [Allow / Block]
                  |
                  v
            [Audit Trail]
```

### Components

| Component            | File                                       | Purpose                                               |
| -------------------- | ------------------------------------------ | ----------------------------------------------------- |
| Policy Schema        | `src/policies/schemas/policy.ts`           | Zod schemas for policies and executions               |
| Database Manager     | `src/policies/database-manager.ts`         | SQLite with WAL, JSON serialization, 3 tables         |
| Policy Memory        | `src/policies/policy-memory.ts`            | CRUD, relevance search, tag/category filtering        |
| Policy Tools         | `src/policies/policy-tools.ts`             | Store/execute Python enforcement tools                |
| Policy Gate          | `src/policies/policy-gate.ts`              | Middleware: check REQUIRED policies, block violations |
| Enforced Tool Router | `src/policies/enforced-tool-router.ts`     | Single entry point for all tool calls                 |
| Policy Converter     | `src/policies/convert-policy-to-claude.ts` | Markdown to CLAUDE.md format                          |

### Enforcement Levels

| Level       | Behavior                                                    |
| ----------- | ----------------------------------------------------------- |
| REQUIRED    | Blocks execution if violated, throws `PolicyViolationError` |
| RECOMMENDED | Logged but does not block                                   |
| OPTIONAL    | Informational only                                          |

### Audit Trail

Every policy check is logged to `policy_executions` table:

- Policy ID, tool name, operation, arguments
- Allowed/blocked decision with reason
- Timestamp

### CLI

```bash
uap-policy add -f policies/image-rules.md -c image -l REQUIRED
uap-policy list
uap-policy check -o "vision_count" -a '{"image":"photo.png"}'
uap-policy audit -n 50
uap-policy convert -i <policy-id> -o output.md
uap-policy add-tool -p <id> -t count_elements -c scripts/count.py
```

---

## 5. Browser Automation (CloakBrowser)

Stealth web browser via CloakBrowser -- a Playwright drop-in with 33 source-level C++ patches.

### Capabilities

| Feature              | Status                                |
| -------------------- | ------------------------------------- |
| Headless Chrome      | Real Chrome UA (not "HeadlessChrome") |
| webdriver flag       | `false` (undetectable)                |
| Plugins              | 5 detected (matches real browser)     |
| window.chrome        | Present                               |
| reCAPTCHA v3         | 0.9 score                             |
| Cloudflare Turnstile | Passes                                |
| FingerprintJS        | Undetected                            |
| Persistent profiles  | Cookie/localStorage persistence       |

### Usage

```typescript
import { createWebBrowser } from 'universal-agent-protocol/browser';

const browser = createWebBrowser();
await browser.launch({ headless: true, humanize: true });
await browser.goto('https://example.com');
const content = await browser.getContent();
await browser.evaluate(() => document.title);
await browser.close();
```

---

## 6. MCP Router (98% Token Reduction)

Replaces N tool definitions with 2 meta-tools.

### Before vs After

```
Before: 47 tools exposed = ~12,000 tokens in system prompt
After:  2 tools exposed  = ~200 tokens in system prompt
                           (98.3% reduction)
```

### Components

| Component         | File                                  | Purpose                                     |
| ----------------- | ------------------------------------- | ------------------------------------------- |
| MCP Server        | `src/mcp-router/server.ts`            | Exposes `discover_tools` and `execute_tool` |
| Config Parser     | `src/mcp-router/config/parser.ts`     | Loads MCP configs from standard paths       |
| Fuzzy Search      | `src/mcp-router/search/fuzzy.ts`      | Tool discovery with fuzzy matching          |
| Client Pool       | `src/mcp-router/executor/client.ts`   | Manages connections to MCP servers          |
| Output Compressor | `src/mcp-router/output-compressor.ts` | Compresses tool output                      |
| Session Stats     | `src/mcp-router/session-stats.ts`     | Per-tool token consumption tracking         |

---

## 7. Multi-Model Architecture

### 3-Tier Execution

```
Tier 1: TaskPlanner    -- Decomposes task into subtasks
Tier 2: ModelRouter    -- Assigns optimal model per subtask
Tier 3: TaskExecutor   -- Executes with validation
```

| Component      | File                           | Purpose                                                  |
| -------------- | ------------------------------ | -------------------------------------------------------- |
| Model Router   | `src/models/router.ts`         | Routes by complexity (critical/high/medium/low) and cost |
| Task Planner   | `src/models/planner.ts`        | Decomposition, dependency analysis, parallelization      |
| Task Executor  | `src/models/executor.ts`       | Executes plans with model clients                        |
| Plan Validator | `src/models/plan-validator.ts` | Cycle detection, coherence checks, timeout protection    |

---

## 8. Pattern System (22 Patterns)

Battle-tested patterns from Terminal-Bench 2.0 analysis, stored in `.factory/patterns/`.

| Pattern               | ID  | Category       | What It Prevents                       |
| --------------------- | --- | -------------- | -------------------------------------- |
| Output Existence      | P12 | Verification   | 37% of failures (missing output files) |
| Output Format         | P14 | Verification   | Wrong format/encoding                  |
| Constraint Extraction | P17 | Planning       | Missing hidden requirements            |
| Task-First            | P16 | Execution      | Over-planning before doing             |
| Impossible Refusal    | P19 | Safety         | Attempting impossible tasks            |
| Adversarial           | P20 | Security       | Missing attack vectors                 |
| Chess Engine          | P21 | Domain         | Reinventing Stockfish                  |
| Git Recovery          | P22 | Recovery       | Data loss during git ops               |
| Compression Check     | P23 | Verification   | Lossy compression errors               |
| Polyglot              | P24 | Code-Golf      | Single-language thinking               |
| Service Config        | P25 | DevOps         | Misconfigured services                 |
| Near-Miss             | P26 | Testing        | Almost-correct solutions               |
| Smoke Test            | P28 | Testing        | Untested changes                       |
| Performance Threshold | P30 | Optimization   | Missing perf targets                   |
| Round-Trip            | P31 | Verification   | Encode/decode mismatches               |
| CLI Verify            | P32 | Verification   | Broken CLI commands                    |
| Numerical Stability   | P33 | Testing        | Floating point errors                  |
| Image Pipeline        | P34 | Domain         | Image processing errors                |
| Decoder-First         | P35 | Analysis       | Wrong problem decomposition            |
| Competition Domain    | P36 | Research       | Missing domain knowledge               |
| IaC Parity            | IaC | Infrastructure | Config drift                           |
| Iterative Refinement  | P13 | Testing        | First-attempt acceptance               |

---

## 9. Droids & Skills

### Expert Droids (8+)

| Droid                    | File                                          | Specialization                   |
| ------------------------ | --------------------------------------------- | -------------------------------- |
| Code Quality Guardian    | `.factory/droids/code-quality-guardian.md`    | Code review, quality enforcement |
| Debug Expert             | `.factory/droids/debug-expert.md`             | Debugging specialist             |
| Documentation Expert     | `.factory/droids/documentation-expert.md`     | Documentation                    |
| ML Training Expert       | `.factory/droids/ml-training-expert.md`       | ML/training                      |
| Performance Optimizer    | `.factory/droids/performance-optimizer.md`    | Performance                      |
| Security Auditor         | `.factory/droids/security-auditor.md`         | Security review                  |
| Sysadmin Expert          | `.factory/droids/sysadmin-expert.md`          | System administration            |
| Terminal-Bench Optimizer | `.factory/droids/terminal-bench-optimizer.md` | Benchmark optimization           |

### Skills (27 total)

**Project Skills** (5): codebase-navigator, memory-management, near-miss-iteration, terminal-bench, worktree-workflow

**Claude Skills** (5): hooks-session-start, hooks-pre-compact, scripts-tool-router, scripts-preload-memory, session-context-preservation-droid

**Factory Skills** (16): adversarial, balls-mode, batch-review, chess-engine, cli-design-expert, codebase-navigator, compression, git-forensics, near-miss, polyglot, sec-context-review, service-config, terminal-bench-strategies, typescript-node-expert, unreal-engine-developer

---

## 10. Task Management

Full task lifecycle with dependencies, claims, and JSONL sync for git versioning.

| Feature      | Description                                  |
| ------------ | -------------------------------------------- |
| Types        | task, bug, feature, epic, chore, story       |
| Statuses     | open, in_progress, blocked, done, wont_do    |
| Priorities   | P0 (critical) through P4 (low)               |
| Dependencies | blocks, related, discovered_from             |
| Claims       | Exclusive claim with worktree + announcement |
| JSONL Sync   | Git-versionable task export                  |
| Compaction   | Archive old closed tasks                     |

---

## 11. Worktree System

Each agent works in an isolated git worktree to prevent conflicts.

```bash
uap worktree create my-feature
# Creates: .worktrees/001-my-feature/
# Branch:  001-my-feature
# Registry: .uap/worktree_registry.db

uap worktree list          # Show all worktrees
uap worktree pr 001        # Create PR
uap worktree cleanup 001   # Remove worktree + branch
```

Auto-numbered (NNN-slug) to prevent naming collisions between agents.

---

## 12. Hooks System

### Session Start Hook

Runs at every session start:

1. Cleans stale agents (>24h no heartbeat)
2. Injects UAP compliance checklist (10 steps)
3. Loads recent memories (last 24h)
4. Surfaces open loops from session memories
5. Warns about stale worktrees

### Pre-Compact Hook

Runs before context compaction:

1. Records compaction marker in memory
2. Checks if lessons were stored (warns if not)
3. Outputs compliance reminder
4. Cleans up agents from current session

### Supported Platforms

```bash
uap hooks install claude
uap hooks install factory
uap hooks install cursor
uap hooks install vscode
uap hooks install opencode
uap hooks install forgecode
```

---

## 13. CLI Reference (20+ Commands)

### Core

| Command                | Description                                  |
| ---------------------- | -------------------------------------------- |
| `uap init`             | Initialize UAP in a project                  |
| `uap setup -p all`     | Full setup (memory, Qdrant, hooks, patterns) |
| `uap generate`         | Regenerate CLAUDE.md from templates          |
| `uap update`           | Update all components                        |
| `uap analyze`          | Analyze project structure                    |
| `uap compliance check` | Verify UAP compliance                        |
| `uap dashboard`        | Rich terminal dashboard                      |

### Memory

| Command                      | Description                           |
| ---------------------------- | ------------------------------------- |
| `uap memory status`          | Check memory system                   |
| `uap memory query <search>`  | Search memories                       |
| `uap memory store <content>` | Store a learning (write-gated)        |
| `uap memory start`           | Start Qdrant                          |
| `uap memory prepopulate`     | Import from docs/git                  |
| `uap memory promote`         | Promote daily log entries             |
| `uap memory correct`         | Correct a memory (propagates)         |
| `uap memory maintain`        | Run maintenance (prune, decay, dedup) |

### Coordination

| Command               | Description           |
| --------------------- | --------------------- |
| `uap agent register`  | Register agent        |
| `uap agent heartbeat` | Send heartbeat        |
| `uap agent announce`  | Announce work area    |
| `uap agent overlaps`  | Check for conflicts   |
| `uap agent broadcast` | Message all agents    |
| `uap coord status`    | Coordination overview |
| `uap coord cleanup`   | Clean stale agents    |

### Deploy

| Command              | Description           |
| -------------------- | --------------------- |
| `uap deploy queue`   | Queue a deploy action |
| `uap deploy batch`   | Group pending actions |
| `uap deploy execute` | Run the batch         |
| `uap deploy flush`   | Force-execute all     |
| `uap deploy status`  | View queue            |

### Additional Binaries

| Binary           | Description                                 |
| ---------------- | ------------------------------------------- |
| `uap-policy`     | Policy management (add, list, check, audit) |
| `uap-tool-calls` | Qwen3.5 tool call fixes                     |
| `llama-optimize` | llama.cpp startup parameter generator       |

---

## 14. Benchmarking System

Terminal-Bench adapter for A/B comparison of UAM-enabled vs naive agents.

| Component           | File                                   | Purpose                              |
| ------------------- | -------------------------------------- | ------------------------------------ |
| Benchmark Framework | `src/benchmarks/benchmark.ts`          | Task schemas, verification functions |
| Benchmark Runner    | `src/benchmarks/runner.ts`             | Orchestrates execution               |
| Naive Agent         | `src/benchmarks/agents/naive-agent.ts` | Baseline without UAM                 |
| UAM Agent           | `src/benchmarks/agents/uam-agent.ts`   | UAM-enabled agent                    |
| SUPERGENIUS Agent   | `src/uam_harbor/supergenius_agent.py`  | Python agent targeting 80%+          |
| Harbor Datasets     | `harbor-datasets/`                     | Docker-sandboxed benchmark tasks     |

---

## 15. Qwen3.5 / Local LLM Optimization

| Component         | File                                                  | Purpose                                   |
| ----------------- | ----------------------------------------------------- | ----------------------------------------- |
| Tool Call Fixes   | `tools/agents/scripts/qwen_tool_call_*.py`            | Fix Qwen3.5 tool call reliability         |
| Chat Template Fix | `tools/agents/scripts/fix_qwen_chat_template.py`      | Template modifications                    |
| Llama Optimizer   | `src/bin/llama-server-optimize.ts`                    | Optimal llama.cpp params for 16/24GB VRAM |
| LoRA Training     | `tools/agents/scripts/generate_lora_training_data.py` | Fine-tuning data generation               |
| Qwen Settings     | `config/qwen35-settings.json`                         | Model-specific configuration              |

---

## 16. RTK (Rust Token Killer)

60-90% token savings on command outputs.

```bash
uap rtk install    # Install RTK
uap rtk status     # Check installation
uap rtk help       # Usage guide
```

---

## 17. Platform Integrations

| Platform    | Directory    | Features                                         |
| ----------- | ------------ | ------------------------------------------------ |
| Claude Code | `.claude/`   | Hooks, skills, settings, commands, agents        |
| Factory.AI  | `.factory/`  | Droids, skills, hooks, patterns, config          |
| OpenCode    | `.opencode/` | Plugin system, config                            |
| ForgeCode   | `.forge/`    | ZSH plugin, hooks                                |
| VSCode      | `.vscode/`   | Workspace settings, extensions                   |
| Beads       | `.beads/`    | Git-native issue tracking with JSONL, daemon RPC |

---

## 18. Harness Feature Matrix

Every AI coding harness ships as a stateless editor with file and terminal access. UAP closes the gap between "tool that edits code" and "agent platform that learns, coordinates, and enforces policy." It works with **15 harnesses** across 4 integration tiers -- same features everywhere, deeper wiring on first-class platforms.

### What UAP Adds (and Why It Matters)

- **4-layer persistent memory** -- agents retain lessons, decisions, and corrections across sessions instead of starting from zero
- **Write gate** -- 5-criteria quality filter prevents memory pollution so only high-value knowledge is stored
- **22 battle-tested patterns** -- Terminal-Bench 2.0 workflows eliminate the 37% of failures caused by missing output files, wrong formats, and skipped verification
- **Pattern RAG** -- on-demand pattern retrieval saves ~12K tokens per session by injecting only relevant patterns
- **Worktree isolation** -- each agent works in its own git worktree so parallel agents never corrupt each other's state
- **Multi-agent coordination** -- heartbeats, overlap detection, and conflict risk assessment let 2-10+ agents collaborate without collisions
- **Deploy batching** -- squash commits and serialize pushes to prevent deploy storms when multiple agents finish simultaneously
- **Policy enforcement** -- required/recommended/optional rules with audit trail ensure agents follow project standards
- **Task management** -- dependency-aware DAG with cycle detection, claims, and JSONL sync for git-versionable task tracking
- **Model routing** -- routes subtasks to optimal models by complexity and cost across 6 presets
- **MCP Router** -- replaces N tool definitions with 2 meta-tools for 98% token reduction in system prompts
- **RTK** -- 60-90% token savings on command outputs via Rust-based compression
- **12-gate compliance** -- automated protocol verification catches drift before it ships
- **20+ CLI commands** -- full system management with rich dashboard visualization

> Full 15-harness matrix with per-harness integration details: **[docs/reference/HARNESS-MATRIX.md](docs/reference/HARNESS-MATRIX.md)**

### Baseline: What Harnesses Provide Natively

| Feature                      | Claude Code | Factory.AI |  OpenCode  | ForgeCode |    Cursor    | VSCode  |    Cline    |    Windsurf    |
| ---------------------------- | :---------: | :--------: | :--------: | :-------: | :----------: | :-----: | :---------: | :------------: |
| File system + terminal       |     Yes     |    Yes     |    Yes     |    Yes    |     Yes      |   Yes   |     Yes     |      Yes       |
| Context file                 |  CLAUDE.md  | PROJECT.md |     --     |    --     | .cursorrules |   --    | .clinerules | .windsurfrules |
| Native hooks                 |     Yes     |    Yes     | Plugin API |    ZSH    |  hooks.json  |   --    |     --      |       --       |
| MCP support                  |   Native    |   Native   |   Config   |    --     |    Native    | Via ext |   Via ext   |    Via ext     |
| Persistent sessions          |     Yes     |    Yes     |    Yes     |  ZSH env  |   Limited    | Limited |   Limited   |    Limited     |
| Local LLM support            |     --      |     --     |   Native   |    Yes    |     Yes      | Via ext |     Yes     |      Yes       |
| **Persistent memory**        |     --      |     --     |     --     |    --     |      --      |   --    |     --      |       --       |
| **Pattern library**          |     --      |     --     |     --     |    --     |      --      |   --    |     --      |       --       |
| **Multi-agent coordination** |     --      |     --     |     --     |    --     |      --      |   --    |     --      |       --       |
| **Policy enforcement**       |     --      |     --     |     --     |    --     |      --      |   --    |     --      |       --       |

The bottom four rows are the gap. No harness provides them. UAP does.

### With UAP: Uniform Capabilities Across All Harnesses

| Capability               | Benefit                               | All Harnesses |
| ------------------------ | ------------------------------------- | :-----------: |
| 4-layer memory (L1-L4)   | Agents remember across sessions       |      Yes      |
| Write gate + tiering     | Only high-value knowledge stored      |      Yes      |
| 22 patterns + RAG        | Proven workflows, ~12K token savings  |      Yes      |
| Worktree isolation       | Parallel agents, zero conflicts       |      Yes      |
| Multi-agent coordination | Heartbeats, overlap detection, claims |      Yes      |
| Deploy batching          | No push races, squashed commits       |      Yes      |
| Policy engine            | Audit-trailed rule enforcement        |      Yes      |
| Task DAG                 | Dependency-aware work tracking        |      Yes      |
| Model router             | Right model for each subtask          |      Yes      |
| MCP Router               | 98% system prompt token reduction     |      Yes      |
| RTK compression          | 60-90% output token savings           |      Yes      |
| 12-gate compliance       | Automated protocol verification       |      Yes      |
| 20+ CLI commands         | Full management + dashboard           |      Yes      |

### Integration Tiers

| Tier                   | Harnesses                                         | What You Get                                                            |
| ---------------------- | ------------------------------------------------- | ----------------------------------------------------------------------- |
| **T1 -- First-Class**  | Claude Code, Factory.AI, OpenCode, ForgeCode      | Native hooks, dedicated config dir, `uap sync`, context file generation |
| **T2 -- IDE-Based**    | Cursor, VSCode, Cline                             | Platform-specific hooks, MCP config paths                               |
| **T3 -- CLI/Terminal** | Windsurf, Codex CLI, Aider, Zed AI                | Mapped to T1/T2 via CLAUDE.md or .cursorrules                           |
| **T4 -- Additional**   | GitHub Copilot, JetBrains AI, SWE-agent, Continue | Piggybacks on T2 infrastructure                                         |

All tiers receive identical UAP features. The difference is integration depth, not capability.

---

## Guardrails

### Completion Gates (Mandatory)

Every task must pass 3 gates before completion:

| Gate            | Check                     | Prevents                |
| --------------- | ------------------------- | ----------------------- |
| OUTPUT_EXISTS   | All expected files exist  | Phantom completions     |
| CONSTRAINTS_MET | All requirements verified | Partial implementations |
| TESTS_PASS      | `npm test` passes 100%    | Broken code             |

### Write Gate (Memory Quality)

Evaluates 5 criteria before storing a memory:

1. **Behavioral change** -- Does this change how we work?
2. **Commitment with consequences** -- Is there a real commitment?
3. **Decision with rationale** -- Was a decision made and why?
4. **Stable recurring fact** -- Is this a durable fact?
5. **Explicit user request** -- Did the user ask to remember this?

Minimum score: 0.3 (configurable). Noise patterns filter acknowledgments and transient requests.

### Policy Enforcement

REQUIRED policies block tool execution. Every check is logged to the audit trail. `PolicyViolationError` thrown with structured details.

### Pattern Router

Critical patterns (Output Existence, Decoder-First) are always active regardless of task classification.

### Correction Propagation

When a memory is corrected, old claims are marked `[superseded]` with date and reason across all tiers.

### Stale Agent Cleanup

Session hooks automatically clean agents with no heartbeat for >24 hours.

---

## Scaling: More Devs, More Agents

### How Multiple Agents Avoid Collisions

| Mechanism                     | How It Works                                                                                    |
| ----------------------------- | ----------------------------------------------------------------------------------------------- |
| **Worktree isolation**        | Each agent gets its own git worktree (`.worktrees/NNN-slug/`). No shared working directory.     |
| **Work announcements**        | Agents announce which files/directories they're touching. Overlap detection warns of conflicts. |
| **Conflict risk levels**      | `none` / `low` / `medium` / `high` / `critical` -- agents can decide whether to proceed.        |
| **Collaboration suggestions** | System recommends merge order and sequential vs parallel work.                                  |
| **Deploy batching**           | Multiple agents' commits are squashed and pushed in a single batch, preventing push races.      |
| **Agent-scoped memory**       | Each agent has its own memory partition. Cross-agent sharing requires explicit promotion.       |
| **Heartbeat liveness**        | 30-second heartbeats detect crashed agents. Stale agents cleaned automatically.                 |
| **Exclusive claims**          | Transaction-safe resource claiming with expiry prevents double-work.                            |

### Scaling from 1 to N Agents

```
1 agent:   No coordination needed. Worktree optional.
2-3 agents: Worktrees + announcements. Deploy batching recommended.
4-10 agents: Full coordination. Capability routing. Deploy batching required.
10+ agents: All of the above + agent-scoped memory + messaging channels.
```

### Scaling from 1 to N Developers

| Concern            | Solution                                                |
| ------------------ | ------------------------------------------------------- |
| Config conflicts   | `.uap.json` is project-scoped, not user-scoped          |
| Memory conflicts   | SQLite WAL mode supports concurrent reads               |
| Worktree naming    | Auto-numbered (001, 002, ...) prevents collisions       |
| Deploy races       | Batcher squashes and serializes state-dependent actions |
| Pattern drift      | Patterns indexed in Qdrant, shared across all agents    |
| Policy consistency | Policies stored in SQLite, enforced uniformly           |

### Database Concurrency

All SQLite databases use WAL (Write-Ahead Logging) mode:

- Multiple concurrent readers
- Single writer with no reader blocking
- Busy timeout prevents lock contention errors

### Resource Isolation

```
agents/data/
  memory/
    short_term.db          # Shared memory (WAL mode)
    policies.db            # Shared policies (WAL mode)
  coordination/
    coordination.db        # Shared coordination (WAL mode)
.uap/tasks/
  tasks.db                 # Shared tasks (WAL mode)
.uap/
  worktree_registry.db     # Shared worktree registry
.worktrees/
  001-feature-a/           # Agent A's isolated checkout
  002-feature-b/           # Agent B's isolated checkout
```

---

## Configuration

### .uap.json (Project)

```json
{
  "project": { "name": "my-project", "defaultBranch": "main" },
  "memory": {
    "shortTerm": { "enabled": true, "path": "./agents/data/memory/short_term.db" },
    "longTerm": { "enabled": true, "provider": "qdrant" }
  },
  "worktrees": { "enabled": true, "directory": ".worktrees" }
}
```

### opencode.json (Platform)

```json
{
  "provider": {
    "llama.cpp": {
      "options": { "baseURL": "http://localhost:8080/v1" },
      "models": {
        "qwen35-a3b-iq4xs": {
          "limit": { "context": 262144, "output": 81920 }
        }
      }
    }
  }
}
```

---

## Testing & Quality

```bash
npm test              # 271 tests across 24 test files
npm run build         # TypeScript compilation
npm run lint          # ESLint
npm run format        # Prettier
```

### Test Coverage

| Area           | Tests                                                   |
| -------------- | ------------------------------------------------------- |
| Deploy Batcher | 16 tests                                                |
| Coordination   | Multi-agent lifecycle                                   |
| Tasks          | CRUD, dependencies, claims                              |
| Models         | Router, planner, validator                              |
| Memory         | Write gate, daily log, corrections, maintenance, scoped |
| MCP Router     | Filter, output compressor                               |
| Browser        | Navigation, evaluate, content extraction                |
| Droids         | Parallel execution                                      |

---

## Requirements

| Dependency | Version   | Required | Purpose                 |
| ---------- | --------- | -------- | ----------------------- |
| Node.js    | >= 18.0.0 | Yes      | Runtime                 |
| git        | Latest    | Yes      | Version control         |
| Docker     | Latest    | No       | Local Qdrant            |
| Python 3   | Latest    | No       | Embeddings, Pattern RAG |

---

## Attribution

- Terminal-Bench patterns from [Terminal-Bench 2.0](https://github.com/aptx432/terminal-bench)
- Code Field prompts from [NeoVertex1/context-field](https://github.com/NeoVertex1/context-field)
- CloakBrowser from [CloakHQ/CloakBrowser](https://github.com/CloakHQ/CloakBrowser)

---

<div align="center">

**[Documentation](docs/UAP_OVERVIEW.md)** | **[Issues](https://github.com/DammianMiller/universal-agent-protocol/issues)** | **[npm](https://www.npmjs.com/package/universal-agent-protocol)**

_Built for developers who want AI that learns._

</div>
