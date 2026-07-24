# UAP Documentation

The complete documentation for the **Universal Agent Protocol** (`@miller-tech/uap` v1.163) — the discipline layer that turns a talented-but-unreliable AI coding agent into a dependable member of your software delivery line.

> **Reviewing the system?** The reverse-engineered, code-verified reference set lives in
> [`documentation/`](../documentation/architecture.md): architecture, flows, permissions
> (incl. trust boundaries and enforcement gaps), variables/secrets, scheduled work, and
> embedded automation. Start there for an honest map of what's enforced vs. documented.

New here? The friendliest way in is the **[Delivery Pipeline tour](guides/DELIVERY_PIPELINE.md)** — it walks the whole factory floor, station by station, showing where agents normally break and what UAP puts in place to catch it. Then grab the [Quickstart](getting-started/QUICKSTART.md).

---

## Find your way by station

UAP is organized like a delivery line. If you know which part of the pipeline you're trying to fix, start here:

| Station | The break it prevents | Start with |
|---|---|---|
| **Intake** — understand the work | Amnesiac sessions, invented scope | [Memory](guides/MEMORY.md) · [Reactor](design/UAP_REACTOR.md) |
| **Prep / routing** — right job, right station | Wrong approach or wrong-sized model | [Multi-Model Routing](guides/MULTI_MODEL.md) · [Patterns](reference/PATTERNS.md) · [Droids & Skills](guides/DROIDS_AND_SKILLS.md) |
| **Isolation** — a bench per job | Editing `main`, clobbering files | [Worktree Workflow](guides/WORKTREE_WORKFLOW.md) |
| **Build** — make the thing | Plausible-but-wrong code, stubs, empty output | [`uap deliver`](guides/DELIVER.md) · [Local Models](guides/LOCAL_MODELS.md) · [Inference Proxy](guides/PROXY.md) |
| **QC / verify** — prove it runs | "Done" on code that never ran | [`uap deliver`](guides/DELIVER.md) · [Policies](guides/POLICIES.md) |
| **Coordination** — many workers, one floor | Parallel agents colliding | [Coordination](guides/COORDINATION.md) · [Deploy Batching](guides/DEPLOY_BATCHING.md) |
| **Shipping** — out the door safely | Regressions, red CI, skipped bumps | [Worktree Workflow](guides/WORKTREE_WORKFLOW.md) · [Policies](guides/POLICIES.md) |
| **Feedback** — the floor learns | The same mistake every session | [Memory](guides/MEMORY.md) · [Self-Harness](design/SELF_HARNESS.md) · [Self-Tuning](guides/SELF_TUNING.md) |
| *Cross-cutting* — the whole line | Ignored rules, bloated context | [Policies](guides/POLICIES.md) · [MCP Router](guides/MCP_ROUTER.md) |

Full map: **[The UAP Delivery Pipeline](guides/DELIVERY_PIPELINE.md)**.

---

## Getting started

| Doc | What it covers |
|---|---|
| [Installation](getting-started/INSTALLATION.md) | Prerequisites, `npm install -g @miller-tech/uap`, what `uap setup` does, per-harness hook install |
| [Quickstart](getting-started/QUICKSTART.md) | 5-minute path: setup → memory → `uap deliver` → dashboard |
| [Configuration](getting-started/CONFIGURATION.md) | `.uap.json`, environment variables, `.uap/proxy.env`, Qdrant, model profiles |

## Guides

| Doc | What it covers |
|---|---|
| [**The Delivery Pipeline**](guides/DELIVERY_PIPELINE.md) | The station-by-station tour — the big-picture map of the whole floor ⭐ |
| [**What UAP Does Automatically**](guides/AUTOMATIC_FEATURES.md) | Every feature in benefit / when-it-kicks-in terms — install once, it all self-applies ⭐ |
| [**`uap deliver`**](guides/DELIVER.md) | The Build+QC harness — convergence loop to verified completion, tiered gates, CI/deploy feedback loop ⭐ |
| [**Orchestrator & Hands-Free**](guides/ORCHESTRATOR.md) | The long-task autonomy layer — blackboard orchestrator, epic controller, completion ledger, auto-seed/resume; any model runs a huge build to 100% hands-free ⭐ |
| [**UAP Across Two Agents & Uplift**](guides/TWO_AGENTS_AND_UPLIFT.md) | The whole line applied seam-by-seam to opencode+Qwen3.6 (local) and Claude Code+Opus 4.8 (cloud), plus the benchmark that measures UAP uplift — diagrams + `benchmarks/suites/swe-bench-pro/` config |
| [Memory](guides/MEMORY.md) | The 4-tier memory system, write-gates, semantic recall |
| [MCP Router](guides/MCP_ROUTER.md) | Token-optimizing tool proxy + FTS5 output compression |
| [Worktree Workflow](guides/WORKTREE_WORKFLOW.md) | Branch-per-feature isolation, auto-PR, enforcement |
| [Sandbox](guides/SANDBOX.md) | Kernel-level (bubblewrap) write isolation — the boundary that survives `--dangerously-skip-permissions` |
| [Policies](guides/POLICIES.md) | Executable policy gates that block non-compliant tool calls |
| [**Policy Selection & Recommendations**](guides/POLICY_SELECTION.md) | Which policies to enable for your workflow — a recommended core + tailored sets by scenario; `uap policy recommend` ⭐ |
| [Pay2U Policy Pack](guides/POLICY_PACK_PAY2U.md) | The pay2u-tailored policy bundle |
| [Multi-Model Routing](guides/MULTI_MODEL.md) | Plan → route → execute across 7 model profiles |
| [Droids & Skills](guides/DROIDS_AND_SKILLS.md) | 38 expert droids, 36 skills, the expert router |
| [Deploy Batching](guides/DEPLOY_BATCHING.md) | Conflict-free batched git/deploy actions |
| [Coordination](guides/COORDINATION.md) | Multi-agent overlap detection |
| [Local Models](guides/LOCAL_MODELS.md) | Running agents against local llama.cpp / Qwen models |
| [Inference Proxy](guides/PROXY.md) | The Anthropic↔local gateway: `uap proxy` lifecycle, reliability guardrails, security, serving recipes |
| [Qwen3.6 on llama.cpp by VRAM](guides/QWEN36_LLAMACPP.md) | Tiered 8/12/16/24/32 GB setup; how `uap deliver` uplifts small local models |
| [**LLM Self-Tuning**](guides/SELF_TUNING.md) | `uap tune` — raise a small model toward Opus by tuning UAP's flag surface with a benchmark-validated LLM/GP-BO loop; quality scoring, model profiles, auto-on real-time adaptation ⭐ |

## Architecture

| Doc | What it covers |
|---|---|
| [Overview](architecture/OVERVIEW.md) | System architecture as the delivery-line floor plan; subsystems, tool-call flow |
| [Protocol](architecture/PROTOCOL.md) | The harness↔UAP contract, hook lifecycle, decision loop |
| [Reactor (auto-apply)](design/UAP_REACTOR.md) | Dynamic experts/skills/patterns injected per prompt across harnesses; the assist vs enforce model, per-harness wiring |
| [Self-Harness](design/SELF_HARNESS.md) | Self-improving harness (shipped as `uap self-harness`): autonomous mine→propose→validate loop over a bounded Mod DSL; cross-model transfer, online mining |
| [LLM Self-Tuning (analysis)](design/LLM_SELF_TUNING_ANALYSIS.md) | The design behind `uap tune`: quality signal, LLM-guided + Gaussian-process flag search, closed-loop validation, model profiles, real-time adaptation |

## Reference

| Doc | What it covers |
|---|---|
| [CLI](reference/CLI.md) | Every `uap` command and flag |
| [API](reference/API.md) | Programmatic API surface |
| [Features](reference/FEATURES.md) | Full feature catalog, mapped to the pipeline stages |
| [Patterns](reference/PATTERNS.md) | The 23 Terminal-Bench patterns |
| [Platforms](reference/PLATFORMS.md) | The 9 supported harnesses + support matrix |
| [Configuration](reference/CONFIGURATION.md) | All config files and env vars |
| [**Configuration Reference**](reference/CONFIGURATION_REFERENCE.md) | Every setting `uap config` exposes — what it does, default, and a recommendation (generated from the registry); `uap config list/explain/set/doctor/wizard` ⭐ |
| [Database Schema](reference/DATABASE_SCHEMA.md) | SQLite databases + Qdrant collections |

## Integrations

| Doc | What it covers |
|---|---|
| [MCP Router](integrations/MCP_ROUTER.md) | Setting up the MCP router across harnesses |
| [RTK](integrations/RTK.md) | Rust Token Killer integration |

## Benchmarks

| Doc | What it covers |
|---|---|
| [**Paired Findings**](benchmarks/PAIRED_FINDINGS.md) | Controlled A/B results: UAP gate value is +20pp vs a non-agentic baseline [CI +8,+32], ~0pp vs an agentic one — with confidence intervals ⭐ |
| [Paired Harness](benchmarks/PAIRED_HARNESS.md) | The `uap bench paired` controlled-A/B harness: design, adapters (mock/opencode/claude/raw), authoring tasks |
| [TBench Investigation](benchmarks/TBENCH_INVESTIGATION.md) | Earlier finding: no measurable UAP-context lift (every uncontrolled gain was a confound), methodology lessons |
| [Validation Results](benchmarks/VALIDATION_RESULTS.md) | Terminal-Bench 2.0 results (−49.7% tokens, +33pp success) |
| [Token Optimization](benchmarks/TOKEN_OPTIMIZATION.md) | Where the token savings come from |
| [Accuracy Analysis](benchmarks/ACCURACY_ANALYSIS.md) | Success-rate and error analysis |

## Contributing

See [CONTRIBUTING.md](../CONTRIBUTING.md) for dev setup, the worktree workflow, completion gates, and PR conventions.

## Attribution

See [ATTRIBUTION.md](ATTRIBUTION.md) for the research papers, community write-ups, and open-source projects whose ideas UAP implements — and the convention for crediting new inspirations.
