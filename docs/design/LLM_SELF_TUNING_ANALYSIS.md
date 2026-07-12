# LLM Self-Tuning Analysis: Raising Small Models Toward Opus 4.8

**Date**: 2026-07-11
**Scope**: UAP flags, self-harness, recipes/escalation, telemetry, benchmarks
**Goal**: Identify and plan options for LLM-driven self-tuning of UAP configuration to maximize small-model (qwen3.6) output quality toward Opus 4.8 levels.

---

## 1. Current State Assessment

### 1.1 Existing Self-Tuning Infrastructure

| System | Location | Lines | Status |
|--------|----------|-------|--------|
| **Self-Harness** | `src/self-harness/` | ~1,600 | Mature, ships with `uap self-harness run` |
| **Paired Benchmarks** | `src/benchmarks/paired/` | ~2,000 | A/B testing with stats, ablation, scaffold |
| **Speculative Autotune** | `src/benchmarks/speculative-autotune.ts` | ~240 | Throughput/latency knob tuning (not quality) |
| **Settings Registry** | `src/config/settings-registry.ts` | ~400 | Single source of truth for all tunable flags |
| **Telemetry** | `src/telemetry/session-telemetry.ts` | ~1,500 | Session-level spans, costs, task trees |
| **Recipes/Escalation** | `src/config/settings-registry.ts:152-187` | ~35 | Confidence/fusion routing to judge model |
| **Cross-Model Transfer** | `src/self-harness/transfer.ts` | ~200 | Stores accept/reject outcomes per weakness signature |

### 1.2 Tunable Flag Surface (42+ flags across 10 categories)

| Category | Flags | Tunable Range |
|----------|-------|---------------|
| **Proxy** | `PROXY_CONTEXT_WINDOW` (65536), `PROXY_CONCURRENCY_LIMIT`, `PROXY_LOOP_BREAKER` (bool), `PROXY_STUCK_BREAK` (bool), `PROXY_RECON_CONVERGENCE_THRESHOLD` (40), `PROXY_RECIPE` (enum) | numeric + bool + enum |
| **Recipes/Escalation** | `recipes.enabled` (bool), `recipes.recipe` (auto/single/confidence/fusion/ratings/remom), `recipes.confidenceThreshold` (0-1), `recipes.fusionN` (2-6), `recipes.allowSelfJudge` (bool), `recipes.judge.model` (string) | bool + enum + numeric |
| **Delivery** | `delivery.enforcement` (block/advisory/off), `delivery.localMode` (advisory/deliver/block), `delivery.runtimeVerify` (bool) | enum + bool |
| **Concurrency** | `modelConcurrency.slots`, `modelConcurrency.headroom`, `modelConcurrency.adaptive` (bool), `UAP_MAX_PARALLEL` (4) | numeric + bool |
| **Handsfree** | `handsfree.enabled` (bool), `handsfree.intensity` (gentle/normal/aggressive), `UAP_HANDSFREE_STAGNATION_LIMIT` (8) | bool + enum + numeric |
| **Memory** | `memory.longTerm.enabled` (bool), `memory.longTerm.provider` (qdrant/none), `memory.shortTerm.maxEntries` (50), `memory.patternRag.enabled` (bool) | bool + enum + numeric |
| **Reactor** | `reactor.enabled` (bool) | bool |
| **Worktrees** | `worktrees.enabled` (bool), `worktrees.branchPrefix` (feature/), `worktrees.autoCleanup` (bool) | bool + string + bool |
| **Optimization** | `costOptimization.enabled` (bool), `timeOptimization.parallelExecution.maxParallelDroids` (4) | bool + numeric |
| **Collaboration** | `collaboration.mode` (auto/always/off) | enum |

### 1.3 What Self-Harness Already Does

The Self-Harness orchestrator runs a closed-loop:
1. **Mine** — analyzes benchmark `RunRecord[]` to find failure patterns (wrong output, timeouts, tool misuse, guardrail wedges, RECON loops)
2. **Propose** — generates `Mod` objects (environment changes, scaffolding, middleware) from weakness reports
3. **Validate** — runs paired benchmark with mod applied vs baseline
4. **Decide** — accepts if validation delta > threshold AND held-out suite doesn't regress
5. **Transfer** — records outcome into cross-model store keyed by weakness signature

**Key insight**: The Mod DSL only touches a handful of knobs today (PROXY_RECON_CONVERGENCE_THRESHOLD, PROXY_CONTEXT_WINDOW, etc.). It does NOT touch recipes, escalation, concurrency, memory, or handsfree settings.

### 1.4 What Self-Harness Does NOT Do

| Gap | Current State |
|-----|---------------|
| **Recipe tuning** | No exploration of recipe type, confidence threshold, fusion N |
| **Escalation tuning** | No tuning of judge model selection, escalation trigger |
| **Concurrency tuning** | No optimization of slots, headroom, parallelism |
| **Memory tuning** | No tuning of short-term entries, pattern RAG, long-term provider |
| **Handsfree tuning** | No tuning of intensity, stagnation limits |
| **Cross-flag interaction** | Each mod tested in isolation; no combinatorial tuning |
| **Real-time adaptation** | All tuning is offline (between benchmark runs); no per-session adaptation |
| **LLM-guided search** | Proposal is heuristic-based only; no LLM to reason about flag interactions |
| **Outcome quality signal** | Benchmarks measure pass/fail on task suites; no "quality score" that correlates with Opus-level output |

---

## 2. Core Problem: Why Small Models Fall Short of Opus 4.8

### 2.1 Quality Gap Sources

| Factor | Opus 4.8 | Qwen 3.6 | UAP Mitigation |
|--------|----------|----------|----------------|
| **Reasoning depth** | Native, deep chain-of-thought | Shallow, needs prompting | `recipes.fusionN` (sample N, judge picks best) |
| **Tool use reliability** | High | Moderate (required-tool re-rolls) | `PROXY_LOOP_BREAKER`, `PROXY_STUCK_BREAK` |
| **Context management** | Large window, good retention | Smaller window, drift | `PROXY_CONTEXT_WINDOW`, `memory.shortTerm.maxEntries` |
| **Self-correction** | Native | Needs explicit guidance | `delivery.runtimeVerify`, `handsfree.intensity` |
| **Planning** | Strong multi-step planning | Weak, gets stuck | `handsfree.enabled`, `PROXY_RECON_CONVERGENCE_THRESHOLD` |
| **Guardrail awareness** | Understands constraints | Violates, gets wedged | `recipes.confidenceThreshold`, `recipes.judge.model` |

### 2.2 The "Generator ≠ Evaluator" Problem

This is the fundamental challenge. A small model cannot reliably judge its own output quality. UAP already addresses this partially:
- **Recipes/fusion**: Generate N candidates, judge (stronger model) picks the best
- **Self-Harness**: Benchmarks measure external correctness, not self-assessment
- **Delivery**: Convergence loop with auto-mine catches failures

**Key gap**: There is no per-session quality signal that approximates "how close to Opus 4.8 is this output?" — only pass/fail on predefined test suites.

---

## 3. Proposed Architecture: LLM-Guided Self-Tuning System

### 3.1 Design Principles

1. **LLM as tuner, not executor** — The LLM (Opus or similar) analyzes telemetry and recommends flag configurations; the small model executes them
2. **Closed-loop validation** — Every tuning recommendation is validated by paired benchmarks before acceptance
3. **Compositional** — Flags are tuned in groups (not individually) to capture interactions
4. **Model-specific profiles** — Each executor model gets its own tuning profile stored in the cross-model transfer store
5. **Progressive disclosure** — Start with coarse tuning (recipe type, enabled/disabled), refine to fine-grained (thresholds, N values)

### 3.2 System Components

```
┌─────────────────────────────────────────────────────────────┐
│                    LLM Self-Tuning System                    │
│                                                             │
│  ┌──────────┐    ┌──────────────┐    ┌──────────────────┐  │
│  │ Telemetry │───▶│ Quality      │───▶│ LLM Tuner        │  │
│  │ Collector │    │ Scorer       │    │ (Opus-guided)    │  │
│  └──────────┘    └──────────────┘    └────────┬─────────┘  │
│                                               │              │
│  ┌──────────┐    ┌──────────────┐    ┌────────┴─────────┐  │
│  │ Flag     │◀───│ Mod          │◀───│ Search           │  │
│  │ Writer   │    │ Generator    │    │ Space Reducer    │  │
│  └──────────┘    └──────────────┘    └──────────────────┘  │
│                                               │              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │          Paired Benchmark Validator                    │  │
│  │  (baseline vs tuned config, statistical significance)  │  │
│  └────────────────────────────────────────────────────────┘  │
│                                               │              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  Cross-Model Tuning Store (extends transfer.ts)        │  │
│  │  (model → config → outcome mapping)                    │  │
│  └────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

### 3.3 Component Details

#### 3.3.1 Quality Scorer (`src/self-tuning/quality-scorer.ts`)

Replaces the pass/fail binary with a multi-dimensional quality score:

```typescript
interface QualityScore {
  // Behavioral correctness (0-100)
  correctness: number;
  // Output quality relative to reference (0-100)
  quality: number;
  // Efficiency (tokens per correct answer)
  efficiency: number;
  // Tool use reliability
  toolReliability: number;
  // Planning coherence across turns
  planning: number;
  // Overall weighted score
  composite: number;
}
```

**Implementation approach**:
- Use Opus 4.8 (or the judge model) as the quality scorer
- Feed it the task spec + agent output + any test results
- Score on a 0-100 scale per dimension
- Composite = weighted average (correctness 40%, quality 30%, efficiency 15%, toolReliability 15%)

#### 3.3.2 LLM Tuner (`src/self-tuning/llm-tuner.ts`)

The core intelligence — an LM-guided tuner that:

1. **Receives**: Quality scores + flag configuration + benchmark results
2. **Analyzes**: Which flags correlate with quality improvements?
3. **Proposes**: New flag combinations to try next
4. **Outputs**: A `TuningProposal` (extends `Mod` type)

```typescript
interface TuningProposal {
  // Which flags to change and to what values
  changes: FlagChange[];
  // Why these changes (LLM reasoning)
  rationale: string;
  // Expected improvement (LLM estimate)
  expectedDelta: number;
  // Confidence in this proposal (0-1)
  confidence: number;
  // Which model profile this is optimized for
  targetModel: string;
  // Which benchmark suites to validate against
  validationSuites: string[];
}

interface FlagChange {
  key: string;        // e.g., "recipes.confidenceThreshold"
  from: number | string | boolean;
  to: number | string | boolean;
  category: string;   // recipe, proxy, concurrency, etc.
}
```

**Search strategy**:
- **Phase 1** (coarse): Binary exploration — enable/disable each major category
- **Phase 2** (medium): Enum exploration — try each recipe type, each handsfree intensity
- **Phase 3** (fine): Numeric optimization — tune thresholds, N values, concurrency limits
- **Phase 4** (combinatorial): Joint optimization of interacting flags

#### 3.3.3 Search Space Reducer (`src/self-tuning/search-reducer.ts`)

Prunes the combinatorial explosion. With 42 flags and even 3 options each: 3^42 ≈ 10^20 possibilities.

**Reduction techniques**:
1. **Category pruning**: Skip categories known to be irrelevant for the model/task type
2. **Dependency awareness**: Some flags only matter when others are enabled (e.g., `recipes.confidenceThreshold` only matters when `recipes.enabled=true`)
3. **Bayesian optimization**: Maintain a Gaussian process over flag space, sample from acquisition function
4. **Transfer learning**: Use tuning profiles from similar models/tasks as priors

#### 3.3.4 Flag Writer (`src/self-tuning/flag-writer.ts`)

Applies tuning proposals to the UAP configuration:
- Writes to `.uap.json` for JSON-config flags
- Writes to `.uap/proxy.env` for proxy env flags
- Exports shell env vars for shell flags
- **Atomic swap**: reads current config, applies changes, validates, writes — on failure, rolls back

### 3.4 Integration with Existing Systems

```
┌─────────────────────────────────────────────────────────────┐
│                    Existing UAP Systems                      │
│                                                             │
│  ┌─────────────┐    ┌─────────────┐    ┌────────────────┐  │
│  │ Self-Harness │    │ Paired      │    │ Settings       │  │
│  │ (weakness    │    │ Benchmarks  │    │ Registry       │  │
│  │  mining)     │    │ (validation)│    │ (flag schema)  │  │
│  └──────┬──────┘    └──────┬──────┘    └────────┬───────┘  │
│         │                  │                     │           │
│         ▼                  ▼                     │           │
│  ┌─────────────┐    ┌─────────────┐             │           │
│  │ New:        │    │ Reuses:     │             │           │
│  │ Quality      │    │ Validation  │             │           │
│  │ Scorer       │    │ Pipeline    │             │           │
│  └──────┬──────┘    └─────────────┘             │           │
│         │                                       │           │
│         ▼                                       │           │
│  ┌─────────────┐                               │           │
│  │ LLM Tuner   │─────▶ Mod Generator ──────────┤           │
│  │ + Search    │                               │           │
│  │ Reducer     │◀──────────────────────────────┤           │
│  └─────────────┘                               │           │
│                                                 │           │
│  ┌────────────────────────────────────────────────────┐  │
│  │  Cross-Model Tuning Store (extends transfer.ts)     │  │
│  └────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

---

## 4. Implementation Plan

### Phase 0: Foundation (Week 1-2)

**Goal**: Add quality scoring to the benchmark pipeline.

| Task | File | Description |
|------|------|-------------|
| Q1 | `src/self-tuning/quality-scorer.ts` | Multi-dimensional quality scoring (correctness, quality, efficiency, toolReliability, planning) |
| Q2 | `src/benchmarks/paired/types.ts` | Extend `RunRecord` with `qualityScore?: QualityScore` |
| Q3 | `src/benchmarks/paired/report.ts` | Include quality scores in comparison reports |
| Q4 | `src/benchmarks/paired/stats.ts` | Statistical tests on quality scores (not just pass/fail) |

**Key decision**: Quality scorer uses Opus 4.8 as judge, or the configured judge model?
**Recommendation**: Use the configured judge model (`recipes.judge.model`) to keep costs down. Fall back to Opus if no judge configured.

### Phase 1: LLM Tuner Core (Week 3-4)

**Goal**: LLM-guided flag proposal system.

| Task | File | Description |
|------|------|-------------|
| T1 | `src/self-tuning/llm-tuner.ts` | Core tuner: receives quality scores, proposes flag changes |
| T2 | `src/self-tuning/search-reducer.ts` | Search space pruning and Bayesian optimization |
| T3 | `src/self-tuning/flag-writer.ts` | Atomic config write/rollback |
| T4 | `src/self-tuning/tuning-profile.ts` | Model-specific tuning profile storage |
| T5 | `src/self-harness/transfer.ts` | Extend with tuning outcome records |

**LLM prompt design** (critical):
```
You are a configuration optimizer for the Universal Agent Protocol (UAP).

EXECUTOR MODEL: qwen3.6-35b
CURRENT CONFIG: {json of current flags}
QUALITY SCORES: {quality scores from benchmark}
PAST ATTEMPTS: [{config, scores, result}] for previous tuning attempts

TASK: Propose the next configuration to try.

CONSTRAINTS:
- Only change 2-4 flags per proposal (keep changes interpretable)
- Respect flag dependencies (e.g., confidenceThreshold requires recipes.enabled)
- Prefer changes that have transferred well from other models
- Target: maximize composite quality score

OUTPUT FORMAT:
{
  "changes": [{"key": "...", "from": ..., "to": ..., "category": "..."}],
  "rationale": "explanation",
  "expectedDelta": 5.2,
  "confidence": 0.75
}
```

### Phase 2: Closed-Loop Integration (Week 5-6)

**Goal**: Full tuning loop — propose → validate → accept/reject → learn.

| Task | File | Description |
|------|------|-------------|
| L1 | `src/self-tuning/orchestrator.ts` | Extends self-harness orchestrator with tuning loop |
| L2 | `src/self-harness/run.ts` | Add `uap self-harness tune` command |
| L3 | `src/cli/self-tuning.ts` | CLI entry point |
| L4 | `src/benchmarks/paired/suite.ts` | Add "tuning" suite type for iterative validation |

**Loop flow**:
```
1. Run baseline benchmark → collect RunRecord[]
2. Score quality for each record
3. LLM Tuner proposes next config
4. Apply config (flag-writer)
5. Run benchmark with new config
6. Score quality
7. Compare: did quality improve?
   - Yes: accept, record in transfer store, go to step 3
   - No: reject, record in transfer store, go to step 3
8. Stop when: budget exhausted, or quality plateaus (3 consecutive rejections)
```

### Phase 3: Small Model Optimization Profile (Week 7-8)

**Goal**: A pre-tuned profile specifically for qwen3.6 → Opus 4.8 quality gap reduction.

| Task | File | Description |
|------|------|-------------|
| P1 | `src/self-tuning/profiles/qwen36.json` | Default tuning profile for qwen3.6 |
| P2 | `src/self-tuning/profiles/opus48.json` | Reference profile for Opus 4.8 (upper bound) |
| P3 | `scripts/tune-model.ts` | CLI tool: `uap tune model qwen3.6` |
| P4 | `docs/guides/SELF_TUNING.md` | User documentation |

**Expected qwen3.6 profile** (hypothesis, needs validation):
```json
{
  "recipes": {
    "enabled": true,
    "recipe": "fusion",
    "confidenceThreshold": 0.6,
    "fusionN": 3,
    "allowSelfJudge": false,
    "judge": { "model": "opus-4-8" }
  },
  "proxy": {
    "CONTEXT_WINDOW": 65536,
    "LOOP_BREAKER": true,
    "STUCK_BREAK": true,
    "RECON_CONVERGENCE_THRESHOLD": 30,
    "RECIPE": "fusion"
  },
  "handsfree": {
    "enabled": true,
    "intensity": "aggressive",
    "stagnationLimit": 6
  },
  "modelConcurrency": {
    "slots": 4,
    "adaptive": true
  },
  "delivery": {
    "enforcement": "advisory",
    "runtimeVerify": true
  },
  "memory": {
    "shortTerm": { "maxEntries": 80 },
    "patternRag": { "enabled": true }
  }
}
```

### Phase 4: Real-Time Adaptation (Week 9-10)

**Goal**: Per-session flag adaptation (not just between sessions).

| Task | File | Description |
|------|------|-------------|
| R1 | `src/self-tuning/realtime-adaptor.ts` | Mid-session flag adjustment |
| R2 | `src/coordination/reactor.ts` | Integrate with reactor for live tuning |
| R3 | `src/telemetry/session-telemetry.ts` | Add per-turn quality estimation |
| R4 | Proxy integration | Apply tuning at proxy layer (not just config file) |

**Real-time signals**:
- Tool-use failure rate → adjust `PROXY_LOOP_BREAKER` aggressiveness
- Context window utilization → adjust `PROXY_CONTEXT_WINDOW`
- RECON loop detection → adjust `PROXY_RECON_CONVERGENCE_THRESHOLD`
- Turn quality degradation → trigger escalation via recipes

---

## 5. Alternative Approaches Considered

### 5.1 Pure Heuristic Tuning (No LLM)

**Approach**: Grid search, random search, or Bayesian optimization over flag space.

**Pros**: Deterministic, no API cost, reproducible
**Cons**: Cannot handle combinatorial complexity; no understanding of flag interactions; slow convergence

**Verdict**: Use as a fallback for Phase 0 (quality scoring). Not sufficient for the full system.

### 5.2 Reinforcement Learning

**Approach**: Train a policy network that maps session state → flag configuration.

**Pros**: Once trained, inference is instant; can learn complex policies
**Cons**: Requires massive training data; training is expensive; fragile to distribution shift

**Verdict**: Too expensive for current data volume. Could be a Phase 5+ after collecting enough tuning data.

### 5.3 Meta-Learning Across Models

**Approach**: Train a meta-learner that takes a model's capabilities as input and outputs an optimal config.

**Pros**: One-shot tuning for new models
**Cons**: Requires diverse model training data; complex to implement

**Verdict**: Aligns with existing `transfer.ts` design. Defer to Phase 4+.

### 5.4 Direct Prompt Engineering (No Flag Tuning)

**Approach**: Instead of tuning UAP flags, improve the system prompt / Claude Code instructions for small models.

**Pros**: Simpler, no config complexity
**Cons**: Prompt tokens are expensive; doesn't leverage UAP's structural advantages (recipes, escalation, guardrails)

**Verdict**: Complementary. The LLM tuner should consider prompt-level changes as one type of "Mod".

---

## 6. Key Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| **LLM tuner makes bad suggestions** | Wastes benchmark runs, degrades quality | Conservative proposal bounds; always validate via paired bench; reject on regression |
| **Combinatorial explosion** | Tuning takes too long | Limit to 2-4 flag changes per proposal; category-level pruning; transfer learning priors |
| **Overfitting to benchmark suite** | Good on bench, bad in production | Held-out validation suites; diverse task types; periodic real-world validation |
| **Cost of Opus-as-judge** | Expensive quality scoring | Use configured judge model; batch scoring; sample-based estimation |
| **Config instability** | Flags oscillate between runs | Hysteresis threshold (need >5% improvement to accept); momentum in numeric tuning |
| **Small model can't follow tuned config** | Config assumes capabilities small model lacks | Capability-aware tuning: profile model capabilities first, only enable flags within capability envelope |

---

## 7. Success Metrics

| Metric | Baseline (qwen3.6, no tuning) | Target (qwen3.6 + self-tuning) |
|--------|-------------------------------|--------------------------------|
| **Task suite pass rate** | ~60-70% (varies) | ~85-90% |
| **Quality composite score** | ~55/100 | ~75/100 |
| **Tokens per correct answer** | ~15K | ~12K (more efficient) |
| **Tool-use success rate** | ~70% | ~85% |
| **RECON loop rate** | ~15% | <5% |
| **Time to first green** | Manual (hours) | Automated (~30 min) |

---

## 8. Recommendation

### Short-term (immediate, 2-3 weeks)

1. **Add quality scoring** to the benchmark pipeline (Phase 0)
   - This is the highest-leverage, lowest-risk change
   - Extends existing `RunRecord` type
   - Uses existing judge model infrastructure
   - Enables all downstream tuning work

2. **Extend Self-Harness Mod DSL** to cover recipe and concurrency flags
   - Add knob specs for `recipes.confidenceThreshold`, `recipes.fusionN`, `recipes.recipe`
   - Add knob specs for `modelConcurrency.slots`, `handsfree.intensity`
   - Reuse existing `heuristicProposer` with new knob targets

### Medium-term (4-8 weeks)

3. **Build LLM Tuner** (Phase 1-2)
   - The core innovation: Opus-guided flag space exploration
   - Integrates with existing self-harness orchestrator
   - Validates all changes through paired benchmarks

4. **Build tuning profile system** (Phase 3)
   - Pre-tuned profiles for qwen3.6, llama, etc.
   - `uap tune model <name>` CLI command
   - Profiles stored in transfer store with provenance

### Long-term (8-12 weeks)

5. **Real-time adaptation** (Phase 4)
   - Mid-session flag adjustment based on live telemetry
   - Requires proxy integration for live config changes

6. **Meta-learning** (Phase 5)
   - Cross-model transfer of tuning knowledge
   - One-shot tuning for new executor models

### Priority Rationale

The quality scorer is the bottleneck. Without a quality signal beyond pass/fail, the LLM tuner has nothing to optimize toward. The existing paired benchmarks measure whether code works, not whether the output is *good*. Raising qwen3.6 toward Opus 4.8 is fundamentally a quality problem, not a correctness problem.

The Self-Harness Mod DSL extension is the second priority because it unlocks the existing orchestrator infrastructure for recipe/concurrency tuning without building new validation pipelines.

The LLM Tuner is the third priority because it depends on both the quality signal and the expanded Mod DSL.

---

## 9. Files to Create/Modify

### New files

| File | Purpose |
|------|---------|
| `src/self-tuning/quality-scorer.ts` | Multi-dimensional quality scoring |
| `src/self-tuning/llm-tuner.ts` | LLM-guided flag proposal |
| `src/self-tuning/search-reducer.ts` | Search space pruning |
| `src/self-tuning/flag-writer.ts` | Atomic config write/rollback |
| `src/self-tuning/tuning-profile.ts` | Model-specific tuning profiles |
| `src/self-tuning/realtime-adaptor.ts` | Per-session flag adaptation |
| `src/self-tuning/orchestrator.ts` | Extends self-harness with tuning loop |
| `src/cli/self-tuning.ts` | CLI entry point |
| `src/self-tuning/profiles/qwen36.json` | Default qwen3.6 tuning profile |
| `src/self-tuning/profiles/opus48.json` | Opus 4.8 reference profile |
| `scripts/tune-model.ts` | `uap tune model` CLI |
| `docs/guides/SELF_TUNING.md` | User documentation |

### Modified files

| File | Change |
|------|--------|
| `src/benchmarks/paired/types.ts` | Add `qualityScore` to `RunRecord` |
| `src/benchmarks/paired/report.ts` | Include quality scores in comparisons |
| `src/benchmarks/paired/stats.ts` | Statistical tests on quality scores |
| `src/self-harness/mods.ts` | Add knob specs for recipe/concurrency/handsfree flags |
| `src/self-harness/transfer.ts` | Extend with tuning outcome records |
| `src/self-harness/orchestrator.ts` | Wire in LLM tuner as alternative proposer |
| `src/self-harness/run.ts` | Add `uap self-harness tune` command |
| `src/config/settings-registry.ts` | Add any new tunable flags |
| `src/telemetry/session-telemetry.ts` | Add per-turn quality estimation |
| `src/index.ts` | Export new modules |

---

## 10. Relationship to Existing Work

| Existing System | How Self-Tuning Relates |
|----------------|------------------------|
| **Self-Harness** | Self-tuning extends Self-Harness; uses same orchestrator, validation pipeline, transfer store |
| **Paired Benchmarks** | Self-tuning reuses the benchmark pipeline; adds quality scoring on top |
| **Recipes/Escalation** | Self-tuning optimizes recipe config; recipes provide the quality signal (judge model) |
| **Cross-Model Transfer** | Self-tuning stores tuning outcomes in transfer store; uses transfer as priors for new models |
| **Speculative Autotune** | Separate concern: autotune optimizes throughput/latency; self-tuning optimizes quality |
| **Delivery Convergence** | Self-tuning validates changes through delivery; delivery provides real-world validation signal |
| **Dashboard** | Self-tuning results visible in dashboard (tuning history, quality trends, profile comparison) |

---

## 11. Appendix: Flag Dependency Map

Understanding which flags interact is critical for search space reduction.

```
recipes.enabled
├── recipes.recipe (enum)
│   ├── confidence → recipes.confidenceThreshold
│   ├── fusion → recipes.fusionN
│   └── ratings → (standalone)
├── recipes.allowSelfJudge (bool, conflicts with recipes.judge.model)
└── recipes.judge.model (requires PROXY_ESCALATE_API_KEY)

PROXY_RECIPE (must match recipes.recipe)

handsfree.enabled
├── handsfree.intensity
└── UAP_HANDSFREE_STAGNATION_LIMIT

modelConcurrency.slots
├── modelConcurrency.headroom
└── modelConcurrency.adaptive

memory.patternRag.enabled
└── QDRANT_URL (runtime dep)

delivery.enforcement
└── UAP_ENFORCE_DELIVERY (env override)

PROXY_CONTEXT_WINDOW
└── (affects all models proportionally)

PROXY_LOOP_BREAKER + PROXY_STUCK_BREAK
└── PROXY_RECON_CONVERGENCE_THRESHOLD (threshold for loop detection)
```

---

## 12. Appendix: Existing Self-Harness Mod DSL

Current knob allowlist (from `src/self-harness/mods.ts`):

```typescript
const KNOB_ALLOWLIST = {
  // Llama.cpp serving params
  LLAMA_CONTEXT_SIZE:   { type: 'number', min: 512, max: 16384, integer: true, target: 'llama' },
  LLAMA_TEMP:           { type: 'number', min: 1.0, max: 1.3, target: 'llama' },

  // Proxy env params
  PROXY_MAX_TURNS:      { type: 'number', min: 10, max: 80, integer: true, target: 'proxy' },
  PROXY_RECON_CONVERGENCE_THRESHOLD: { type: 'number', min: 5, max: 40, integer: true, target: 'proxy' },
  PROXY_CONCURRENCY_LIMIT: { type: 'number', min: 2, max: 24, integer: true, target: 'proxy' },
  PROXY_CONTEXT_WINDOW: { type: 'number', min: 5, max: 40, integer: true, target: 'proxy' },
} as const;
```

**Note**: These are all numeric knobs targeting proxy/llama env vars. The self-tuning system needs to extend this to:
- Enum knobs (e.g., `recipes.recipe`, `handsfree.intensity`)
- Boolean knobs (e.g., `recipes.enabled`, `handsfree.enabled`)
- Nested JSON config knobs (e.g., `recipes.judge.model`)
- String knobs (e.g., `worktrees.branchPrefix`)
