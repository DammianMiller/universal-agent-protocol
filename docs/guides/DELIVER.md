# `uap deliver` — the delivery harness

> **🏭 Where this fits:** BUILD + QC/VERIFY — the two stations where a normal agentic workflow breaks hardest. Your agent writes plausible-but-wrong code (or empty, looping local-model output), then declares "done" on something that never compiled. **What it delivers:** a convergence loop that keeps working the code against your project's *real* gates — build, tests, lint, integration, even a dev deploy — and refuses to call it finished until they actually pass.

`uap deliver` drives a model through a **convergence loop that iterates against your project's real completion gates until the work is actually delivered** — build green, tests passing, lint clean — not until the model *claims* it's done.

Think of it as the quality-control station on your [delivery pipeline](./DELIVERY_PIPELINE.md): raw code goes in, and nothing leaves the line until it has been inspected against the real definition of done. It is UAP's answer to "the agent said it finished, but nothing compiles." Instead of a single shot, `deliver` runs an execute → verify → critique → iterate loop, feeding real gate failures back to the model and persisting until the gates pass or the run provably stalls.

```bash
uap deliver "implement the password reset flow"
```

---

## How it works

The loop lives in `src/delivery/` (15 modules). Each turn:

1. **Explore & plan** — the model reads the relevant code and proposes a change. With best-of-N exploration enabled, several candidate approaches are generated and the most promising is taken (`explorer.ts`).
2. **Apply** — the applier writes the proposed file changes (`applier.ts`). Pre-existing test files, gate configs, and the transitive imports of your spec files are **protected from being overwritten by default** — the model cannot "pass" by editing the tests. A runtime integrity guard hashes protected files and rejects tampering (`integrity.ts`, `spec-imports.ts`).
3. **Verify** — the verifier ladder runs your real gates — build, typecheck, test, lint — and scores the turn (`verifier-ladder.ts`). Nothing counts as delivered until the required gates are green.
4. **Critique & feed back** — failures are turned into structured guidance for the next turn (`critic.ts`); learned best-practice cards can be injected and recorded on success (`practice.ts`).
5. **Iterate until delivered** — the loop continues. By default it **extends past `--max-turns` up to a ceiling**, stopping early only on genuine stagnation (no score improvement across several turns). On stagnation with `--escalate`, it widens exploration, adds a critic pass, and finally escalates to a stronger model (`escalation.ts`).

```
        ┌──────────── guidance file (optional) ───────────┐
        ▼                                                  │
  explore → apply → verify (build/test/lint) → critique ──┘
     ▲                        │
     └──── until delivered ◄──┘   (stops on green gates or stagnation)
```

---

## Autonomy

`deliver` runs the **whole mission without stopping to ask between phases**. It still reports progress, and you can steer it live through a guidance channel:

```bash
uap deliver "migrate the auth module to JWT" --guidance-file ./guidance.txt
# in another shell, append guidance at any time — the loop polls it each turn:
echo "prefer RS256 and keep the existing /login route" >> ./guidance.txt
```

For **huge, multi-epic builds**, `deliver` goes further: it decomposes the
mission into a task DAG (the **blackboard orchestrator**, minimal fresh context
per task) and, for epic-scale work, loops whole **epics as fresh sessions**
until each is accepted. Combined with **hands-free persistence**, any model —
local or frontier — runs the build to 100% without stopping. See
**[The Orchestrator & Hands-Free Persistence](ORCHESTRATOR.md)**.

---

## Big builds: decompose → orchestrate → epics → contracts-first

For a mission too large to hold in one context, `deliver` scales down the context each turn actually needs — this is what lets a small-context local model compose a system it could never see all at once.

- **`--decompose`** splits the mission into sequential phases, each converged by its own loop (auto for long, complex instructions; `--no-decompose` forbids it).
- **`--orchestrate`** runs those phases through the **blackboard orchestrator** with *minimal* per-task context — each task sees only its goal + its direct-dependency outputs. Implies `--decompose`.
- **`--epics`** runs a massive mission as a sequence of **epics, each a fresh session** — only prior epics' summaries are injected, never their full code — looped until each is accepted (auto for very long missions; `--no-epics` disables).

**Contracts-first** (on by default inside epic/decompose runs; `UAP_DELIVER_CONTRACTS=0` disables): the first epic plans the shared types, interfaces, and registry APIs the rest build against. Once accepted, its files are **locked read-only** so later epics build against frozen signatures and can't drift them. The public surface is *extracted and verified against emitted source* — only names proven present are recorded — which is what makes cross-module composition reliable without holding every module in context.

**Scaffold-then-fill** (on by default in phased runs; `UAP_DELIVER_SCAFFOLD=0` disables): a large phase is split into a **scaffold** phase that emits the compiling skeleton (complete public signatures, wired imports/exports, stub bodies — build/typecheck must pass) and a **fill** phase that implements the logic *without changing any signature*. The skeleton keeps the build green while the details land.

Interrupted a long run? **`--resume <id|latest>`** picks up a durable run from `.uap/deliver-runs` where it left off.

---

## Auto-optimization

By default every task is **classified by complexity** and the matching convergence aids turn on automatically (`auto-optimizer.ts`). You don't have to tune anything for the common case. To control it explicitly:

```bash
uap deliver "big refactor across modules" --optimize   # enable every aid
uap deliver "trivial typo fix"           --no-auto     # disable dynamic optimization
```

`--optimize` enables exploration, critic, practices, escalation, ideation, HALO spans, and coordination together. It also turns on the local **integration** and **deploy-dev** gate tiers (below); the commit/push boundary (`--watch-ci`) stays opt-in.

---

## Tiered validation gates (cheap-first)

Real delivery is more than unit tests — it also has to integrate and deploy. `deliver` groups gates into **tiers** and runs them **cheapest-first**, only promoting to the next, more expensive tier once the prior one is green:

```
fast → integration → deploy-dev → │ commit │ → ci → deploy-staging → deploy-prod
└──────── run locally ───────────┘          └──── verified by CI (the watcher) ────┘
```

- **`fast`** — build, typecheck, unit tests, lint (the original ladder). Always on.
- **`integration`** — `test:integration` / `test:e2e` scripts, or a pytest `integration` marker. **Auto-detected and on by default** (like lint); disable with `--no-integration`.
- **`deploy-dev`** — a local dev deploy + smoke check: brings a `docker compose` stack up (or runs a `deploy:dev` / `smoke` script), health-checks it, then **always tears it down**. Opt-in with `--deploy-dev`. If docker is unavailable the tier is *skipped*, never failed.

Because promotion is cheap-first, a turn that fails the build never pays for integration or deploy — the expensive tiers run only once the cheap ones pass.

### CI / deploy feedback loop

The `ci`, `deploy-staging`, and `deploy-prod` tiers are **never run locally** — they are verified by CI after commit. With `--watch-ci`, once the local tiers are green `deliver`:

1. commits the applied files and **pushes the current worktree branch** (never `master`/`main`, never force-push);
2. resolves the CI run for that exact commit (matched by SHA) and watches it;
3. on CI / deploy failure, feeds the **sanitized failure logs back into a fresh convergence pass** and re-converges (bounded by `--ci-passes`).

`--until-deployed` implies `--watch-ci` and additionally requires the `deploy-staging` and `deploy-prod` jobs to be green before exiting 0 — so "delivered" means *deployed and verified*, not just "tests pass locally".

The bundled workflow [`.github/workflows/deploy-verify.yml`](../../.github/workflows/deploy-verify.yml) provides the `deploy-dev` / `deploy-staging` / `deploy-prod` jobs the watcher reads. Add `deploy:dev` / `deploy:staging` / `deploy:prod` and `smoke` npm scripts to your project and the no-op verification steps become real.

```bash
# iterate locally through fast → integration → local dev deploy+smoke
uap deliver "add the orders endpoint" --deploy-dev

# …then push, watch CI, and re-converge until staging + prod deploy verify green
uap deliver "add the orders endpoint" --until-deployed
```

> Gate inputs are protected like tests: the model cannot "pass" by editing `docker-compose.yml`, `Dockerfile`, `*.tf`, CI workflows, or runner configs (`--no-protect-tests` lifts this).

---

## Beyond build & test: proving it runs

Green gates prove code *compiles and tests pass* — not that the artifact actually **runs**. `deliver` adds gates for that:

- **Execution gate** — auto-synthesized as a ladder rung whenever a runnable artifact is detected: it actually *runs* the thing (headless browser / vm-dom / child-process) and fails the turn on a runtime error, a blank canvas, or a static frame. Catches "declared done but never ran."
- **Acceptance judge** (`--acceptance`) — after the objective gates pass, an LLM judges the spec's *behavioral completeness* from the code + runtime evidence and feeds any unmet requirements back so the loop finishes the spec. Pair it with **`--evaluator-model <preset>`** to have a *different* model judge than the one that implemented (separate generator from evaluator — the "barbell" strategy).
- **Self-gate** — when a project has **no** detectable gates, `deliver` authors a task-specific acceptance gate as a fallback so there is always something to converge against (on by default; `--no-self-gate` disables, `--force-self-gate` authors one even when project gates exist).

## Resilience: baseline-delta, migrations & repair escalation

Long autonomous runs fail in predictable ways; `deliver` has a guard for each:

- **Baseline-delta gating** — the full ladder is run **once at mission start**. Any required gate that is *already red at baseline* (a pre-existing failure the mission didn't cause) is demoted to non-blocking and annotated; only **new** regressions (green→red) block delivery. So a pre-existing broken lint or flaky test can't consume every attempt. On by default (`UAP_DELIVER_BASELINE_DELTA=0` or `.uap.json` `deliver.baselineDelta:false` to disable).
- **Migration-validation gate** — when a `migrations/` dir with `.sql` files exists, a ladder rung runs the migrations against an **ephemeral throwaway Postgres container** before they can ship broken. Skips cleanly (never fails) when Docker/`sqlx-cli` isn't available.
- **Repair escalation** — a circuit breaker for the compile-error death spiral: when the compile-error count *grows* across consecutive turns, the loop stops mission work and runs **one narrow "make it compile, change nothing else" pass** — in a fresh focused session, on the `--escalate-model` when configured — then resumes.

## Options

**Loop & termination**

| Flag | Purpose |
|---|---|
| `--max-turns <n>` | Maximum execute→verify iterations before until-delivered extension (default `5`) |
| `--no-until-delivered` | Disable loop-until-delivered (ON by default: extends past `--max-turns` to the ceiling, stopping on stagnation) |
| `--ceiling <n>` | Hard turn ceiling for until-delivered (1–50, default `30`) |
| `--no-lazy` | Skip the lazy bare first attempt (by default one bare turn runs before the convergence aids engage) |
| `--resume <id>` | Resume an interrupted durable run: a run id or `latest` (`.uap/deliver-runs`) |

**Executor**

| Flag | Purpose |
|---|---|
| `--executor <mode>` | Per-turn executor: `blind` (one completion), `agentic` (tool-using read/list/bash/write loop), or `auto` (agentic when there's repo context/gates to inspect) — default `auto` |
| `--allow-bash` | Permit the agentic executor's `run_bash` tool when NOT under `uap sandbox` (off by default; auto-enabled under sandbox) |

**Models & routing**

| Flag | Purpose |
|---|---|
| `-m, --model <preset>` | Model preset (default `$UAP_DELIVER_MODEL` or `qwen35-a3b`) |
| `--routing <preset>` | Pick the executor per task complexity from a routing preset (e.g. `cost-tiered`, `speed-tiered`); ignored when `--model` is set (`$UAP_DELIVER_ROUTING`) |
| `--endpoint <url>` | Override the model endpoint (OpenAI-compatible `/v1`) |
| `--escalate-model <preset>` | Stronger model for the escalation/repair ladder (default `$UAP_ESCALATE_MODEL`) |
| `--temperature <t>` | Sampling temperature (default: execution-profile value) |

**Gates & acceptance**

| Flag | Purpose |
|---|---|
| `--gates <ids>` | Gate subset: `build,typecheck,test,lint` |
| `--acceptance` | After objective gates pass, judge spec behavioral completeness (LLM) and feed unmet requirements back |
| `--evaluator-model <preset>` / `--evaluator-endpoint <url>` | Judge the acceptance gate with a DIFFERENT model than the implementer (generator≠evaluator) |
| `--no-self-gate` | Disable the self-authored acceptance-gate fallback (on by default when no project gates are detected) |
| `--force-self-gate` | Author a task-specific acceptance gate even when project gates exist |
| `--keep-best` | Never regress: snapshot first, roll back if the run ends with a worse required-gate score |

**Tiers & CI/deploy feedback**

| Flag | Purpose |
|---|---|
| `--tiers <list>` | Explicit local tiers, e.g. `fast,integration,deploy-dev` (overrides auto-detection) |
| `--integration` / `--no-integration` | Run the integration tier (on by default when a suite is detected) |
| `--deploy-dev` / `--no-deploy-dev` | Run a local dev deploy + smoke tier (compose up → smoke → teardown) |
| `--watch-ci` | After local-green, commit + push the worktree branch and watch CI; re-converge on failure (never pushes master/main) |
| `--until-deployed` | Imply `--watch-ci` and require CI + staging/prod deploy jobs green before exiting 0 |
| `--ci-passes <n>` | Max CI re-converge passes on failure (1–10, default `2`) |
| `--ci-timeout <minutes>` | CI watch budget in minutes (1–120, default `20`) |

**Big builds (decompose → orchestrate → epics)**

| Flag | Purpose |
|---|---|
| `--decompose` / `--no-decompose` | Split the mission into sequential phases, each converged by its own loop (auto for long complex tasks) |
| `--orchestrate` / `--no-orchestrate` | Run decomposed tasks through the blackboard orchestrator with MINIMAL per-task context (implies `--decompose`) |
| `--epics` / `--no-epics` | Run a massive mission as a sequence of fresh-session epics until each is accepted (auto for very long missions) |

**Exploration & quality aids**

| Flag | Purpose |
|---|---|
| `--candidates <n>` | Best-of-N exploration: candidates per turn (2–8) |
| `--critic` | Structured critique of failed turns (extra model call per failure) |
| `--practices` / `--no-semantic` | Inject/record best-practice cards (keyword retrieval with `--no-semantic`) |
| `--escalate` | Escalation ladder on stagnation (widen exploration → critic → stronger model) |
| `--ideate` / `--ideate-project <name>` | Divergent ideation strategy seeds |
| `--optimize` | Enable every convergence aid |
| `--no-auto` | Disable dynamic optimization (aids are auto-selected by task complexity by default) |

**Integration & run control**

| Flag | Purpose |
|---|---|
| `--no-protect-tests` | Allow the model to modify pre-existing test files (protected by default) |
| `--guidance-file <path>` | Poll a file each turn for live operator guidance |
| `--halo` | Emit HALO spans (analyze with `uap harness analyze`) |
| `--coordinate` | Register the run with the coordination layer (announce, heartbeat, overlap detection) |
| `--deploy` | On success, queue a commit of applied files into the deploy batcher |
| `--project-root <path>` | Project whose gates define delivery (default: cwd) |
| `--dry-run` | Show detected gates and plan without calling the model |
| `--json` | Emit a JSON result |

### `--keep-best` snapshots

The pre-run snapshot lands on real disk under `~/.cache/uap/snapshots`
(`UAP_SNAPSHOT_DIR` overrides; absolute paths only) — never `/tmp`, which is
RAM-backed on many Linux systems. Derived directories (`.git`,
`node_modules`, `target`, `.venv`, `dist`, `build`, …) are neither
snapshotted nor touched by a rollback, at any depth. Secret-bearing files
(`.env*`, `.npmrc`, `.netrc`, `*.pem`/`*.key`/`*.p12`/`*.pfx`, `id_rsa` &
friends) follow the same symmetric contract: they are never copied into
snapshot storage, and a rollback never reverts or deletes them — even inside
directories created after the snapshot. Committed env templates
(`.env.example`/`.sample`/`.template`/`.dist`) are treated as source and roll
back normally. Trees larger
than `UAP_SNAPSHOT_MAX_MB` (default 4096) skip the snapshot and the run
proceeds with rollback disabled. Snapshots orphaned by killed runs are reaped
automatically on the next `--keep-best` run (snapshots created on another
host or in a container are judged only by a 7-day age backstop, never by
local pid liveness); a snapshot whose restore failed is preserved and its
path printed.

---

## Local or frontier models

`deliver` speaks the OpenAI-compatible `/v1` API, so it runs against frontier models or a **local model** (e.g. Qwen on llama.cpp). The default preset `qwen35-a3b` targets a local server; point elsewhere with `--endpoint` / `--model`. See **[Local Models](LOCAL_MODELS.md)**.

```bash
uap deliver "add a healthcheck endpoint" --model qwen35-a3b --endpoint http://127.0.0.1:8080/v1
```

---

## Automatic routing & enforcement

- **MCP `deliver` meta-tool** — harnesses with the MCP router can auto-route a coding task into `uap deliver` without a shell call (see [MCP Router](../integrations/MCP_ROUTER.md)).
- **delivery-enforcement policy** — an optional policy gate that routes source edits through `deliver` rather than ad-hoc writes. It is a cooperative-agent guardrail, not a security boundary (see [Policies](POLICIES.md)).

---

## Dry run first

```bash
uap deliver "add input validation to the signup form" --dry-run
```

shows the gates UAP detected and the plan, without spending a single model token — the fastest way to confirm `deliver` understands your project's definition of done.

---

See also: [Architecture overview](../architecture/OVERVIEW.md) · [Policies](POLICIES.md) · [Multi-model routing](MULTI_MODEL.md)
