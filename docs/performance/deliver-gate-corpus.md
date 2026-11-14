# Delivery-gate corpus — the descriptive model × technique × tier table

Generated 2026-11-14 by `python3 scripts/aggregate_gate_corpus.py`
([proof-plan option O1](../plans/model-performance-proof-options.md),
directed by [client-performance option
O-E](../plans/droid-client-performance-options.md)).

**Discrimination status: descriptive by construction.** This is a population
record, not a controlled experiment — no paired arm exists *inside* this
aggregation. Per the house rule it is never quoted as a finding; it directs
where to spend the controlled paired runs (O2). The paired-benchmark rows
carry their own per-run discrimination verdicts verbatim (floor / ceiling /
underpowered / discordant-pair analysis from the harness itself); the
`full-uap-stack` rows are live single-attempt delivery observations.

## The table

<!-- BEGIN GENERATED: scripts/aggregate_gate_corpus.py (regenerate) -->
| Model | Technique | Tier | n attempts | Gate pass | Mean tokens | Mean turns | Discrimination |
| --- | --- | --- | ---: | ---: | ---: | ---: | --- |
| `opus-4.8` | full-uap-stack | frontier | 2 | 0.0% | n/r | 5.0 | descriptive (n=1) |
| `Qwen3.8-27B` | baseline | local | 176 | 71.0% | 3067 | 1.0 | floor; no-discordant-pairs; underpowered |
| `Qwen3.8-27B` | uap-full | local | 176 | 71.0% | 3514 | 1.0 | floor; no-discordant-pairs; underpowered |
| `bench-proxy/qwen35-a3b-iq4xs` | baseline | local | 123 | 94.3% | 3270 | 13.7 | unlabeled |
| `bench-proxy/qwen35-a3b-iq4xs` | uap-full | local | 123 | 96.7% | 3311 | 13.9 | unlabeled |
| `qwen-proxy/Qwen3.8-27B` | baseline | local | 36 | 94.4% | 253828 | 7.0 | underpowered |
| `qwen-proxy/Qwen3.8-27B` | uap-full | local | 36 | 97.2% | 309971 | 8.3 | underpowered |
| `qwen35-a3b` | baseline | local | 295 | 38.6% | 6901 | 1.0 | floor; ok; unlabeled |
| `qwen35-a3b` | full-uap-stack | local | 5 | 73.2% | n/r | 7.4 | descriptive (n=1) |
| `qwen35-a3b` | uap-full | local | 295 | 54.2% | 21973 | 2.1 | floor; ok; unlabeled |
| `qwen35-a3b` | uap-lazy | local | 40 | 67.5% | 21070 | 2.7 | unlabeled |
| `qwen36-35b-a3b-iq4xs` | baseline | local | 79 | 7.6% | n/r | n/r | unlabeled |
| `qwen36-35b-a3b-iq4xs` | uap-full | local | 79 | 3.8% | n/r | n/r | unlabeled |
| `qwen38-27b` | baseline | local | 62 | 62.9% | n/r | 1.0 | ceiling; underpowered |
| `qwen38-27b` | uap-full | local | 62 | 62.9% | n/r | 1.0 | ceiling; underpowered |
<!-- END GENERATED -->

## Sources

Two corpora, pooled by (model, technique, tier):

1. **Paired benchmark reports** (`benchmark-results/<run>/report.json`, 34
   runs) — the A/B harness output. `baseline` vs `uap-full` vs `uap-lazy` are
   the technique arms; the gate pass is the run's own success rate pooled
   over its `n` attempts, and token/turn costs are the arm means weighted by
   n. Model ids carry the harness adapter prefix where the run used one
   (`bench-proxy/…`, `qwen-proxy/…`).
2. **Live `[deliver]` lessons** (`full-uap-stack` rows, from the memory-DB
   backups and the committed memory bridge mirror) — every recorded delivery
   outcome, best-%-of-gates per attempt, n=1 each. Token cost is not recorded
   per lesson (n/r).

## What the table already says (directions, not findings)

- The **floor/ceiling discrimination verdicts matter more than the rates**:
  `qwen38-27b` at 62.9% in BOTH arms is a ceiling row (the task set caps the
  measurable difference), and `Qwen3.8-27B` at 71.0% in both arms is a
  no-discordant-pairs floor. Rows like those cannot rank techniques no
  matter how large the n — the discriminating runs are the ones the harness
  itself labeled `ok` or `underpowered`.
- `qwen35-a3b` is the only model with a large non-floor gap in both
  directions: baseline 38.6% → uap-full 54.2% (+15.6 points, n=295, harness
  verdict `ok`), at ~3.2x the token cost and ~2x the turns — the UAP layer
  buys gates on weak models by spending tokens, which is the exact trade the
  reliability ladder prices.
- The frontier row is **route-death, not model quality**: both `opus-4.8`
  attempts died at 0% of gates within 5 turns on the dead `:8317` passthrough
  (see the client-performance plan) — no frontier baseline exists yet.
- Live lessons (`full-uap-stack`) sit ABOVE the same model's benchmark
  baseline (qwen35-a3b: 73.2% best-gate average over 5 real deliveries vs
  38.6% bench baseline) — real tasks are more tractable than the paired task
  set, so bench rows are a pessimistic floor for live outcomes, not a
  prediction of them.

## Regenerating

```
python3 scripts/aggregate_gate_corpus.py            # markdown (this table)
python3 scripts/aggregate_gate_corpus.py --json     # the raw row records
```

The script reads the MAIN checkout only (benchmark-results/ is untracked run
output; worktrees do not carry it) and is fail-soft: unreadable run dirs and
non-matching rows are skipped, never fatal.
