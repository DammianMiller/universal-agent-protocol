# The Evolution of UAP — from a Miller-Tech dogfood to the agent discipline layer

> **🏭 Where this fits:** Every station. This is the *why* behind the machinery —
> the origin story, the eras, and the feature map. If the
> [delivery pipeline](DELIVERY_PIPELINE.md) is the floor plan, this is why the
> factory got built at all, station by station.

**TL;DR:** UAP was not designed in a vacuum. It is the codified result of
Miller-Tech running real agentic development — the fintech app **Pay2U** and
the **Miller-Tech platform** — and refusing to accept "the agent is just like
that" as an engineering answer. Every gate in UAP exists because a specific
class of failure actually happened on a real codebase, and the fix that worked
was the same every time: **turn the software-engineering practice into an
executable check the agent cannot route around.** Enforce, don't suggest.

---

## The origin: two real codebases, one repeating failure

Miller-Tech builds **Pay2U**, a fintech application (three Istio service
meshes — MAIN, OPENOBSERVE, ZITADEL — behind a COOKIE-ONLY, ZITADEL-IDP,
PIPELINE-ONLY, THREE-CLUSTERS architecture), and the **Miller-Tech platform**
that runs it. Development is heavily agentic: AI coding agents do the typing,
humans do the reviewing and the deciding.

That worked — until it didn't, in ways that will sound familiar to anyone who
has run agents on a real codebase:

- An agent would **declare "done"** on code that had never been executed.
- It would **edit on `main`**, or clobber a sibling agent's file mid-edit.
- It would **forget last session's decision** and re-litigate or contradict it.
- It would **ignore the architecture invariants** — the ones written in prose
  in `AGENTS.md` — because prose doesn't block anything.
- Left unattended, it would **stop on the first question** ("which option do
  you want?") or, worse, silently **pick one** and keep going.
- And when reviewers pushed back, the same failure would **recur next session**,
  because nothing remembered the lesson.

The usual answers — "use a smarter model," "write better prompts," "paste the
rules into the context" — each helped a little and none of it stuck. The
diagnosis that became UAP: **an agent without enforcement is a talented but
undisciplined line worker.** You do not fix a factory by hiring a smarter
worker; you fix the line. Software engineering already knows what the stations
are — intake, isolation, build, verify, coordinate, ship, learn — the problem
was that none of them *executed* during agentic development.

So Miller-Tech started building the line under its own agents, on its own
products. The first artifact of that is still shipped today: the
[Pay2U policy pack](POLICY_PACK_PAY2U.md) — the project's load-bearing
invariants (COOKIE-ONLY, ZITADEL-IDP, OO-UNIFIED, PIPELINE-ONLY,
THREE-CLUSTERS, each indexed to the ADR it comes from), extracted from
Pay2U's `AGENTS.md` and made *reviewable and selectable* — the precursor to
executable enforcement; the executable form arrived later as the built-in
enforcer set. That pattern — **rules as inspectable artifacts, indexed to
their why** — is UAP's DNA.

---

## The principle, stated once

Everything below is an instance of one idea:

> **A software-engineering practice that isn't enforced at the moment the agent
> acts is a suggestion, and agents route around suggestions.**

Hence the shape of every UAP feature: hooks installed *underneath* the harness
so the agent cannot skip them; gates that *block* rather than warn; a
generator≠evaluator split so the builder never grades itself; memory that
*surfaces the lesson at the moment of the next decision*; and a review/ADR
trail so a human can always reconstruct *why the gate is like that*.

---

## The eras

UAP has shipped continuously since March 2026 — **694 versioned releases**
(v1.5.2 → v2.29.0; the
[CHANGELOG](../../CHANGELOG.md) carries every step). Four eras, each adding a
layer of the same thesis:

### Era 1 — The floor (v1.x, 2026-03 onward): memory, hooks, the proxy

The first build of the line. **4-tier memory** (short-term SQLite → Qdrant
semantic recall → patterns → promotion) so sessions stop starting from zero.
**Harness hooks** (Claude Code, Factory, Cursor, VSCode, OpenCode, Codex,
ForgeCode, oh-my-pi, Hermes — the nine that survive today) so enforcement runs
wherever the agent works. The **Anthropic↔local proxy** so Pay2U development
could run on local llama.cpp/Qwen models with guardrails (reliability pruning,
tool-call grammar repair) instead of raw endpoints. The **worktree workflow**
and **file coordination** so two agents on the same repo stop colliding.
**Policy enforcers** (34 today) arrive as exit-code scripts: *allow, block,
or degrade* — the enforcement primitive everything else builds on.

### Era 2 — The verification spine (v1.224 "the hardening," planned 2026-07-13, shipped 2026-09): deliver, evidence, operator trust

The [deliver hardening plan](../plans/deliver-hardening-plan-2026-07-13.md)
is the era's document: a **14-defect audit of the convergence loop**, fixed in
batches and hardened under parallel review. `uap deliver` becomes the heart of
the system — a loop that drives a model against the project's *real* completion
gates (build, tests, lint, execution) until the work is genuinely delivered,
with scoped rollback, declared gates, polyglot execution, and a
generator≠evaluator acceptance judge. Around it: the **evidence-bound ship**
(a merge is blocked unless gate evidence is bound to the exact candidate SHA),
the **quality-metrics gate** (deterministic complexity/coverage budgets with a
ratchet baseline), **operator overrides** (root-owned, expiring), and
AutoMode's risk floor. The 2026-07-13 review's "should-fix" — *a worktree
session writes state where the gate never looks* — is fixed here and becomes a
recurring UAP design rule: **shared state anchors to the main checkout.**

This is also the era of the honest benchmarks: the
[paired A/B](../benchmarks/PAIRED_FINDINGS.md) showed UAP's value is
**+20pp accuracy on a non-agentic baseline** (78%→98%, 95% CI [+8,+32]) and
~0pp on a harness that already self-checks — and a 2026-09 replication on a
stronger model (Qwen3.8-27B) showed no lift, which sharpens the thesis:
*the gates pay exactly when the baseline can't self-check.*

### Era 3 — Autonomy machinery (v2.0 → v2.26, 2026-09 → 2026-10): model placement, capacity, inference health

To run Pay2U-scale development on one 24GB GPU, UAP grew a **model placement
subsystem**: a registry of measured residents, admission control
(reuse → load-alongside → displacement), an **operator-directed allowlist as
standing consent** (ADR 0007), auto-load, idle auto-unload, and a
fleet-capacity doctor with per-service budgets. **Inference health** learned to
catch a server that is *up but not working* (throughput decay that liveness
probes never see). The **orchestrator** (blackboard + epic controller) and the
**self-harness** (mine→propose→validate improvement loop) extended autonomy
from single tasks to missions. This era's theme: autonomy without legibility
is a hazard, so every auto action is consent-gated, logged, and reversible.

### Era 4 — The bridge program (v2.27 → v2.29, 2026-10): legibility, scheduling, attention

mtlynch.io's *Why Are Coding Agents So Dumb?* read the state of the art and
listed the gaps; Miller-Tech audited UAP against it and committed to a
five-phase **bridge program** — three phases shipped (with the full review
protocol: deterministic prepass → 3 parallel reviewers → every finding fixed
in-branch), P4/P5 as the intended next steps:

| Phase | Gap addressed | What shipped | Where |
|---|---|---|---|
| **P1 — Legibility** (v2.27.0, PR #846) | Plans the agent can't follow; agents that don't know their own tools; no cost/ETA intuition | Plan comprehension gate (readability rules over `uap plan validate`, advisory→strict), the **self-knowledge card** (`uap self card/query` — agents stop guessing their own capabilities), ETA wall-clock telemetry keyed (model, task type, complexity) | [feature catalog](../reference/FEATURES.md) |
| **P2 — Scheduling** (v2.28.0, PR #847) | Serial waves idling fast workers behind slow ones; one model per mission | **Completion-triggered dispatch** (a finished task's slot refills instantly; dependents start when their last dependency settles — no wave barrier), **per-leaf model dials** (a phase may pin its own model, fail-closed everywhere) | [ADR 0009](../architecture/adr/0009-completion-triggered-dispatch-and-per-leaf-model-dials.md) |
| **P3 — Autonomy** (v2.29.0, PR #848) | Agents stop on any question, or silently decide for you | The **attention queue** (asks recorded with a safe default; `uap attention list/ack/decide/sweep`) and the **AFK auto-decider** (grace-elapsed asks adopt their recorded default — logged, never silent; no default ⇒ escalate). Deadlines pinned to the ask's real TTL; apply/dismiss close the ask by origin | [ADR 0010](../architecture/adr/0010-attention-queue-and-afk-auto-decider.md) |
| **P4 — Sandboxing** (next) | Agents with too much authority | Per-session sandbox grants; a network egress boundary | planned |
| **P5 — Surfaces** (next) | The operator's own legibility | Local diff view; ETA surfaces + paired bench delta report | planned |

The bridge program closed the loop on UAP's own behavior as an agent: each
phase was developed *under UAP* — worktree isolation, completion gates,
parallel review, versioned ship — which is the whole point. **The tool is the
proof of its own thesis.**

---

## What exists today (the honest inventory)

As of v2.29.0: **434 TypeScript modules across 34 `src/` subsystems**, 58
top-level CLI commands (~210 registrations including subcommands), **34
executable policy enforcers**, **518 vitest suites (~6,050 tests)** plus a
~1,400-test Python enforcer/proxy suite, and **9 supported harnesses**. The
feature-by-feature catalog, mapped to pipeline stations, is
[FEATURES.md](../reference/FEATURES.md); the "what applies automatically"
walkthrough is
[AUTOMATIC_FEATURES.md](AUTOMATIC_FEATURES.md); the code-verified
implementation map (trust boundaries and all) is
[documentation/architecture.md](../../documentation/architecture.md).

The decision record lives in the [ADRs](../architecture/adr/) — 0001
(AutoMode risk floor) through 0010 (attention queue and the AFK decider) —
and in [docs/plans/](../plans/), where the audits and review responses that
shaped each era are kept deliberately: **the reasoning is part of the
product.**

---

## Where it goes next

The same rule that got UAP here: every new capability must answer *what does
this stop the agent from getting wrong*, and every new authority must state
*who consented*. P4 (sandbox grants, egress boundary) tightens the blast
radius; P5 (diff view, ETA surfaces) makes the operator's own view as legible
as the agent's. Beyond the bridge program, the direction is unchanged since
the Pay2U days: more of the software-engineering discipline, executed instead
of suggested — and the honest benchmarks to prove which parts pay.
