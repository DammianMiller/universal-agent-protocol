# Paired UAP Benchmark Harness

A controlled A/B experiment that measures the impact of the UAP layer on
**accuracy, efficiency, and outcomes** by holding the base model + base agent
constant and toggling UAP on/off over the *same* task suite and seeds.

This matches the evaluation methodology the literature converges on for a
*scaffold/middleware* layer (UAP changes the scaffold, not the model):

- **Paired design** — the same task at the same seed runs in both arms, so the
  analysis removes between-task variance (the dominant noise source) and gains
  far more statistical power than comparing two independent means.
- **Metric vector, not a headline number** — correctness *and* tokens, turns,
  tool-calls, cost, latency, each reported as a paired delta with a 95% CI.
- **Deterministic ground truth** — each task's `verifyCmd` is the scorer (exit 0
  ⇒ resolved). No LLM judge.
- **Beat a strong baseline** — the baseline arm is the *bare* agent on the same
  model and prompt; the only thing that differs is the injected UAP surface.
- **Per-component ablation** — leave-one-out matrix attributes the marginal
  contribution (and token cost) of each UAP component, so we can tell whether
  the whole protocol earns its overhead or just a couple of features do.

## Quick start

```bash
# Offline plumbing check with the deterministic mock adapter:
uap bench paired --suite benchmarks/suites/smoke --adapter mock --epochs 8

# Real A/B against a real agent (opencode / claude) on the real-gate suite:
uap bench paired --adapter opencode --model qwen35-a3b --epochs 5
uap bench paired --adapter claude   --model claude-sonnet-4-6 --epochs 5

# Per-component ablation (baseline + full + leave-one-out per component):
uap bench paired --adapter opencode --model qwen35-a3b --epochs 8 --ablation
```

Artifacts are written to `benchmark-results/paired-<timestamp>/`:

- `records.jsonl` — every run (for post-hoc audit / re-analysis)
- `report.json` — structured analysis (per-condition, comparisons, ablation)
- `report.md` — the human-readable paired report

## How the on/off toggle works

For each non-baseline arm the harness injects an inspectable UAP surface into the
isolated scratch repo before the agent runs (see `src/benchmarks/paired/scaffold.ts`):

- `AGENTS.md` — the cross-agent instruction file with one section per enabled
  component (gates, worktree, memory, experts, skills, patterns).
- `.uap-bench.json` — a machine-readable manifest installed UAP hooks can consume.
- Environment: `UAP_BENCH_COMPONENTS`, `UAP_DELIVER_ACTIVE`, etc.

The baseline arm gets none of this. Everything else — model, prompt, repo state,
seed — is identical, so the measured delta is attributable to UAP alone. The
injected files are plain text precisely so a reviewer can audit exactly what the
"treatment" was (pre-empting the asymmetric-prompt critique that sank prior
memory-layer benchmarks).

## Authoring a real-gate task

```
benchmarks/suites/real-gate/<task-id>/
  task.json        # instruction, difficulty, verifyCmd, timeouts
  repo/            # git fixture in a FAILING state
```

`task.json` fields (see `TaskSpecSchema` in `src/benchmarks/paired/types.ts`):

| field | meaning |
|---|---|
| `instruction` | natural-language task handed verbatim to the agent |
| `difficulty` | `easy` \| `medium` \| `hard` (used for slicing) |
| `verifyCmd` | shell command run inside the scratch repo; exit 0 ⇒ resolved |
| `setupCmd` | optional one-time setup after the repo is copied |
| `verifyTimeoutSec` / `agentTimeoutSec` | kill thresholds |

The `verifyCmd` is the ground truth: it must **fail** on the unmodified fixture
and **pass** once the task is correctly solved.

## Reading the report

- **Correctness** — baseline → treatment success rate, the paired Δ (percentage
  points) with a bootstrap 95% CI and a permutation p-value. A claim requires the
  CI to exclude 0.
- **Gate value (McNemar 2×2)** — of the tasks the baseline got wrong, how many
  did UAP *fix*, vs of the tasks the baseline got right, how many did UAP
  *regress*. A useful layer has `fixed ≫ regressed` (positive net gain).
- **Metric deltas** — paired Δ for tokens / turns / tool-calls / cost / latency.
  A credible UAP win is **non-inferior correctness at lower tokens/turns**, or
  higher correctness at acceptable cost.
- **Pareto** — success vs mean tokens per condition.

## Statistical notes

- Bootstrap CI and the sign-flip permutation test are both seeded
  (`--seed`, `--iterations`) so reports are reproducible. Single-run,
  non-reproducible numbers are the #1 credibility red flag.
- Run `--epochs ≥ 5` (the research recommendation); more distinct tasks reduce
  variance more than more reruns of the same few.
- Run across ≥2 backing models to show the lift is model-independent, not a quirk
  of one model.

## Adapters

| adapter | command | usage parsed |
|---|---|---|
| `mock` | none (deterministic simulation) | exercises the pipeline offline; **not** a source of real claims |
| `opencode` | `opencode run --model <m> <instruction>` | tokens, cost, steps, tool-calls (best-effort JSON) |
| `claude` | `claude -p <instruction> --output-format json --model <m>` | tokens, cost, turns |
| `raw` | one chat completion per cell; UAP arm loops it against the visible gate | tokens, turns, latency |
| `mini` | `mini -y -m <m> -t <instruction>` (mini-SWE-agent) | external comparability anchor |
| `deliver` | real `uap deliver` CLI per cell (baseline arm runs one bare turn) | verdict + turns from the JSON result |

New agents are a few lines: implement `AgentAdapter` (or configure a
`SubprocessAdapter` with a `parseUsage` function) in `src/benchmarks/paired/adapter.ts`.

### Time budgets on slow local models

A `deliver` cell's budget is `agentTimeoutSec × UAP_BENCH_DELIVER_TIMEOUT_MULT`
(default 6, raised from 3 in 2026-09). The ×3 era was calibrated on fast hosted
models; a full convergence mission on a slow local model (plan + self-gate +
N turns + acceptance judge, each model call costing minutes) blew through it
and the harness killed missions whose workdir already passed verification —
paired-qwen38-e4 lost 21/25 treatment cells that way, manufacturing a -8pp
"regression" out of pure budget starvation. Raise the multiplier (never
disable it — an unbounded cell is a wedged overnight run) when the backing
model is slow, and read a `timeout`-errored cell as *harness budget*, not a
model failure.
