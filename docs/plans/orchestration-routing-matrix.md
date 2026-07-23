# Design: Complexity-Scaled Orchestration + Per-Phase Model Routing Matrix

Status: **PROPOSED** (design only — no implementation in this PR)
Author: orchestration/deliver working session, 2026-07-23
Related memory: `loop_playbook_vs_uap` (Generator≠Evaluator), `context_overflow_epic_decompose`,
`always_on_file_coordination`, `tiered_gates_ci_feedback`, `model_slot_concurrency`,
`routing_options_oauth`, `model_profile_autoswitch`.

## 1. Motivation

Two inputs drive this design:

1. **"Graph Engineering" (0xWast3, 2026-07-22)** — multi-agent latency is dominated by the
   *shape* of the workflow, not the model. Linear "A then B then C" chains serialize work that
   has no real dependency. The fix is to model work as a **graph of nodes and real edges**
   (an edge exists only when node B's input actually reads node A's output), fan out independent
   nodes, and fan in with layered summarization. Its three named failure modes each map onto an
   existing UAP primitive (see §4.5).

2. **Product requirement** — *simple tasks should carry little or no overhead; complex tasks
   should escalate accordingly*, including a **model routing matrix where each of
   plan / execute / review / fallback has its own escalation models on failure.**

### Three diagnoses of the current system (grounded in code)

1. **Two disconnected complexity systems.** `src/models/router.ts` classifies
   `low|medium|high|critical` from keywords; `src/utils/query-complexity.ts` scores
   `simple|moderate|complex` heuristically. They are bridged one-way by `COMPLEXITY_TO_TIER`
   (`src/cli/deliver.ts:373`), which **silently drops `critical`**. Any per-phase matrix must
   reconcile these at the pure seam, not the CLI.

2. **The orchestrator is complexity-blind.** `ExpertOrchestrator.plan()`
   (`src/coordination/expert-orchestrator.ts:140`) emits the same fixed 5-phase chain
   (`DEFAULT_PHASES`, `:57`) with a 5-reviewer fan-out for a typo fix and a distributed rewrite
   alike. This is the primary source of overhead on simple tasks.

3. **Escalation is execute-only and single-model.** Both the stagnation ladder
   (`src/delivery/escalation.ts`) and the compile-spiral circuit breaker
   (`src/delivery/repair-escalation.ts`) resolve to *one* `escalateModel` via
   `resolveEscalateModelId` (`repair-escalation.ts:30`). There is no per-phase escalation — but
   the hook exists: every model swap flows through `IterationDirective.switchExecutor` +
   `LoopExecutor` (`src/delivery/convergence-loop.ts:172,35`).

## 2. Goals / Non-goals

**Goals**
- One complexity signal, consumed by orchestration, deliver aids, and routing.
- A `plan / execute / review / fallback` × `low|medium|high|critical` model matrix.
- Per-phase escalation with a **hybrid policy**: fixed ordered chains as the floor, the final
  rung deferring to capability-driven selection.
- Near-zero overhead for trivial/low tasks; graph decomposition + panels + escalation for
  high/critical.
- Backward compatible: existing single-string `RoutingPreset.tiers` presets keep working.

**Non-goals (this pass)**
- Rewriting the proxy or the gate ladder.
- Changing the local-model inference stack.
- Auto-tuning the matrix from telemetry (a follow-up; hooks noted in §10).

## 3. Current architecture (concise)

| Layer | Component | File | Complexity-aware? |
|---|---|---|---|
| Orchestration | `ExpertOrchestrator` (fixed 5-phase chain) | `coordination/expert-orchestrator.ts:140` | No |
| Orchestration | `CapabilityRouter` (task→droid) | `coordination/capability-router.ts` | No (keywords) |
| Orchestration | `decompose` / blackboard / epics | `delivery/decompose.ts:82,301`, `task-orchestrator.ts:271`, `epic-controller.ts:189` | Gated on `complex` |
| Deliver | `ConvergenceLoop` | `delivery/convergence-loop.ts:562` | Adaptive turns |
| Deliver | escalation ladder / repair breaker | `delivery/escalation.ts:105`, `repair-escalation.ts:84` | One model |
| Deliver | self-gate / verifier ladder / execution gate / judge | `delivery/self-gate.ts`, `verifier-ladder.ts`, `execution-gate.ts`, `acceptance-judge.ts` | Tiered gates |
| Routing | `RoutingPreset` / resolvers | `models/types.ts:219,345,361` | Per-tier (single model) |
| Routing | rule/keyword + unified routers | `models/router.ts:190`, `unified-router.ts` | Keyword + benchmark |
| Routing | `uap model routing use` | `cli/model.ts:583` | Materializes preset |

## 4. Design

### 4.1 Unified complexity classifier (`src/models/complexity.ts`, new)

A single function that both existing systems delegate to:

```ts
export type Tier = 'trivial' | 'low' | 'medium' | 'high' | 'critical';

export interface ComplexitySignal {
  tier: Tier;
  score: number;          // 0..1 continuous, for thresholds/telemetry
  reasons: string[];      // keyword hits, size, file count, risk flags
  source: 'heuristic' | 'model';
}

export function classifyComplexity(input: {
  instruction: string;
  affectedFiles?: string[];
  riskFlags?: string[];   // security/auth/schema/migration
}): ComplexitySignal;
```

- **Cheap-first:** pure heuristic (keywords from `router.ts:48`, size, file count, risk) returns
  immediately for the clear cases. A model call is made **only** when the heuristic score sits in
  an ambiguous band — otherwise we reintroduce the overhead we are removing.
- Maps to the existing four levels plus `trivial` (new floor). `router.ts` `classifyTask` and
  `query-complexity.ts` `measureQueryComplexity` become thin adapters over this so there is one
  source of truth. `COMPLEXITY_TO_TIER` (`deliver.ts:373`) is deleted; `critical` is preserved
  end-to-end.

### 4.2 Per-phase × per-tier routing matrix

**Type change** (`src/models/types.ts`):

```ts
// Escalation chain: ordered model ids; index 0 = primary, later = escalated rungs.
export type ModelChain = string[];

export interface PhaseModels {
  plan?:     ModelChain;   // omitted => phase skipped for this tier
  execute?:  ModelChain;
  review?:   ModelChain;
  fallback?: ModelChain;
}

export interface RoutingPreset {
  id: string;
  name: string;
  description: string;
  roles: { planner: string; executor: string; reviewer: string; fallback: string };
  // WIDENED: was Partial<Record<TaskComplexity, string>>
  tiers?: Partial<Record<Tier, string | PhaseModels>>;   // string = legacy single-execute model
  models: string[];
  routingStrategy?: string;
}
```

**Backward compatibility:** a tier whose value is a `string` is interpreted exactly as today
(single execute model, all other phases fall back to `roles`). Only the object form unlocks
per-phase chains. Existing presets (`cost-tiered`, `sonnet-5-tiered`, …) are untouched.

**Resolver changes (the two pure, tested seams):**

```ts
// types.ts:361 — add `phase`, return the primary model of that phase's chain
export function resolvePresetModel(
  preset: RoutingPreset,
  sel: { complexity: Tier; role: ModelRole; phase?: Phase }
): string;

// NEW — return the whole escalation chain for a phase+tier
export function resolvePhaseChain(
  preset: RoutingPreset,
  sel: { complexity: Tier; phase: Phase }
): ModelChain;

// types.ts:345 — tiersToRoutingMatrix widens to emit per-phase entries
```

Reference preset (`adaptive-tiered`, new):

| Tier | plan | execute | review | fallback |
|---|---|---|---|---|
| trivial | — | `haiku-4.5` | — | `sonnet-5` |
| low | — | `qwen35-a3b`→`sonnet-5` | `haiku-4.5` | `sonnet-5` |
| medium | `sonnet-5` | `sonnet-5`→`opus-4.8` | `sonnet-5` | `opus-4.8` |
| high | `sonnet-5`→`opus-4.8` | `qwen35-a3b`→`sonnet-5`→`opus-4.8` | `sonnet-5`→`opus-4.8` | `opus-4.8` |
| critical | `opus-4.8` | `sonnet-5`→`opus-4.8` | `opus-4.8` ×N (panel) | `opus-4.8` |

Omitting `plan`/`review` at trivial/low is the mechanism that makes those phases **skipped**, not
merely cheap — this is where "no overhead for simple tasks" actually comes from.

`deliver.ts:386` `resolveTierModel` currently hard-codes `role:'executor'`; it gains a `phase`
parameter and calls `resolvePhaseChain`.

### 4.3 Effort-dial orchestration profiles

The classifier output selects an **orchestration profile** that gates all three orchestration
layers and the deliver aids in one place:

| Tier | Decompose (graph) | Plan phase | Review | Self-gate | maxTurns | Escalation scope |
|---|---|---|---|---|---|---|
| trivial | no | no | no | lenient/skip | 1–2 | fallback only |
| low | no | no | 1 reviewer | yes | 3 | execute chain |
| medium | no | yes | 1 reviewer | yes | 5 | plan+execute |
| high | **yes** | yes | panel (3) | yes | 10 | all phases |
| critical | yes | yes | adversarial panel | yes | 20+ | all + fallback |

- `ExpertOrchestrator.plan()` consults the profile: for trivial/low it emits a **1–2 step chain**
  (execute [+review]) instead of the fixed 5-phase `DEFAULT_PHASES`. Extension point:
  `OrchestratorOptions` (`:42`) gains a `profile`, and `PHASE_ROSTER` selection is filtered by it.
- `decompose.ts:82` `shouldDecompose` becomes `profile.decompose` (already complexity-gated;
  this just formalizes the gate and adds the graph upgrades of §4.5).
- Replaces the ad-hoc `applyAutoPlan()` (`deliver.ts:469`) aid toggles with a principled profile;
  `hasExplicitAidFlags()` still lets a user override.

### 4.4 Per-phase escalation — hybrid policy

Generalize the single `escalateModel` into a phase-keyed resolver:

```ts
// repair-escalation.ts:30 evolves into:
export function resolveEscalation(args: {
  preset: RoutingPreset; tier: Tier; phase: Phase; rung: number;
}): { model: string; policy: 'fixed' | 'capability' };
```

**Hybrid policy (selected):**
- **Rungs 1..n-1:** advance along the phase's **fixed chain** (deterministic, testable).
- **Final rung:** if the chain is exhausted, defer to **capability-driven** selection
  (`unified-router` with `complexity` bumped one level) — the adaptive ceiling for the hardest
  cases.

Triggers are unchanged and already exist:
- stagnation (`escalation.ts:119`, `improvementEpsilon` 0.01, `stagnationTurns` 2),
- compile-error spiral (`repair-escalation.ts:47`),
- gate failure at a tier (`verifier-ladder.ts`).

Each now escalates **the phase that failed** on its own ladder, via
`IterationDirective.switchExecutor` (execute), `ConvergenceConfig.criticFactory` (review), and a
new plan-phase re-run hook. `defaultEscalationLadder({escalateExecutor})` (`escalation.ts:76`)
becomes `escalateByPhase` keyed by `Phase`.

**Generator ≠ Evaluator enforcement:** at matrix-resolution time, assert `review[k] !==
execute[k]` for the active rung (fall to the next review-chain entry if they collide). This bakes
the thread's "network of loops that check each other" / anti-Goodhart property into the router
instead of leaving it to convention (addresses memory `loop_playbook_vs_uap`).

### 4.5 Graph-engineering upgrades (the thread → UAP)

The blackboard/epic DAG is already a graph engine; `planDeliveryPhases` just emits near-linear
phases. Four upgrades, each mapping a thread concept to an existing UAP primitive:

| Thread concept | Upgrade | Where |
|---|---|---|
| **Edge test** — "does B read A's output?" | `planDeliveryPhases` defaults independent nodes to *no edge*; independent nodes fan out in parallel (`parallel`/`pipeline` semantics) instead of serial phases | `decompose.ts:301`, `DeliveryPhase.deps` |
| **Layered fan-in** — batch 20–50 → summarize → consolidate | When node count > N, synthesize in layers instead of one consolidation that blows context | epic fan-in (`epic-controller.ts` `runEpics`) |
| **False independence** — hidden shared-resource edge | Wire the **always-on file-coordination DB** into the planner: two nodes writing the same file get a *synthetic edge* (serialized), even with zero data dependency | coord DB → graph planner |
| **Silent node failure** | Fan-in guard asserts `completed == expected`; flags/reruns gaps instead of synthesizing partial results | `runEpics` fan-in reconciliation |

The **false-independence** fix is the highest-leverage and a genuine differentiator: it is the
difference between parallel fan-out that corrupts files and one that is safe — and the
coordination substrate already exists (memory `always_on_file_coordination`). The thread's naive
`asyncio.gather` has no answer for this.

## 5. Consolidated type diffs (summary)

- `src/models/complexity.ts` (new): `Tier`, `ComplexitySignal`, `classifyComplexity`.
- `src/models/types.ts`: `ModelChain`, `PhaseModels`, widen `RoutingPreset.tiers`,
  add `Phase` to `resolvePresetModel`, add `resolvePhaseChain`, widen `tiersToRoutingMatrix`,
  widen `MultiModelConfigSchema.routingMatrix` per-tier value to accept `PhaseModels`.
- `src/delivery/escalation.ts` / `repair-escalation.ts`: `escalateByPhase`, `resolveEscalation`
  (hybrid), phase-keyed executors.
- `src/coordination/expert-orchestrator.ts`: `OrchestratorOptions.profile`; profile-gated chain.
- `src/delivery/decompose.ts` + `epic-controller.ts`: edge-test, layered fan-in, coord-edge
  injection, node-count reconciliation.
- `src/cli/deliver.ts`: thread `phase` through `resolveTierModel`; replace `applyAutoPlan` toggles
  with profile; delete `COMPLEXITY_TO_TIER`.
- `src/cli/model.ts`: `uap model routing use` materializes per-phase matrix into `.uap.json`.

## 6. Migration & backward compatibility

- Legacy `tiers: { high: "opus-4.8" }` (string) resolves identically to today.
- `.uap.json` `multiModel.routingMatrix` already accepts `string | {planner,executor}`
  (`types.ts:463`); extend the object arm to `PhaseModels`. Old configs load unchanged.
- New `adaptive-tiered` preset ships opt-in; default routing behavior is unchanged until a user
  runs `uap model routing use adaptive-tiered`.
- No proxy/env changes required beyond the passthrough model set already derived by
  `passthroughModelsForPreset`.

## 7. Test plan

- **Unit (pure resolvers):** `resolvePhaseChain`/`resolvePresetModel` for every tier×phase incl.
  legacy string tiers, missing-phase skip, chain exhaustion → capability fallback, and the
  `review !== execute` invariant. (These are the tested seams; highest coverage priority.)
- **classifier:** golden set of instructions → expected tier; assert heuristic path takes no model
  call for the clear cases (overhead regression guard).
- **effort-dial:** trivial task ⇒ orchestrator emits ≤2 steps, no decompose, no panel; critical
  task ⇒ decompose + panel + full escalation scope.
- **escalation:** simulate stagnation/compile-spiral/gate-fail per phase; assert the *correct
  phase's* chain advances and the final rung switches to capability policy.
- **graph:** two nodes writing the same file ⇒ synthetic edge (serialized); N>threshold ⇒ layered
  fan-in; a dropped node ⇒ fan-in flags the gap rather than synthesizing partial output.
- **e2e (guarded-live):** one trivial + one high task through `uap deliver --routing
  adaptive-tiered`, asserting model selection per phase and cost/latency deltas.

## 8. Rollout (each independently shippable)

1. **Unify complexity** (`complexity.ts` + adapters; delete `COMPLEXITY_TO_TIER`). Small, unblocks all.
2. **Widen `RoutingPreset.tiers`** + `resolvePhaseChain` + `adaptive-tiered` preset + unit tests.
3. **Effort-dial profiles** gating orchestrator + deliver aids.
4. **Per-phase escalation** (hybrid) off the widened matrix.
5. **Graph upgrades** (edge-test, layered fan-in, coord-edge, silent-node guard).

## 9. Risks & open questions

- **Classifier cost/accuracy.** If the ambiguous band is too wide, trivial tasks pay a model call.
  Mitigation: conservative band + telemetry on `source:'model'` rate.
- **Local-model chains.** `qwen35-a3b` rungs route through the proxy (`:4000`); escalation to a
  cloud model changes the passthrough set mid-run — must re-derive `ANTHROPIC_PASSTHROUGH_MODELS`
  or pre-authorize both. (Ref: memory `routing_passthrough_local_only`.)
- **Panel cost at critical.** Adversarial review ×N on `opus-4.8` is expensive; gate behind an
  explicit `--max-cost` ceiling (tie to `costOptimization`).
- **Coord-edge completeness.** False-independence protection is only as good as the coordination
  DB's file-write predictions; nodes that write unpredicted paths still race. Document the limit.
- **Two orchestration entry points** (`ExpertOrchestrator` vs deliver's blackboard) — do we unify
  them under one profile, or keep expert-route advisory and make deliver authoritative? (Proposed:
  deliver authoritative; expert-route consumes the same profile.)

## 10. Telemetry hook (follow-up, not this pass)

Record `(tier, phase, model, rung, outcome, cost, latency)` per turn (you already have
`successRateFor` and `uap tune`). This lets the matrix self-tune and the classifier's ambiguous
band shrink over time — the "network of loops that check each other" applied to the router itself.

---

# Part II — The Self-Optimizing System Around the Model

Second input: **@0xNoryxx thread (2026-07-18)** — DSPy / STORM / MIPRO / GEPA / Claude Code / MCP.
Thesis: *competitive advantage is no longer the model, but the system around it* — pipeline,
optimization, reflection, tools, real-world connection. Its five principles: (1) model is a
component; (2) each step has a separate role; (3) **verification is mandatory and objective — the
model cannot verify itself**; (4) the system optimizes itself in the process; (5) it is connected
to the real world.

Part I made the *shape/routing* adaptive. Part II makes the *instructions and verification*
self-optimizing and objective. They share two concepts (the `reflect` phase and a distinct
evaluator model), so Part II is designed to slot into Part I's routing matrix, not replace it.

## 11. Mapping the six systems onto UAP (grounded)

| Thread system | Principle | UAP reality | Gap |
|---|---|---|---|
| **DSPy compiler** | self-optimization | ✅ `uap tune` full closed loop (`self-tuning/run.ts:79`): GP-BO (`search-reducer.ts`) + LLM-tuner (`llm-tuner.ts:225`) → metric `compositeQuality` (`benchmarks/paired/types.ts:207`), held-out guard, cross-model priors | optimizes **flags, not prompts** |
| **MIPRO** | instructions are a variable | ❌ prompts are static: `defaultPromptBuilder`/`OUTPUT_CONTRACT`/`AUTONOMY_CONTRACT` (`convergence-loop.ts:499/421/440`), `systemContent` (`agentic-executor.ts:873`) | nothing optimizes instructions |
| **GEPA** | reflect→improve→retry | ⚠️ Structured Critic (`critic.ts:98`) is a real separate reflection model w/ gate-personas, but emits a **fix-list** for the next turn | not an *approach/instruction rewrite*; no Pareto archive |
| **STORM** | role-separated steps | ✅ = Part I plan/execute/review phases | — |
| **Claude Code** | model is a component | ✅ AGENTS.md/CLAUDE.md loaded (`memory/bridge.ts:66`, `dynamic-retrieval.ts:962`), skills, spec/goal, gates | — (UAP is the production shape) |
| **MCP** | real-world connection | ✅ `mcp__uap-router__*` (`mcp-router/server.ts` — discover/execute/deliver/react) | — |

**Takeaway:** UAP already implements the two hardest pieces (a working self-optimizing compiler,
and the production Claude-Code pattern). The additions are narrow: point the existing optimizer at
prompts, upgrade tactical reflection to strategic, and close the self-verification boundary.

## 12. Diagnosis — three gaps

1. **The compiler optimizes flags, not instructions.** `uap tune` is a near-textbook MIPRO loop
   (propose→validate→accept over a metric, GP + LLM proposer, held-out guard, transfer priors) —
   but its search space is `TUNABLE_FLAGS` (`self-tuning/flags.ts:140`), i.e. settings-registry
   booleans/enums, never prompt text.

2. **Reflection is tactical, not strategic.** `critic.ts` analyzes *why a turn failed* through a
   gate-specific persona and returns `Critique { fixList, focusGate }` (`critic.ts:24`), injected
   as "REPAIR PLAN" (`convergence-loop.ts:516`). It never rewrites the *approach* or the
   *instruction*, and §2's `PromptBuilder` seam is disconnected from §3's reflection output.

3. **Self-verification boundary is open by default.** Acceptance judge **fails OPEN**
   (`acceptance-judge.ts:455`: `passed:true` on no-evidence/throw/unparseable/no-criteria).
   Generator≠Evaluator is a setting (`recipes.allowSelfJudge` default false) that **defaults to the
   generator when no evaluator model is set** (`deliver.ts:1229`) — so single-model deliver has the
   generator authoring `verify.sh` *and* being graded by it. Mitigations exist (anti-vacuity floor
   `self-gate.ts:373`, `requireDiffForAcceptance` `convergence-loop.ts:265`, sole-gate fail-closed
   `mission-acceptance.ts:52`) but the structural boundary Principle 3 names is real.

## 13. Feature A — MIPRO instruction optimization (extend `uap tune` to prompts)

**Idea:** make the delivery/orchestration *instructions* an optimized variable, compiled by the
optimizer that already exists. Highest leverage, lowest risk — the metric, validator, GP-BO, and
transfer priors are already built and battle-tested; we only widen the search space.

**Design:**
- Introduce **`TUNABLE_PROMPTS`** parallel to `TUNABLE_FLAGS` (`self-tuning/flags.ts:140`): each
  entry is a named prompt fragment (`OUTPUT_CONTRACT`, `AUTONOMY_CONTRACT`, `systemContent`,
  per-gate critic persona) with a small set of candidate variants + a `dependsOn` graph (same
  pruning as flags via `isFlagActive`).
- Make `defaultPromptBuilder` (`convergence-loop.ts:499`) read the active variant from the
  `TuningProfile` instead of the hard-coded constants. `PromptBuilder`/`PromptContext` are already
  the swap seam.
- The proposer (`llm-tuner.ts:225` `proposeTuning`, `TuningProposal.changes: FlagChange[]`) widens
  to also propose prompt-variant selections (and, at a higher tier, MIPRO-style *generated* variant
  text scored by the same `compositeQuality`). GP-BO treats variant choice as a categorical
  dimension — no engine change.
- Metric + harness reused verbatim: `compositeQuality` (`benchmarks/paired/types.ts:207`),
  `buildPairedTuningValidator` (`paired-validator.ts:85`).

**Result:** the same model produces better output because the instructions were *compiled*, not
hand-written — DSPy's core claim, realized through UAP's existing compiler.

**Seam:** `TUNABLE_FLAGS`/`FlagConfig` (`flags.ts`), `PromptBuilder` (`convergence-loop.ts:499`),
`TuningProposal` (`llm-tuner.ts`).

## 14. Feature B — GEPA reflect phase (join reflection to prompt-gen; slots into Part I)

**Idea:** upgrade the Structured Critic from "fix-list for next turn" to GEPA's "reflect on the
failed reasoning → mutate the *approach/instruction* → retry", with a Pareto archive of reflected
candidates. This *is* the `reflect` phase of the Part I routing matrix (its own model chain).

**Design:**
- Extend `Critic` (`critic.ts:31`) with an optional `approachRewrite` output: a natural-language
  critique of *why the strategy* (not just the code) failed + a rewritten instruction/approach.
- Add `IterationDirective.mutateInstruction?: (prev: PromptContext) => PromptContext`
  (`convergence-loop.ts:162`) — the loop applies it before the next `PromptBuilder` call, closing
  the §3→§2 gap. This is the missing wire between reflection and prompt generation.
- Trigger: on stagnation (reuse `escalation.ts:119`) run a **reflect turn** *before* model
  escalation — cheaper and often sufficient (change the approach, not the model).
- **Pareto archive** (GEPA core): keep the best-K reflected `(instruction, score)` candidates
  across turns; reseed from the archive instead of always mutating the latest — avoids collapsing
  to a local optimum (the same anti-Goodhart insight as Part I §4.4).
- **Routing-matrix integration:** `reflect` becomes a first-class phase in `PhaseModels`
  (Part I §4.2): `PhaseModels { plan?, execute?, review?, reflect?, fallback? }`. Its escalation
  chain is resolved by the same `resolvePhaseChain`. Reflect defaults to a *strong, distinct* model
  (reflection is where model quality pays off most).

**Seam:** `Critic` (`critic.ts:31`), `IterationDirective` (`convergence-loop.ts:162`),
`defaultEscalationLadder` reflect tier (`escalation.ts:76`), `PhaseModels` (Part I §4.2).

## 15. Feature C — Verification hardening (Principle 3: the model cannot verify itself)

**Idea:** make objective, non-self verification the default, not an opt-in — the thread's single
strongest principle and the one place UAP has a real hole.

**Design:**
- **Require a distinct evaluator.** In the routing matrix, the `review`/`judge` phase model MUST
  differ from the `execute` model at the active rung (Part I already proposes this for review;
  extend to the acceptance judge). `deliver.ts:1229` stops defaulting `judgeExecutor` to the
  generator; when only one model is available, fall to a *cheaper distinct* model
  (e.g. `haiku-4.5`) for judging rather than the generator itself.
- **Fail-closed when the judge is the only gate** — already done for primary mode
  (`mission-acceptance.ts:52`); make it the documented, tested invariant and extend the
  churn-breaker (`acceptance-judge.ts:521`) to flag (not silently pass) repeated parse failures.
- **Keep self-gate, harden provenance.** The model may still *author* `verify.sh` (`self-gate.ts`)
  — the anti-vacuity floor makes that safe — but the *grading* of it, and the acceptance judgment,
  run on a distinct model. Author≠Grader as a hard rule.
- Emit a one-line **verification-provenance banner** per delivery: which model executed, which
  distinct model judged, whether any gate ran fail-open. Observability for Principle 3.

**Seam:** `resolveEvaluatorPreset`/`judgeExecutor` (`deliver.ts:1239-1265`), `AcceptanceGate`
(`convergence-loop.ts:555`), `MissionAcceptanceDeps.judgeExecutor` (`mission-acceptance.ts:69`).

## 16. How Part II composes with Part I

- **`reflect` becomes a matrix phase.** `PhaseModels` gains `reflect?` alongside
  plan/execute/review/fallback; escalation resolves it via the same `resolvePhaseChain`.
- **One Generator≠Evaluator rule** now spans review (Part I §4.4), acceptance judge (Part II §15),
  and reflect (§14) — all required distinct from execute at the active rung.
- **The optimizer tunes the matrix too.** Feature A's `TUNABLE_PROMPTS` and Part I's tier/phase
  model choices are both search dimensions for `uap tune` — the router self-optimizes (Part I §10
  telemetry hook becomes the training signal for both).
- **Effort dial gates reflection.** Trivial/low tiers skip the reflect phase (overhead control);
  high/critical enable reflect + Pareto archive.

## 17. Rollout additions (extends Part I §8)

6. **Verification hardening (Feature C)** — smallest, a correctness fix, ship first. Distinct judge
   default + fail-closed-when-sole-gate invariant + provenance banner.
7. **GEPA reflect phase (Feature B)** — `Critic.approachRewrite` + `mutateInstruction` +
   `reflect` matrix phase; Pareto archive as a follow-up.
8. **MIPRO prompt-optimization (Feature A)** — `TUNABLE_PROMPTS` + `PromptBuilder` reads profile;
   variant-selection first, generated-variant text second.

## 18. Risks & open questions (Part II)

- **Prompt-optimization overfitting.** Optimizing instructions against the paired suite may overfit
  to it. Mitigation: held-out task split (already in `decideTuning`) + cross-model priors as a
  regularizer; cap variant churn per profile version.
- **Reflect cost vs escalate cost.** A reflect turn on a strong model may cost as much as
  escalation. Mitigation: reflect only at stagnation, before escalation; measure win-rate and let
  `uap tune` decide the order.
- **Distinct-judge availability offline.** Single-local-model setups can't always field a distinct
  cloud judge; falling to a cheaper *local* distinct model (or heuristic-only gates) must degrade
  gracefully — document the offline contract (ref memory `routing_passthrough_local_only`).
- **Prompt variants as an attack surface.** Optimizer-generated instruction text must pass the same
  secret-scan / protected-path review as code; never let the optimizer weaken a gate's own prompt.
- **Static-string provenance.** Some constants (`OUTPUT_CONTRACT`) encode hard safety rules; mark
  those `frozen` (non-tunable) so optimization can't erode them.
