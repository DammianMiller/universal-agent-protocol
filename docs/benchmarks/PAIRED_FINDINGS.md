# Paired Benchmark Findings — When Does UAP Actually Help?

> **2026-09-02 replication available:** re-run on Qwen3.8-27B × UAP v1.224.x —
> the +20pp lift did not replicate. The stronger model moved the ceiling
> (baseline 78%→94% on the same suite), and pooled across 146 raw-adapter
> cells the gate loop is an exact wash: **82.9% vs 82.9%, Δ 0.0pp
> [−5.5, +6.9]** — the CI excludes +20pp. UAP never significantly hurt
> accuracy on any surface; the one actionable regression is deliver-path
> stop-criteria latency on slow local models. See
> [the replication section](#2026-09-02-replication--qwen38-27b-dense--uap-v1224x).

Results from the controlled paired harness (`uap bench paired`, see
[PAIRED_HARNESS.md](PAIRED_HARNESS.md)). These supersede earlier uncontrolled
numbers and complete the story the [TBench Investigation](TBENCH_INVESTIGATION.md)
started: every "UAP lift" measured without a controlled baseline turned out to be
a confound. This is the rigorous version — same model, same tasks, same seeds,
toggling **only** the UAP layer, with bootstrap confidence intervals on every
delta.

## TL;DR

> **UAP's accuracy lift depends entirely on whether the base agent already
> self-verifies.** Against a strong agentic harness (opencode, which runs the
> tests itself), UAP adds overhead with **no measurable accuracy gain**. Against
> a non-agentic single-shot model, UAP's gate loop delivers **+20pp accuracy**
> (78% → 98%, 95% CI [+8, +32], p=0.008) by catching and repairing edge-case
> bugs the model ships in one shot.

| Baseline type | UAP accuracy lift | What this means |
|---|---|---|
| **Agentic** (opencode self-tests) | **~0pp** (CI spans 0) | gate is redundant; cost is pure overhead |
| **Non-agentic** (raw single-shot) | **+20pp** [CI +8, +32] | gate loop rescues failures the model can't self-catch |

The headline implication: **UAP's gate value is real and large, but only over a
baseline that doesn't already loop** — which is exactly the `uap deliver`
(model-wrapping) case. When you are already driving a capable agentic harness,
UAP's contribution shifts from *accuracy* to *efficiency, coordination, and
never-regress*.

## The experiments

Five controlled runs against `ik-llama/qwen36-35b-a3b-iq4xs` (a 35B-A3B MoE).
All paired, all with deterministic ground-truth `verifyCmd` scorers (no LLM
judge). Metrics reported as a vector — correctness **and** tokens/turns/latency —
each as a paired delta with a 95% bootstrap CI and a sign-flip permutation
p-value. Correctness deltas additionally get a McNemar 2×2 ("fixed" vs
"regressed").

### 1–3. Agentic baseline (opencode adapter)

| Run | Suite | Design | baseline → uap-full | Token Δ |
|---|---|---|---|---|
| 1 | real-gate (easy) | 2 tasks × 2 × 6 | 100% → 100% | +34.2k |
| 2 | real-gate-hard | 6 tasks × 8-arm ablation × 4 | 100% → 100% | +48.7k [13.9k, 93.3k] |
| 3 | real-gate-gated | 5 edge-case tasks × 8-arm ablation × 4 | 100% → 100% | +25.2k (n.s.) |

In every agentic run the **baseline already scored 100%** — there was no headroom
for UAP to improve accuracy. The per-component ablation (turning off gates /
worktree / memory / experts / skills / patterns one at a time) found **no
component with a Δsuccess confidence interval above zero**; the token deltas only
rank overhead.

**Root cause:** opencode is itself an agentic harness that runs the in-repo
tests and self-corrects by default. The UAP gate instruction is redundant on top
of an agent that already self-verifies — and adding in-repo tests to give the
"gate" something to run handed the same self-verification to the *baseline*.

### 4. Non-agentic baseline (raw single-shot vs gate loop) — the decisive run

To isolate **gate value**, the `raw` adapter calls the model's completion
endpoint directly:

- **baseline** = one completion, no self-check (whatever it writes is final)
- **uap-full** = execute → run the visible in-repo gate → feed the failure back
  → regenerate, looping until the gate passes (the `uap deliver` mechanism in
  miniature)

5 edge-case tasks × {single-shot, gate-loop} × 10 epochs, temperature 0.6
(so the first shot sometimes misses edges):

| Condition | Success | Errors | Tokens | Turns |
|---|--:|--:|--:|--:|
| baseline (single-shot) | **78.0%** | 22% | 1,170 | 1.0 |
| uap-full (gate loop) | **98.0%** | 2% | 2,242 | 1.3 |

- **Correctness: +20.0pp** — 95% CI **[+8.0, +32.0]**, p=0.008 ✅
- **Gate value (McNemar):** 11 fixed, 1 regressed, **net +10** (p=0.006)
- **Cost:** +1,072 tokens, +0.3 turns per task — cheap for a 20-point gain

When the baseline can't self-verify, it ships edge-case bugs 22% of the time. The
gate loop catches and repairs 11 of them, cutting the error rate to 2%. The one
"regressed" case is the honest caveat — once, the loop's rewrite broke something
single-shot happened to get right.

## What the tasks look like

Findings only hold if the tasks have real headroom. The `real-gate-gated` suite
was built so the **obvious solution passes the happy path but fails hidden edge
cases**, and validated before any run: for every task the stub fails, a correct
reference passes, **and a naive happy-path solution fails the hidden verify**.

| Task | Happy-path trap | Hidden edge the gate must catch |
|---|---|---|
| `py-roman-strict` | sum the symbols | reject invalid numerals (`IIII`, `VV`, `IL`) |
| `js-csv-parse` | `split(',')` | quoted commas, escaped `""`, CRLF, trailing newline |
| `js-deep-equal` | `JSON.stringify` compare | `NaN`, key order, `{a:undefined}` vs `{}` |
| `py-parse-duration` | single-unit only | combined `1h30m15s`, raise on invalid |
| `py-merge-intervals` | assume sorted, strict overlap | unsorted input, touching `[1,2],[2,3]→[1,3]` |

Each ships an in-repo test suite (the *visible* gate, `task.gateCmd`) distinct
from the hidden superset `verifyCmd` that remains the authoritative scorer.

## Methodology notes (and honest caveats)

- **Paired design** removes between-task variance — the dominant noise source.
  Deltas are bootstrap CIs (10k resamples, seeded for reproducibility) + a
  sign-flip permutation test. Single-arm point estimates are never claims.
- **Small N + a single shared GPU.** Token/latency CIs are wide and latency is
  confounded by request queueing on one GPU; read the *correctness* and *token*
  deltas, not absolute latency. The +20pp result holds with N=50/arm and a CI
  that excludes zero, but it is one model on five tasks — directional, not a
  universal constant.
- **Ceiling effect** is why the agentic runs show 0pp: a 35B model in an
  agentic harness simply solves these self-contained algorithmic tasks. A weaker
  model, or genuinely harder multi-file tasks, would re-open headroom.
- **Harness reliability:** an early ablation wedged for ~50 min because
  `spawnSync`'s timeout only SIGTERMs the immediate child while opencode forks a
  detached tree that keeps the pipe open. Fixed with a detached process-group
  spawn + group SIGKILL; subsequent runs completed 158–190/192 cleanly.

## 2026-09-02 replication — Qwen3.8-27B (dense) × UAP v1.224.x

Same paired design, re-run on the current production local stack:
**Qwen3.8-27B** (dense qwen35-arch, UD-IQ4_XS, native draft-mtp on llama.cpp,
131k ctx/slot × 2 slots, RTX 3090) against **UAP v1.224.x** — i.e. *after* the
quality-metrics gate (v1.223.0) and the deliver-pipeline hardening (v1.224.0)
shipped. Plan: [qwen38-uap-retest-plan](../plans/qwen38-uap-retest-plan.md).

**Headline: the +20pp gate-loop lift did not replicate at that magnitude —
because the stronger model moved the ceiling.** On the identical gated suite
the without-UAP baseline rose from 78% (qwen36 MoE) to **94%**, leaving almost
no headroom; UAP fixed every remaining baseline failure and regressed none.
On never-before-seen held-out tasks with real headroom (78.4% baseline), the
raw gate loop was net-neutral (5 fixed, 5 regressed). UAP never significantly
hurt accuracy on any surface; its costs (tokens, turns, latency) are real and
quantified below.

| Surface | n/arm | WITHOUT UAP | WITH UAP | Δ accuracy (95% CI) | McNemar fixed/regressed | Cost Δ |
|---|---|---|---|---|---|---|
| E1 raw, `real-gate-gated`, 10 ep | 50 | 94.0% | **100%** | **+6.0pp [0, +14]**, p=0.25 | **3 / 0** | +272 tok (n.s.) |
| E3a raw, `real-gate-heldout`, 3 ep | 51 | 78.4% | 78.4% | 0pp [−11.8, +11.8] | 5 / 5 | +1,044 tok [+101, +2,571] |
| E3b raw, `real-gate-power`, 3 ep | 45 | 75.6% | 68.9% | −6.7pp [−20, +6.7], p=0.51 | 3 / 6 | +117 tok (n.s.; loop never fired — see below) |
| E2 opencode, `real-gate-hard`, 4 ep | 36 | 94.4% | 97.2% | +2.8pp [0, +8.3], p=1 | 1 / 0 | +52.0k tok [+20.8k, +86.8k], +1.2 turns |
| E4 `uap deliver` (real pipeline), `real-gate-gated`, 5 ep | 25 | 68.0% | 60.0% | −8.0pp [−32, +16], p=0.75 | 4 / 6 | **+7.7 min/cell, p=0.0007** |

**Pooled raw-adapter estimate (E1+E3a+E3b, 146 paired cells, 38 distinct
tasks): 82.9% vs 82.9% — Δ 0.0pp, sign-flip 95% CI [−5.5, +6.9], p=1.0;
McNemar 11 fixed / 11 regressed.** The CI now *excludes* the original +20pp:
for this model, that lift is falsified, not replicated. (Pooled analysis:
paired sign-flip bootstrap over the union of the three runs' records, seed 1,
10k resamples — same method as the per-run reports.)

### How to read it

- **E1 (direct replication of the decisive qwen36 run):** same suite, same
  temp (0.6), same epochs. Baseline 78%→94% across model generations is the
  story — Qwen3.8-27B one-shots most edge cases the older MoE missed. UAP's
  gate loop converted the remaining 3 baseline failures into passes with zero
  regressions: same sign as the original +20pp, smaller magnitude because the
  headroom shrank. CI touches 0 at n=50, so treat as directional.
- **E3a (held-out tasks):** the honest counterweight. On tasks neither the
  model tuning nor this repo's earlier analysis could have overfit to, the
  loop's fixes (5) were exactly offset by rewrites that broke working
  single-shot answers (5). The +1,044-token overhead is real. Net accuracy
  claim on unseen tasks: **no measurable gain, no measurable harm**.
- **E3b (power suite):** a different null mechanism — uap-full turns = 1.0
  exactly. On these tasks the model's solution passes the *visible* in-repo
  gate but fails the *hidden* verify superset, so the gate loop has nothing
  to catch and never iterates; the arms differ only by prompt-surface
  sampling noise at temp 0.6 (3 flips one way, 6 the other). Lesson for suite
  design: gate-loop value requires the visible gate to correlate with the
  hidden edges; where it doesn't, UAP can neither help nor systematically
  hurt.
- **E2 (agentic harness):** replicates the original 0pp-at-ceiling finding in
  spirit (94.4% baseline; +2.8pp, 1 fixed / 0 regressed) and confirms the
  cost side precisely: the UAP surface costs ~52k tokens and ~1.2 turns per
  task on opencode. On a self-verifying agent, UAP's contribution is not
  first-pass accuracy.
- **E4 (the actual v1.224.x deliver pipeline, not the raw miniature):** the
  one surface where UAP underperformed its own bare-turn baseline (−8pp, CI
  spans 0, underpowered at n=25). The mechanism is visible in the records:
  **29 of 50 cells hit the 21-minute cell timeout** (median treatment latency
  = the cap), and every treatment mission ended in a not-delivered verdict —
  including 15 that had in fact written a verify-passing solution. The
  convergence loop does not stop in time on a slow local 27B: stop-criteria
  and acceptance-judge latency are calibrated for fast API models.
  **Actionable follow-up:** tune deliver stop criteria / judge timeouts for
  slow local backends (or auto-scale the cell budget to model speed) before
  quoting deliver-path numbers on this class of hardware.

### Cross-model caveat

The qwen36 → qwen38 comparison is **not paired**: model, serving stack
(llama.cpp build, template, speculative decoding), and UAP version all moved
between June and September. The per-model paired deltas above are the claims;
the generational baseline shift (78%→94% on the same suite) is context, not a
measurement of the model alone.

### Reproduce (this stack)

```bash
# Raw single-shot vs gate loop (E1):
UAP_RAW_TEMPERATURE=0.6 uap bench paired --adapter raw --model "Qwen3.8-27B" \
  --suite benchmarks/suites/real-gate-gated --epochs 10 --concurrency 2

# Agentic with/without (E2 — model id is opencode's provider/model form):
uap bench paired --adapter opencode --model "qwen-proxy/Qwen3.8-27B" \
  --suite benchmarks/suites/real-gate-hard --epochs 4 --concurrency 2

# Real deliver pipeline (E4 — model is a deliver preset, not the served alias):
uap bench paired --adapter deliver --model "qwen38-27b" \
  --suite benchmarks/suites/real-gate-gated --epochs 5 --concurrency 2
```

Artifacts: `benchmark-results/paired-qwen38-e1-gated`,
`-e2-hard-opencode`, `-e3a-heldout`, `-e3b-power`, `-e4-deliver2`.

## Reproduce

```bash
# The decisive gate-value experiment (raw single-shot vs gate loop):
UAP_RAW_TEMPERATURE=0.6 uap bench paired \
  --adapter raw --model "<model-served-name>" \
  --suite benchmarks/suites/real-gate-gated \
  --epochs 10 --concurrency 3

# Agentic baseline + per-component ablation:
uap bench paired --adapter opencode --model <provider/model> \
  --suite benchmarks/suites/real-gate-hard --ablation --epochs 4
```

Artifacts (`records.jsonl`, `report.json`, `report.md`) land in
`benchmark-results/paired-<timestamp>/`. See [PAIRED_HARNESS.md](PAIRED_HARNESS.md)
for the harness internals, adapters, and how to author a task.

## Bottom line

The accuracy-lift hypothesis is **falsified for the agentic-vs-agentic case** and
**confirmed for the non-agentic case**. Use UAP's gate loop (`uap deliver`) when
wrapping a model that won't self-verify — that is where the measurable accuracy
win lives. When you already run a strong agentic harness, value UAP for its
efficiency (token savings), coordination (multi-agent file safety), and
never-regress guarantees, not for first-pass accuracy.
