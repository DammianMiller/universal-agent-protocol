# Case Study — Shipping Two Commercial Products on UAP

> UAP v2.39.x · This page is the proof, not the pitch: every artifact, PR
> number, and count below was taken from the live repos (Miller-Tech's two
> commercial products plus UAP itself) and can be re-verified with the commands
> in the footnotes.

**The claim, stated plainly.** UAP is not a demo. It is the discipline layer
under Miller-Tech's entire delivery floor, and the software it disciplined is in
production today:

- **Pay2U** — a multi-tenant payments and product-management SaaS, live at
  `pay2u.com.au`, running on three production Kubernetes clusters.
- **The Miller-Tech Platform** — the subscribable cloud operating platform
  (IaC pipelines, observability, auth) that Pay2U runs on, extracted into its
  own product and pinned by consumers at semver tags.

UAP itself is the third proof: 833 merged PRs, developed under its own gates —
the tool is the demonstration of its own thesis.

---

## TL;DR — the three repos

| | **Pay2U** (payments SaaS) | **The Platform** (operating platform) | **UAP** (this tool) |
|---|---|---|---|
| In production | `app` / `api` / `auth` / `observe` `.pay2u.com.au` | consumers pin semver tags (pay2u pins `v0.5.1`) | npm `@miller-tech/uap` |
| Commits | 4,644 | 501 | — |
| Merged PRs (worktree → PR line) | 187 | 52 | 833 |
| Worktrees under `.worktrees/` | 17 | 9 | — |
| Materialized policy enforcers under `.policy-tools/` | 35 copies | 36 copies | 34 built-ins shipped |
| Agent harnesses wired to one shared memory | 4 | 5 | 9 supported |

Counts taken directly from each checkout: `git rev-list --count HEAD`,
`git log --merges \| wc -l`, `ls .worktrees`, `ls .policy-tools`, and the
project's `.uap.json`.

---

## The two products

### Pay2U — payments in production

Pay2U is a cloud-native payment and product management platform for modern
businesses, focused on the Australian market. It provides secure payment
processing via the Zai gateway with real-time transaction tracking, a
JSONB-based product catalog with REST API access, organization-based
multi-tenancy with OAuth2/OIDC via Zitadel, and an AI image-to-list OCR
service that extracts products from photos of price lists.

The footprint it runs on is deliberately serious: three production DigitalOcean
clusters with one concern each (Main for applications, OpenObserve for
observability, Zitadel for authentication), an Istio mesh, pgEdge Postgres
behind a PgDog pooler, TLS everywhere, and a non-production dev sandbox as the
pre-staging rung of the environment ladder.

That is exactly the kind of system where "the agent said it's done" is not an
acceptable completion signal — and it is developed the UAP way end to end:
feature work happens in numbered worktrees (`.worktrees/586-worktree-payment-plans-and-settlement-sp`,
`…/599-web-brand-iterate`, up to branch `feature/600-lighthouse-excellence`),
merges land through reviewed PRs (#3594 … #3599 in a recent window), and the
repo's own `AGENTS.md` opens with the UAP memory bridge and a table of
ADR-indexed architecture invariants that UAP enforces at tool-call time.

### The Platform — the operating platform as a product

The `platform` repo is Miller-Tech's operating platform: all of the Terraform
(the DOKS clusters, Istio, CNPG/pgEdge, Zitadel, OpenObserve, cert-manager,
Kyverno), OpenObserve dashboards and alerts, and the operations pipeline —
extracted from the pay2u monorepo per **ADR-0013** so it could become a product
in its own right. Consumers (Pay2U today as cell #1; `aevren.ai` planned as
cell #2) pin the repo at a **semver tag, never `@main`**, and deploy their
applications through its app-deploy contract.

Two things make it a showcase for what agentic delivery looks like under real
guardrails:

- **The rules are executable.** Its README doesn't just state "Pipeline-only
  IaC — no local `terraform apply`. Ever." — `.policy-tools/` carries the
  **IaC destruction-check gate**, and the README marks it *load-bearing, do not
  bypass*. Every audited operation goes through a single risk-gated entry
  point (`ops-approved-operations.yml`), plan-before-apply is enforced, and
  destructive plans are blocked by the same enforcer family UAP ships
  (`iac_plan_destruction_check`, `iac_parity`, `evidence_bound_ship`,
  `ship_loop_gate`).
- **It was built the way it enforces.** The 501-commit, 52-PR history grew in
  the same numbered worktrees (`079-audit-infra-state-vs-iac-for-rebuild-par…`,
  `080-oo-alerts-data-fix`), under the same policy gate, with production
  incidents resolved end to end — e.g. the CNPG backup-watchdog rewrite
  (platform PRs #159–#171), the alert-importer fixes (platform PRs
  #544/#546/#549), and the dashboard stable-IDs saga (platform PRs
  #564/#566/#567/#569).

---

## The line in action — six mechanisms that carried both products

### 1. Policy engine and gating — prose became executable blocks

Most projects keep their architecture rules in a prose `AGENTS.md` the model is
free to ignore. On pay2u, the same file's invariants — **COOKIE-ONLY**
(bearer tokens never reach the frontend), **ZITADEL-IDP** (one IdP only),
**OO-UNIFIED** (one observability plane), **PIPELINE-ONLY** (no manual prod
edits), **THREE-CLUSTERS** — are ADR-indexed and *enforced at tool-call time*:

- The **`bearer_lockdown`** enforcer blocks bearer-token auth in frontend code
  (ADR-0007, COOKIE-ONLY) — materialized in both product repos.
- **`iac_parity`** blocks live-state changes without a matching IaC diff, and
  **`iac_plan_destruction_check`** blocks destructive Terraform plans
  (PIPELINE-ONLY, plan-before-apply) — materialized in the platform repo, where
  the README calls the destruction check *load-bearing*.
- **`evidence_bound_ship`** and **`ship_loop_gate`** mean "shipped" requires
  evidence that merge, deploy, monitoring, and verification actually happened
  for the exact SHA.
- pay2u carries **35 materialized enforcer copies** under `.policy-tools/`
  (worktree, delivery-enforcement, schema-diff, expert-review,
  quality-metrics, design-token, visual-verification, enforcement
  self/infra-protect, plus its own custom gates); the platform repo carries
  **36**. pay2u also carries `policy-liveness.json` — UAP watches that the
  gates themselves stay satisfiable — and operator overrides live in a
  root-owned, expiring file the agent cannot mint.

The extraction runs both directions, too: during `uap setup`, pay2u's prose
rules were promoted into first-class UAP policies, and the resulting
**pay2u policy pack** now ships with UAP as a worked example
([POLICY_PACK_PAY2U.md](guides/POLICY_PACK_PAY2U.md)) — a commercial product's
invariants became reusable, installable artifacts.

### 2. Convergence and ideation — loops, not one-shots

Both products were built with `uap deliver`'s convergence loop at the Build and
QC stations: the model proposes, an applier writes, a verifier ladder runs the
project's **real** gates (build → typecheck → test → lint → integration → dev
deploy), failures come back as structured critique, and the loop persists until
the gates are green — with the generator deliberately separated from the
evaluator so no agent grades its own homework. pay2u's `.uap/` shows the
machinery in daily use: `deliver-runs/`, `deliver-logs/`,
`delivery-evidence.jsonl`, `escalation-state.json`, and `handsfree-state.json`.

The same loop reaches all the way to production: with `--watch-ci` /
`--until-deployed`, "delivered" means CI, staging, and prod deploy jobs are
green — e.g. pay2u's Playwright e2e suite became a delivery gate itself
(PR #3598, "e2e-gate-no-run-budget"), so convergence has to satisfy
end-to-end runs, not just unit tests.

And when a problem is genuinely hard, UAP widens the search before it grinds:
**divergent ideation** (`uap ideate` — the open-collider; `--ideate` strategy
seeds inside deliver) generates non-trivial candidate approaches, best-of-N
exploration samples several plans and keeps the most promising, and the
**team-solve-deliver workflow** runs a planner plus two parallel ideators
(minimal-change vs structural) before a fresh-context reviewer judges the
result against the plan and a review-seeded repair loop applies only what the
review named. Recurring failure patterns feed back in too: the proxy's loop
incident ledger is distilled by `uap loops --steer` into session-start context
so a fresh session never re-enters a logged loop.

### 3. Small-model guardrails — a local Qwen that ships

A headline reason Miller-Tech can run this floor economically: much of the
execution runs on **local models** (Qwen 3.x-class, served from llama.cpp and
exllamav3 on a single 3090), with the frontier models reserved for judging and
escalation. What makes that viable is the guardrail stack around the small
model:

- **The convergence loop itself** is the big one — a small model's plausible
  first attempt gets repaired against real compiler and test feedback until it
  actually works. The controlled paired A/B measured **+20pp accuracy
  (78% → 98%, 95% CI [+8, +32], p=0.008)** for a non-agentic single-shot
  baseline once the gate loop took over — edge-case bugs get repaired, not
  shipped. Status, disclosed up front: a 2026-09-02 replication on the
  stronger Qwen3.8-27B did not reproduce the +20pp (the model raised its own
  ceiling, and pooled across 146 raw-adapter cells the gate loop was a wash:
  82.9% vs 82.9%, Δ 0.0pp [−5.5, +6.9]). The gate loop never significantly
  *hurt* accuracy on any measured surface — its value scales with how weak
  the ungated baseline is, which is exactly the small-local-model case.
- **The inference proxy** keeps a weak model from wedging: loop-breaker,
  error-loop with a known-fix class table, recon-convergence ("stop exploring,
  produce the deliverable" after N no-write turns), deferral-break,
  MANDATE-DELIVER (a blocked route becomes a *binding* route), and lockstep
  escalation that hard-fails a session that keeps making the identical failing
  call. pay2u's `.uap/loop-protection/` and the proxy's loop-incident ledger
  are that machinery's exhaust in production.
- **Honest guidance about judges:** a same-model judge (qwen grading qwen)
  was measured to add no lift, so escalation and acceptance judging only spend
  budget on a genuinely stronger, distinct model — generator ≠ evaluator.
- **Self-tuning and live adaptation:** `uap tune` tunes the flag surface
  toward stronger models with a benchmark-validated loop, and real-time
  adaptation escalates a struggling small model mid-session on live signals.
- **Model-aware persistence:** hands-free intensity scales inversely with the
  model's own stickiness — trust a frontier model, firmly drive a local one —
  so the Stop hook carries a local model to 100% of its ledger without
  spinning forever.

The result is a delivery floor where the marginal cost of a coding turn is
electricity, without the quality story collapsing.

### 4. Memory — one store per project, every agent reads it

Both product repos open their agent instruction files with the same UAP memory
bridge: *"Your persistent memory is the UAP memory system — ONE store shared by
every coding agent on this project, NOT a per-agent memory file."* Claude Code,
Factory, VSCode, and OpenCode sessions on pay2u all read and write the same
four-tier memory (daily log → working cache → semantic Qdrant → long-term
archive), with local `nomic-embed-text-v2-moe` embeddings so semantic recall
carries no per-query API cost.

The write side is disciplined the same way everything else is: a **write gate**
rejects low-signal entries, significant learnings are **promoted**, and
corrections **propagate across every tier** with a superseded-entries audit
trail — the archive can't silently rot.

What that looks like after months of production work: pay2u's long-term store
is tens of megabytes of durable, high-signal operational knowledge, and the
auto-mirrored bridge shows what's in it — root-cause analyses of observability
alerts, "gotchas" from the OpenObserve v0.60.0 importer, Fluent-Bit filter
landmines, reconciliation-run false-positive post-mortems — each tagged with
the PRs that resolved it. A fresh agent on either repo starts its first turn
already knowing this floor's history.

### 5. Multi-agent coordination — many workers, one floor

Both products run multiple agents at once — different harnesses, worktrees
numbering in the teens (17 on pay2u, 9 on the platform) — without clobbering
each other, because coordination is a station, not a convention:

- Every agent **registers, announces the resources it's about to touch, and
  checks overlaps before editing**; same-file collisions are flagged with
  conflict-risk badges and merge-order suggestions, and the `coord_overlap`
  enforcer backs it at tool-call time.
- **Worktree isolation** gives each job its own bench (the numbered
  `NNN-slug` worktrees in both repos), with drift blocking so a stale branch
  can't overwrite landed work, and **deploy batching** de-conflicts the
  git/deploy actions at the merge boundary.
- **Model-slot concurrency** keeps parallel fan-out from exhausting the local
  inference server's real capacity.
- The **attention queue + AFK auto-decider** means an agent that needs an
  operator decision records the ask with its safe default and keeps working —
  work never stalls on a question, and unattended adoptions are logged, never
  silent.

The clearest production evidence is cross-repo: observability delivery that
landed as platform PR #537 *and* pay2u PR #3554 in one coordinated push, and
the trial-tier removal that shipped as platform PR #557 + pay2u PR #3567 with
the website redeployed live — one memory entry in the shared store holds both
PRs and the verification.

### 6. Endless context — injection, not accumulation

A long build should not die of context exhaustion. Across both products, every
mechanism is "carry less, recall smarter":

- **Session start** injects recent memories, any unfinished build's resume
  banner, and steering context distilled from past loop incidents — a fresh
  session starts warm, not amnesiac.
- **Every prompt** passes the reactor, which injects only the matching experts,
  skills, and patterns for what was just asked (pattern-RAG on top of a
  pattern library), instead of a bloated standing system prompt.
- **Every tool call** passes the MCP Router, which compresses large outputs with
  intent-driven FTS5 search — up to ~98% fewer tokens on big results — and
  the proxy's backstop pruning keeps the window from overflowing in the first
  place.
- **Every orchestrated task** runs in *minimal fresh context*: a one-line
  orientation, its own goal and acceptance criteria, the verified interface
  contracts of its direct dependencies (a few hundred tokens), and a small
  memory pull — never the whole spec. This is precisely what lets a
  small-context local model compose a three-cluster system it could never see
  all at once.
- **Epics run as fresh sessions**, carrying only prior epics' summaries, so a
  build can be arbitrarily larger than any context window.

That is the "endless context" claim made concrete: memory injection plus
output compression plus minimal-context orchestration, all of it visible in
`.uap/` state on both products (`fastpath-accum.json`, the memory bridge,
`halo/` spans, the orchestrator's run ledgers).

---

## The incident that became a gate

The best single story about the policy engine comes from pay2u's operations
plane. In October 2026, an agent command mutated the Plane admin account's
credentials (`docker exec plane-app-api-1 python manage.py changepassword …`).
A guard policy existed but was weak: no waiver expiry, no fail-closed
behaviour, no tests.

The response is the UAP playbook in miniature. A session hardened the
**`plane_admin_protect`** enforcer (132 lines: shell ops only; blocks only when
a command both targets the Plane stack and carries a credential-mutation verb;
owner waivers must carry an expiry and **fail closed** when expired or
unreadable), added regression tests, upstreamed it into UAP's enforcer set
(`src/policies/enforcers/plane_admin_protect.py`), and deployed it to force in
pay2u — re-verified end to end through the live gate, with the whole trail
recorded in
[docs/reports/2026-10-02-plane-admin-protect-session.md](reports/2026-10-02-plane-admin-protect-session.md).

An incident on a commercial product became a reusable, tested gate shipped in
the open-source tool — and the consuming repo's protection got stronger in the
same motion.

---

## The honest numbers

UAP's benchmark culture is deliberately self-skeptical, so this page inherits
it. The controlled paired A/B (same model, tasks, seeds; only UAP toggled):

| Baseline | Accuracy lift with UAP | Reading |
|---|---|---|
| Non-agentic single-shot model | **+20pp** (78% → 98%, 95% CI [+8, +32], p=0.008) — *not reproduced* on the stronger Qwen3.8-27B (replication: a wash, Δ 0.0pp [−5.5, +6.9]) | the gate loop repairs real edge-case bugs; value scales with how weak the ungated baseline is |
| Agentic harness (already self-tests) | **~0pp** (CI spans 0) | UAP's value there is efficiency + coordination, not raw accuracy |

Earlier Terminal-Bench runs showed **−49.7% tokens, +33pp success, −68%
errors, −57% wall-clock**, and UAP's own investigation
([TBENCH_INVESTIGATION.md](benchmarks/TBENCH_INVESTIGATION.md)) documented that
those gains were confounded — which is exactly why the paired harness exists.
Re-run it yourself: `uap bench paired --adapter raw --suite benchmarks/suites/real-gate-gated`.

The production evidence above is the other half of the story: numbers you can
count in two commercial repos, from commits and merges to the enforcer copies
doing the gating.

---

## UAP under UAP — the third proof

UAP develops itself the way it tells you to: every change lands from a
worktree, `npm test` (~540 vitest suites, ~6,375 tests) and the ~1,400-test
Python enforcer/proxy suite gate every merge, the version bump is scripted,
and the delivery-enforcement, evidence-bound-ship, and self-protect gates run
against UAP's own source. The 833 merged PRs of its history are the dogfood.
When the tool's gates found a defect in the tool's own delivery path, the
hardening plan and its parallel-review dispositions were published as
[docs/plans/deliver-hardening-plan-2026-07-13.md](plans/deliver-hardening-plan-2026-07-13.md)
— motivated by a real incident on pay2u — and shipped.

---

## Steal this setup

Everything in this case study is in the box:

```bash
npm install -g @miller-tech/uap
cd your-project
uap setup        # memory, policies, worktrees, routing, coordination, gates — one wizard
```

Then start where Miller-Tech started: write your invariants down, let `uap
setup` extract them into policies, set them to `REQUIRED` so they block, and
route your builds through `uap deliver`. The line does the rest.

---

**Verification footnotes** — every count on this page is reproducible:

- Commits / merged PRs: `git rev-list --count HEAD` and `git log --oneline
  --merges | wc -l` in each repo (pay2u: 4,644 / 187; platform: 501 / 52; UAP:
  833 merged PRs). The platform counts are from its working checkout, whose
  HEAD is a feature branch a few commits ahead of its `main` (493 / 50).
- Worktrees: `ls .worktrees` (pay2u: 17, platform: 9).
- Enforcer copies: `ls .policy-tools | grep -cE '^[0-9a-f]{8}-[0-9a-f]{4}.*\.py$'`
  (pay2u: 35, platform: 36; UAP ships 34 enforcer-source files under
  `src/policies/enforcers/` — the repo's canonical "34 enforcers" count, of
  which one is the shared `_common.py` helper rather than an enforcer itself).
- Shared-memory wiring: `.uap.json` in each product repo (pay2u wires
  claudeCode, factory, vscode, opencode to one store; collection
  `pay2u_memory`, local `nomic-embed-text-v2-moe` embeddings).
- Benchmark table + replication status: [docs/benchmarks/PAIRED_FINDINGS.md](benchmarks/PAIRED_FINDINGS.md).
