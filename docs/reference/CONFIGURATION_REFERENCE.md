# UAP Configuration Reference

> **Generated from the settings registry** (`src/config/settings-registry.ts`) via `uap config docs`. Do not edit by hand — change the registry and regenerate.

Every UAP setting, what it does, its default, and a recommendation. Inspect and change any of these with **`uap config`**:

```bash
uap config list                 # all settings + current values
uap config explain <key>        # learn one setting
uap config set <key> <value>    # change it (.uap.json / .uap/proxy.env)
uap config doctor               # flag risky / sub-optimal settings
uap config wizard               # interactive expert configurator (also: uap setup --profile custom)
```

**Where each setting lives:** `json` settings persist to `.uap.json`; `proxy.env` settings persist to `.uap/proxy.env` (loaded by the inference proxy); `shell` settings are runtime environment variables read by the hooks/CLI.

## Categories

- [Delivery & enforcement](#delivery) — Whether coding routes through `uap deliver` and how hard the gates block.
- [Verification gates](#verification) — Proving generated code actually builds and runs before "done".
- [Model routing](#routing) — Which model handles planning, execution, and review.
- [Serving recipes & escalation](#recipes) — Confidence/fusion recipes and the judge model that grades a local model.
- [Memory](#memory) — Short-term recall, long-term semantic memory, and pattern RAG.
- [Concurrency & model slots](#concurrency) — How many agents/inference slots run in parallel before backpressure.
- [Multi-agent collaboration](#collaboration) — The shared coordination board and file-overlap protection.
- [Orchestrator & hands-free](#orchestration) — Long-task autonomy: decompose, resume, and loop-to-100%.
- [Reactor (auto-apply)](#reactor) — Per-prompt injection of the matching experts, skills, and patterns.
- [Design system](#design) — DESIGN.md interrogation and the hard token gate for UI work.
- [Worktree workflow](#worktree) — Branch-per-feature isolation and auto-cleanup.
- [Inference proxy tuning](#proxy) — Guardrails and context limits for a local model behind the proxy.
- [Dashboard](#dashboard) — The live analytics server and its mutation token.
- [Token & time optimization](#optimization) — Context budgets, caching, batching, and parallelism.
- [General](#general) — Project metadata and CLI behavior.

## Delivery & enforcement

<a id="delivery"></a>Whether coding routes through `uap deliver` and how hard the gates block.

### `delivery.enforcement`

| | |
|---|---|
| **Where** | `.uap.json` |
| **Type** | enum (block \| advisory \| off) |
| **Default** | `block` |

How the delivery gate treats a direct source edit outside `uap deliver`. `block` refuses it (exit 2), `advisory` warns but allows, `off` disables the gate. (The `UAP_ENFORCE_DELIVERY` env var overrides this at runtime.)

**Recommendation:** `block` for hands-free/local-model work so every change is gated and verified; `advisory` when a capable human/Opus is driving and you want warnings without friction.

### `delivery.localMode`

| | |
|---|---|
| **Where** | `.uap.json` |
| **Type** | enum (advisory \| deliver \| block) |
| **Default** | `advisory` |

How local-model sessions are routed through delivery. `deliver` runs builds through the convergence loop; `block` forbids raw edits; `advisory` warns.

**Recommendation:** `deliver` when a local model does the writing (routes it through the verified loop); `advisory` for exploratory work.

### `UAP_ENFORCE_DELIVERY`

| | |
|---|---|
| **Where** | shell env |
| **Type** | enum (block \| advisory \| off) |
| **Default** | `block` |

Runtime override of the delivery gate read by the hooks/enforcers from the shell env. Takes precedence over `delivery.enforcement`.

**Recommendation:** Leave UNSET so it defaults to `block`. Exporting `advisory` globally leaks into every shell and silently disables the gate + the delivery-enforcement tests — set it inline per-command if you must.

### `UAP_DELIVER_BYPASS`

| | |
|---|---|
| **Where** | shell env |
| **Type** | boolean |
| **Default** | `false` |

When set to 1 for a single command, exempts that one sanctioned manual edit from the delivery gate.

**Recommendation:** Use inline (`UAP_DELIVER_BYPASS=1 <cmd>`) for a one-off edit; never export it.

## Verification gates

<a id="verification"></a>Proving generated code actually builds and runs before "done".

### `delivery.runtimeVerify`

| | |
|---|---|
| **Where** | `.uap.json` |
| **Type** | boolean |
| **Default** | `false` |

Installs the runtime-verify Stop-hook: at end of turn it actually runs the changed code (headless / vm-dom / child-process) and blocks stopping on a genuine runtime failure.

**Recommendation:** Enable for any project with a runnable artifact — it catches "declared done but never ran". Safe on empty projects (it skips when nothing is runnable).

### `UAP_VERIFY_ON_STOP`

| | |
|---|---|
| **Where** | shell env |
| **Type** | boolean |
| **Default** | `true` |

Master switch for the runtime execution gate in the Stop hook. `0` bypasses it.

**Recommendation:** Leave on (default). Set `0` only to unblock a session where the runtime gate misfires.

## Model routing

<a id="routing"></a>Which model handles planning, execution, and review.

### `multiModel.enabled`

| | |
|---|---|
| **Where** | `.uap.json` |
| **Type** | boolean |
| **Default** | `false` |

Turns on multi-model routing (distinct planner/executor/reviewer models) instead of a single model for everything.

**Recommendation:** Enable to pair a cheap local executor with a strong cloud reviewer. Configure via `uap model routing use <preset>`.

### `multiModel.routingStrategy`

| | |
|---|---|
| **Where** | `.uap.json` |
| **Type** | enum (cost-optimized \| performance-first \| balanced \| adaptive) |
| **Default** | `balanced` |

How the router trades cost against capability when picking a model per task.

**Recommendation:** `cost-optimized` for local-first setups, `performance-first` for all-cloud hot paths, `balanced`/`adaptive` otherwise.

### `ANTHROPIC_PASSTHROUGH_MODELS`

| | |
|---|---|
| **Where** | `.uap/proxy.env` |
| **Type** | string |
| **Default** | `` |

Comma-separated model IDs the proxy forwards to Anthropic instead of serving locally. The sentinel `__local_only__` forces every model ID onto the local Qwen.

**Recommendation:** Set automatically by `uap model routing use`. Use `__local_only__` for a fully offline setup; list cloud IDs for a hybrid local+cloud routing preset.

## Serving recipes & escalation

<a id="recipes"></a>Confidence/fusion recipes and the judge model that grades a local model.

### `recipes.enabled`

| | |
|---|---|
| **Where** | `.uap.json` |
| **Type** | boolean |
| **Default** | `false` |

Enables serving-layer recipes (confidence escalation, fusion, ratings) in front of the local model.

**Recommendation:** Enable for a local model when you have a stronger judge model available — it materially lifts output quality.

### `recipes.recipe`

| | |
|---|---|
| **Where** | `.uap.json` |
| **Type** | enum (auto \| single \| confidence \| fusion \| ratings \| remom) |
| **Default** | `auto` |

Which recipe to apply. `confidence` escalates only low-confidence turns to the judge; `fusion` samples N and judges; `auto` picks per-signal.

**Recommendation:** `auto` is the safe default; `confidence` for the best cost/quality trade when the judge is expensive.

### `recipes.confidenceThreshold`

| | |
|---|---|
| **Where** | `.uap.json` |
| **Type** | number |
| **Default** | `0.5` |

Below this confidence, a turn is escalated to the judge model.

**Recommendation:** 0.5 to start; raise toward 0.7 to escalate more often (higher quality, higher cost).

### `recipes.fusionN`

| | |
|---|---|
| **Where** | `.uap.json` |
| **Type** | number |
| **Default** | `3` |

How many candidate samples the fusion recipe generates before the judge picks/merges.

**Recommendation:** 3 balances quality and cost; 5 for hard tasks if you can afford the samples.

### `recipes.allowSelfJudge`

| | |
|---|---|
| **Where** | `.uap.json` |
| **Type** | boolean |
| **Default** | `false` |

Allows the generating model to also act as its own judge (generator == evaluator).

**Recommendation:** Keep `false` — a distinct, stronger judge is what adds the lift. Only allow self-judge if no separate judge is available.

### `recipes.judge.model`

| | |
|---|---|
| **Where** | `.uap.json` |
| **Type** | string |
| **Default** | `null` |

The model ID used to grade/escalate. Must be distinct from and stronger than the executor to help.

**Recommendation:** Point at your strongest available model (e.g. an Opus/Sonnet cloud ID) even if the executor is local.

### `PROXY_ESCALATE_API_KEY`

| | |
|---|---|
| **Where** | `.uap/proxy.env` |
| **Type** | string |
| **Default** | `null` |
| **Secret** | yes — never store in `.uap.json` |

API key for the judge/escalation model endpoint.

**Recommendation:** Store only in `.uap/proxy.env` (chmod 600) — never in `.uap.json`. `uap config set` writes it there.

## Memory

<a id="memory"></a>Short-term recall, long-term semantic memory, and pattern RAG.

### `memory.longTerm.enabled`

| | |
|---|---|
| **Where** | `.uap.json` |
| **Type** | boolean |
| **Default** | `true` |

Enables long-term semantic memory (vector recall across sessions) via Qdrant.

**Recommendation:** Keep on — cross-session recall is a core value. Requires a running Qdrant (`uap memory start`).

### `memory.longTerm.provider`

| | |
|---|---|
| **Where** | `.uap.json` |
| **Type** | enum (qdrant \| chroma \| pinecone \| github \| qdrant-cloud \| serverless \| none) |
| **Default** | `qdrant` |

The long-term memory backend.

**Recommendation:** `qdrant` (local) for privacy/speed; `qdrant-cloud` or `github` if you want memory to follow you across machines.

### `memory.shortTerm.maxEntries`

| | |
|---|---|
| **Where** | `.uap.json` |
| **Type** | number |
| **Default** | `50` |

How many recent short-term entries are retained/injected per session.

**Recommendation:** 50 is a good default; raise for long, context-heavy sessions if token budget allows.

### `memory.patternRag.enabled`

| | |
|---|---|
| **Where** | `.uap.json` |
| **Type** | boolean |
| **Default** | `false` |

Enables pattern RAG — semantic retrieval of the 23 execution patterns to steer the agent.

**Recommendation:** Enable for local models (patterns compensate for weaker planning); optional for frontier models.

### `QDRANT_URL`

| | |
|---|---|
| **Where** | shell env |
| **Type** | string |
| **Default** | `http://localhost:6333` |

Qdrant endpoint for long-term/pattern memory.

**Recommendation:** Leave default for local Qdrant; point at your cloud cluster URL for `qdrant-cloud`.

### `QDRANT_API_KEY`

| | |
|---|---|
| **Where** | shell env |
| **Type** | string |
| **Default** | `null` |
| **Secret** | yes — never store in `.uap.json` |

API key for a cloud Qdrant cluster.

**Recommendation:** Only needed for `qdrant-cloud`. Keep it in your shell env / secret store, not in `.uap.json`.

## Concurrency & model slots

<a id="concurrency"></a>How many agents/inference slots run in parallel before backpressure.

### `modelConcurrency.slots`

| | |
|---|---|
| **Where** | `.uap.json` |
| **Type** | number |
| **Default** | `null` |

How many inference slots the local server exposes; the lease system caps parallel agents to this.

**Recommendation:** Set to your llama.cpp `--parallel` value so fan-out never exhausts the server. Leave null to auto-probe.

### `modelConcurrency.headroom`

| | |
|---|---|
| **Where** | `.uap.json` |
| **Type** | number |
| **Default** | `null` |

Slots to hold back from the budget so the interactive session never starves behind background agents.

**Recommendation:** Reserve 1 on small servers so foreground work stays responsive.

### `modelConcurrency.adaptive`

| | |
|---|---|
| **Where** | `.uap.json` |
| **Type** | boolean |
| **Default** | `true` |

AIMD backpressure: shrinks the effective slot budget on exhaustion signals (429/timeouts) and recovers over time.

**Recommendation:** Keep on — it prevents overload cascades when many agents run at once.

### `UAP_MAX_PARALLEL`

| | |
|---|---|
| **Where** | shell env |
| **Type** | number |
| **Default** | `4` |

Upper bound on parallel agent/tool fan-out regardless of slot budget.

**Recommendation:** Match to CPU/GPU capacity; 4 is a safe default, lower it on constrained hosts.

## Multi-agent collaboration

<a id="collaboration"></a>The shared coordination board and file-overlap protection.

### `collaboration.mode`

| | |
|---|---|
| **Where** | `.uap.json` |
| **Type** | enum (auto \| always \| off) |
| **Default** | `auto` |

The shared coordination board + live file-overlap protection. `always` injects the board every turn; `auto` only when peers are active; `off` disables it.

**Recommendation:** `auto` for solo work, `always` when multiple agents/worktrees run concurrently so they compound instead of colliding.

### `coordination.deployBatching`

| | |
|---|---|
| **Where** | `.uap.json` |
| **Type** | boolean |
| **Default** | `true` |

Batches git/deploy actions across agents to avoid conflicting concurrent pushes.

**Recommendation:** Keep on for multi-agent setups.

## Orchestrator & hands-free

<a id="orchestration"></a>Long-task autonomy: decompose, resume, and loop-to-100%.

### `handsfree.enabled`

| | |
|---|---|
| **Where** | `.uap.json` |
| **Type** | boolean |
| **Default** | `false` |

Forces any model to keep working until a multi-epic completion ledger is 100% done, instead of stopping early.

**Recommendation:** Enable for large autonomous builds; leave off for interactive/exploratory sessions.

### `handsfree.intensity`

| | |
|---|---|
| **Where** | `.uap.json` |
| **Type** | enum (gentle \| normal \| aggressive) |
| **Default** | `normal` |

How hard hands-free pushes back against early stops before the ledger is complete.

**Recommendation:** `normal` for most work; `aggressive` for unattended overnight runs; `gentle` if the model over-persists on dead ends.

### `UAP_HANDSFREE_STAGNATION_LIMIT`

| | |
|---|---|
| **Where** | shell env |
| **Type** | number |
| **Default** | `8` |

Consecutive no-progress turns before hands-free breaks the loop instead of pushing on.

**Recommendation:** Lower (e.g. 5) if runs waste turns stuck; raise for genuinely long-horizon tasks.

## Reactor (auto-apply)

<a id="reactor"></a>Per-prompt injection of the matching experts, skills, and patterns.

### `reactor.enabled`

| | |
|---|---|
| **Where** | `.uap.json` |
| **Type** | boolean |
| **Default** | `true` |

Per-prompt injection of the experts, skills, and patterns that match what you just asked — so relevant capability is on the bench before the agent starts.

**Recommendation:** Keep on. Disable only to debug prompt bloat or measure the reactor's own contribution.

## Design system

<a id="design"></a>DESIGN.md interrogation and the hard token gate for UI work.

### `design.enabled`

| | |
|---|---|
| **Where** | `.uap.json` |
| **Type** | boolean |
| **Default** | `false` |

Turns on DESIGN.md: the agent interrogates and lints UI work against your design brief.

**Recommendation:** Enable for any project with a UI so design work starts from intent, not a guess.

### `design.tokenGate`

| | |
|---|---|
| **Where** | `.uap.json` |
| **Type** | boolean |
| **Default** | `false` |

Hard-blocks UI edits that hardcode off-token colors or off-scale spacing.

**Recommendation:** Enable once your DESIGN.md tokens are stable — it keeps the UI on-system automatically.

## Worktree workflow

<a id="worktree"></a>Branch-per-feature isolation and auto-cleanup.

### `worktrees.enabled`

| | |
|---|---|
| **Where** | `.uap.json` |
| **Type** | boolean |
| **Default** | `true` |

Branch-per-feature isolation: edits happen in `.worktrees/NNN-slug/`, never the working tree, with auto-PR.

**Recommendation:** Keep on for any team or multi-agent workflow; it is the safety net against clobbering `main`.

### `worktrees.branchPrefix`

| | |
|---|---|
| **Where** | `.uap.json` |
| **Type** | string |
| **Default** | `feature/` |

Prefix for auto-created worktree branches.

**Recommendation:** Match your team's branch convention (e.g. `feat/`, `fix/`).

### `worktrees.autoCleanup`

| | |
|---|---|
| **Where** | `.uap.json` |
| **Type** | boolean |
| **Default** | `true` |

Removes a worktree automatically once its branch is merged/unchanged.

**Recommendation:** Keep on to avoid a pile of stale worktrees.

## Inference proxy tuning

<a id="proxy"></a>Guardrails and context limits for a local model behind the proxy.

### `PROXY_CONTEXT_WINDOW`

| | |
|---|---|
| **Where** | `.uap/proxy.env` |
| **Type** | number |
| **Default** | `65536` |

The context window the proxy advertises/enforces for the local model. Must match the server's KV allocation.

**Recommendation:** Set to your llama.cpp per-slot context size. Too high overflows KV; too low truncates history.

### `PROXY_CONCURRENCY_LIMIT`

| | |
|---|---|
| **Where** | `.uap/proxy.env` |
| **Type** | number |
| **Default** | `null` |

Max concurrent upstream generations the proxy admits before queuing.

**Recommendation:** Match to the server's parallel slots so the proxy queues instead of overloading the model.

### `PROXY_LOOP_BREAKER`

| | |
|---|---|
| **Where** | `.uap/proxy.env` |
| **Type** | boolean |
| **Default** | `true` |

Breaks no-progress generation loops by forcing a single non-streaming call.

**Recommendation:** Keep on for local models — it is a core reliability guardrail.

### `PROXY_STUCK_BREAK`

| | |
|---|---|
| **Where** | `.uap/proxy.env` |
| **Type** | boolean |
| **Default** | `true` |

When the model self-reports "stuck" but keeps repeating the same failing tool, releases it to a prose exit.

**Recommendation:** Keep on for local models; harmless for cloud models (rarely triggers).

### `PROXY_RECON_CONVERGENCE_THRESHOLD`

| | |
|---|---|
| **Where** | `.uap/proxy.env` |
| **Type** | number |
| **Default** | `40` |

After this many read-only (no-write) turns, the proxy forces synthesis/`deliver` so the model stops exploring forever.

**Recommendation:** 40 is balanced; lower it (e.g. 20) if local sessions over-explore before writing.

### `PROXY_RECIPE`

| | |
|---|---|
| **Where** | `.uap/proxy.env` |
| **Type** | enum (auto \| single \| confidence \| fusion \| ratings \| remom) |
| **Default** | `auto` |

The serving recipe the proxy applies (mirror of `recipes.recipe`, consumed by the proxy process).

**Recommendation:** Keep in sync with `recipes.recipe`; `uap setup`/`uap config` write both.

### `realtimeAdapt.enabled`

| | |
|---|---|
| **Where** | `.uap.json` |
| **Type** | boolean |
| **Default** | `true` |

Real-time flag adaptation (LLM Self-Tuning P4): the reactor emits per-session adjustments from live signals (tool-failure/quality/context/RECON) so the proxy can escalate or converge mid-session. This is the effective master switch — off means no signal is emitted.

**Recommendation:** Leave on. It is conservative (emits only when a live signal breaches a threshold) and is the effective master switch — disabling it turns the whole feature off regardless of the proxy side.

### `PROXY_REALTIME_ADAPT`

| | |
|---|---|
| **Where** | `.uap/proxy.env` |
| **Type** | boolean |
| **Default** | `true` |

Proxy side of real-time adaptation: whether the serving proxy honors a fresh adaptation signal per request. Auto-on; harmless when no emitter is running (no signal to honor).

**Recommendation:** Leave on. Set `false` only to make the proxy ignore adaptation signals even when the reactor emits them.

## Dashboard

<a id="dashboard"></a>The live analytics server and its mutation token.

### `UAP_DASHBOARD_TOKEN`

| | |
|---|---|
| **Where** | shell env |
| **Type** | string |
| **Default** | `null` |
| **Secret** | yes — never store in `.uap.json` |

The token required for dashboard policy-mutation routes (enable/disable/stage/level). Read routes stay open.

**Recommendation:** Set a strong token if the dashboard binds beyond localhost (`--host 0.0.0.0`); otherwise a generated per-session token is used.

### `UAP_DASH_REFRESH_MS`

| | |
|---|---|
| **Where** | shell env |
| **Type** | number |
| **Default** | `2000` |

Dashboard data refresh interval in milliseconds (floor 250).

**Recommendation:** 2000 is fine; lower for a more live feel at higher CPU cost.

## Token & time optimization

<a id="optimization"></a>Context budgets, caching, batching, and parallelism.

### `costOptimization.enabled`

| | |
|---|---|
| **Where** | `.uap.json` |
| **Type** | boolean |
| **Default** | `true` |

Enables token budgets, response caching, and embedding batching to cut token spend.

**Recommendation:** Keep on — it is free savings with no quality cost.

### `timeOptimization.parallelExecution.maxParallelDroids`

| | |
|---|---|
| **Where** | `.uap.json` |
| **Type** | number |
| **Default** | `4` |

Max expert droids run in parallel during a task.

**Recommendation:** Match to host capacity; 4 is a safe default.

## General

<a id="general"></a>Project metadata and CLI behavior.

### `project.defaultBranch`

| | |
|---|---|
| **Where** | `.uap.json` |
| **Type** | string |
| **Default** | `main` |

The branch PRs target and worktrees branch from.

**Recommendation:** Set to your repo's default branch (`main` or `master`).

### `UAP_NO_SELF_UPDATE`

| | |
|---|---|
| **Where** | shell env |
| **Type** | boolean |
| **Default** | `false` |

Disables the automatic global-CLI version check/self-update on `uap setup`.

**Recommendation:** Set in CI or pinned environments where you manage the UAP version yourself.

---

*Not every environment variable UAP reads is a first-class setting — the inference proxy alone exposes ~130 `PROXY_*` tuning knobs. The registry surfaces the high-impact, commonly-tuned ones; see the proxy source (`tools/agents/scripts/anthropic_proxy.py`) for the full set.*
