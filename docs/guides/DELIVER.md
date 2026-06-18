# `uap deliver` — the delivery harness

`uap deliver` drives a model through a **convergence loop that iterates against your project's real completion gates until the work is actually delivered** — build green, tests passing, lint clean — not until the model *claims* it's done.

It is UAP's answer to "the agent said it finished, but nothing compiles." Instead of a single shot, `deliver` runs an execute → verify → critique → iterate loop, feeding real gate failures back to the model and persisting until the gates pass or the run provably stalls.

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

## Options

| Flag | Purpose |
|---|---|
| `--max-turns <n>` | Maximum execute→verify iterations before until-delivered extension (default `5`) |
| `--no-until-delivered` | Disable loop-until-delivered (ON by default: extends past `--max-turns` to the ceiling, stopping on stagnation) |
| `--ceiling <n>` | Hard turn ceiling for until-delivered (1–50, default `30`) |
| `-m, --model <preset>` | Model preset (default `$UAP_DELIVER_MODEL` or `qwen35-a3b`) |
| `--endpoint <url>` | Override the model endpoint (OpenAI-compatible `/v1`) |
| `--escalate-model <preset>` | Stronger model for escalation (default `$UAP_ESCALATE_MODEL`) |
| `--temperature <t>` | Sampling temperature (default: execution-profile value) |
| `--gates <ids>` | Gate subset: `build,typecheck,test,lint` |
| `--tiers <list>` | Explicit local tiers to run, e.g. `fast,integration,deploy-dev` (overrides auto-detection) |
| `--integration` / `--no-integration` | Run the integration tier (on by default when a suite is detected) |
| `--deploy-dev` / `--no-deploy-dev` | Run a local dev deploy + smoke tier (compose up → smoke → teardown) |
| `--watch-ci` | After local-green, commit + push the worktree branch and watch CI; re-converge on failure |
| `--until-deployed` | Imply `--watch-ci` and require CI + staging/prod deploy jobs green before exiting 0 |
| `--ci-passes <n>` | Max CI re-converge passes on failure (1–10, default `2`) |
| `--ci-timeout <minutes>` | CI watch budget in minutes (1–120, default `20`) |
| `--candidates <n>` | Best-of-N exploration: candidates per turn (2–8) |
| `--critic` | Structured critique of failed turns |
| `--practices` / `--no-semantic` | Inject/record best-practice cards (keyword retrieval with `--no-semantic`) |
| `--escalate` | Escalation ladder on stagnation |
| `--ideate` / `--ideate-project <name>` | Divergent ideation strategy seeds |
| `--halo` | Emit HALO spans (analyze with `uap harness analyze`) |
| `--coordinate` | Register the run with the coordination layer |
| `--deploy` | On success, queue a commit of applied files into the deploy batcher |
| `--optimize` | Enable every convergence aid |
| `--no-auto` | Disable dynamic optimization |
| `--no-protect-tests` | Allow the model to modify pre-existing test files (protected by default) |
| `--guidance-file <path>` | Poll a file each turn for live operator guidance |
| `--project-root <path>` | Project whose gates define delivery (default: cwd) |
| `--dry-run` | Show detected gates and plan without calling the model |
| `--json` | Emit a JSON result |

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
