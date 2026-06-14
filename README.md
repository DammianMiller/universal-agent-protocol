# Universal Agent Protocol (UAP)

[![npm version](https://img.shields.io/npm/v/@miller-tech/uap.svg)](https://www.npmjs.com/package/@miller-tech/uap)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen)](https://nodejs.org)
[![Tests](https://img.shields.io/badge/tests-1087_passed-brightgreen)](https://github.com/DammianMiller/universal-agent-protocol/actions)

<div align="center">

### AI agents that learn, remember, and coordinate

**Every lesson, every pattern, every memory preserved across sessions.**

v1.26.5 &middot; 149 source modules &middot; 86 test files &middot; 1087 tests

</div>

---

## Why UAP?

AI agents are powerful but notoriously forgetful and inefficient. Each session starts from scratch, redundant context bloats token bills, and multi-agent coordination is error-prone. UAP solves these problems with a production-tested stack:

| Problem | UAP Solution | Measured Impact |
|---------|-------------|-----------------|
| Agents forget past sessions | 4-layer memory with semantic embeddings | 49.7% token reduction |
| Wasted tokens on tool output | MCP Router with hierarchical compression | 98%+ token savings on tool calls |
| Agents step on each other | Worktree isolation + coordination service | Zero deploy conflicts |
| Repetitive mistakes | 23 Terminal-Bench patterns + learning | 68% fewer errors |
| Wrong model for the job | Multi-model router with 7 profiles | Optimal cost/performance per task |
| No policy enforcement | DB-driven gates with audit trail | REQUIRED policies block violations |

**Benchmark results** (Terminal-Bench 2.0, 12 representative tasks):

- **49.7% fewer tokens** (558k baseline → 280k with UAP)
- **+33pp success rate** (25% → 58%)
- **68% fewer errors** (1.17 → 0.42 per task)
- **57% faster** (618s → 266s total)

See [docs/benchmarks/](docs/benchmarks/) for full analysis.

---

## Quick Start

```bash
# Install globally
npm install -g @miller-tech/uap

# Initialize in your project
cd your-project
uap init
uap setup -p all
```

That's it. You now have memory, patterns, policy gates, and coordination wired into your AI agent sessions.

---

## Table of Contents

- [Architecture](#architecture)
- [Memory System](#memory-system)
- [Multi-Agent Coordination](#multi-agent-coordination)
- [Policy Enforcement](#policy-enforcement)
- [MCP Router](#mcp-router)
- [Multi-Model Architecture](#multi-model-architecture)
- [Pattern System](#pattern-system)
- [Expert Droids](#expert-droids)
- [Worktree System](#worktree-system)
- [Hooks System](#hooks-system)
- [CLI Reference](#cli-reference)
- [Testing](#testing--quality)
- [Requirements](#requirements)

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  AI Agent Harnesses                                         │
│  Claude Code · Factory · OpenCode · VSCode · Cursor · …    │
└────────────────────┬────────────────────────────────────────┘
                     │ hooks (PreToolUse / tool.execute.before)
                     ▼
┌─────────────────────────────────────────────────────────────┐
│                    UAP CLI (uap)                            │
│  init · setup · memory · patterns · worktree · deploy      │
│  task · droids · policy · model · mcp-router · hooks       │
│  harness · ideate · coord · sync · compliance · dashboard  │
└──┬──────────┬──────────┬──────────┬──────────┬─────────────┘
   │          │          │          │          │
   ▼          ▼          ▼          ▼          ▼
┌──────┐ ┌────────┐ ┌────────┐ ┌───────┐ ┌──────────┐
│Memory│ │Coord.  │ │Policy  │ │Models │ │MCP Router│
│4-lay │ │8 mod   │ │8 mod   │ │10 mod │ │11 mod    │
└──┬───┘ └──┬─────┘ └──┬─────┘ └──┬────┘ └────┬─────┘
   │        │         │         │           │
   ▼        ▼         ▼         ▼           ▼
┌──────┐ ┌────────┐ ┌──────┐ ┌──────┐ ┌──────────┐
│SQLite│ │SQLite  │ │SQLite│ │JSON  │ │stdio MCP │
│Qdrant│ │messages│ │WAL   │ │prof. │ │pool      │
└──────┘ └────────┘ └──────┘ └──────┘ └──────────┘
```

149 TypeScript source modules across 12 subsystems. See [docs/architecture/COMPLETE_ARCHITECTURE.md](docs/architecture/COMPLETE_ARCHITECTURE.md) for the full diagram.

---

## Memory System

### 4-Layer Architecture

```
L1: WORKING    Recent actions          SQLite   50 max
L2: SESSION    Current session         SQLite   per run
L3: SEMANTIC   Long-term learnings     Qdrant   vectors
L4: KNOWLEDGE  Entity relationships    SQLite   graph
```

### Hierarchical Tiers (Hot / Warm / Cold)

| Tier | Entries | Behavior |
|------|---------|----------|
| Hot | 10 | Always in context, highest relevance |
| Warm | 50 | Promoted on frequent access |
| Cold | 500 | Semantic search only, compressed |

Time-decay formula: `effective_importance = importance * decayRate^daysSinceAccess`

### Components (27 modules)

| Component | Purpose |
|-----------|---------|
| Short-Term (SQLite) | FTS5 full-text search, WAL mode |
| Hierarchical Memory | Hot/warm/cold tiering with auto-promotion |
| Dynamic Retrieval | Adaptive depth, 6 memory sources |
| Embedding Service | 5 providers: LlamaCpp, Ollama, OpenAI, Local, TF-IDF |
| GitHub / Qdrant Backends | Cloud-synced and vector search |
| Write Gate | Quality filter: 5 criteria, minimum score 0.3 |
| Correction Propagator | Cross-tier updates, `[superseded]` markers |
| Memory Maintenance | Prune, decay, archive, deduplicate |
| Context Compression | 3 levels, dynamic budget-aware |
| Knowledge Graph | Entities + relationships, recursive CTE traversal |
| Adaptive Context | 21 optimizations with benefit tracking |
| Predictive Memory | Cross-session query prediction |
| Task Classifier | 9 categories, suggests droids |
| Prepopulation | Import from docs and git history |

> **v1.26.5 fix**: Semantic embeddings now use real nomic 768-dim vectors instead of deterministic-hash placeholders. Long-term recall accuracy improved significantly. See [docs/benchmarks/ACCURACY_ANALYSIS.md](docs/benchmarks/ACCURACY_ANALYSIS.md).

---

## Multi-Agent Coordination

Agents register, announce their work scope, detect overlaps, and coordinate via a shared SQLite database.

```
Agent A                    Agent B
   │                          │
[Register] → [Heartbeat 30s] → [Announce: src/auth/]
   │                          │
[Overlap Check] ──────────► [Overlap Check]
   │                          │
[Worktree: 001-auth]     [Worktree: 002-api]
   │                          │
[Queue deploy] ──────────► [Deploy Batcher → Squash & Execute]
```

### Key Features

- **Work claims** with exclusive ownership
- **Messaging** with broadcast, direct, channels, and read receipts
- **Deploy batching** prevents deploy storms (configurable windows)
- **Capability router** maps tasks to expert droids by 18 capability types
- **Expert Orchestrator** composes plan→design→implement→review→release chains

---

## Policy Enforcement

Store, evaluate, and enforce operational policies with a full audit trail.

### Enforcement Levels

| Level | Behavior |
|-------|----------|
| REQUIRED | Blocks execution, throws `PolicyViolationError` |
| RECOMMENDED | Logged but does not block |
| OPTIONAL | Informational only |

### Platform Coverage

| Platform | Gate Tier |
|----------|-----------|
| Claude Code | Full (PreToolUse hooks) |
| VSCode | Full (Claude format) |
| Cursor | Full (preToolUse array) |
| Factory.AI | Full (PreToolUse hooks) |
| OpenCode | Full (tool.execute.before) |
| Codex | MCP-gated (no native hook) |
| ForgeCode | Advisory only |

See [docs/architecture/PLATFORM_GATING.md](docs/architecture/PLATFORM_GATING.md) for the full matrix.

---

## MCP Router

Replaces N tool definitions with 2 meta-tools (`discover_tools` + `execute_tool`) for **98%+ token reduction** on tool definitions.

### How It Works

1. **Discover**: Fuzzy-search tools across connected MCP servers
2. **Execute**: Run the tool with policy gate enforcement
3. **Compress**: Tiered output compression (passthrough → head/tail → FTS5 search)

### Token Savings by Tier

| Output Size | Strategy | Savings |
|-------------|----------|---------|
| < 5 KB | Passthrough | 0% |
| 5–10 KB | Head + tail truncation | ~45% |
| > 10 KB | FTS5 index-and-search | ~70% |

---

## Multi-Model Architecture

### 3-Tier Execution

```
Tier 1: TaskPlanner    → Decomposes task into subtasks
Tier 2: ModelRouter    → Assigns optimal model per subtask
Tier 3: TaskExecutor   → Executes with validation, rate limiting
```

### Model Profiles (7 built-in)

| Profile | Use Case |
|---------|----------|
| claude-opus-4.6 | Complex reasoning, architecture |
| claude-sonnet-4.6 | Balanced speed/quality |
| claude-haiku-3.5 | Simple tasks, high volume |
| gpt-5.4 | OpenAI fallback |
| gpt-5.3-codex | Code generation |
| qwen35 | Cost-effective general purpose |
| generic | Custom profile template |

Each profile supports: dynamic temperature decay, tool call batching, rate limits.

---

## Pattern System (23 Patterns)

Battle-tested patterns from Terminal-Bench 2.0, stored in `.factory/patterns/`. Critical patterns (P12 Output Existence, P35 Decoder-First) are always active.

| Pattern | ID | What It Prevents |
|---------|-----|-----------------|
| Output Existence | P12 | Missing output files (37% of failures) |
| Iterative Refinement | P13 | First-attempt acceptance |
| Output Format | P14 | Wrong format/encoding |
| Task-First | P16 | Over-planning before doing |
| Constraint Extraction | P17 | Missing hidden requirements |
| Adversarial | P20 | Missing attack vectors |
| Smoke Test | P28 | Untested changes |
| Decoder-First | P35 | Wrong problem decomposition |
| Competition Domain | P36 | Missing domain knowledge |
| IaC Parity | IaC | Config drift |

---

## Expert Droids

30+ expert droids covering the full SDLC, orchestrated by the `ExpertOrchestrator`.

| Phase | Droids |
|-------|--------|
| **Ideation** | ideation-expert (open-collider divergent ideation) |
| **Strategy** | product-strategist, strategic-architect, tactical-architect, implementation-planner |
| **Design** | architect-reviewer, api-designer |
| **Build** | typescript-node-expert, javascript-pro, python-pro, rust-pro, go-pro, cli-design-expert |
| **Review** | code-quality-guardian, code-quality-reviewer, security-auditor, security-code-reviewer |
| **Performance** | performance-optimizer, performance-reviewer, cost-engineer |
| **Testing** | test-strategist, test-plan-writer, test-coverage-reviewer, qa-expert |
| **Ops** | release-manager, compliance-officer, incident-responder, observability-engineer |
| **Specialty** | ml-training-expert, sysadmin-expert, accessibility-tester |

```bash
uap droids list                     # see what's installed
uap droids validate                 # CI-grade integrity check
uap expert-route "<task>"           # recommended droid chain
```

Droids are also reachable as virtual `experts.<name>` tools through the MCP router.

---

## Worktree System

Each agent works in an isolated git worktree to prevent conflicts.

```bash
uap worktree create my-feature   # Creates .worktrees/001-my-feature/
uap worktree list                # Show all worktrees
uap worktree pr 001              # Create PR
uap worktree finish 001          # Sync, merge PR, auto-cleanup
uap worktree ensure --strict     # Verify inside worktree (CI gate)
uap worktree prune --dry-run     # Preview stale worktrees
```

---

## Hooks System

Session hooks inject UAP compliance, memory, and policy gates into every AI agent session.

```bash
uap hooks install                # all platforms at once
uap hooks install claude         # Claude Code
uap hooks install opencode       # OpenCode
uap hooks doctor                 # audit policy-gate coverage
```

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

---

## CLI Reference

### 30 Top-Level Commands

| Command | Description |
|---------|-------------|
| `uap init` | Initialize UAP in a project |
| `uap setup -p all` | Full setup (memory, Qdrant, hooks, patterns) |
| `uap generate` | Regenerate CLAUDE.md from templates |
| `uap update` | Update all components |
| `uap analyze` | Analyze project structure |
| `uap compliance check` | Verify UAP compliance |
| `uap dashboard` | Rich terminal dashboard (11 views) |
| `uap memory` | Memory management (9 subcommands) |
| `uap patterns` | Pattern RAG management (4 subcommands) |
| `uap worktree` | Git worktree management (7 subcommands) |
| `uap agent` | Agent lifecycle (10 subcommands) |
| `uap coord` | Coordination status (3 subcommands) |
| `uap deploy` | Deploy batching (8 subcommands) |
| `uap task` | Task management (16 subcommands) |
| `uap droids` | Droid management (3 subcommands) |
| `uap expert-route` | Recommend expert droid chain |
| `uap harness` | HALO trace analysis |
| `uap ideate` | Open-collider ideation |
| `uap model` | Multi-model management (8 subcommands) |
| `uap policy` | Policy management (15 subcommands) |
| `uap mcp-router` | MCP Router management (4 subcommands) |
| `uap hooks` | Hook install/status/doctor (3 subcommands) |
| `uap tool-calls` | Qwen3.5 tool call fixes (4 subcommands) |
| `uap rtk` | RTK token compression (3 subcommands) |
| `uap schema-diff` | Detect breaking schema changes |
| `uap mcp-setup` | Configure MCP Router for harnesses |
| `uap sync` | Sync config between platforms |
| `uap uap-omp` | Oh-My-Pi integration (7 subcommands) |

**Total: 120+ commands and subcommands.**

### Additional Binaries

| Binary | Purpose |
|--------|---------|
| `uap-policy` | Standalone policy management |
| `llama-optimize` | llama.cpp startup parameter generator |
| `uap-tool-call-test` | Qwen3.5 tool call testing |
| `uap-template-verify` | Chat template verification |
| `generate-lora-data` | LoRA training data generation |

---

## Testing & Quality

| Metric | Value |
|--------|-------|
| Test files | 86 |
| Total tests | 1087 |
| Passing | 1086 |
| TypeScript | Clean (`tsc --noEmit` passes) |
| Coverage threshold | 50% |

```bash
npm test              # Run all 1087 tests
npm run build         # TypeScript compilation
npm run lint          # ESLint
npm run test:coverage # Coverage report
```

---

## Requirements

| Dependency | Version | Required | Purpose |
|------------|---------|----------|---------|
| Node.js | >= 18.0.0 | Yes | Runtime |
| git | Latest | Yes | Worktrees, version control |
| Docker | Latest | No | Local Qdrant vector store |
| Python 3 | Latest | No | Embeddings, Pattern RAG |

---

## Attribution

- Terminal-Bench patterns from [Terminal-Bench 2.0](https://github.com/aptx432/terminal-bench)
- CloakBrowser from [CloakHQ/CloakBrowser](https://github.com/CloakHQ/CloakBrowser)

---

<div align="center">

**[Full Documentation](docs/INDEX.md)** · **[Architecture](docs/architecture/COMPLETE_ARCHITECTURE.md)** · **[Benchmarks](docs/benchmarks/)** · **[npm](https://www.npmjs.com/package/@miller-tech/uap)**

</div>
