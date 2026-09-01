# UAP Benchmarks

Performance and accuracy results for the Universal Agent Protocol.

## How to read these numbers (the rationale)

UAP's core claim is *process* value: gates, memory, and coordination make an
agent's output more reliable. Measuring that honestly is hard, because an
agentic scaffold changes many variables at once (prompts, retries, tools,
budgets). So the benchmark program runs in two tiers, and they answer
different questions:

1. **Controlled paired A/B** (`uap bench paired`) — same model, same tasks,
   same seeds, same harness; the *only* thing toggled is the UAP scaffold.
   This is the only design that isolates UAP's causal contribution, and it's
   the tier whose numbers we quote as findings.
2. **Uncontrolled field runs** (Terminal-Bench 2.0, uplift sweeps) — real
   tasks, real agents, real token bills. These show magnitude and cost shape
   but can't attribute causation; the
   [TBench Investigation](TBENCH_INVESTIGATION.md) documents exactly how
   apparent lifts dissolve into confounds when you control the variables.

The headline below is therefore deliberately narrower than a marketing page
would like — that's the point.

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

## Task suites and raw runs

Reproduce or extend any of it:

- **Task suites** (`benchmarks/suites/`) — the paired-harness suites, ordered
  roughly by difficulty: `smoke/` (easy/medium/hard sanity checks),
  `real-gate/` and `real-gate-medium/` (small real tasks), `real-gate-hard/`,
  `real-gate-brutal/`, `real-gate-power/`, `real-gate-gated/` (tasks with a
  deterministic `verifyCmd` as ground truth — no LLM judge),
  `real-gate-heldout/` (kept out of tuning), and `swe-bench-pro/` (generator +
  A/B runner for SWE-bench-style tasks).
- **Cluster jobs** (`benchmarks/harbor-*.yaml`, `benchmarks/harbor-configs/`,
  `benchmarks/harbor-tasks/`) — Harbor job definitions for running the suites
  on a GPU box against local llama.cpp models (e.g. the Qwen3.5/3.6 configs).
- **Terminal-Bench shim** (`benchmarks/terminal_bench/`) — the opencode agent
  adapter used for the TBench runs.
- **Raw results** (`benchmark-results/`, untracked — local only) — every
  paired run drops a named directory (timestamped or version-labeled) with
  `records.jsonl`, `report.json`, and `report.md`. Notable series: the June
  2026 `paired-qwen36-*` sweeps (model/adapter/budget ablations), the
  `paired-uplift-*` regression series (per-version uplift tracking), and
  `real-uplift-1610/` (an agentic-baseline run: 100% → 83.3%, Δ −16.7pp with
  CI [−0.50, 0.00] spanning 0 — i.e. no measurable lift against an agent that
  already self-verifies, matching the paired finding).

A typical reproduction:

```bash
uap bench paired --adapter raw --suite benchmarks/suites/real-gate-gated
```

## What we measure

Each paired run reports a vector, not a single score: correctness delta with a
bootstrap 95% CI, a McNemar gate-value 2×2 (tasks the gates rescued vs tasks
they broke), token/turn/latency deltas, and a leave-one-out ablation over UAP
components so you can see which station earns its keep.

See the [documentation index](../INDEX.md) for the rest of the docs.
