<div align="center">

# Universal Agent Protocol (UAP)

**The discipline layer that turns a talented but unreliable AI coding agent into a dependable member of your software delivery line.**

[![npm](https://img.shields.io/npm/v/@miller-tech/uap?color=blue&label=npm)](https://www.npmjs.com/package/@miller-tech/uap)
[![Node](https://img.shields.io/node/%3E%3D18-brightgreen)](https://nodejs.org)
[![Tests](https://img.shields.io/badge/tests-500%2B_suites-brightgreen)](#testing)
[![License](https://img.shields.io/badge/license-MIT-black)](LICENSE)

454 TypeScript modules across 35 subsystems · 548 vitest suites (~6,450 tests) plus a 1,490-test Python enforcer and proxy suite · 9 agent harnesses

[Quickstart](#quickstart) · [Why UAP?](#why-uap) · [Origin & principle](#origin--principle) · [The delivery pipeline](docs/guides/DELIVERY_PIPELINE.md) · [`uap deliver`](#the-deliver-harness) · [Docs](docs/INDEX.md)

</div>

---

## Origin & principle

UAP is a **Miller-Tech** tool built for real delivery floors. It targets the failures that keep coming back in agentic development: "done" code that never ran, edits on `main`, forgotten decisions, architecture rules written in prose that blocked nothing, and agents that stall on every question or quietly decide for you.

The fix that works, every time, is the same one. **Turn the software-engineering practice into an executable check the agent cannot route around. Enforce, don't suggest.**

That principle became UAP. It is a discipline layer that installs underneath the agent harness and puts a verification station at every point where agentic development actually breaks. The tool ships under its own gates (worktree isolation, parallel review, evidence-bound shipping), so it is the proof of its own thesis. Design decisions are recorded in the [ADR set](docs/architecture/OVERVIEW.md). Prior art and credits live in [docs/ATTRIBUTION.md](docs/ATTRIBUTION.md).

---

## Why UAP?

Shipping software with an AI agent is like running a small factory floor. Intent goes in one end. Working, verified, merged code should come out the other. In between are stations: understand the job, set up a bench, build it, check that it actually works, ship it. A jam at any station quietly ruins everything downstream.

Coding agents are capable but undisciplined line workers. They forget yesterday's shift, grab the wrong tool, build something that looks right, and stamp it "done" without ever plugging it in. They trip over the other workers on the floor. A smarter model does not fix this. It is a process problem, and UAP is the process. It sits underneath your agent harness (Claude Code, Factory, Cursor, OpenCode, and more) and puts a station at every point where the line usually breaks. No model change required.

| Where the line jams | What UAP puts there | What you get |
|---|---|---|
| Agent starts every session amnesiac | 4-tier memory with semantic recall and write-gates | It remembers your codebase and past decisions |
| Tool output floods the context window | MCP Router with tool hiding and output compression | Up to ~98% smaller payloads on big tool calls |
| "Looks right" but doesn't run | `uap deliver`, a loop against your real gates | Code that compiles, not a mock-up of it |
| Agent grades its own homework | Execution verify plus a separate acceptance judge | "Done" means verified done |
| Two agents clobber each other | Worktree isolation plus live file coordination | Conflict-free parallel work |
| "Guidelines" get ignored | Policy gates as executable hooks, not prose | Violations are blocked, not politely suggested |
| Same mistake, every session | Memory promotion and pattern learning | The floor gets better every run |
| The agent stalls on any question, or silently decides for you | Attention queue and AFK auto-decider | Asks are recorded with a safe default and work continues; unattended decisions are logged, never silent |
| Fast tasks idle behind slow siblings | Completion-triggered dispatch | A finished task's slot refills instantly, and dependents start the moment their last dependency settles |
| Plans the agent can't follow, so it guesses its own tooling | Plan readability gate and self-knowledge card | Legible plans; the agent answers "how do I X" from its own version-pinned card |

Take the full station-by-station tour: [The UAP Delivery Pipeline](docs/guides/DELIVERY_PIPELINE.md).

---

## Quickstart

```bash
# Install globally
npm install -g @miller-tech/uap

# One friendly, arrow-key guided setup in your project
cd your-project
uap setup
```

`uap setup` walks you through the whole line: memory, patterns, policy gates, model routing, multi-agent coordination, and the verification gates. It wires all of it into every agent session it detects. Take the defaults and you are one Enter away from a disciplined agent.

**How it runs from there: automatically.** When you use a coding agent (Claude Code, Factory, Cursor, OpenCode, Codex, and the other [supported harnesses](docs/reference/PLATFORMS.md)), you never drive UAP by hand. The hooks `uap setup` installed fire on the agent's own tool calls: memory is recalled before work starts and written as the agent learns, edits are forced into isolated worktrees, policy violations are blocked with exit 2 instead of suggested, large tool output is compressed, and "done" is judged by gates the agent cannot route around. You talk to your agent; UAP enforces underneath it.

The CLI is still there when you want it, for direct operator work: querying memory, driving `uap deliver` yourself, watching the dashboard, managing the local model fleet, and configuring the line.

```bash
uap memory query "how did we handle auth last time?"   # semantic recall
uap deliver "add rate limiting to the API"             # drive a model to verified completion
uap dashboard overview                                  # live task, agent, and memory state
```

---

## The `deliver` harness

The two stations that matter most are **Build** and **QC**, and `uap deliver` owns both. It runs a convergence loop that iterates a model against your project's real completion gates until the work is actually delivered: build passes, tests pass, lint is clean. Not until the model thinks it is done.

```bash
uap deliver "implement the password reset flow"
```

What happens under the hood:

1. **Explore, plan, apply.** The model proposes changes. The applier writes them safely; existing tests and gate configs are protected from being overwritten.
2. **Verify against real gates.** A verifier ladder runs your build, tests, and lint, and can execute the result (headless browser, vm-dom, or a child process) to prove it runs. Nothing is done until they are green.
3. **Critique and iterate.** Failures feed back as structured guidance, and the loop continues until the work is delivered.
4. **The generator is not the evaluator.** The check that signs off is deliberately not the model that wrote the code, so an agent cannot confirm its own success.
5. **Autonomy with a guidance channel.** The mission runs to completion without stopping to ask, and it still accepts operator guidance mid-flight.

It works with frontier models and with local models (llama.cpp, Qwen) served over the Anthropic Messages API. See [docs/guides/DELIVER.md](docs/guides/DELIVER.md).

The harness is built for shared floors. Rollback is scoped to the run's own write-set, so a shared-worktree rollback cannot revert another agent's work. Projects can declare extra gates in `delivery.gates[]`. The execution gate is polyglot (Python packages, native binaries). `delivery.model`, `routing`, and `criticality` in `.uap.json` steer model choice, and root-owned, expiring operator overrides cover emergencies.

---

## The line, station by station

| Station | The break it prevents | Key machinery |
|---|---|---|
| **Intake** | Amnesiac sessions, invented scope | [Memory](docs/guides/MEMORY.md), reactor injection, [DESIGN.md](DESIGN.md) |
| **Prep / routing** | Wrong approach, wrong-sized model | [Multi-model routing](docs/guides/MULTI_MODEL.md), [patterns](docs/reference/PATTERNS.md), [droids and skills](docs/guides/DROIDS_AND_SKILLS.md) |
| **Isolation** | Editing `main`, clobbering files | [Worktrees](docs/guides/WORKTREE_WORKFLOW.md), live file coordination, delivery gate |
| **Build** | Plausible-but-wrong code, stubs, empty output | [`uap deliver`](docs/guides/DELIVER.md), serving-layer recipes, [local-model guardrails](docs/guides/LOCAL_MODELS.md) |
| **QC / verify** | "Done" on code that never ran | Completion gates, `uap verify`, acceptance judge, generator ≠ evaluator |
| **Coordination** | Parallel agents colliding or deadlocking | [Coordination](docs/guides/COORDINATION.md), model-slot concurrency, [deploy batching](docs/guides/DEPLOY_BATCHING.md), attention queue (asks instead of stalls) |
| **Shipping** | Regressions, red CI, skipped version bumps | Worktree-to-PR flow, version gates, CI feedback watcher |
| **Feedback** | The same mistake every session | Memory promotion, pattern learning, session analysis |

Three pieces of machinery run the whole length of the floor. **Policy gates** are 34 executable enforcers that block non-compliant tool calls: worktree, test, schema-diff, expert-review, delivery-enforcement, quality-metrics, design-token, visual-verification, and more. The **quality-metrics gate** enforces deterministic complexity, coverage, and mutation budgets against a ratchet baseline, so standards can only tighten. The **MCP Router** keeps the context window lean. Full catalog: [docs/reference/FEATURES.md](docs/reference/FEATURES.md).

---

## Architecture

UAP installs hooks into your agent harness, then mediates every tool call through the memory, policy, and token-optimization layers. Think of it as a control booth over the whole line.

```
┌─────────────────────────────────────────────────────────────┐
│  Agent harnesses                                            │
│  Claude Code · Factory · Cursor · VSCode · OpenCode · …     │
└───────────────────────────┬─────────────────────────────────┘
                            │ hooks (PreToolUse / tool.execute.before)
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                       UAP CLI (uap)                         │
│  setup · memory · deliver · verify · review · worktree ·    │
│  policy · quality · plan · fidelity · interaction · task ·  │
│  coord · droids · model · mcp-router · proxy · supervise ·  │
│  orchestrator · self-harness · tune · design · principles · │
│  bench · doctor · classify …                                │
└──┬─────────┬──────────┬──────────┬──────────┬───────────────┘
   ▼         ▼          ▼          ▼          ▼
 Memory   Policy    MCP Router   Delivery   Coordination
 4 tiers  34 gates  compression  + verify   + deploy batch
```

- 76 top-level CLI commands plus subcommands, across 35 source subsystems and 454 TypeScript modules.
- Deep dive: [docs/architecture/OVERVIEW.md](docs/architecture/OVERVIEW.md) · protocol spec: [docs/architecture/PROTOCOL.md](docs/architecture/PROTOCOL.md).

---

## Benchmarks

The honest, controlled result (paired A/B: same model, same tasks, same seeds, only UAP toggled, with confidence intervals): **UAP's accuracy lift depends on whether the base agent already checks its own work at the QC station.**

| Baseline | UAP accuracy lift | |
|---|---|---|
| Agentic harness (self-tests) | **~0pp** (CI spans 0) | overhead only; the value is efficiency and coordination |
| Non-agentic single-shot model | **+20pp** (78% → 98%, 95% CI [+8, +32], p=0.008) | the gate loop repairs edge-case bugs |

That table is the pipeline thesis in one place: the more an agent skips the QC station on its own, the more UAP's gates are worth. Run it yourself with `uap bench paired --adapter raw --suite benchmarks/suites/real-gate-gated`. Full analysis: [docs/benchmarks/PAIRED_FINDINGS.md](docs/benchmarks/PAIRED_FINDINGS.md).

<details><summary>Earlier uncontrolled Terminal-Bench numbers (confounded; see the TBench investigation)</summary>

| Metric | Baseline | With UAP | Δ |
|---|---|---|---|
| Tokens consumed | 558,000 | 280,438 | **−49.7%** |
| Task success rate | 25% | 58% | **+33pp** |
| Errors per task | 1.17 | 0.42 | **−68%** |
| Wall-clock (total) | 618s | 266s | **−57%** |

</details>

Methodology, raw runs, and cost analysis: [docs/benchmarks/](docs/benchmarks/).

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

Install into every detected harness with `uap hooks install`. Audit coverage with `uap hooks doctor`. Matrix: [docs/reference/PLATFORMS.md](docs/reference/PLATFORMS.md).

---

## Documentation

| | |
|---|---|
| **[The Delivery Pipeline](docs/guides/DELIVERY_PIPELINE.md)** | The station-by-station tour. Start here for the big picture |
| **[ATTRIBUTION](docs/ATTRIBUTION.md)** | Prior art, inspirations, and credits |
| **[Getting Started](docs/getting-started/)** | Installation, quickstart, configuration |
| **[Guides](docs/guides/)** | deliver, memory, MCP router, worktrees, policies, multi-model, local models |
| **[Architecture](docs/architecture/)** | System overview and the UAP protocol |
| **[Reference](docs/reference/)** | CLI, API, patterns, database schema, platforms |
| **[Benchmarks](docs/benchmarks/)** | Methodology and results |
| **[Contributing](CONTRIBUTING.md)** | Dev setup, gates, conventions |

Start at the [documentation index](docs/INDEX.md).

---

## Testing

```bash
npm install
npm run build           # TypeScript compile
npm test                # vitest: 548 suites (~6,450 tests)
npm run test:enforcers  # Python enforcer + proxy suite (89 modules, ~1,490 tests)
npm run bench           # benchmark suite
```

Every ship is gated. `npm test` and `npm run build` must be green, the change must come from a worktree, and the version bump goes through `npm run version:patch|minor|major` (no manual edits). Details: [CONTRIBUTING.md](CONTRIBUTING.md).

---

## Acknowledgements

UAP implements ideas from published research and community engineering: the Atomic Task Graph paper ([arXiv 2607.01942](https://arxiv.org/abs/2607.01942)) behind the plan-validation and minimal-repair delivery uplifts, vLLM Semantic Router's serving-layer recipes, Anthropic's loop-engineering practices, and Google Labs' DESIGN.md, among others. Full credits and the attribution convention: [docs/ATTRIBUTION.md](docs/ATTRIBUTION.md).

## License

MIT © Miller Tech. See [LICENSE](LICENSE).
