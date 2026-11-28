# UAP commercialization plan: open core, paid control plane

**Date:** 2026-11-28
**Status:** Proposal for owner review. No decision committed.
**Evidence base:** UAP v2.93.9 (README, `docs/`, `COMPARISON.md`, `PRODUCT_NAMING.md`), the Miller-Tech platform blog series and website copy (`consulting.md`, `platform/capabilities.md`, `platform/pricing.md`, `BLOG-PLAN.md`), and the platform's production architecture (three-cluster cell, Zitadel identity plane, OpenObserve observability plane, Pay2U billing).

**One line:** keep UAP Core MIT, local-first and single-floor-complete forever; sell the org-shaped layer above it (central logs, audit evidence, multi-team sharing, budgets, routing, cost optimization) as a self-hostable control plane first, SaaS second, with consulting as the install motion that already exists.

**Stance recorded (unattended defaults, per engineering-principles policy):** backward compatibility = **PRESERVE** (nothing is removed or crippled from the OSS core; the enterprise layer is purely additive), maturity = the core is **PRODUCTION** (real floors run on it; do not break callers), the control plane is **GREENFIELD** (new product, no existing callers).

---

## 1. Executive summary

UAP today is a complete, free, MIT-licensed discipline layer for a single delivery floor: memory, 34 policy enforcers, the deliver/verify convergence loop, worktrees, coordination, multi-model routing, benchmarks. It has no org story at all, and `COMPARISON.md` says so in its own honest-gaps list: "Single-operator tool. No user auth, no teams, no hosted service, no enterprise compliance story." Meanwhile, the Miller-Tech blog series and consulting page have already sold the org story as a **manual engagement**: assessment, install, memory bootstrap, gates, enablement, measurement. The engagement is the enterprise product's feature list, delivered by hand.

The commercial shape that follows from the evidence:

1. **UAP Core stays MIT and genuinely complete.** The moat is adoption and cross-harness neutrality (9 harnesses), not artificial limits. A crippled core would kill the funnel that the blog and npm distribution already feed.
2. **The paid product is the control plane** — the layer that only organizations need: central logs, audit and compliance evidence, team hierarchy and sharing of memory/skills/patterns/droids, delivery portfolio visibility, budget allocation, centralized routing policy, and cost optimization. Everything the engagement currently wires by hand.
3. **Distribution is dogfooded:** the control plane runs on the Miller-Tech platform (Zitadel OIDC for SSO, OpenObserve for the log plane, Pay2U for billing). The platform is itself delivered by the UAP line, so the sales story is recursive and already true.
4. **Timing is the forcing function.** The naming analysis recorded that the "supervise your AI agents" category colonized within a single documentation cycle (Ratchet, Corral, Muster, Bosun, Keel all claimed in mid-2026). The window for an independent discipline layer is months, not years.

---

## 2. What UAP is today (the asset inventory)

| Asset | State (v2.93.9) | Commercial meaning |
|---|---|---|
| Discipline layer under 9 harnesses | Claude Code, Factory, Cursor, VSCode, OpenCode, Codex, ForgeCode, Oh-My-Pi, Hermes | The neutral seat: no harness vendor can be the buyer's compliance plane |
| Scale | 454 TS modules / 35 subsystems, 76 CLI commands, 34 enforcers, ~6,450 vitest + ~1,490 Python tests | Credibility with engineering leaders; the "500+ suites" badge is sales collateral |
| Verification machinery | `uap deliver` convergence loop, generator ≠ evaluator, evidence-bound ship (`.uap/evidence/<sha>.json`) | The audit story already produces artifacts; they are just local and per-floor |
| Memory | 4 tiers, pluggable backends (`memory/backends/factory.ts`, GitHub, Qdrant cloud) | A server backend fits an existing seam — no rearchitecture needed |
| Telemetry & analytics | `analytics.ts` per-task token/cost/outcome metrics (`model_analytics.db`), policy audit trail (`uap policy audit`), bounded sandbox audit JSONL, stream/project telemetry events | The enterprise "logs + cost" features are aggregation of signals UAP already records |
| Coordination | file claims, merge queue, deploy batching, attention queue, orchestration + completion ledger | Single-floor today; the multi-team version is the same primitives with org scoping |
| Routing & cost | 7 model profiles, `uap classify`, self-tuning, convergence economics per model (`npm run bench:convergence`), local-model fleet guardrails | Cost optimization is measured, not guessed — the differentiator vs. governance point tools |
| Policy packs | Pay2U pack precedent; policy as executable enforcers | Org policy-pack distribution is a versioning + approval problem, not a new engine |
| Benchmarks | Paired A/B with confidence intervals (+20pp vs non-agentic baseline, CI [+8, +32]; ~0pp vs agentic) | Honest-measurement machinery is productizable: buyers can audit the vendor |
| License | MIT, npm `@miller-tech/uap`, self-hosted, free | Free tier already shipped; nothing to unbundle |

**What does not exist (the honest list, straight from `COMPARISON.md` §6):** user auth, teams, hosted service, enterprise compliance story, memory benchmarks vs Mem0/Zep, and a community beyond one vendor.

That gap list is the enterprise product spec, nearly verbatim.

---

## 3. What the blog series tells us (market research we already ran)

The "Agentic Delivery Line" series (9 parts + 3 production notes) is not just content; it is validated positioning for this exact product. Key findings from the copy and plan:

- **Thesis:** every station is a leadership practice made executable. The buyer recognizes the human failure modes instantly. This is the wedge into non-startup buyers (finance, utilities, insurance — the industries the consulting page already targets).
- **Audience priority (recorded in `BLOG-PLAN.md`):** (1) engineering/platform leaders — the consulting buyer; (2) senior engineers already using agents — the UAP adopter and future platform subscriber; (3) CTO/COO readers of the case study. A product ladder (free → teams → cloud) maps 1:1 onto that list.
- **The claim that works:** "10-20x per-developer throughput on well-suited work, observed in our own delivery" — scoped, mechanically guarded by `check-claims.py`. The product marketing inherits this discipline; every number ships with scope or does not ship.
- **The engagement is the product manual.** Article 8 ("Installing the line") lists what gets installed by hand today. Article 7 ("The honest multiplier") names the machinery buyers will pay to keep running org-wide (paired benchmarks, ETAs from recorded attempts, quality ratchet). Article 5 (staff-org) describes multi-team coordination. Article 2 describes org memory (bootstrap from ADRs/postmortems). The series is the enterprise roadmap written a year early.

### The blog → enterprise-feature map

| Series part (the practice) | Org-scale need it names | Control-plane feature |
|---|---|---|
| 1. Undisciplined team | "Swapping a smarter model makes unreliability faster" | Board-level delivery risk view: gate pass rates, unverified-done counts per team |
| 2. Memory as onboarding | Institutional knowledge that survives staff churn | Shared team/org memory namespaces with promotion governance and superseded-entry audit |
| 3. Done is verification | One definition of done, enforced everywhere | Org-wide gate visibility; quality ratchet reporting per repo and team |
| 4. Architecture invariants | Standards that block, not suggest | Versioned org policy packs with review/approval distribution |
| 5. Staff-engineering org | Floors that don't collide | Cross-team coordination: org merge queue, file claims across repos, attention queue with routing to owners |
| 6. Postmortems change behavior | Lessons that propagate | Org lesson promotion; fleet-scale self-harness mining over centralized traces |
| 7. Honest multiplier | Numbers with scope | Paired-benchmark and ETA dashboards; cost-per-outcome reporting |
| 8. Installing the line | Assessment → install → handover | Productized onboarding: assessment tooling, bootstrap pipelines, enablement curriculum |
| 9. How to prompt | Lazy prompting once gates carry standards | Org prompt/policy library (the "standards ride the line" pitch) |

The commercial insight: **consulting sells the line once; the control plane sells the line recurring.** The engagement converts from "we hand-wire your floor" to "we install the product and configure it" — faster delivery, higher margin, and a software asset underneath.

---

## 4. Strategy: open core

### What stays free (and why)

Everything a single floor needs to be disciplined: memory (local + existing cloud backends), all 34 enforcers, `deliver`/`verify`, worktrees, MCP router, coordination, routing, local models, self-harness, bench, dashboard, policy authoring. No seat caps, no telemetry ransom, no "contact sales" for single-team use.

Rationale: the funnel (npm → `uap setup` → blog-driven senior-engineer adoption) only compounds if the free tier is the real product. The cross-harness neutrality claim ("harness choice becomes a preference, not a process change") requires the core to be universally usable. And the consulting engagement's promise — "the protocol is open, the tooling is yours" (article 8) — is a marketing asset that must stay true.

### What is charged: the org-shaped layer

The features in the user's list are org features by nature — none of them makes sense on a single floor:

| Requested capability | Why it is inherently org-scale |
|---|---|
| Logs | Central, multi-floor, retained, searchable — a floor's own logs already live locally |
| Audit | Compliance evidence is produced for auditors across teams and time |
| Multi-team/hierarchy sharing | Sharing is inter-team by definition |
| Coordination of skills | Registry governance (review, versioning, deprecation) exists because multiple teams consume |
| Delivery | Portfolio/ETA views exist because multiple teams deliver |
| Budget allocation | Allocation is a principal–agent problem across teams |
| Routing | Org policy on model spend is an org decision |
| Cost optimization | Savings are measured against an org baseline |

This is the cleanest possible open-core seam: it is not a feature gate, it is a customer boundary. Single floor = free forever. Organization = paid. The seam is honest and defensible in the community.

### The seam (architecture principle)

UAP is local-first; the control plane must not break that:

- **Core works fully offline.** The plane is opt-in. If the plane is unreachable: policy fetched from the plane fails **closed** (org rules are rules), telemetry and log shipping fail **open** (spool locally, ship on reconnect).
- **Existing seams carry the integration:** a new memory backend for shared namespaces (the `backends/factory.ts` seam already ships GitHub and Qdrant cloud backends); the existing telemetry/analytics events get a pluggable sink; skills/droids/patterns registries gain a server source alongside the directory/git sources.
- **No new trust in the agent.** Agent → plane auth is per-agent short-lived tokens issued after human SSO; the plane never holds repo credentials.

---

## 5. Free core vs enterprise: the feature map

| Capability | In free core today (raw material) | Enterprise control plane adds |
|---|---|---|
| **Logs** | Policy audit trail, stream/project telemetry, `model_analytics.db`, sandbox audit JSONL — all local | Central aggregation of session/tool-call/gate/delivery events; retention policy; search & dashboards (OpenObserve behind it); cross-floor correlation IDs |
| **Audit** | `uap policy audit`, evidence-bound ship artifacts, superseded-entry trail | Org-wide immutable audit store; WORM retention windows; compliance export packs (SOC 2 / PCI evidence generated continuously, matching the consulting page's "evidence pipelines" offer); maker-checker approvals on sensitive overrides (a platform pattern already proven in Pay2U) |
| **Multi-team sharing (memory)** | 4-tier memory, pluggable backends, write-gates, promotion | Team/org namespaces; scoping (repo → team → org); curated org memory with editorial promotion; access control per namespace; cross-team search with permissions |
| **Skills / droids / patterns coordination** | 34 patterns, 38+ droids, 41 skills as local registries; expert router | Central registry with review workflow, semantic versioning, deprecation, per-team enablement, usage analytics ("which patterns actually pay"), curated marketplace |
| **Delivery** | Orchestrator, epics, completion ledger, ETAs from recorded attempts, deploy batching | Portfolio dashboard across teams/repos; org merge queue; dependency-aware cross-repo batching; org-level ETA rollups with the same honest "not an estimate" rule |
| **Budget allocation** | Per-task cost metrics | Budget policies as gates: per-team/per-project ceilings, quota exhaustion blocks or degrades (route to cheaper rail) instead of silently overrunning; chargeback reports by team/repo; approval flows for overruns |
| **Routing** | 7 model profiles, complexity tiers, `uap classify`, per-leaf model dials | Org routing policy managed centrally, versioned, rolled out fleet-wide; fleet view of local-model capacity; per-team rail allowlists (e.g., "PII repos never route to cloud models") |
| **Cost optimization** | Convergence economics per model, self-tuning, paired benchmarks, the two-rail line | Org savings dashboard vs measured baseline; automatic "cheapest rail that passes the ladder" enforcement at scale; cost-per-delivered-outcome per team; anomaly alerts on runaway spend |

Nothing in the right column requires a new enforcement engine. It is aggregation, permissions, distribution, and policy — a server plus the hooks UAP already has.

---

## 6. The enterprise product, component by component (MVP scope)

**Product name (working):** UAP Control Plane. Brand decision deferred (see §14): `PRODUCT_NAMING.md` recommends keeping any rename separate from this work.

### 6.1 Central logs
- Core emits a versioned event stream (schema v0: gate decisions, tool-call outcomes, delivery attempts, session summaries) to a pluggable sink; the plane's sink ships via OTLP into OpenObserve.
- MVP: one org, all floors streaming, 30-day retention default, per-repo filters, gate pass-rate panels.
- Dogfood target: Miller-Tech's own floors (UAP + platform + pay2u repos) run on it before any external pilot.

### 6.2 Audit and compliance evidence
- Append-only audit store of every block, allow, override, ship-evidence hash, memory promotion/supersession.
- Export: point-in-time evidence pack for a chosen window (the artifacts auditors ask for: "show me that every change to X went through gates").
- Ties directly to the compliance-readiness consulting service already on sale: the control plane is the machinery that makes SOC 2 / PCI evidence continuous instead of assembled.

### 6.3 Org structure: teams, hierarchy, sharing
- Org → team → floor/repo hierarchy; OIDC-backed identities (the platform's Zitadel already runs multi-org sign-in in production).
- Memory namespaces with per-team write-gates and org-level curation (the "editor discipline" from the memory article, at org scale: junk does not graduate to org memory).
- Policy packs distributed org-wide with version pinning (the Pay2U pack becomes the first internal reference).

### 6.4 Skills/droids/patterns registry
- Server-backed registry sources for the existing local registries; review/approve workflow; per-team enablement flags; usage analytics feeding pattern reinforcement.
- The expert router already ranks; the registry adds governance ("this security-auditor droid is approved for the payments repos; that community one is not").

### 6.5 Delivery portfolio
- Read-model over completion-ledger + gate events: per-team WIP, ETA rollups, quality-ratchet movement, blocked items.
- Org merge queue extends the single-floor merge queue across repos with dependency ordering (deploy batching already handles conflict-free batched actions).

### 6.6 Budget allocation
- Budgets per team/project/period, enforced as policy: hard stop, or degrade-to-cheaper-rail, or require-approval — the same three-way choice the sandbox grants model uses.
- Chargeback exports (CSV/API) so platform teams can bill internally without building anything.

### 6.7 Routing policy
- Org-level routing table (task class → allowed rails), versioned, with staged rollout; per-team exceptions require approval and are audit-logged.
- PII/repo-class rail allowlists as first-class policy (the differentiator for the finance/utilities/insurance buyers the site already courts).

### 6.8 Cost optimization
- Fleet savings view: measured cost per delivered outcome by model/rail (the convergence-table data, aggregated); automatic rail-ladder enforcement; spend anomaly alerts.
- The honest-multiplier discipline applies: savings reported against the customer's own paired baseline, never a vendor multiplier.

---

## 7. Architecture sketch

```
┌──────────────────────── Agent harnesses (9) ────────────────────────┐
│ hooks (PreToolUse etc.) — unchanged                                 │
└───────────────────────────────┬─────────────────────────────────────┘
                                ▼
┌───────────────────────── UAP Core (MIT, local) ─────────────────────┐
│ memory · 34 enforcers · deliver/verify · worktrees · coordination   │
│ routing · analytics · NEW: event sink interface + plane client     │
│ (offline-complete: plane down ⇒ policy closed, telemetry spooled)   │
└───────┬────────────────────────────────────────────────┬───────────┘
        │ opt-in, per-agent tokens                        │ shared sources
        ▼                                                 ▼
┌───────────────────── UAP Control Plane (commercial) ───────────────┐
│ API (undici/ws) · authz (OIDC → Zitadel) · namespaces/budgets      │
│ routing policy · registry governance · delivery read-model        │
│ sinks → OpenObserve (logs) · audit store (immutable) · billing     │
└───────────────────────────────┬────────────────────────────────────┘
                                ▼
              Miller-Tech platform cells (Zitadel · OpenObserve · Pay2U billing)
```

- **Stack:** the plane uses the dependencies UAP already carries (TypeScript, `better-sqlite3`/Postgres, `ws`, `undici`, `zod`) — one toolchain, one hiring profile, delivered by the same line that builds everything else.
- **Deployment modes:** (a) self-hosted single container (compose/Helm) for Teams tier; (b) SaaS cell on the Miller-Tech platform for Cloud tier — the platform's per-workload subscription, resource clamping, and PayTo billing (already live for platform workloads) apply unchanged.
- **Recursion is the proof:** the control plane is itself delivered through the UAP line and ships with its own gate evidence. The sales demo writes itself: "this product's own changelog is our audit trail."

---

## 8. Packaging and pricing

Four rungs, mirroring the platform's proven ladder (published flat shared-tier pricing → dedicated cells):

| Rung | What | Price model (to validate) | Precedent |
|---|---|---|---|
| **UAP Core** | Everything single-floor, MIT, self-hosted | Free, forever, no seat caps | npm today |
| **UAP Teams** (self-hosted plane) | Control plane container: logs, audit, namespaces, budgets, routing, cost | Per seat per month, annual, 5-seat minimum (working range US$19–29; validate against willingness-to-pay interviews) | Platform per-workload flat pricing (A$295–795/mo) |
| **UAP Cloud** (SaaS) | Same plane, hosted on Miller-Tech cells | Per seat per month, monthly rolling, billed via Pay2U | Platform shared tiers; subscribe-online flow already live |
| **Enterprise / dedicated** | Dedicated cell or on-prem plane, SSO/SCIM, custom retention, compliance packs, DR drills, monthly operating review | From platform dedicated-cell precedent (A$3,500/mo + onboarding fee, 12-month minimum) | Platform dedicated cells |

Principles, inherited from the platform's pricing copy so the brand stays consistent:

- **Published numbers, flat by plan, ceilings enforced loudly** (a budget that exceeds a plan's ceiling fails at the gate, it does not silently bill — this is already how platform resource clamping speaks).
- **Currency:** recommend US$ for the SaaS/Teams product (global dev-tooling market), A$ retained for AU consulting and dedicated cells. Decision recorded in §14.
- **Consulting remains the top of funnel and converts to install/enablement engagements** — the assessment (article 8) becomes a productized onboarding with a fixed fee, feeding Teams/Cloud subscriptions.
- **Claims discipline extends to pricing pages:** every figure ships with scope; no multipliers without the rider; `check-claims.py`-style guards on the product site from day one.

---

## 9. Go-to-market

1. **Sequencing with the blog:** the series' CTA ladder already runs blog → consulting. Insert the product rung: blog → consulting *or* npm → core → org need → Teams/Cloud. Article 8 gets a closing product note when the plane ships ("the engagement now installs a product; the line is yours on day one, not day 90").
2. **OSS distribution:** `uap setup` stays the activation moment; add an honest "control plane" status line in the dashboard (visible, not nagging). No dark patterns: the boundary is org-features, and the copy says exactly what they are.
3. **Existing buyers first:** the consulting pipeline (enquiries already referencing the series) is the pilot pool. Assessment clients get the plane at cost during Phase 1 dogfood; their day-30/90 reports become the case studies.
4. **Regulated-industry wedge:** finance/utilities/insurance (the site's stated industries) buy audit evidence and budget control before they buy throughput. Lead with §6.2 and §6.6, not the multiplier.
5. **Community:** ATTRIBUTION.md convention, honest COMPARISON.md, and the self-hosted-first posture are the credibility assets vs. point-tool vendors. Publish the event schema v0 as an open spec (it is protocol-shaped, like UAP itself) — an open audit-event format is a standards play that costs little and compounds.

**Competition window:** per `COMPARISON.md` and `PRODUCT_NAMING.md`, the agent-governance category filled fast in 2026 (Ratchet, Corral, Muster, Bosun, Keel; CodeRabbit/Greptile at the PR stage; OPA for general policy). UAP's defensible differences: cross-harness (no vendor can be neutral about their own harness), deterministic enforcement pre-PR (not review-after), the verification loop tied to the customer's real gates, and honest measurement machinery. Move while the neutral seat is still open.

---

## 10. Licensing and repo strategy

- **Core: MIT, unchanged.** No license games, no CLA wall initially; keep contribution friction near zero. Revisit a lightweight CLA only if code needs to flow into the plane (avoid that by keeping the plane a separate codebase consuming core's public API).
- **Control plane: commercial.** Default recommendation: proprietary source, enterprise license for self-host (like the platform's dedicated-cell posture), i.e., customers get the code under NDA/contract. Revisit FSL/BSL source-available licensing once there is revenue and a support obligation; do not spend the decision now.
- **The protocol stays open:** hook contract, policy semantics, event schema, memory/pattern/skill formats remain open specs under the UAP name. The brand promise in article 8 ("the protocol is open, the tooling is yours") must survive every future pricing decision.
- **Anti-goal guardrails:** UAP does not become a harness, a hosted memory API (Mem0/Zep territory), or an orchestration framework (LangGraph territory). It stays the discipline layer; the plane stays the org layer.

---

## 11. Risks and mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Harness vendors absorb governance (richer hooks, CI droids, policy UIs) | High | Cross-harness neutrality + audit evidence as the wedge; regulators and platform teams prefer a neutral layer over a harness feature |
| Category window closes (naming doc: spaces claimed within one cycle) | Medium-high | Phase 1 in weeks, pilots from the existing consulting pipeline, dogfood from day one |
| Open-core backlash ("they'll paywall the good parts") | Medium | The boundary is org-features only; publish the free/paid matrix (§5) in the README; keep core releases meaty and visible |
| Consulting cannibalization | Low | The engagement gets faster and cheaper to deliver (margin up) and gains a recurring attach; sell-through, not trade-off |
| Solo/small-team delivery bandwidth | High | Phased roadmap with ruthless MVP (§12); the plane reuses the platform's identity/observability/billing rather than building them |
| Claims risk (a number ships unscoped) | Medium | Product site under the same mechanical claims guard as the platform site from day one |
| Fail-closed plane outage halts floors | Low | Degradation matrix shipped with the client: org policy cached locally with TTL; telemetry spools; core floors without the plane never notice |

---

## 12. Roadmap with gates and measurable targets

**Phase 0 — decisions and seam freeze (2 weeks)**
- Owner decisions from §14 recorded; event schema v0 and sink interface spec'd; plane repo scaffolded; pricing interviews with 3–5 consulting-pipeline contacts.
- Gate: schema v0 reviewed as an ADR in the UAP repo (the decision-record habit the platform already runs).

**Phase 1 — control plane MVP (6–8 weeks)**
- Scope: event sink + central logs (OpenObserve), audit store + evidence export, OIDC SSO (Zitadel), team namespaces for memory + patterns/skills/droids, per-team budget gates, cost dashboard. Self-hosted container.
- Dogfood gates (self-measurable, measured on Miller-Tech's own floors, the artifact itself):
  - ≥ 95% of gate decisions on the UAP/platform floors land in the central audit store within 30 days of deploy (the rest accounted for).
  - Audit query p95 < 2 s over a 90-day corpus.
  - Zero floor-days where a floor ran with the plane reachable but unlogged.
  - Budget gate: a synthetic overrun on a dev floor is blocked/degraded 100% of the time, and the block appears in the audit store.
- Exit: one external pilot (consulting client) running Teams tier for 30 days.

**Phase 2 — org scale (8–12 weeks)**
- Scope: org routing policy with staged rollout, delivery portfolio + ETA rollups, org merge queue, policy-pack distribution with approval workflow, chargeback exports.
- Gates: routing policy rollout to the full Miller-Tech floor with zero unapproved exceptions; portfolio dashboard matches the completion ledger exactly (reconciliation test); one cross-repo batched delivery landed through the org queue.

**Phase 3 — UAP Cloud + marketplace (quarter)**
- Scope: SaaS cell on the platform (Pay2U billing, per-workload subscription), subscribe-online flow, curated skills/droids marketplace with the review workflow, compliance export packs productized.
- Gates: first self-serve subscription converts without human touch; SLO stated with the platform's honesty wording (99.9% internal objective); DR drill evidence produced for the SaaS cell.

**Continuous:** every phase ships under UAP's own gates (worktree, paired review, evidence-bound) — the product's development process is its first case study.

---

## 13. How we know it is working

| Horizon | Signals (leading → lagging) |
|---|---|
| 90 days | Phase 1 dogfood gates green; 1 external pilot live; ≥ 3 pricing interviews done; event schema published as open spec |
| 6 months | 5+ Teams installs (self-host) incl. 2 non-consulting customers; ≥ 50% of consulting engagements attaching a plane install; first Cloud subscriptions |
| 12 months | Recurring revenue ≥ 2× the consulting line's margin contribution; 2 published case studies with scoped numbers; OSS adoption growing (npm downloads trend) with core release cadence maintained |

Failure modes to watch (from article 8, applied to ourselves): the culture that will not enforce kills the enterprise product too — pilots whose floors bypass gates get flagged in the assessment, not discovered at day 60. And if the honest answer for a prospect is "your work is judgement-shaped, the line will not move your numbers," we say so and sell them nothing, because the claims culture is the brand.

---

## 14. Decisions needed from the owner (best-guess defaults recorded)

| Decision | Default assumed in this plan | Alternative rejected |
|---|---|---|
| Rename UAP before commercializing | **No** — keep `uap` CLI + `@miller-tech/uap`; plane named "UAP Control Plane"; revisit `PRODUCT_NAMING.md` shortlist (Pointsman/Brakevan) only after Phase 1 revenue | Rename now: costs the window the naming doc itself warns about; brand equity in the blog series and npm points at UAP |
| Core license change | **None** — MIT stays, uncrippled | Source-available core: kills the adoption funnel the strategy depends on |
| Plane license | **Proprietary + enterprise self-host agreement** | FSL/BSL now: premature; revisit post-revenue |
| Pricing currency | **US$ for Teams/Cloud, A$ for consulting/dedicated** | A$ everywhere (smaller global reach); US$ everywhere (breaks platform consistency) |
| First paid tier | **Self-hosted Teams** (regulated buyers want on-prem first) | SaaS first: faster billing but the wedge industry wants on-prem evidence stores |
| Billing rails | **Pay2U subscriptions** (already live, dogfoods the platform) | External billing: splits the story and the stack |
| Event schema ownership | **Open spec under the UAP name** (standards play) | Proprietary format: closes an integration moat to save nothing |

Each default is reversible; none of them blocks Phase 0 starting.

---

## Appendix: sources

- UAP: `README.md`, `docs/INDEX.md`, `docs/reference/COMPARISON.md` (honest gaps, category landscape), `docs/design/PRODUCT_NAMING.md` (category-closure timing), `docs/guides/MEMORY.md` (backend factory seam), `docs/guides/POLICIES.md` (audit trail), `package.json` (MIT, scale).
- Platform: `website/BLOG-PLAN.md` (audience priority, thesis, claims rules), `website/copy/blog/` series (esp. `installing-the-line.md`, `honest-multiplier.md`, `agents-staff-org.md`), `website/copy/consulting.md` (current monetization), `website/copy/platform/pricing.md` + `capabilities.md` (pricing precedents, identity/observability planes, evidence pipelines).
