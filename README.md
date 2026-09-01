<div align="center">

# Universal Agent Protocol (UAP)

**The discipline layer that turns a talented-but-unreliable AI coding agent into a dependable member of your software delivery line.**

[![npm](https://img.shields.io/npm/v/@miller-tech/uap?color=blue&label=npm)](https://www.npmjs.com/package/@miller-tech/uap)
[![Node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)
[![Tests](https://img.shields.io/badge/tests-450%2B_suites-brightgreen)](#testing)
[![License](https://img.shields.io/badge/license-MIT-black)](LICENSE)

`v1.224.0` · 367 TypeScript modules across 26 subsystems · 459 vitest suites (+ a ~1,200-test Python enforcer/proxy suite) · 9 agent harnesses

[Quickstart](#quickstart) · [Why UAP?](#why-uap) · [The delivery pipeline](docs/guides/DELIVERY_PIPELINE.md) · [`uap deliver`](#the-deliver-harness) · [Docs](docs/INDEX.md)

</div>

---

## Why UAP?

Shipping software with an AI agent is a lot like running a small factory floor. Intent comes in one end; working, verified, merged code should come out the other. In between are stations — understand the job, set up a bench, build it, **check it actually works**, ship it — and a jam at any one of them quietly ruins everything downstream.

Coding agents are capable but undisciplined line workers. They forget yesterday's shift, grab the wrong tool, build something that *looks* right, stamp it "done" without plugging it in, and trip over the other workers on the floor. That's not a problem you fix by swapping in a smarter model — it's a *process* problem. UAP is the process: it sits **underneath your agent harness** (Claude Code, Factory, Cursor, OpenCode, and more) and puts a station at every point where the line usually breaks — no model change required.

| Where the line jams | What UAP puts there | What you get |
|---|---|---|
| Agent starts every session amnesiac | 4-tier memory with semantic recall + write-gates | It remembers your codebase and past decisions |
| Tool output floods the context window | MCP Router — tool-hiding + output compression | Up to **~98%** smaller on big tool calls |
| "Looks right" but doesn't run | `uap deliver` — a loop against your **real** gates | Code that compiles, not a mock-up of it |
| Agent grades its own homework | Execution/runtime verify + a separate acceptance judge | "Done" means *verified* done |
| Two agents clobber each other | Worktree isolation + live file coordination | Conflict-free parallel work |
| "Guidelines" get ignored | Policy gates as executable hooks, not prose | Violations are **blocked**, not politely suggested |
| Same mistake, every session | Memory promotion + pattern learning | The floor gets better every run |

**→ Take the full station-by-station tour: [The UAP Delivery Pipeline](docs/guides/DELIVERY_PIPELINE.md).**

---

## Quickstart

```bash
# Install globally
npm install -g @miller-tech/uap

# One friendly, arrow-key guided setup in your project
cd your-project
uap setup
```

`uap setup` walks you through the whole line — memory, patterns, policy gates, model routing, multi-agent coordination, and the verification gates — and wires it into every agent session. Take the defaults and you're one Enter away from a disciplined agent.

```bash
uap memory query "how did we handle auth last time?"   # semantic recall
uap deliver "add rate limiting to the API"             # drive a model to verified completion
uap dashboard overview                                  # live task / agent / memory state
```

---

## The `deliver` harness

The two stations that matter most are **Build** and **QC**, and `uap deliver` owns both. It's a **convergence loop that iterates a model against your project's real completion gates until the work is actually delivered** — build passes, tests pass, lint is clean — not until the model *thinks* it's done.

```bash
uap deliver "implement the password reset flow"
```

What happens under the hood:

1. **Explore → plan → apply** — the model proposes changes; the applier writes them safely (existing tests and gate configs are protected from being overwritten).
2. **Verify against real gates** — a verifier ladder runs your build, tests, and lint, and can *execute* the result (headless browser / vm-dom / child process) to prove it runs. Nothing is "done" until they're green.
3. **Critique & iterate** — failures feed back as structured guidance and the loop continues, persisting until delivered.
4. **Generator ≠ evaluator** — the check that signs off is deliberately not the model that wrote the code, so an agent can't confirm its own success.
5. **Autonomy with a guidance channel** — runs the full mission without stopping to ask, while still accepting operator guidance mid-flight.

It works with frontier models *and* local models (llama.cpp / Qwen) served over the Anthropic Messages API. See **[docs/guides/DELIVER.md](docs/guides/DELIVER.md)**.

Hardened for shared floors (v1.224): rollback is scoped to the run's own write-set (a shared-worktree rollback can't revert another agent's work), projects can declare extra gates in `delivery.gates[]`, the execution gate is polyglot (Python packages, native binaries), and `delivery.model`/`routing`/`criticality` in `.uap.json` steer model choice — with root-owned, expiring operator overrides for emergencies.

---

## The line, station by station

| Station | The break it prevents | Key machinery |
|---|---|---|
| **Intake** | Amnesiac sessions, invented scope | [Memory](docs/guides/MEMORY.md), reactor injection, [DESIGN.md](DESIGN.md) |
| **Prep / routing** | Wrong approach, wrong-sized model | [Multi-model routing](docs/guides/MULTI_MODEL.md), [patterns](docs/reference/PATTERNS.md), [droids & skills](docs/guides/DROIDS_AND_SKILLS.md) |
| **Isolation** | Editing `main`, clobbering files | [Worktrees](docs/guides/WORKTREE_WORKFLOW.md), live file coordination, delivery gate |
| **Build** | Plausible-but-wrong code, stubs, empty output | [`uap deliver`](docs/guides/DELIVER.md), serving-layer recipes, [local-model guardrails](docs/guides/LOCAL_MODELS.md) |
| **QC / verify** | "Done" on code that never ran | Completion gates, `uap verify`, acceptance judge, generator≠evaluator |
| **Coordination** | Parallel agents colliding/deadlocking | [Coordination](docs/guides/COORDINATION.md), model-slot concurrency, [deploy batching](docs/guides/DEPLOY_BATCHING.md) |
| **Shipping** | Regressions, red CI, skipped version bumps | Worktree→PR flow, version gates, CI feedback watcher |
| **Feedback** | The same mistake every session | Memory promotion, pattern learning, session analysis |

Running the whole length of the floor: **policy gates** (32 executable enforcers that *block* non-compliant tool calls — worktree, test, schema-diff, expert-review, delivery-enforcement, quality-metrics, design-token, visual-verification…), the **quality-metrics gate** (deterministic complexity/coverage/mutation budgets with a ratchet baseline, so standards can only tighten), and the **MCP Router** (keeps the context window lean). Full catalog: **[docs/reference/FEATURES.md](docs/reference/FEATURES.md)**.

---

## Architecture

UAP installs hooks into your agent harness, then mediates every tool call through the memory, policy, and token-optimization layers — a control booth over the whole line.

```
┌─────────────────────────────────────────────────────────────┐
│  Agent harnesses                                            │
│  Claude Code · Factory · Cursor · VSCode · OpenCode · …     │
└───────────────────────────┬─────────────────────────────────┘
                            │ hooks (PreToolUse / tool.execute.before)
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                       UAP CLI (uap)                         │
│  setup · memory · deliver · verify · worktree · policy      │
│  quality · plan · fidelity · interaction · task · coord ·   │
│  droids · model · mcp-router · proxy · orchestrator ·       │
│  self-harness · tune · design · principles · bench …        │
└──┬─────────┬──────────┬──────────┬──────────┬───────────────┘
   ▼         ▼          ▼          ▼          ▼
 Memory   Policy    MCP Router   Delivery   Coordination
 4 tiers  32 gates  compression  + verify   + deploy batch
```

- **60 CLI commands** across 26 source subsystems (367 TypeScript modules).
- Deep dive: **[docs/architecture/OVERVIEW.md](docs/architecture/OVERVIEW.md)** · protocol spec: **[docs/architecture/PROTOCOL.md](docs/architecture/PROTOCOL.md)**.

---

## Benchmarks

The honest, controlled result (paired A/B — same model, tasks, and seeds, toggling only UAP, with confidence intervals): **UAP's accuracy lift depends on whether the base agent already checks its own work at the QC station.**

| Baseline | UAP accuracy lift | |
|---|---|---|
| Agentic harness (self-tests) | **~0pp** (CI spans 0) | overhead only — value is efficiency/coordination |
| Non-agentic single-shot model | **+20pp** (78%→98%, 95% CI [+8,+32], p=0.008) | gate loop repairs edge-case bugs |

That's the pipeline thesis in one table: the more an agent skips the QC station on its own, the more UAP's gates are worth. Run it yourself: `uap bench paired --adapter raw --suite benchmarks/suites/real-gate-gated`. Full analysis: **[docs/benchmarks/PAIRED_FINDINGS.md](docs/benchmarks/PAIRED_FINDINGS.md)**.

<details><summary>Earlier uncontrolled Terminal-Bench numbers (confounded — see TBench Investigation)</summary>

| Metric | Baseline | With UAP | Δ |
|---|---|---|---|
| Tokens consumed | 558,000 | 280,438 | **−49.7%** |
| Task success rate | 25% | 58% | **+33pp** |
| Errors per task | 1.17 | 0.42 | **−68%** |
| Wall-clock (total) | 618s | 266s | **−57%** |

</details>

Methodology, raw runs, and cost analysis: **[docs/benchmarks/](docs/benchmarks/)**.

---

## Supported harnesses

Same line, whichever floor you code on.

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
| **[The Delivery Pipeline](docs/guides/DELIVERY_PIPELINE.md)** | The station-by-station tour — start here for the big picture |
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
npm run build           # TypeScript compile
npm test                # vitest — 459 suites (~5,000 tests)
npm run test:enforcers  # Python policy-enforcer suite (~1,200 tests)
npm run bench           # benchmark suite
```

Every ship is gated: `npm test` and `npm run build` must be green, the change
must come from a worktree, and the version bump goes through
`npm run version:patch|minor|major` (no manual edits). Details:
[CONTRIBUTING.md](CONTRIBUTING.md).

---

## Acknowledgements

UAP implements ideas from published research and community engineering — the
Atomic Task Graph paper ([arXiv 2607.01942](https://arxiv.org/abs/2607.01942))
behind the plan-validation/minimal-repair delivery uplifts, vLLM Semantic
Router's serving-layer recipes, Anthropic's loop-engineering practices, and
Google Labs' DESIGN.md, among others. Full credits and the attribution
convention: [docs/ATTRIBUTION.md](docs/ATTRIBUTION.md).

## License

MIT © Miller Tech. See [LICENSE](LICENSE).
