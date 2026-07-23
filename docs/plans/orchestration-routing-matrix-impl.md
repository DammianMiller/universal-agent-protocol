# Implementation Plan (end-to-end): Adaptive Orchestration + Self-Optimizing Deliver

Companion to `orchestration-routing-matrix.md` (Part I routing/graph, Part II DSPy/MIPRO/GEPA).
This document turns that design into **8 dependency-ordered, PR-sized build steps**, each with the
exact files/types to touch, signature diffs, new files, test cases, acceptance criteria, and a
`uap deliver` invocation. Status: **build-ready, awaiting go**.

## Execution model

- **One worktree + one PR per step** (`uap worktree create <slug>` → build → `uap worktree pr`).
- **Build each step via `uap deliver`** with a written spec; do not hand-edit core files. The
  harness's own gates (self-gate, verifier ladder, execution gate) verify each step — dogfooding.
- **Test-first**: every step ships ≥2 new vitest cases in `test/` (completion gate #1) plus
  `tsc --noEmit` clean, `npm test` green, `npm run build` green.
- **Backward compatibility is a hard invariant** for every step: existing presets/configs/callers
  keep working. Each step lists its compat assertion.
- **Version bumps** on the feature branch: `feat` → `version:minor`, pure refactor/fix →
  `version:patch`.

## Dependency DAG (build in this order)

```
S1 Verify-hardening ──────────────┐        (correctness; no deps; SHIP FIRST)
S2 Unified complexity ──┬─────────┤
                        │         │
S3 Per-phase matrix ────┼──┬──────┤        (needs S2)
                        │  │      │
S4 Effort dial ─────────┘  │      │        (needs S2,S3)
S5 Per-phase escalation ───┘      │        (needs S3)
S6 GEPA reflect phase ────────────┘        (needs S3,S5)
S7 Graph upgrades                          (needs S4)
S8 MIPRO prompt-opt                        (needs S3; largest; last)
```

Rationale: S1 is an independent correctness fix and ships first. S2 is the foundation everything
routing-related needs. S3 is the matrix itself. S4/S5 sit on S3. S6 (reflect) needs the matrix +
escalation. S7 (graph) is independent of routing but needs the effort dial to gate it. S8 (prompt
optimization) is largest and benefits from the telemetry the earlier steps emit.

---

## S1 — Verification hardening (Feature C) · correctness · SHIP FIRST

**Goal:** enforce Principle 3 ("the model cannot verify itself"): a distinct judge model by
default, fail-closed when the judge is the sole gate, and a provenance banner.

**Files & changes**
- `src/cli/deliver.ts:1225-1269` — `resolveEvaluatorPreset`/`judgeExecutor`: stop defaulting the
  judge to the generator (`:1229`). New precedence: explicit `--judge-model` > evaluator preset >
  **a cheaper distinct model** (e.g. `haiku-4.5`) > (last resort, single-model-offline) generator
  with a logged warning.
- `src/delivery/mission-acceptance.ts:45-93` — make "judge is sole convergence target ⇒ parseError
  becomes `passed:false`" (`:52`) a documented, tested invariant; extend the vision cross-check
  fail-open note.
- `src/delivery/acceptance-judge.ts:521` `createAcceptanceChurnBreaker` — on repeated parse
  failures, **flag** (surface `stallReason`) rather than silently pass.
- New: `src/delivery/verification-provenance.ts` — a one-line banner
  `verify: exec=<model> judge=<model> distinct=<bool> failOpenGates=[...]` emitted at delivery end.

**Signature diffs**
```ts
// deliver.ts — judge resolution
function resolveJudgeExecutor(opts: {
  explicit?: string; evaluatorPreset?: string; generator: string; offline: boolean;
}): { executor: LoopExecutor; model: string; distinct: boolean };
```

**Tests** (`test/delivery/verification-hardening.test.ts`)
- judge defaults to a **distinct** model when generator is the only configured model (asserts
  `distinct === true`, model ≠ generator).
- sole-gate + judge parseError ⇒ `passed:false` (fail-closed), not fail-open.
- churn breaker surfaces a stallReason after N parse failures instead of passing.
- provenance banner reports `distinct=false` only in the offline single-model fallback.

**Acceptance:** no path lets the generator be the *sole* grader of its own output unless offline;
banner present on every delivery; existing deliveries unaffected when an evaluator is configured.

**Compat:** configs with an explicit evaluator/escalate model behave identically.

**`uap deliver` spec:** "Harden deliver verification: judge model must be distinct from the
generator by default (fall to haiku-4.5, warn if forced to generator offline); fail-closed when the
acceptance judge is the sole gate; add a verification-provenance banner. Add tests."

---

## S2 — Unified complexity classifier · foundation

**Goal:** one complexity signal replacing the two disconnected systems; restore `critical`.

**Files & changes**
- New: `src/models/complexity.ts` — `Tier`, `ComplexitySignal`, `classifyComplexity` (cheap-first
  heuristic; model call only in the ambiguous band).
- `src/models/router.ts:190` `classifyTask` → thin adapter over `classifyComplexity`.
- `src/utils/query-complexity.ts` `measureQueryComplexity` → thin adapter (keep the 3-level public
  shape, derive from `Tier`).
- `src/cli/deliver.ts:373` — delete `COMPLEXITY_TO_TIER`; call `classifyComplexity` directly
  (preserves `critical`).

**Signatures** — as in design §4.1 (`Tier`, `ComplexitySignal { tier, score, reasons, source }`,
`classifyComplexity(input)`).

**Tests** (`test/models/complexity.test.ts`)
- golden instruction set → expected tier (incl. a `critical` case that the old bridge dropped).
- heuristic path takes **no model call** for clear cases (overhead regression guard — assert the
  model-call spy is not invoked).
- `router.ts`/`query-complexity.ts` adapters return values consistent with the unified classifier.

**Acceptance:** `critical` survives end-to-end; the two old classifiers agree via the adapters;
zero model calls on clearly-simple/clearly-complex inputs.

**Compat:** `classifyTask`/`measureQueryComplexity` public signatures unchanged.

**`uap deliver` spec:** "Add src/models/complexity.ts with a unified cheap-first complexity
classifier (trivial|low|medium|high|critical). Make router.ts classifyTask and
query-complexity.ts measureQueryComplexity delegate to it. Delete COMPLEXITY_TO_TIER in deliver.ts
so critical is preserved. Tests for critical preservation + no-model-call on clear cases."

---

## S3 — Per-phase × per-tier routing matrix · the matrix

**Goal:** widen `RoutingPreset.tiers` from one model per tier to per-phase escalation chains;
ship an `adaptive-tiered` preset. Backward compatible with string tiers.

**Files & changes**
- `src/models/types.ts` — add `ModelChain`, `PhaseModels`, `Phase`; widen
  `RoutingPreset.tiers` to `Partial<Record<Tier, string | PhaseModels>>`; add `resolvePhaseChain`;
  widen `resolvePresetModel` (add `phase?`) and `tiersToRoutingMatrix`; widen
  `MultiModelConfigSchema.routingMatrix` per-tier value to accept `PhaseModels`.
- `src/models/types.ts` `RoutingPresets` — add `adaptive-tiered` (design §4.2 table).
- `src/cli/deliver.ts:386` `resolveTierModel` — thread a `phase` param; call `resolvePhaseChain`.
- `src/cli/model.ts:583` `routingUseCommand` — materialize the per-phase matrix into `.uap.json`.

**Signatures** — design §4.2 (`ModelChain = string[]`, `PhaseModels {plan?,execute?,review?,
fallback?}`, `resolvePhaseChain(preset,{complexity,phase}): ModelChain`).

**Tests** (`test/models/routing-matrix.test.ts`) — the highest-priority coverage (pure seam):
- every tier×phase resolves; **legacy string tier** resolves identically to today.
- missing phase (e.g. no `plan` at `low`) ⇒ empty chain ⇒ phase skipped.
- `resolvePresetModel` primary == `resolvePhaseChain[0]`.
- `tiersToRoutingMatrix` round-trips the `adaptive-tiered` preset.

**Acceptance:** `uap model routing use adaptive-tiered` writes a valid per-phase `.uap.json`;
legacy presets (`cost-tiered`, `sonnet-5-tiered`) unchanged.

**Compat:** string-form tiers and `{planner,executor}` routingMatrix entries still load.

**`uap deliver` spec:** "Widen RoutingPreset.tiers to per-phase model chains (PhaseModels), add
resolvePhaseChain, update resolvePresetModel/tiersToRoutingMatrix, add adaptive-tiered preset,
thread phase through deliver.ts resolveTierModel. Backward compatible with string tiers. Full unit
tests on the resolvers incl. legacy compat."

---

## S4 — Effort-dial orchestration profiles

**Goal:** one profile (from the classifier) gates orchestrator chain length, decompose, review
fan-out, self-gate strictness, maxTurns, escalation scope. Trivial/low ⇒ near-zero overhead.

**Files & changes**
- New: `src/coordination/effort-profile.ts` — `EffortProfile` + `profileForTier(tier): EffortProfile`
  (design §4.3 table).
- `src/coordination/expert-orchestrator.ts:42,63,140` — `OrchestratorOptions.profile`; emit a
  1–2 step chain for trivial/low instead of `DEFAULT_PHASES`.
- `src/delivery/decompose.ts:82` `shouldDecompose` → `profile.decompose`.
- `src/cli/deliver.ts:469` — replace `applyAutoPlan` aid toggles with `profileForTier`;
  `hasExplicitAidFlags` still overrides.

**Tests** (`test/coordination/effort-profile.test.ts`)
- trivial task ⇒ orchestrator emits ≤2 steps, `decompose=false`, no review panel.
- critical task ⇒ decompose=true, review panel, full escalation scope.
- explicit user aid flags override the profile.

**Acceptance:** a typo-fix task runs plan-less/review-less/decompose-less; a large task keeps
today's full machinery.

**Compat:** default profile for `medium` reproduces current behavior.

**`uap deliver` spec:** "Add EffortProfile keyed by complexity tier; gate expert-orchestrator chain
length, decompose, review, maxTurns, escalation scope through it; replace applyAutoPlan toggles.
Trivial/low skip plan+review+decompose. Tests for trivial-minimal and critical-maximal."

---

## S5 — Per-phase escalation (hybrid policy)

**Goal:** each phase escalates on its own chain; final rung defers to capability-driven selection.

**Files & changes**
- `src/delivery/repair-escalation.ts:30` `resolveEscalateModelId` → `resolveEscalation({preset,
  tier,phase,rung}): {model, policy:'fixed'|'capability'}` (hybrid).
- `src/delivery/escalation.ts:76` `defaultEscalationLadder` → `escalateByPhase` keyed by `Phase`;
  the last tier calls `unified-router` (capability) instead of a fixed model.
- `src/delivery/convergence-loop.ts:172` — `IterationDirective.switchExecutor` already exists;
  route per-phase executors through it. Add review-phase escalation via `criticFactory` (`:298`).
- `src/cli/deliver.ts:1445-1471` — build phase-keyed escalate executors instead of one.

**Tests** (`test/delivery/per-phase-escalation.test.ts`)
- stagnation in execute advances the **execute** chain; gate-fail in review advances **review**.
- chain exhaustion ⇒ `policy:'capability'` (unified-router picks stronger).
- `review !== execute` invariant holds at each rung (Generator≠Evaluator).

**Acceptance:** a stalled execute phase escalates without changing the review model, and vice
versa; final rung is capability-driven.

**Compat:** presets without per-phase chains fall back to the single `escalateModel` behavior.

**`uap deliver` spec:** "Generalize deliver escalation to per-phase chains with a hybrid policy
(fixed chain rungs, capability-driven final rung). Wire phase-keyed executors through
IterationDirective.switchExecutor and criticFactory. Enforce review!=execute. Tests per phase."

---

## S6 — GEPA reflect phase (Feature B)

**Goal:** upgrade the critic from fix-list to approach-rewrite; add a `reflect` matrix phase and a
Pareto archive; run reflect before model escalation.

**Files & changes**
- `src/delivery/critic.ts:31` — extend `Critic`/`Critique` with optional
  `approachRewrite: { why: string; newInstruction: string }`.
- `src/delivery/convergence-loop.ts:162` — add
  `IterationDirective.mutateInstruction?: (ctx: PromptContext) => PromptContext`; loop applies it
  before the next `PromptBuilder` call.
- New: `src/delivery/reflect.ts` — reflect turn + a small **Pareto archive**
  `ReflectArchive` of best-K `(instruction, score)`; reseed from archive on stagnation.
- `src/delivery/escalation.ts:76` — insert a **reflect tier** before the switch-model tier.
- `src/models/types.ts` `PhaseModels` — add `reflect?: ModelChain` (defaults to a strong distinct
  model).

**Tests** (`test/delivery/reflect.test.ts`)
- a failing run produces an `approachRewrite`; `mutateInstruction` changes the next prompt.
- reflect fires **before** model escalation on stagnation.
- Pareto archive keeps best-K and reseeds (doesn't collapse to the latest candidate).

**Acceptance:** on a task where the *approach* (not the model) is wrong, a reflect turn recovers
without escalating the model.

**Compat:** presets without `reflect` skip it (phase omitted ⇒ no reflect turn).

**`uap deliver` spec:** "Add a GEPA-style reflect phase: extend Critic to emit an approach rewrite,
add IterationDirective.mutateInstruction feeding PromptBuilder, add a Pareto reflect archive, run
reflect before model escalation on stagnation, add reflect to PhaseModels. Tests."

---

## S7 — Graph-engineering upgrades (Part I §4.5)

**Goal:** edge-test decomposition + parallel fan-out, layered fan-in, false-independence via the
coordination DB, silent-node-failure reconciliation.

**Files & changes**
- `src/delivery/decompose.ts:301` `planDeliveryPhases` — apply the edge test; default independent
  nodes to no edge; mark fan-out groups.
- `src/delivery/epic-controller.ts` `runEpics` fan-in — layered summarization when node count > N;
  reconcile completed vs expected, flag/rerun gaps.
- New: `src/delivery/coord-edges.ts` — read the always-on file-coordination DB; inject synthetic
  edges between nodes predicted to write the same file (serialize).
- `src/delivery/task-orchestrator.ts` — honor synthetic edges in scheduling.

**Tests** (`test/delivery/graph-upgrades.test.ts`)
- two nodes writing the same file ⇒ synthetic edge ⇒ serialized (no parallel write).
- node count > threshold ⇒ layered fan-in path taken.
- a dropped node ⇒ fan-in flags the gap (does not synthesize partial output).

**Acceptance:** independent nodes fan out; shared-file nodes serialize; missing nodes surface.

**Compat:** small missions (below fan-out threshold) run exactly as today.

**`uap deliver` spec:** "Add graph-engineering to decompose/epic-controller: edge-test fan-out,
layered fan-in above N nodes, synthetic write-conflict edges from the coordination DB, and
completed-vs-expected node reconciliation at fan-in. Tests for each."

---

## S8 — MIPRO prompt-optimization (Feature A) · largest · last

**Goal:** point the existing `uap tune` optimizer at prompts, not just flags.

**Files & changes**
- `src/self-tuning/flags.ts:140` — add `TUNABLE_PROMPTS` (named fragments:
  `OUTPUT_CONTRACT`, `AUTONOMY_CONTRACT`, `systemContent`, per-gate critic personas) with candidate
  variants + `dependsOn`; mark hard-safety constants **`frozen`** (non-tunable).
- `src/delivery/convergence-loop.ts:499` `defaultPromptBuilder` — read the active variant from the
  `TuningProfile` instead of hard-coded constants.
- `src/self-tuning/llm-tuner.ts:225` `proposeTuning` — allow prompt-variant selections in
  `TuningProposal.changes`; (tier 2) MIPRO-style generated variant text scored by
  `compositeQuality`.
- Reuse unchanged: `compositeQuality` (`benchmarks/paired/types.ts:207`),
  `buildPairedTuningValidator` (`paired-validator.ts:85`), GP-BO (`search-reducer.ts`),
  `TuningProfileStore` (`tuning-profile.ts`).

**Tests** (`test/self-tuning/prompt-optimization.test.ts`)
- `TUNABLE_PROMPTS` variant selection flows through `defaultPromptBuilder` from a profile.
- `frozen` fragments are never mutated by the proposer.
- held-out split guards against overfitting (a variant that only wins on the training arm is
  rejected by `decideTuning`).

**Acceptance:** `uap tune` can improve `compositeQuality` by selecting prompt variants; safety
constants stay frozen; no regression on held-out tasks.

**Compat:** with no prompt variants configured, `defaultPromptBuilder` emits today's constants.

**`uap deliver` spec:** "Extend uap tune to optimize prompts: add TUNABLE_PROMPTS (variants +
frozen safety fragments), make defaultPromptBuilder read the active variant from the TuningProfile,
allow the proposer to select prompt variants, reuse compositeQuality + paired-validator +
GP-BO unchanged. Tests incl. frozen-fragment protection and held-out overfitting guard."

---

## Cross-cutting: telemetry (enables self-tuning of the matrix)

Land alongside S3–S5: record `(tier, phase, model, rung, outcome, cost, latency)` per turn
(reuse `successRateFor` + `uap tune`). This is the training signal that lets S8 optimize the matrix
itself and the classifier's ambiguous band shrink over time.

## Global acceptance (end-to-end, after all steps)

1. A trivial task runs with 1 model, no plan/review/decompose, ≤2 turns.
2. A critical task decomposes into a graph, runs a review panel + reflect, and escalates per phase.
3. No task lets the generator be the sole grader of its own output (offline excepted, warned).
4. `uap tune` improves `compositeQuality` via prompt variants without eroding frozen safety rules.
5. All existing presets/configs/callers behave identically (backward-compat suite green).

## Rollout logistics

- 8 PRs, each green through the CLAUDE.md completion gates (new tests, `npm test`, `npm run build`,
  `tsc --noEmit`, version bump, self-review, expert-review artifact).
- Ship order: **S1 → S2 → S3 → {S4, S5} → S6 → S7 → S8** (S4/S5 parallelizable after S3).
- Each PR carries a backward-compat assertion in its description.
- Feature-flag risky steps (S6 reflect, S8 prompt-opt) behind `.uap.json` toggles defaulting off,
  so they ship dark and enable per-project.
