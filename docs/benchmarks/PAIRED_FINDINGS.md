# Paired Benchmark Findings — When Does UAP Actually Help?

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
