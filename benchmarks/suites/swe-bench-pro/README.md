# SWE-bench Pro — paired UAP-uplift A/B

The `uap bench paired` configuration that measures how much **UAP lifts a fixed
local model** on long-horizon, real-gate coding tasks:

```
uplift = score(Qwen3.6 + UAP) − score(Qwen3.6 + plain agent)
```

The base model and base agent are held constant; only the UAP scaffold toggles.
See [`../../../docs/guides/TWO_AGENTS_AND_UPLIFT.md`](../../../docs/guides/TWO_AGENTS_AND_UPLIFT.md)
for why SWE-bench Pro is the primary instrument (real hidden test gates =
UAP's converge-to-green analog; ideal Qwen-tier headroom; contamination-resistant
vs Verified; agent-native with swappable scaffolds).

## Why this, not a hand-written suite

The paired harness (`src/benchmarks/paired/`) scores an agent by copying a local
`repo/` fixture into an isolated scratch dir, running the agent, then running a
**hidden `verifyCmd`** that exits 0 iff the task is resolved. `generate.py` maps
each SWE-bench Pro instance onto exactly that shape and — critically — delegates
scoring to the **official SWE-bench evaluator** rather than reimplementing per-repo
test logic. The agent edits the working tree; `verify.sh` derives its patch as
`git diff` against `base_commit` and hands it to `swebench.harness.run_evaluation`
as a single-instance prediction.

## Layout

```
swe-bench-pro/
  README.md            ← you are here
  suite.config.yaml    ← canonical run parameters (arms, model, seeds, prereqs)
  generate.py          ← SWE-bench Pro instances → task-folder suite
  run-ab.sh            ← generate + run the paired A/B end-to-end
  examples/            ← a sample emitted task.json (NOT scanned as a task)
```

> This directory is the **config**, not a runnable suite — it has no top-level
> task folders, so pointing `--suite` here yields "no tasks found". `generate.py`
> writes the runnable suite to a separate dir (default `../swe-bench-pro-generated`).

## Prerequisites

- `pip install swebench` — the official evaluator (`verify.sh` official mode)
- **Docker** running — SWE-bench Pro instance images
- `opencode` installed, with `opencode.json` routing the Qwen model to the proxy
- `uap proxy` up — `uap-anthropic-proxy` on `:4000` in front of Qwen at `:8080`
- A SWE-bench Pro **instances file** (JSONL or JSON array) with at least:
  `instance_id, repo, base_commit, problem_statement, test_patch,
  FAIL_TO_PASS, PASS_TO_PASS` (optional `test_cmd`)

## Run it

```bash
# Full A/B (baseline vs uap-full vs uap-lazy), 5 seeds:
./run-ab.sh path/to/swe_bench_pro_public.jsonl

# Quick smoke (25 instances, 3 seeds):
LIMIT=25 EPOCHS=3 ./run-ab.sh instances.jsonl

# Per-component ablation (which UAP piece carries the uplift):
ABLATION=1 ./run-ab.sh instances.jsonl

# Measure the `uap deliver` machine specifically instead of prompt-injection:
ADAPTER=deliver ./run-ab.sh instances.jsonl
```

Or drive the harness directly after generating:

```bash
python3 generate.py --instances instances.jsonl --out ../swe-bench-pro-generated --shallow
uap bench paired --suite ../swe-bench-pro-generated \
    --adapter opencode --model qwen36-a3b --epochs 5 --concurrency 4 --lazy
```

Artifacts land in `benchmark-results/paired-<timestamp>/` — `records.jsonl`
(raw, for audit), `report.json`, and `report.md`. The **headline is the paired
Δ resolve-rate (uap-full − baseline) with a 95% CI**, never a single-run number.

## The arms

| Arm | What it is | Components |
|-----|-----------|-----------|
| `baseline` | bare opencode + Qwen3.6 | *(none)* |
| `uap-full` | same agent + full UAP surface injected | gates, worktree, memory, experts, skills, patterns |
| `uap-lazy` | bare first attempt; UAP engages only on gate failure | all, lazy |

Same seed drives the same task across all arms, so records pair cell-for-cell —
the basis for the McNemar 2×2 and paired-bootstrap stats in
`src/benchmarks/paired/stats.ts`.

## `verify.sh` scoring modes

- `SWEBENCH_VERIFY_MODE=official` **(default)** — canonical: builds a prediction
  from the agent's working-tree diff and runs the official Docker evaluation for
  that instance. Requires `swebench` + Docker + a pullable image.
- `SWEBENCH_VERIFY_MODE=local` — Docker-free fallback: applies the test patch and
  runs the instance's `test_cmd` on `FAIL_TO_PASS`+`PASS_TO_PASS` locally. Faster,
  but less faithful (no image isolation, best-effort per-repo test command).

`gate.sh` is the **visible** subset the UAP gate loop iterates against (runs the
`PASS_TO_PASS` tests locally to catch regressions); it is *not* authoritative.

## Methodology guardrails (don't skip)

1. **Hold all but the harness constant** — same weights, quant, decode params,
   context window, tool budget, task set, and seeds across arms.
2. **≥5 seeds + paired stats** — agentic runs are high-variance; a single-run
   delta is noise. The harness reports CIs and McNemar by default.
3. **Standardize the external baseline = mini-SWE-agent** — bash-only, the most
   robust control for Qwen via llama.cpp. Run it separately for public
   comparability (see *Extending* below); the paired toggle here holds the base
   agent = opencode constant.
4. **Report the split + scaffold every time** — SWE-bench Pro numbers differ by
   both.
5. **Watch cost + the snapshot/tmpfs leak** — long solves are heavy; cap
   `--concurrency` at your inference slot budget.
6. **Verify the numbers** — the headroom figures in the docs are directional
   (mid-2026 aggregators); re-pull exact Qwen3.6 scores from the primary
   SWE-bench Pro leaderboard before publishing.

## Extending

- **mini-SWE-agent reference arm** — add a `miniSweAdapter` in
  `src/benchmarks/paired/adapter.ts` (a `SubprocessAdapter` invoking
  `mini-swe-agent`/`mini` in `{workdir}` with the instruction), register it in
  `src/cli/bench.ts` `pickAdapter`, then run it as a separate baseline for
  cross-harness comparability against the public leaderboard.
- **Terminal-Bench 2.0 (secondary)** — a separate Harbor/Terminus adapter; the
  canonical harness-native confirmatory instrument.
- **RoadmapBench (stretch)** — partial-credit scoring; the most sensitive detector
  of incremental convergence-loop gains. Needs a partial-credit `verifyCmd`
  (return a score, not just 0/1) — a small extension to the metric vector.
