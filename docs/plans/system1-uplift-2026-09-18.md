# UAP System-1 Uplift Plan — 2026-09-18

Status: APPROVED for implementation (plan PR → implementation PRs)
Scope decision: Wave 0 (all five) + Wave 1 (1.1–1.4). Backend decision: **local-only
classifier, airgap-pure, trained from UAP telemetry** (no hosted Jev dependency).

## 1. Source analysis

Ten external signals were analyzed. They converge on one architectural shift:
split System 2 (slow generative reasoning) from System 1 (fast structured
decisions), and bind every gate to evidence.

| Source | Signal |
| --- | --- |
| x.com/sydneyrunkle (LangChain) | TypeSafe Jev "System One" model: state + typed questions (choice/score/noul), parallel evaluation, calibrated probabilities. Killer apps: model routing and AutoMode (pre-execution tool-call risk classification). |
| x.com/JoshARosen + thruwire/foreman | Foreman: semantic supervision of coding agents. 9 noul dimensions (worker_stuck, work_off_track, implementation_complete, tests_sufficient, requirements_satisfied, needs_verification, meaningful_progress, needs_human, ready_to_finish) against bounded observations (20k-char diff, 12k tails, 30 events). **Deterministic policy owns all actions** (CONTINUE/START/STOP/RETRY/VERIFY/FINISH/ESCALATE); the model only assesses. Debounced loop, persisted state + events.jsonl, safety-first action ordering. |
| x.com/decapostos | Split thinking from next-action selection; fewer protocol round trips → fewer drift points. |
| tamaratran/fast-jev-compaction | Replace lossy compaction summaries with per-tool-call keep/truncate/drop decisions. Kept content stays **verbatim**; pinned recency; staged state fitting; fallback to summary when reduction < 25%. |
| mrinalwadhwa/fluent | Evidence-bound factory: EARS behavior specs with `Test:` refs; candidate-bound test evidence (exact command, reject stale/mismatched, fail closed); two queues (human attention vs compute capacity); Learner → project Expertise; provider liveness guards + resumable Attempts; post-merge review. |
| khuynh22/agent-dev-team | Tier ceilings T0–T3 (confidence never raises a ceiling); structured HANDOFF/BRIEF escalation packets; routing evals (rank-1 97%, CI-enforced, planted traps); restated-count validation in CI. |
| alibaba/open-code-review | Hybrid review: deterministic rule pipelines first (NPE, thread-safety, XSS, SQLi), LLM agent second; per-group token budgets with grace round; resumable sessions; delegation mode. |
| senoff/self-hosted-ci-runner | Capacity policy: provision N+1, run N; per-runner swap/scratch/reaper; GREEN/RED/DARK health; single-purpose box. Same discipline as the 2026-09-18 llama.cpp OOM fix. |
| NeoLabHQ/context-engineering-kit | Measured reliability ladder: accuracy vs files-changed vs token cost per technique (reflect +1–3k tokens; do-and-judge 1.5–3x; SDD+human 95–99% at 5–35x). Reflexion/memorize/critique loops; subagent-per-task against context rot. |

## 2. UAP gap assessment

UAP already exceeds these projects in: deterministic quality-metrics gate,
proxy enforcer suite (deliver autoroute, gate evidence, confidence escalation,
stuck-break), worktree/mission/checkpoint infrastructure, and local-first
serving. Gaps, in leverage order:

1. Every UAP decision point is either a heuristic or a full LLM call — no fast,
   calibrated middle layer for routing, risk, stuckness, or compaction.
2. Proxy compaction is summarization/threshold based — lossy.
3. Deliver gates check artifacts, not evidence-bound behavior specs.
4. Technique selection in the decision loop is unquantified (no reliability/cost
   ladder).
5. Droids have no capability ceilings or handoff contracts.
6. Visual gating covers design tokens only; no captured visual evidence bound
   to UI changes.

## 3. Design principles (all waves)

- **Policy is deterministic; models only assess.** Thresholds and actions live
  in reviewed code. A classifier can be wrong; the policy bounds the blast
  radius (Foreman's central lesson).
- **Fail closed.** If the classifier is unavailable, gates keep their current
  heuristic behavior; nothing gets *looser* because the model is down.
- **Airgap-pure.** No hosted classifier dependency. The System-1 model is
  trained and served locally (see §6).
- **Evidence-bound.** Every gate emits machine-checkable evidence bound to the
  candidate SHA; stale or mismatched evidence is rejected (Fluent's rule).
- **Measured.** Every uplift lands with before/after numbers from UAP's own
  benchmark suites; claims without measurements do not merge.

## 4. Wave 0 — quick wins (each lands as its own PR)

### 0.1 Reliability ladder in the decision loop
- Add a measured technique-selection table to the CLAUDE.md decision loop
  (THINK step): task complexity × files-touched → technique (direct /
  reflect / judge / SDD) with token-cost ranges.
- Calibrate on `benchmarks/` suites; publish the table in
  `docs/performance/` with the raw results.
- Acceptance: table exists, numbers reproduced by a suite run, decision loop
  references it.

### 0.2 Deterministic review pre-pass
- A ruleset scanner (secrets, injection patterns, NPE/null deref, thread-safety
  smells) runs before the three LLM reviewers in the parallel review protocol;
  reviewers receive pre-filtered, line-anchored findings.
- Reuse the quality-gate scanner infra where possible.
- Acceptance: pre-pass fires in `.uap/reviews/<branch>.json`; reviewer prompt
  embeds findings; at least 2 fixture vulnerabilities caught without an LLM.

### 0.3 Visual gate for UI changes
- Any diff touching UI files requires before/after captures
  (agent-browser/tuistory/pty-capture) attached to the review artifact;
  `uap design check` remains the token enforcer.
- Acceptance: completion gate 7 refuses DONE on UI diffs without captures;
  artifact embeds capture paths.

### 0.4 Routing evals for pattern router + droid registry
- TF-IDF/embedding rank-1 eval over every skill/droid description with planted
  traps and negatives; CI-enforced threshold (start at 90% rank-1).
- Validates `.factory/patterns/index.json` and the droid registry stay
  separable as entries are added.
- Acceptance: `npm run eval:routing` (or equivalent) exists, runs in CI, and
  catches a deliberately degraded description.

### 0.5 Capacity policy as code
- Generalize the 2026-09-18 llama.cpp OOM fix discipline: every UAP-managed
  service declares a resource budget, headroom policy, and GREEN/RED/DARK
  health definition; `uap doctor` (or monitor) reports violations.
- Acceptance: the gsq-rco server and monitor are the reference
  implementations; policy file under `config/`; doc in `docs/guides/`.

## 5. Wave 1 — the System-1 layer (each lands as its own PR)

### 1.1 Semantic supervisor for deliver missions
- New `uap supervise` loop watching `uap deliver` missions: 9 assessment
  dimensions (Foreman's set, adapted) against bounded observations
  (git status, bounded diff, output tails, recent events, prior assessment,
  attempt/failure counts, elapsed time).
- Deterministic policy with explicit, reviewed thresholds; safety-first action
  ordering: human-need > iteration bounds > off-track/stuck > retry >
  completion > verification > continue. Actions: CONTINUE / STOP / RETRY /
  VERIFY / FINISH / ESCALATE.
- Debounced (≥5s) and periodic (30s) assessment; persisted state.json +
  events.jsonl per run; oscillation guards (verification cannot loop).
- Acceptance: a seeded stuck-mission fixture is stopped; a healthy mission is
  never interrupted; policy branches unit-tested (offline, fake classifier).

### 1.2 Verbatim decision compaction in the proxy
- Replace the lossy prune/summarize path in `anthropic_proxy.py` with
  per-tool-call keep/truncate/drop decisions: pinned first + recent messages,
  staged state fitting, truncation keeps a head + note, kept content verbatim.
- Fallback to the current summarizer when reduction is insufficient or the
  classifier is unavailable.
- Acceptance: existing enforcer/compaction test suites pass; new tests cover
  keep/truncate/drop decisions, pairing integrity (no orphan tool_result), and
  fallback; measured context reduction ≥ current path on fixtures.

### 1.3 AutoMode pre-execution risk classification
- Calibrated risk classification of tool calls before dispatch, ahead of the
  current verb/regex heuristics in the enforcer chain. Classifier output is
  advisory to the deterministic policy; heuristics remain the floor.
- Acceptance: destructive/fixture tool calls classified with calibration
  report (per-class precision/recall on held-out telemetry); heuristic tests
  unaffected; latency overhead < 50ms local.

### 1.4 Evidence-bound merge candidates
- Deliver missions produce merge candidates whose gate evidence is bound to
  the candidate SHA: exact test commands, outputs, timestamps; stale, missing,
  malformed, or SHA-mismatched evidence is rejected (fail closed).
- Acceptance: gate evidence enforcer rejects a forged/stale artifact in tests;
  PR flow requires candidate-bound evidence for ship.

## 6. Local System-1 classifier (the airgap-pure backend)

Decision: **no hosted dependency.** The classifier is trained and served
locally, and every Wave 1 consumer talks to it through one interface
(`uap classify` / library call) so the backend can evolve without touching
policy code.

- **Training data:** UAP's own telemetry — `project_telemetry` events, gate
  decisions and outcomes, escalation results, stuck/attractor events,
  deliver-mission histories, and incident records (e.g., the 2026-09-18 OOM
  timeline). This dataset is the moat: nobody else has UAP's decision-outcome
  pairs.
- **Model form (v1):** small, CPU-fast, calibrated. Start with an embedding +
  calibrated head (nomic-embeddings already deployed; logistic/isotonic on
  top) for noul/score/choice questions. Evaluate against a distilled small
  LLM head only if the simple model underperforms on held-out telemetry.
- **Calibration:** per-dimension reliability curves and thresholds derived
  from held-out outcomes; thresholds ship as reviewed policy config, not
  model output.
- **Serving:** local process (CPU), <50ms p95 per assessment batch; questions
  batched per state like Jev's parallel evaluation.
- **Interfaces:** `assess(state, questions) -> {name: {value, probability,
  confidence}}` matching the noul/choice/score shapes, so Jev-compatible
  request/response fixtures work unchanged.
- Acceptance: calibration report committed; supervisor/compaction/AutoMode all
  run against the local backend with policy tests offline.

## 7. Sequencing and PR plan

1. This plan (docs PR).
2. Wave 0 PRs in order: 0.4 (evals infrastructure) → 0.2 (review pre-pass) →
   0.3 (visual gate) → 0.1 (ladder, needs bench runs) → 0.5 (capacity policy).
3. Local classifier foundation (§6) — prerequisite for Wave 1.
4. Wave 1 PRs: 1.1 → 1.2 → 1.3 → 1.4 (1.4 is independent and may parallel).

## 8. Risks and open questions

- **Classifier quality is unproven** (Foreman says the same about Jev).
  Mitigation: shadow mode first — classifier assesses, heuristics decide,
  divergence logged; promotion to active only after measured agreement.
- **Compaction regressions are silent.** Mitigation: verbatim guarantee +
  reduction floor + fallback; replay fixtures from real sessions.
- **Gate fatigue.** Every new gate must have an escape hatch and a measured
  false-positive rate, or it will be bypassed (UAP_QUALITY_GATE_OFF exists for
  a reason).
- **Scope.** Wave 0 items are independent; Wave 1 items share the classifier
  PR — land it small (one dimension end-to-end) before generalizing.

## 9. Later waves (not approved yet; recorded for the roadmap)

- Wave 2: tier ceilings + HANDOFF/BRIEF droid contracts; EARS behavior-spec
  layer; two-queue scheduling dashboard; post-merge review loop.
- Wave 3: train a dedicated small System-1 model (beyond embedding+head);
  publish UAP's measured reliability ladder as the external benchmark claim.
