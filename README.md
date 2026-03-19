# Universal Agent Protocol (UAP)

[![npm version](https://img.shields.io/npm/v/@miller-tech/uap.svg)](https://www.npmjs.com/package/@miller-tech/uap)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

<div align="center">

### AI agents that learn, remember, and coordinate

**Every lesson, every pattern, every memory preserved across sessions.**

</div>

---

## Quick Start

```bash
npm install -g @miller-tech/uap
cd your-project
uap init
uap setup -p all
```

---

## Table of Contents

- [Feature Overview](#feature-overview)
- [Memory System](#memory-system)
- [Multi-Agent Coordination](#multi-agent-coordination)
- [Deploy Batching](#deploy-batching)
- [Policy Enforcement](#policy-enforcement)
- [Browser Automation](#browser-automation)
- [MCP Router](#mcp-router)
- [Multi-Model Architecture](#multi-model-architecture)
- [Pattern System](#pattern-system)
- [Droids and Skills](#droids--skills)
- [Task Management](#task-management)
- [Worktree System](#worktree-system)
- [Hooks System](#hooks-system)
- [CLI Reference](#cli-reference)
- [Configuration](#configuration)
- [Testing](#testing--quality)
- [Requirements](#requirements)

---

## Feature Overview

| Category           | Components     | Purpose                                                                          |
| ------------------ | -------------- | -------------------------------------------------------------------------------- |
| Memory             | 27 modules     | 4-layer persistent memory with embeddings, knowledge graph, hierarchical tiering |
| Coordination       | 8 modules      | Multi-agent lifecycle, work claims, messaging, overlap detection                 |
| Deploy Batching    | 1 module       | Squash, merge, parallelize deploy actions across agents                          |
| Policy Enforcement | 8 modules      | Store, evaluate, and enforce operational policies with audit trail               |
| Browser            | 1 module       | Stealth web automation via CloakBrowser (Playwright drop-in)                     |
| MCP Router         | 10 modules     | 2-tool meta-router replacing N tool definitions (98% token savings)              |
| Models             | 10 modules     | Multi-model routing, planning, execution, validation, 13 model profiles          |
| Patterns           | 23 patterns    | Battle-tested workflows from Terminal-Bench 2.0                                  |
| Droids             | 8 experts      | Specialized agents for security, performance, docs, testing                      |
| Skills             | 24 skills      | Reusable domain expertise (chess, polyglot, compression, etc.)                   |
| Tasks              | 7 modules      | Full task lifecycle with dependencies, claims, JSONL sync                        |
| Worktrees          | 1 module       | Isolated git branches per agent, auto-numbered                                   |
| Hooks              | 2 hooks        | Session start (memory injection) and pre-compact (preservation)                  |
| CLI                | 25 commands    | Full system management with rich dashboard visualization                         |
| Benchmarks         | 9 modules      | Terminal-Bench adapter, Harbor integration, A/B comparison                       |
| LLM Optimization   | 5 tools        | Qwen3.5 tool call fixes, llama.cpp optimizer, LoRA training                      |
| RTK                | 1 module       | 60-90% token savings on command outputs                                          |
| Platforms          | 9 integrations | Claude, Factory, OpenCode, ForgeCode, VSCode, Beads, Codex, Pipeline, OMP        |

---

## Memory System

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

| Tier | Entries | Behavior                             |
| ---- | ------- | ------------------------------------ |
| Hot  | 10      | Always in context, highest relevance |
| Warm | 50      | Promoted on frequent access          |
| Cold | 500     | Semantic search only, compressed     |

Time-decay formula: `effective_importance = importance * decayRate^daysSinceAccess`

### Components (27 modules)

| Component                | File                                     | Purpose                                                     |
| ------------------------ | ---------------------------------------- | ----------------------------------------------------------- |
| Short-Term (SQLite)      | `src/memory/short-term/sqlite.ts`        | FTS5 full-text search, WAL mode                             |
| Short-Term Schema        | `src/memory/short-term/schema.ts`        | FTS5 triggers, table definitions                            |
| Hierarchical Memory      | `src/memory/hierarchical-memory.ts`      | Hot/warm/cold tiering with auto-promotion/demotion          |
| Dynamic Retrieval        | `src/memory/dynamic-retrieval.ts`        | Adaptive depth, hierarchical query, 6 memory sources        |
| Embedding Service        | `src/memory/embeddings.ts`               | 5 providers: LlamaCpp, Ollama, OpenAI, Local, TF-IDF        |
| GitHub Backend           | `src/memory/backends/github.ts`          | Store memories as JSON files in a GitHub repo               |
| Qdrant Backend           | `src/memory/backends/qdrant-cloud.ts`    | Vector search with project-isolated collections             |
| Backend Factory          | `src/memory/backends/factory.ts`         | Backend selection and initialization                        |
| Backend Base             | `src/memory/backends/base.ts`            | Interface definitions                                       |
| Serverless Qdrant        | `src/memory/serverless-qdrant.ts`        | Auto-start/stop Docker, cloud fallback, idle shutdown       |
| Write Gate               | `src/memory/write-gate.ts`               | Quality filter: 5 criteria, minimum score 0.3               |
| Daily Log                | `src/memory/daily-log.ts`                | Staging area -- all writes land here first                  |
| Correction Propagation   | `src/memory/correction-propagator.ts`    | Cross-tier updates, old claims marked [superseded]          |
| Memory Maintenance       | `src/memory/memory-maintenance.ts`       | Prune, decay, archive, deduplicate                          |
| Memory Consolidation     | `src/memory/memory-consolidator.ts`      | Semantic dedup, quality scoring, background consolidation   |
| Context Compression      | `src/memory/context-compressor.ts`       | 3 levels (light/medium/aggressive), dynamic budget-aware    |
| Semantic Compression     | `src/memory/semantic-compression.ts`     | Atomic facts extraction, token reduction                    |
| Speculative Cache        | `src/memory/speculative-cache.ts`        | Pre-computes likely queries, LRU with TTL                   |
| Knowledge Graph          | `src/memory/knowledge-graph.ts`          | Entities + relationships in SQLite, recursive CTE traversal |
| Adaptive Context         | `src/memory/adaptive-context.ts`         | 21 optimizations, historical benefit tracking               |
| Task Classifier          | `src/memory/task-classifier.ts`          | 9 categories, suggests droids                               |
| Model Router             | `src/memory/model-router.ts`             | Routes to optimal model by task type and cost               |
| Predictive Memory        | `src/memory/predictive-memory.ts`        | Cross-session query prediction with SQLite persistence      |
| Ambiguity Detector       | `src/memory/ambiguity-detector.ts`       | Detects ambiguous task descriptions                         |
| Context Pruner           | `src/memory/context-pruner.ts`           | Token-budget-aware memory pruning                           |
| Prepopulation            | `src/memory/prepopulate.ts`              | Import from docs (markdown) and git history                 |
| Terminal-Bench Knowledge | `src/memory/terminal-bench-knowledge.ts` | Domain knowledge from benchmark analysis                    |

---

## Multi-Agent Coordination

### How Agents Work Together

```
Agent A                    Agent B                    Agent C
   |                          |                          |
[Register] -> [Heartbeat 30s] -> [Announce: src/auth/]
   |                          |                          |
[Overlap Check] ---------> [Overlap Check] ---------> [Overlap Check]
   |                          |                          |
[Worktree: 001-auth]    [Worktree: 002-api]      [Worktree: 003-ui]
   |                          |                          |
[Queue deploy] ----------> [Deploy Batcher] -------> [Squash & Execute]
```

### Components (8 modules)

| Component             | File                                    | Purpose                                                        |
| --------------------- | --------------------------------------- | -------------------------------------------------------------- |
| Coordination Service  | `src/coordination/service.ts`           | Agent lifecycle, work claims, announcements, messaging         |
| Coordination Database | `src/coordination/database.ts`          | SQLite with WAL: agents, claims, announcements, messages       |
| Capability Router     | `src/coordination/capability-router.ts` | Routes tasks to droids by 18 capability types                  |
| Auto-Agent            | `src/coordination/auto-agent.ts`        | Automatic registration, heartbeat, graceful shutdown           |
| Pattern Router        | `src/coordination/pattern-router.ts`    | Loads Terminal-Bench patterns, critical patterns always active |
| Deploy Batcher        | `src/coordination/deploy-batcher.ts`    | Squash, merge, parallelize deploy actions                      |
| Adaptive Patterns     | `src/coordination/adaptive-patterns.ts` | Pattern success tracking with SQLite persistence               |

### Messaging

- **Broadcast** -- all agents
- **Direct** -- specific agent
- **Channels** -- broadcast, deploy, review, coordination
- **Priority** -- normal, high, urgent
- **Read receipts** -- delivery confirmation

---

## Deploy Batching

Prevents deploy storms when multiple agents finish work simultaneously.

### Batch Windows

| Action   | Default | Urgent |
| -------- | ------- | ------ |
| commit   | 30s     | 3s     |
| push     | 5s      | 1s     |
| merge    | 10s     | 2s     |
| workflow | 5s      | 1s     |
| deploy   | 60s     | 5s     |

### CLI

```bash
uap deploy queue --action commit --target main --message "feat: add auth"
uap deploy batch          # Group pending actions
uap deploy execute        # Run the batch
uap deploy status         # View queue
uap deploy flush          # Force-execute all pending
uap deploy config         # View batch config
uap deploy set-config     # Update config
uap deploy urgent         # Enable urgent mode
```

---

## Policy Enforcement

### Components (8 modules)

| Component            | File                                       | Purpose                                          |
| -------------------- | ------------------------------------------ | ------------------------------------------------ |
| Policy Schema        | `src/policies/schemas/policy.ts`           | Zod schemas for policies and executions          |
| Database Manager     | `src/policies/database-manager.ts`         | SQLite with WAL, JSON serialization              |
| Policy Memory        | `src/policies/policy-memory.ts`            | CRUD, relevance search, tag/category filtering   |
| Policy Tools         | `src/policies/policy-tools.ts`             | Store/execute Python enforcement tools           |
| Policy Gate          | `src/policies/policy-gate.ts`              | Middleware: blocks REQUIRED violations           |
| Enforced Tool Router | `src/policies/enforced-tool-router.ts`     | Single entry point for policy-checked tool calls |
| Policy Converter     | `src/policies/convert-policy-to-claude.ts` | Markdown to CLAUDE.md format                     |

### Enforcement Levels

| Level       | Behavior                                        |
| ----------- | ----------------------------------------------- |
| REQUIRED    | Blocks execution, throws `PolicyViolationError` |
| RECOMMENDED | Logged but does not block                       |
| OPTIONAL    | Informational only                              |

### CLI (15 subcommands)

```bash
uap policy list                    # List all policies
uap policy install <name>          # Install built-in policy
uap policy enable <id>             # Enable a policy
uap policy disable <id>            # Disable a policy
uap policy status                  # Enforcement status
uap policy add -f <file>           # Add from markdown
uap policy convert -i <id>         # Convert to CLAUDE.md format
uap policy get-relevant -t <task>  # Find relevant policies
uap policy add-tool -p <id> -t <name> -c <file>  # Add Python tool
uap policy check -o <operation>    # Check if allowed
uap policy audit                   # View audit trail
uap policy toggle <id>             # Toggle on/off
uap policy stage <id> -s <stage>   # Set enforcement stage
uap policy level <id> -l <level>   # Set enforcement level
```

Also available as standalone binary: `uap-policy`

---

## Browser Automation

Stealth web browser via CloakBrowser -- a Playwright drop-in.

```typescript
import { createWebBrowser } from '@miller-tech/uap/browser';

const browser = createWebBrowser();
await browser.launch({ headless: true, humanize: true });
await browser.goto('https://example.com');
const content = await browser.getContent();
await browser.close();
```

---

## MCP Router

Replaces N tool definitions with 2 meta-tools for 98% token reduction.

### Components (10 modules)

| Component         | File                                  | Purpose                                     |
| ----------------- | ------------------------------------- | ------------------------------------------- |
| MCP Server        | `src/mcp-router/server.ts`            | Exposes `discover_tools` and `execute_tool` |
| Config Parser     | `src/mcp-router/config/parser.ts`     | Loads MCP configs from standard paths       |
| Fuzzy Search      | `src/mcp-router/search/fuzzy.ts`      | Tool discovery with fuzzy matching          |
| Client Pool       | `src/mcp-router/executor/client.ts`   | Manages connections to MCP servers          |
| Tool Execute      | `src/mcp-router/tools/execute.ts`     | Tool execution with policy gate             |
| Tool Discover     | `src/mcp-router/tools/discover.ts`    | Tool discovery definitions                  |
| Output Compressor | `src/mcp-router/output-compressor.ts` | Compresses tool output                      |
| Session Stats     | `src/mcp-router/session-stats.ts`     | Per-tool token consumption tracking         |

---

## Multi-Model Architecture

### 3-Tier Execution

```
Tier 1: TaskPlanner    -- Decomposes task into subtasks
Tier 2: ModelRouter    -- Assigns optimal model per subtask
Tier 3: TaskExecutor   -- Executes with validation, dynamic temperature, rate limiting
```

### Components (10 modules)

| Component          | File                               | Purpose                                      |
| ------------------ | ---------------------------------- | -------------------------------------------- |
| Model Router       | `src/models/router.ts`             | Routes by complexity and cost                |
| Task Planner       | `src/models/planner.ts`            | Decomposition, dependency analysis           |
| Task Executor      | `src/models/executor.ts`           | Execution with model profiles, rate limiting |
| Plan Validator     | `src/models/plan-validator.ts`     | Cycle detection, coherence checks            |
| Profile Loader     | `src/models/profile-loader.ts`     | Load model profiles from JSON                |
| Execution Profiles | `src/models/execution-profiles.ts` | Runtime profile management                   |
| Unified Router     | `src/models/unified-router.ts`     | Combined routing logic                       |
| Analytics          | `src/models/analytics.ts`          | Model performance tracking                   |

### Model Profiles (13 profiles)

Pre-configured profiles in `config/model-profiles/`: claude-opus-4.6, claude-sonnet-4.6, claude-haiku-3.5, gpt-4.1, gpt-4o, gpt-o3, gemini-2.5-pro, gemini-2.5-flash, qwen35, glm-5, kimi-k2.5, llama, generic.

Each profile supports: `dynamic_temperature` (decay per retry), `tool_call_batching` (system prompt suffix), `rate_limits` (requests/tokens per minute).

---

## Pattern System (23 Patterns)

Battle-tested patterns from Terminal-Bench 2.0, stored in `.factory/patterns/`.

| Pattern               | ID  | What It Prevents                       |
| --------------------- | --- | -------------------------------------- |
| Output Existence      | P12 | Missing output files (37% of failures) |
| Iterative Refinement  | P13 | First-attempt acceptance               |
| Output Format         | P14 | Wrong format/encoding                  |
| Task-First            | P16 | Over-planning before doing             |
| Constraint Extraction | P17 | Missing hidden requirements            |
| Impossible Refusal    | P19 | Attempting impossible tasks            |
| Adversarial           | P20 | Missing attack vectors                 |
| Chess Engine          | P21 | Reinventing Stockfish                  |
| Git Recovery          | P22 | Data loss during git ops               |
| Compression Check     | P23 | Lossy compression errors               |
| Polyglot              | P24 | Single-language thinking               |
| Service Config        | P25 | Misconfigured services                 |
| Near-Miss             | P26 | Almost-correct solutions               |
| Smoke Test            | P28 | Untested changes                       |
| Performance Threshold | P30 | Missing perf targets                   |
| Round-Trip            | P31 | Encode/decode mismatches               |
| CLI Verify            | P32 | Broken CLI commands                    |
| Numerical Stability   | P33 | Floating point errors                  |
| Image Pipeline        | P34 | Image processing errors                |
| Decoder-First         | P35 | Wrong problem decomposition            |
| Competition Domain    | P36 | Missing domain knowledge               |
| Ambiguity Detection   | P37 | Ambiguous task descriptions            |
| IaC Parity            | IaC | Config drift                           |

---

## Droids & Skills

### Expert Droids (8)

| Droid                    | Specialization                   |
| ------------------------ | -------------------------------- |
| Code Quality Guardian    | Code review, quality enforcement |
| Debug Expert             | Debugging specialist             |
| Documentation Expert     | Documentation                    |
| ML Training Expert       | ML/training                      |
| Performance Optimizer    | Performance                      |
| Security Auditor         | Security review                  |
| Sysadmin Expert          | System administration            |
| Terminal-Bench Optimizer | Benchmark optimization           |

### Skills (24)

**Project Skills** (5): codebase-navigator, memory-management, near-miss-iteration, terminal-bench, worktree-workflow

**Claude Skills** (5): hooks-session-start, hooks-pre-compact, scripts-tool-router, scripts-preload-memory, session-context-preservation-droid

**Factory Skills** (14): adversarial, balls-mode, batch-review, chess-engine, cli-design-expert, codebase-navigator, compression, git-forensics, near-miss, polyglot, service-config, terminal-bench-strategies, typescript-node-expert, unreal-engine-developer

---

## Task Management

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

## Worktree System

Each agent works in an isolated git worktree to prevent conflicts.

```bash
uap worktree create my-feature   # Creates .worktrees/001-my-feature/
uap worktree list                # Show all worktrees
uap worktree pr 001              # Create PR
uap worktree cleanup 001         # Remove worktree + branch
uap worktree ensure --strict     # Verify inside worktree (CI gate)
```

---

## Hooks System

### Session Start Hook

1. Cleans stale agents (>24h no heartbeat)
2. Injects UAP compliance checklist
3. Loads recent memories (last 24h)
4. Surfaces open loops from session memories
5. Warns about stale worktrees

### Pre-Compact Hook

1. Records compaction marker in memory
2. Checks if lessons were stored
3. Outputs compliance reminder
4. Cleans up agents from current session

### Supported Platforms

```bash
uap hooks install claude      # Claude Code
uap hooks install factory     # Factory.AI
uap hooks install cursor      # Cursor
uap hooks install vscode      # VSCode
uap hooks install opencode    # OpenCode
uap hooks install forgecode   # ForgeCode
uap hooks install codex       # Codex CLI
uap hooks install omp         # Oh-My-Pi
```

---

## CLI Reference

### 25 Top-Level Commands

| Command                   | Description                                  |
| ------------------------- | -------------------------------------------- |
| `uap init`                | Initialize UAP in a project                  |
| `uap setup -p all`        | Full setup (memory, Qdrant, hooks, patterns) |
| `uap generate`            | Regenerate CLAUDE.md from templates          |
| `uap update`              | Update all components                        |
| `uap analyze`             | Analyze project structure                    |
| `uap compliance check`    | Verify UAP compliance                        |
| `uap dashboard`           | Rich terminal dashboard (13 views)           |
| `uap memory <action>`     | Memory management (9 subcommands)            |
| `uap patterns <action>`   | Pattern RAG management (4 subcommands)       |
| `uap worktree <action>`   | Git worktree management (5 subcommands)      |
| `uap agent <action>`      | Agent lifecycle (10 subcommands)             |
| `uap coord <action>`      | Coordination status (3 subcommands)          |
| `uap deploy <action>`     | Deploy batching (8 subcommands)              |
| `uap task <action>`       | Task management (15 subcommands)             |
| `uap droids <action>`     | Droid management (3 subcommands)             |
| `uap model <action>`      | Multi-model management (8 subcommands)       |
| `uap policy <action>`     | Policy management (15 subcommands)           |
| `uap mcp-router <action>` | MCP Router management (4 subcommands)        |
| `uap hooks <action>`      | Hook installation (2 subcommands)            |
| `uap tool-calls <action>` | Qwen3.5 tool call fixes (4 subcommands)      |
| `uap rtk <action>`        | RTK token compression (3 subcommands)        |
| `uap schema-diff`         | Detect breaking schema changes               |
| `uap mcp-setup`           | Configure MCP Router for AI harnesses        |
| `uap sync`                | Sync configuration between platforms         |
| `uap uap-omp <action>`    | Oh-My-Pi integration (7 subcommands)         |

**Total: 109 commands and subcommands.**

### Additional Binaries

| Binary                  | Purpose                               |
| ----------------------- | ------------------------------------- |
| `uap-policy`            | Standalone policy management          |
| `llama-optimize`        | llama.cpp startup parameter generator |
| `uap-tool-call-test`    | Qwen3.5 tool call testing             |
| `uap-tool-call-wrapper` | Qwen3.5 tool call wrapper             |
| `uap-template-verify`   | Chat template verification            |
| `generate-lora-data`    | LoRA training data generation         |

---

## Configuration

### .uap.json (Project)

```json
{
  "version": "1.0.0",
  "project": { "name": "my-project", "defaultBranch": "main" },
  "memory": {
    "shortTerm": { "enabled": true, "path": "./agents/data/memory/short_term.db" },
    "longTerm": { "enabled": true, "provider": "qdrant" }
  },
  "multiModel": {
    "enabled": true,
    "models": ["opus-4.6", "qwen35"],
    "roles": { "planner": "opus-4.6", "executor": "qwen35" },
    "routingStrategy": "balanced"
  },
  "worktrees": { "enabled": true, "directory": ".worktrees" }
}
```

---

## Testing & Quality

```bash
npm test              # 693 tests across 45 test files
npm run build         # TypeScript compilation
npm run lint          # ESLint
npm run format        # Prettier
npm run test:coverage # Coverage report (50% thresholds)
```

---

## Requirements

| Dependency | Version   | Required | Purpose                    |
| ---------- | --------- | -------- | -------------------------- |
| Node.js    | >= 18.0.0 | Yes      | Runtime                    |
| git        | Latest    | Yes      | Version control, worktrees |
| Docker     | Latest    | No       | Local Qdrant               |
| Python 3   | Latest    | No       | Embeddings, Pattern RAG    |

---

## Attribution

- Terminal-Bench patterns from [Terminal-Bench 2.0](https://github.com/aptx432/terminal-bench)
- CloakBrowser from [CloakHQ/CloakBrowser](https://github.com/CloakHQ/CloakBrowser)

---

<div align="center">

**[Documentation](docs/INDEX.md)** | **[npm](https://www.npmjs.com/package/@miller-tech/uap)**

</div>
