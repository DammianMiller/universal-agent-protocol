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
