# UAP Documentation

The complete documentation for the **Universal Agent Protocol** (`@miller-tech/uap` v1.40.0) — a layer that gives AI coding agents memory, judgment, and the discipline to finish the job.

New here? Start with the [project README](../README.md), then [Getting Started](getting-started/).

---

## Getting started

| Doc | What it covers |
|---|---|
| [Installation](getting-started/INSTALLATION.md) | Prerequisites, `npm install -g @miller-tech/uap`, what `uap setup` does, per-harness hook install |
| [Quickstart](getting-started/QUICKSTART.md) | 5-minute path: setup → memory → `uap deliver` → dashboard |
| [Configuration](getting-started/CONFIGURATION.md) | `.uap.json`, environment variables, Qdrant, model profiles |

## Guides

| Doc | What it covers |
|---|---|
| [**What UAP Does Automatically**](guides/AUTOMATIC.md) | Every feature in benefit / when-it-kicks-in terms — install once, it all self-applies ⭐ |
| [**`uap deliver`**](guides/DELIVER.md) | The delivery harness — convergence loop to verified completion ⭐ |
| [Memory](guides/MEMORY.md) | The 4-tier memory system, write-gates, semantic recall |
| [MCP Router](guides/MCP_ROUTER.md) | Token-optimizing tool proxy + FTS5 output compression |
| [Worktree Workflow](guides/WORKTREE_WORKFLOW.md) | Branch-per-feature isolation, auto-PR, enforcement |
| [Policies](guides/POLICIES.md) | Executable policy gates that block non-compliant tool calls |
| [Multi-Model Routing](guides/MULTI_MODEL.md) | Plan → route → execute across 7 model profiles |
| [Droids & Skills](guides/DROIDS_AND_SKILLS.md) | 38 expert droids, 32 skills, the expert router |
| [Deploy Batching](guides/DEPLOY_BATCHING.md) | Conflict-free batched git/deploy actions |
| [Coordination](guides/COORDINATION.md) | Multi-agent overlap detection |
| [Local Models](guides/LOCAL_MODELS.md) | Running agents against local llama.cpp / Qwen models |
| [Qwen3.6 on llama.cpp by VRAM](guides/QWEN36_LLAMACPP.md) | Tiered 8/12/16/24/32 GB setup; how `uap deliver` uplifts small local models |

## Architecture

| Doc | What it covers |
|---|---|
| [Overview](architecture/OVERVIEW.md) | System architecture, subsystems, tool-call flow |
| [Protocol](architecture/PROTOCOL.md) | The harness↔UAP contract, hook lifecycle, decision loop |
| [Reactor (auto-apply)](design/UAP_REACTOR.md) | Dynamic experts/skills/patterns injected per prompt across harnesses; the assist vs enforce model, per-harness wiring |

## Reference

| Doc | What it covers |
|---|---|
| [CLI](reference/CLI.md) | Every `uap` command and flag |
| [API](reference/API.md) | Programmatic API surface |
| [Features](reference/FEATURES.md) | Full feature catalog by subsystem |
| [Patterns](reference/PATTERNS.md) | The 23 Terminal-Bench patterns |
| [Platforms](reference/PLATFORMS.md) | The 9 supported harnesses + support matrix |
| [Configuration](reference/CONFIGURATION.md) | All config files and env vars |
| [Database Schema](reference/DATABASE_SCHEMA.md) | SQLite databases + Qdrant collections |

## Integrations

| Doc | What it covers |
|---|---|
| [MCP Router](integrations/MCP_ROUTER.md) | Setting up the MCP router across harnesses |
| [RTK](integrations/RTK.md) | Rust Token Killer integration |

## Benchmarks

| Doc | What it covers |
|---|---|
| [Validation Results](benchmarks/VALIDATION_RESULTS.md) | Terminal-Bench 2.0 results (−49.7% tokens, +33pp success) |
| [Token Optimization](benchmarks/TOKEN_OPTIMIZATION.md) | Where the token savings come from |
| [Accuracy Analysis](benchmarks/ACCURACY_ANALYSIS.md) | Success-rate and error analysis |

## Contributing

See [CONTRIBUTING.md](../CONTRIBUTING.md) for dev setup, the worktree workflow, completion gates, and PR conventions.
