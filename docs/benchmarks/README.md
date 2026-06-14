# UAP Benchmarks

Performance and accuracy results for the Universal Agent Protocol, measured on Terminal-Bench 2.0.

## Headline results

UAP-on vs. baseline, 12 representative tasks across 8 categories:

| Metric | Baseline | With UAP | Δ |
|---|---|---|---|
| Tokens consumed | 558,000 | 280,438 | **−49.7%** |
| Task success rate | 25% | 58% | **+33pp** |
| Errors per task | 1.17 | 0.42 | **−68%** |
| Wall-clock (total) | 618s | 266s | **−57%** |

## Reports

| Doc | What it covers |
|---|---|
| [Validation Results](VALIDATION_RESULTS.md) | Full methodology + per-task breakdown |
| [Token Optimization](TOKEN_OPTIMIZATION.md) | Where the token savings come from |
| [Accuracy Analysis](ACCURACY_ANALYSIS.md) | Success-rate and error analysis |
| [Comprehensive Benchmarks](COMPREHENSIVE_BENCHMARKS.md) | Extended measurements |

See the [documentation index](../INDEX.md) for the rest of the docs.
