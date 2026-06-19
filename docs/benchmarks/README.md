# UAP Benchmarks

Performance and accuracy results for the Universal Agent Protocol.

## Controlled paired result (start here)

The rigorous, reproducible finding from the [paired harness](PAIRED_HARNESS.md)
— same model, same tasks, same seeds, toggling **only** UAP, with confidence
intervals:

> **UAP's accuracy lift depends on whether the base agent already self-verifies.**
> Vs an agentic harness that self-tests → **~0pp** (overhead only). Vs a
> non-agentic single-shot model → **+20pp** (78% → 98%, 95% CI [+8, +32],
> p=0.008) from the gate loop repairing edge-case bugs.

Full analysis with all five experiments: **[Paired Findings](PAIRED_FINDINGS.md)**.

## Earlier (uncontrolled) Terminal-Bench numbers

UAP-on vs. baseline, 12 representative tasks across 8 categories. These are
*uncontrolled* — the [TBench Investigation](TBENCH_INVESTIGATION.md) found the
apparent lifts were largely confounds; treat the paired results above as
authoritative.

| Metric | Baseline | With UAP | Δ |
|---|---|---|---|
| Tokens consumed | 558,000 | 280,438 | **−49.7%** |
| Task success rate | 25% | 58% | **+33pp** |
| Errors per task | 1.17 | 0.42 | **−68%** |
| Wall-clock (total) | 618s | 266s | **−57%** |

## Reports

| Doc | What it covers |
|---|---|
| [**Paired Findings**](PAIRED_FINDINGS.md) | Controlled results: when UAP helps (+20pp vs non-agentic; ~0pp vs agentic), with CIs ⭐ |
| [Paired Harness](PAIRED_HARNESS.md) | The `uap bench paired` A/B harness: design, adapters, authoring tasks |
| [TBench Investigation](TBENCH_INVESTIGATION.md) | Earlier finding: uncontrolled "lifts" were confounds |
| [Validation Results](VALIDATION_RESULTS.md) | Full methodology + per-task breakdown |
| [Token Optimization](TOKEN_OPTIMIZATION.md) | Where the token savings come from |
| [Accuracy Analysis](ACCURACY_ANALYSIS.md) | Success-rate and error analysis |
| [Comprehensive Benchmarks](COMPREHENSIVE_BENCHMARKS.md) | Extended measurements |

See the [documentation index](../INDEX.md) for the rest of the docs.
