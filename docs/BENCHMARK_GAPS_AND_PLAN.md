# UAP Benchmark: Actual Gaps & Execution Plan

**Generated:** 2026-03-17
**Benchmark:** Harbor Terminal-Bench 2.0 (89 tasks)
**Primary Target:** Qwen3.5 35B A3B (IQ4_XS)

---

## What Already Exists (DO NOT REBUILD)

| Component                        | File                                                       | Status                                                                                         |
| -------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Baseline benchmark (no UAP)      | `scripts/benchmarks/benchmark-qwen35-baseline-no-uap.tsx`  | 403 lines, 94 tasks                                                                            |
| UAP benchmark (full integration) | `scripts/benchmarks/benchmark-qwen35-uap-3.0-opencode.tsx` | 812 lines, 89 tasks                                                                            |
| Harbor quick runner (UAP)        | `scripts/benchmarks/run-tbench-qwen35-quick.sh`            | 459 lines, hybrid-adaptive                                                                     |
| Harbor baseline+UAP runner       | `scripts/benchmarks/run-harbor-qwen35-benchmark.sh`        | Runs both configs sequentially                                                                 |
| Harbor YAML configs              | `benchmarks/harbor-configs/qwen35_*.yaml`                  | Baseline + UAP pair                                                                            |
| Comparison report generator      | `scripts/benchmarks/generate-comparison-report.ts`         | 461 lines, p-value tests                                                                       |
| Full benchmark harness           | `scripts/benchmarks/run-full-benchmark.sh`                 | 413 lines, multi-model A/B                                                                     |
| Multi-turn agent loop            | `src/benchmarks/multi-turn-loop.ts`                        | 213 lines, `executeWithRetry()`                                                                |
| Multi-turn + verification        | `src/benchmarks/multi-turn-agent.ts`                       | Wired to dynamic retrieval                                                                     |
| Improved benchmark runner        | `src/benchmarks/improved-benchmark.ts`                     | 794 lines, wires multi-turn + dynamic retrieval + task classification + hierarchical prompting |
| Dynamic memory retrieval         | `src/memory/dynamic-retrieval.ts`                          | 1168 lines, 6 memory sources, adaptive depth                                                   |
| Task classifier                  | `src/memory/task-classifier.ts`                            | 426 lines, 8 categories, ambiguity detection                                                   |
| Qdrant embeddings                | `src/memory/embeddings.ts`                                 | Fixed, 5 backends with fallback                                                                |
| Tool call retry (Qwen)           | `tools/agents/scripts/qwen_tool_call_wrapper.py`           | 686 lines, 6 retry strategies                                                                  |
| Harbor UAP agent                 | `tools/uap_harbor/uap_agent.py`                            | 379 lines, classified preamble                                                                 |
| Qwen3.5 model presets            | `src/models/types.ts:136-151`                              | `qwen35-a3b` and `qwen35` defined                                                              |
| Model router                     | `src/models/router.ts`                                     | Qwen3.5 as default executor                                                                    |

---

## Actual Gaps (3 items)

### Gap 1: `improved-benchmark.ts` MODELS array missing Qwen3.5

`src/benchmarks/improved-benchmark.ts:95-99` has the fully wired runner (multi-turn + dynamic retrieval + task classification + hierarchical prompting + verification) but its MODELS array only contains:

```typescript
const MODELS: ModelConfig[] = [
  { id: 'opus-4.5', name: 'Claude Opus 4.5', apiModel: 'claude-opus-4-5-20251101' },
  { id: 'glm-4.7', name: 'GLM 4.7', apiModel: 'glm-4.7' },
  { id: 'gpt-5.2-codex', name: 'GPT 5.2 Codex', apiModel: 'gpt-5.2-codex' },
];
// Qwen3.5 MISSING
```

**Fix:** Add Qwen3.5 to the MODELS array. The preset already exists in `src/models/types.ts:136-151`.

### Gap 2: `model-integration.ts` MODELS array missing Qwen3.5 + still single-shot

`src/benchmarks/model-integration.ts:336-361` is the older benchmark runner. It:

- Has no Qwen3.5 in its MODELS array
- Uses single-shot execution (no multi-turn, no dynamic retrieval)

**Fix:** Add Qwen3.5 to its MODELS array. The multi-turn wiring gap is already solved by `improved-benchmark.ts` -- this file can remain as the "legacy single-shot" runner for comparison purposes.

### Gap 3: No benchmark results exist

`benchmark-results/` directory does not exist. None of the scripts have been executed.

**Fix:** Run the existing scripts.

---

## Execution Plan

### Step 1: Add Qwen3.5 to improved-benchmark.ts MODELS array

**File:** `src/benchmarks/improved-benchmark.ts:95-99`

```typescript
const MODELS: ModelConfig[] = [
  { id: 'opus-4.5', name: 'Claude Opus 4.5', apiModel: 'claude-opus-4-5-20251101' },
  { id: 'glm-4.7', name: 'GLM 4.7', apiModel: 'glm-4.7' },
  { id: 'gpt-5.2-codex', name: 'GPT 5.2 Codex', apiModel: 'gpt-5.2-codex' },
  { id: 'qwen35-a3b', name: 'Qwen 3.5 35B A3B', apiModel: 'qwen35-a3b-iq4xs' },
];
```

### Step 2: Add Qwen3.5 to model-integration.ts MODELS array

**File:** `src/benchmarks/model-integration.ts:336-361`

```typescript
{
  id: 'qwen35-a3b',
  name: 'Qwen 3.5 35B A3B',
  provider: 'local',
  apiModel: 'qwen35-a3b-iq4xs',
},
```

### Step 3: Run existing benchmarks

```bash
# Option A: Quick Qwen3.5 baseline + UAP via Harbor (recommended first)
./scripts/benchmarks/run-harbor-qwen35-benchmark.sh

# Option B: Direct API baseline (no Harbor containers)
npx tsx scripts/benchmarks/benchmark-qwen35-baseline-no-uap.tsx

# Option C: Direct API UAP-enhanced
npx tsx scripts/benchmarks/benchmark-qwen35-uap-3.0-opencode.tsx

# Option D: Improved benchmark with multi-turn + dynamic retrieval (all models)
npx tsx src/benchmarks/improved-benchmark.ts

# Option E: Full Harbor harness (all models, baseline vs UAP)
./scripts/benchmarks/run-full-benchmark.sh --model qwen35-a3b-iq4xs
```

### Step 4: Generate comparison report

```bash
npx tsx scripts/benchmarks/generate-comparison-report.ts \
  --baseline benchmark-results/qwen35_baseline_no_uap/ \
  --uap benchmark-results/qwen35_uap_3.0_opencode/
```

---

## What This Plan Does NOT Do (because it already exists)

- Build a multi-turn agent loop (exists: `src/benchmarks/multi-turn-loop.ts`)
- Build dynamic memory retrieval (exists: `src/memory/dynamic-retrieval.ts`)
- Build task classification (exists: `src/memory/task-classifier.ts`)
- Fix Qdrant embeddings (already fixed: `src/memory/embeddings.ts`)
- Build Harbor configs (exist: `benchmarks/harbor-configs/qwen35_*.yaml`)
- Build comparison report generator (exists: `scripts/benchmarks/generate-comparison-report.ts`)
- Wire multi-turn into benchmark runner (exists: `src/benchmarks/improved-benchmark.ts`)
- Build tool call retry for Qwen (exists: `tools/agents/scripts/qwen_tool_call_wrapper.py`)
- Create execution scripts (exist: 6+ scripts in `scripts/benchmarks/`)

---

## Estimated Effort

| Step                                 | Effort         | Type                                   |
| ------------------------------------ | -------------- | -------------------------------------- |
| Add Qwen3.5 to improved-benchmark.ts | 2 minutes      | Code change (1 line)                   |
| Add Qwen3.5 to model-integration.ts  | 2 minutes      | Code change (5 lines)                  |
| Run benchmarks                       | 2-8 hours      | Execution (depends on model speed)     |
| Review results                       | 30 minutes     | Analysis                               |
| **Total**                            | **~3-9 hours** | Mostly waiting for benchmark execution |
