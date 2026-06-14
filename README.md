<div align="center">

# Universal Agent Protocol (UAP)

**Give your AI coding agents memory, judgment, and the discipline to finish the job.**

[![npm](https://img.shields.io/npm/v/@miller-tech/uap?color=blue&label=npm)](https://www.npmjs.com/package/@miller-tech/uap)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)
[![Tests](https://img.shields.io/badge/tests-117_suites-brightgreen)](#testing)
[![License](https://img.shields.io/badge/license-MIT-black)](LICENSE)

`v1.40.0` · 168 modules · 117 test suites · 9 agent harnesses

[Quickstart](#quickstart) · [Why UAP?](#why-uap) · [`uap deliver`](#the-deliver-harness) · [Architecture](#architecture) · [Benchmarks](#benchmarks) · [Docs](docs/INDEX.md)

</div>

---

## Why UAP?

AI coding agents are capable but undisciplined. They forget everything between sessions, burn tokens echoing huge tool outputs, repeat the same mistakes, declare victory on work that doesn't compile, and trip over each other in shared repos. UAP is a production-tested layer that sits **underneath your agent harness** (Claude Code, Factory, Cursor, OpenCode, and more) and fixes these problems at the protocol level — no model change required.

| The problem | What UAP does | Measured impact |
|---|---|---|
| Agents forget past sessions | 4-tier memory with semantic recall + write-gates | **49.7% fewer tokens** |
| Tool output floods the context | MCP Router — tool-hiding + FTS5 output compression | **up to ~98%** on large tool calls |
| Agents declare done on broken work | `uap deliver` — convergence loop against **real** gates | **+33pp** task success (25% → 58%) |
| Repetitive mistakes | 23 Terminal-Bench patterns + learning loop | **68% fewer errors** |
| Wrong model for the job | Multi-model router, 7 profiles | optimal cost/perf per task |
| Agents step on each other | Worktree isolation + coordination service | conflict-free parallel work |
| "Guidelines" get ignored | Policy gates as executable hooks, not prose | violations are **blocked**, not suggested |

> Benchmarks below are from Terminal-Bench 2.0 (12 representative tasks). See [docs/benchmarks/](docs/benchmarks/) for the full methodology and raw data.

---

## Quickstart

```bash
# Install globally
npm install -g @miller-tech/uap

# One-command setup in your project (memory, patterns, hooks, policies)
cd your-project
uap setup
```

That's it. Your agent now has persistent memory, battle-tested patterns, policy gates, and multi-agent coordination wired into every session.

```bash
uap memory query "how did we handle auth last time?"   # semantic recall
uap deliver "add rate limiting to the API"             # drive a model to verified completion
uap dashboard overview                                  # live task / agent / memory state
```

---

## The `deliver` harness

`uap deliver` is the headline of the v1.27–v1.40 line: a **convergence loop that iterates a model against your project's real completion gates until the work is actually delivered** — build passes, tests pass, lint is clean — not until the model *thinks* it's done.

```bash
uap deliver "implement the password reset flow"
```

What happens under the hood:

1. **Explore → plan → apply** — the model proposes changes; the applier writes them safely (pre-existing tests and gate configs are protected from being overwritten).
2. **Verify against real gates** — a verifier ladder runs your build, tests, and lint. Nothing is "done" until they're green.
3. **Critique & iterate** — failures feed back as structured guidance; the loop continues, **persisting until delivered** (extends past `--max-turns` to a ceiling, stopping on genuine stagnation).
4. **Auto-optimization** — every task is classified by complexity and the matching aids (HALO trace analysis, divergent ideation, coordination, deploy batching) activate automatically.
5. **Autonomy with a guidance channel** — runs the full mission without stopping to ask, while still accepting operator guidance mid-flight.

It works with frontier models *and* local models (llama.cpp / Qwen) served over the Anthropic Messages API. See **[docs/guides/DELIVER.md](docs/guides/DELIVER.md)**.

---

## Features

- **🧠 4-tier memory** — daily log → working cache → semantic (Qdrant) → long-term archive, with write-gates that block low-quality/duplicate memories and corrections that cascade across tiers.
- **🗜️ MCP Router** — a token-optimizing tool proxy; large outputs are compressed via FTS5 intent search instead of dumped into context.
- **🎯 `uap deliver`** — the convergence/delivery harness (above).
- **🌳 Worktree workflow** — isolated branch-per-feature, auto-PR, safe cleanup; enforced so agents never edit the project root.
- **🛡️ Policy gates** — 20 executable enforcers (worktree, test, schema-diff, expert-review, memory-before-plan, delivery-enforcement…) that *block* non-compliant tool calls.
- **🤖 Expert droids & skills** — 38 specialized droids and 32 skills, with an expert-router that recommends a droid chain per task.
- **🧭 Multi-model routing** — 7 profiles (Claude Opus/Sonnet/Haiku, GPT, Qwen, generic); the router picks by complexity, cost, and performance.
- **🚦 Deploy batching & coordination** — batched git/deploy actions and overlap detection keep multi-agent work conflict-free.
- **📊 Dashboard** — rich TUI/web views of tasks, agents, memory, benchmarks, and policy status.
- **🔌 9 harnesses** — Claude Code, Factory, Cursor, VSCode, OpenCode, Codex, ForgeCode, Oh-My-Pi, Hermes.

Full list with code-level detail: **[docs/reference/FEATURES.md](docs/reference/FEATURES.md)**.

---

## Architecture

UAP installs hooks into your agent harness, then mediates every tool call through memory, policy, and token-optimization layers.

```
┌─────────────────────────────────────────────────────────────┐
│  Agent harnesses                                            │
│  Claude Code · Factory · Cursor · VSCode · OpenCode · …     │
└───────────────────────────┬─────────────────────────────────┘
                            │ hooks (PreToolUse / tool.execute.before)
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                       UAP CLI (uap)                         │
│  setup · memory · deliver · worktree · policy · deploy      │
│  task · droids · model · mcp-router · harness · ideate …    │
└──┬─────────┬──────────┬──────────┬──────────┬───────────────┘
   ▼         ▼          ▼          ▼          ▼
 Memory   Policy    MCP Router   Delivery   Coordination
 4 tiers  20 gates  FTS5 compr.  harness    + deploy batch
```

- **30+ CLI commands** across 18 source subsystems (168 TypeScript modules).
- Deep dive: **[docs/architecture/OVERVIEW.md](docs/architecture/OVERVIEW.md)** · protocol spec: **[docs/architecture/PROTOCOL.md](docs/architecture/PROTOCOL.md)**.

---

## Benchmarks

Terminal-Bench 2.0, 12 representative tasks, UAP-on vs. baseline:

| Metric | Baseline | With UAP | Δ |
|---|---|---|---|
| Tokens consumed | 558,000 | 280,438 | **−49.7%** |
| Task success rate | 25% | 58% | **+33pp** |
| Errors per task | 1.17 | 0.42 | **−68%** |
| Wall-clock (total) | 618s | 266s | **−57%** |

Methodology, raw runs, and cost analysis: **[docs/benchmarks/](docs/benchmarks/)**.

---

## Supported harnesses

| Harness | Hooks | MCP Router | Policy gates |
|---|---|---|---|
| Claude Code | ✅ | ✅ | ✅ |
| Factory | ✅ | ✅ | ✅ |
| Cursor | ✅ | ✅ | ✅ |
| VSCode | ✅ | ✅ | ✅ |
| OpenCode | ✅ | ✅ | ✅ |
| Codex | ✅ | ✅ | ✅ |
| ForgeCode | ✅ | ✅ | ✅ |
| Oh-My-Pi | ✅ | ✅ | ✅ |
| Hermes (global) | ✅ | ✅ | ✅ |

Install into all detected harnesses with `uap hooks install`; audit coverage with `uap hooks doctor`. Matrix: **[docs/reference/PLATFORMS.md](docs/reference/PLATFORMS.md)**.

---

## Documentation

| | |
|---|---|
| **[Getting Started](docs/getting-started/)** | Installation, quickstart, configuration |
| **[Guides](docs/guides/)** | deliver, memory, MCP router, worktrees, policies, multi-model, local models |
| **[Architecture](docs/architecture/)** | System overview + the UAP protocol |
| **[Reference](docs/reference/)** | CLI, API, patterns, database schema, platforms |
| **[Benchmarks](docs/benchmarks/)** | Methodology and results |
| **[Contributing](CONTRIBUTING.md)** | Dev setup, gates, conventions |

Start at the **[documentation index](docs/INDEX.md)**.

---

## Testing

```bash
npm install
npm run build      # TypeScript compile
npm test           # vitest — 117 suites
npm run bench      # benchmark suite
```

---

## License

MIT © Miller Tech. See [LICENSE](LICENSE).
