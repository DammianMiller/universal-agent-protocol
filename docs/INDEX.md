# UAP Documentation

The complete documentation for the **Universal Agent Protocol** (`@miller-tech/uap` v2.11.0) — the discipline layer that turns a talented-but-unreliable AI coding agent into a dependable member of your software delivery line. 367 TypeScript modules across 26 subsystems, 459 vitest suites plus a ~1,200-test Python enforcer/proxy suite, 60+ CLI command registrations, 32 executable policy enforcers, 9 supported agent harnesses.

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
| **Prep / routing** — right job, right station | Wrong approach or wrong-sized model | [Multi-Model Routing](guides/MULTI_MODEL.md) · [Patterns](reference/PATTERNS.md) · [Droids & Skills](guides/DROIDS_AND_SKILLS.md) · [System-1 Classifier](reference/system1-classifier.md) (`uap classify`) |
| **Isolation** — a bench per job | Editing `main`, clobbering files | [Worktree Workflow](guides/WORKTREE_WORKFLOW.md) |
| **Build** — make the thing | Plausible-but-wrong code, stubs, empty output | [`uap deliver`](guides/DELIVER.md) · [Local Models](guides/LOCAL_MODELS.md) · [Inference Proxy](guides/PROXY.md) |
| **QC / verify** — prove it runs | "Done" on code that never ran | [`uap deliver`](guides/DELIVER.md) · [Policies](guides/POLICIES.md) · [Quality gate](../CLAUDE.md) (`uap quality check`) · [AutoMode risk](reference/automode-risk.md) · [Evidence-bound ship](reference/evidence-bound-ship.md) |
| **Coordination** — many workers, one floor | Parallel agents colliding, stale branches overwriting landed work | [Parallel Agents](guides/PARALLEL_AGENTS.md) · [Coordination](guides/COORDINATION.md) · [Deploy Batching](guides/DEPLOY_BATCHING.md) · [Semantic Supervisor](reference/semantic-supervisor.md) (`uap supervise`) |
| **Shipping** — out the door safely | Regressions, red CI, skipped bumps | [Worktree Workflow](guides/WORKTREE_WORKFLOW.md) · [Policies](guides/POLICIES.md) |
| **Capacity** — services inside their budgets | Silent OOMs, crash loops, headroom loss | [Capacity Policy](guides/CAPACITY_POLICY.md) (`uap doctor`) |
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
| [What UAP Does Automatically (compact)](guides/AUTOMATIC.md) | A shorter, trigger-by-trigger telling of the same ground as AUTOMATIC_FEATURES |
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
| [Droids & Skills](guides/DROIDS_AND_SKILLS.md) | 38 expert droids, 6 bundled skills (plus per-harness skill surfaces), the expert router |
| [Deploy Batching](guides/DEPLOY_BATCHING.md) | Conflict-free batched git/deploy actions |
| [Coordination](guides/COORDINATION.md) | Multi-agent overlap detection |
| [**Parallel Agents**](guides/PARALLEL_AGENTS.md) | Many agents, one codebase: fresh bases, drift blocking, `uap worktree sync`, the merge queue, ownership lanes ⭐ |
| [Local Models](guides/LOCAL_MODELS.md) | Running agents against local llama.cpp / Qwen models |
| [Inference Proxy](guides/PROXY.md) | The Anthropic↔local gateway: `uap proxy` lifecycle, reliability guardrails, security, serving recipes |
| [Qwen3.6 on llama.cpp by VRAM](guides/QWEN36_LLAMACPP.md) | Tiered 8/12/16/24/32 GB setup; how `uap deliver` uplifts small local models |
| [Qwen3.8-27B on exllamav3 (EXL3)](guides/QWEN38_EXL3.md) | The production serving stack since 2026-09-04: EXL3 3.5bpw + DFlash2 draft on a 3090, the sm_86 adaptations, local kit patches, rollback to llama.cpp |
| [**LLM Self-Tuning**](guides/SELF_TUNING.md) | `uap tune` — raise a small model toward Opus by tuning UAP's flag surface with a benchmark-validated LLM/GP-BO loop; quality scoring, model profiles, auto-on real-time adaptation ⭐ |

## Architecture

| Doc | What it covers |
|---|---|
| [Overview](architecture/OVERVIEW.md) | System architecture as the delivery-line floor plan; subsystems, tool-call flow |
| [Protocol](architecture/PROTOCOL.md) | The harness↔UAP contract, hook lifecycle, decision loop |
| [Reactor (auto-apply)](design/UAP_REACTOR.md) | Dynamic experts/skills/patterns injected per prompt across harnesses; the assist vs enforce model, per-harness wiring |
| [Self-Harness](design/SELF_HARNESS.md) | Self-improving harness (shipped as `uap self-harness`): autonomous mine→propose→validate loop over a bounded Mod DSL; cross-model transfer, online mining |
| [LLM Self-Tuning (analysis)](design/LLM_SELF_TUNING_ANALYSIS.md) | The design behind `uap tune`: quality signal, LLM-guided + Gaussian-process flag search, closed-loop validation, model profiles, real-time adaptation |
| [Product Naming (analysis)](design/PRODUCT_NAMING.md) | UAP rename candidates: availability sweeps (npm/PyPI/domains), AI-space collision checks, railway-theme shortlist, recommendation. No decision committed; availability data is point-in-time |
| [ADRs](architecture/adr/) | Architecture decision records: [0001 AutoMode risk floor](architecture/adr/0001-automode-risk-floor.md) (Python heuristic scorer ahead of the TS SYS1 head), [0002 Evidence-bound ship](architecture/adr/0002-evidence-bound-ship.md) (gate evidence bound to the candidate SHA) |

## Reference

| Doc | What it covers |
|---|---|
| [CLI](reference/CLI.md) | Every `uap` command and flag |
| [Comparison](reference/COMPARISON.md) | UAP vs other agent harnesses and adjacent tooling (memory, orchestration, spec-driven, review/policy) — positioning, honest trade-offs, sources |
| [API](reference/API.md) | Programmatic API surface |
| [Features](reference/FEATURES.md) | Full feature catalog, mapped to the pipeline stages |
| [Patterns](reference/PATTERNS.md) | The 23 Terminal-Bench patterns |
| [Routing Evals](reference/routing-evals.md) | CI-enforced rank-1 routing evals over the pattern/droid/skill registries — planted traps, negative cases, 90% threshold |
| [Platforms](reference/PLATFORMS.md) | The 9 supported harnesses + support matrix |
| [Review Pre-Pass](reference/review-prepass.md) | Deterministic ruleset scanner (`uap review prepass`) that feeds line-anchored findings to the parallel review protocol |
| [Visual Captures](reference/visual-captures.md) | Before/after capture binding for UI diffs (`uap review captures`) — ship-time gate 7 enforcement |
| [System-1 Classifier](reference/system1-classifier.md) | `uap classify` — the local, airgap-pure assessment backend (noul/score/choice questions) behind the Wave 1 consumers; thresholds ship as policy config |
| [Semantic Supervisor](reference/semantic-supervisor.md) | `uap supervise` — watchdog loop for `uap deliver` missions; nine assessment dimensions, deterministic safety-first policy, cooperative STOP only |
| [AutoMode Risk](reference/automode-risk.md) | Pre-execution tool-call risk classification (`tools/agents/scripts/tool_risk.py`) — advisory only, ahead of the deterministic enforcer floor |
| [Evidence-Bound Ship](reference/evidence-bound-ship.md) | Ship actions blocked unless `.uap/evidence/<head-sha>.json` proves the gates passed for the exact commit being shipped |
| [Configuration](reference/CONFIGURATION.md) | All config files and env vars |
| [**Configuration Reference**](reference/CONFIGURATION_REFERENCE.md) | Every setting `uap config` exposes — what it does, default, and a recommendation (generated from the registry); `uap config list/explain/set/doctor/wizard` ⭐ |
| [Database Schema](reference/DATABASE_SCHEMA.md) | SQLite databases + Qdrant collections |

## Integrations

| Doc | What it covers |
|---|---|
| [MCP Router](integrations/MCP_ROUTER.md) | Setting up the MCP router across harnesses |

## Benchmarks

| Doc | What it covers |
|---|---|
| [Benchmarks overview](benchmarks/README.md) | The headline numbers, what to trust, and where the raw runs and task suites live |
| [**Paired Findings**](benchmarks/PAIRED_FINDINGS.md) | Controlled A/B results: UAP gate value is +20pp vs a non-agentic baseline [CI +8,+32], ~0pp vs an agentic one — with confidence intervals ⭐ |
| [Paired Harness](benchmarks/PAIRED_HARNESS.md) | The `uap bench paired` controlled-A/B harness: design, adapters (mock/opencode/claude/raw), authoring tasks |
| [TBench Investigation](benchmarks/TBENCH_INVESTIGATION.md) | Earlier finding: no measurable UAP-context lift (every uncontrolled gain was a confound), methodology lessons |
| [Validation Results](benchmarks/VALIDATION_RESULTS.md) | Terminal-Bench 2.0 results (−49.7% tokens, +33pp success) |
| [Token Optimization](benchmarks/TOKEN_OPTIMIZATION.md) | Where the token savings come from |
| [Accuracy Analysis](benchmarks/ACCURACY_ANALYSIS.md) | Success-rate and error analysis |
| [Comprehensive Benchmarks](benchmarks/COMPREHENSIVE_BENCHMARKS.md) | Extended measurements |

## Analysis

Dated, strategy-level reads of the market UAP operates in. For the evergreen
feature-level comparison, see [Comparison](reference/COMPARISON.md).

| Doc | What it covers |
|---|---|
| [Market Position & Competitive Analysis (2026-09)](analysis/MARKET_POSITION.md) | The 2026 agentic-delivery market, UAP's category (agent discipline layer), competitive dynamics per adjacent category, moats, honest weaknesses, and strategic options |

## Plans & post-mortems

Working documents that explain *why* the code looks the way it does — kept as
the decision record.

| Doc | What it covers |
|---|---|
| [Deliver hardening plan](plans/deliver-hardening-plan-2026-07-13.md) | The 14-defect audit (batches A–D) that became v1.224.0: scoped rollback, declared gates, polyglot execution, config routing, liveness, operator overrides |
| [Deliver hardening review response](plans/deliver-hardening-review-response-2026-07-13.md) | Parallel-review findings and their dispositions — the rationale behind the root-owned trust model |
| [Harness engineering uplift](plans/harness-engineering-uplift-2026-07-31.md) | Three-paper analysis of harness variance and what UAP does about it |
| [K3 UAP uplift validation](plans/k3-uap-uplift-validation.md) | Plan to measure UAP's paired uplift on Kimi K3 by re-running Terminal-Bench 2.1 with Factory Droid as the harness, UAP on vs off |
| [Qwen3.8 UAP re-test plan](plans/qwen38-uap-retest-plan.md) | Plan to re-run the paired benchmark matrix on the current local Qwen3.8-27B stack with UAP v1.224.x, replicating the +20pp gate-loop finding and checking the hardened deliver pipeline |
| [System-1 uplift plan](plans/system1-uplift-2026-09-18.md) | Approved uplift from the 2026-09-18 ten-source analysis (Jev/Foreman/Fluent/CEK et al): Wave 0 quick wins + Wave 1 System-1 decision layer, local-only classifier trained from UAP telemetry |

## Specs & performance

| Doc | What it covers |
|---|---|
| [P0 anti-vacuous spec](specs/p0-anti-vacuous.md) | The verbatim-operations spec behind deliver's anti-stub hardening |
| [Dashboard uplift spec](DASHBOARD_UPLIFT_SPEC.md) | Replacing the monolithic dashboard with the modular token-locked console |
| [Performance baseline](performance/baseline-2026-03-27.json) | Machine-recorded perf baseline (heap, query latency) |
| [Reliability ladder](performance/reliability-ladder.md) | Measured technique-selection table for the decision loop; `npm run bench:ladder` regenerates it from `benchmark-results/` |

## Contributing

See [CONTRIBUTING.md](../CONTRIBUTING.md) for dev setup, the worktree workflow, completion gates, and PR conventions.

## Attribution

See [ATTRIBUTION.md](ATTRIBUTION.md) for the research papers, community write-ups, and open-source projects whose ideas UAP implements — and the convention for crediting new inspirations.
