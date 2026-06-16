# Terminal-Bench Investigation — Findings & Improvement Plan

> A rigorous investigation into whether UAP improves a local model
> (Qwen3.6-35B-A3B via llama.cpp) on terminal-bench@2.0, and what to do next.
> Headline: **every apparent gain we found was a measurement confound.** The
> value of the investigation is the *method* and a clear, honest baseline.

## TL;DR

- **`uap deliver` cannot beat a strong agentic baseline on terminal-bench**, and
  it's **structural**: the benchmark hides its verifier and the tasks expose no
  real gates, so deliver's convergence loop has nothing to converge against.
  Confirmed across 7 integration variants.
- **UAP's automatic context layer shows no measurable pass-rate lift** on this
  benchmark. The single apparent win (`fix-git` 0/3 → 3/3) was traced by
  ablation to a **one-flag harness bug** (`OpenCodeBaseline` invoked opencode
  without `--dir /app`), not to UAP. With a fair control the arms tie.
- **Single 6-task runs are not trustworthy** — per-task pass rates flip
  run-to-run (≈10–33% variance). Several "results" earlier in the investigation
  were variance, not signal.
- **What is genuinely true:** deliver's value is *real-gate projects*
  (build/test/CI), proven independently; terminal-bench is the wrong instrument
  to measure UAP-context value.

## Method

- Model: Qwen3.6-35B-A3B (IQ4_XS) on llama.cpp, OpenAI-compatible `:8080/v1`.
- Harness: harbor + the opencode agents in `tools/agents/opencode_uap_agent.py`.
- Subset: a 6-task "quick" set (`fix-git`, `openssl-selfsigned-cert`, `regex-log`,
  `sqlite-db-truncate`, `log-summary-date-ranges`, `financial-document-processor`).
- Multi-seed: `k=3` trials/task (added after single-run results proved noisy).
- A stall-watchdog (kill a container idle >22 min) handles the intermittent
  opencode hangs that otherwise lock a run for ~50 min.

## Results

### deliver integrations (6-task, single-run unless noted)

| Arm | Result | deliver's role |
|---|---|---|
| Baseline (opencode + UAP context) | 4/6 | none |
| Gateless deliver (per-edit trigger) | ≤2/5 + 23-min hang | vacuous / harmful |
| Self-gated deliver (trigger, blind exec) | 4/6 | inert |
| Agentic deliver (trigger) | 2/6 | **corrupted** tasks |
| Deliver-as-executor (agentic solver) | 2/6 | proxy-gated, underperforms |
| Deliver-hybrid (opencode + repair, `--keep-best`) | 3/6 | no-op (no real gates) → safe |

Deliver only helps when **real gates** exist; the subset exposes none, so it is
at best a no-op and at worst (forced against a self-authored *proxy* gate)
corrupts tasks the agent already solves.

### Baseline-vs-UAP A/B (k=3 = 18 trials/arm)

| | Confounded (broken control) | **Corrected (`--dir /app` fixed)** |
|---|---|---|
| Baseline | 10/18 (56%) | 10/16 (62%) |
| UAP-context | 11/17 (65%) | 11/17 (65%) |
| `fix-git` | 0/3 vs 3/3 | **3/3 vs 3/3** |

The corrected A/B's only per-task differences are within noise; on the 5 clean
(non-`sqlite`) tasks the fair baseline (10/15) is ≥ UAP (9/15). **No measurable
UAP-context lift.**

### Ablation of the one apparent win (`fix-git`)

| Variant | `fix-git` (k=3) | Conclusion |
|---|---|---|
| Plain opencode, no `--dir` | 0/3 | handicapped control |
| Full UAP | 3/3 | — |
| UAP − git domain snippet | 3/3 | domain knowledge ≠ cause |
| UAP − agentic-forcing − retry | 3/3 | tool-forcing ≠ cause |
| **Baseline + `--dir /app`** | **3/3** | **the actual cause (a harness bug)** |

## Methodology lessons (the durable value)

1. **An A/B is only as good as its control.** A single mis-invocation (`--dir
   /app`) manufactured a 9-point "UAP lift" that did not exist.
2. **Ablate a surprising win before believing it.** Every premature conclusion
   here was overturned by ablation or a fairer control.
3. **Always multi-seed.** n=1 on this benchmark is noise; report mean±range.
4. **Disprove cheaply first.** The `openssl` "difference" was killed in 30s by
   checking that the task matches no UAP category (no mechanism) — no run needed.
5. **Watchdog hang-prone runs.** `sqlite-db-truncate` hangs opencode for *both*
   agents; without a stall-killer a run loses hours.

---

## Improvement plan

Terminal-bench pass-rate has proven a poor instrument for UAP value (variance
swamps effects; deliver needs gates the benchmark hides). The options below are
split into "raise the tbench number" and "improve real UAP usage", since they
are different goals.

### A. Raise the terminal-bench number

1. **Fix the hangs (free reliability).** `sqlite-db-truncate` (and occasionally
   others) lock opencode for ~50 min, losing trials and wall-clock. Root-cause
   the stall (suspect: a tool-call that never returns, or the enforce-plugin
   loop detection) and bound it. Ship the stall-watchdog into the runner.
2. **Reduce variance with self-consistency.** Run N attempts/task and vote or
   judge-select. Directly converts boundary tasks (the 1–2/3 tasks) into wins.
   Cost: N× inference — but the model is local/zero-marginal-cost.
3. **Escalate hard tasks to a stronger model.** The compute/ML/algorithm tasks
   (`path-tracing`, `torch-tensor-parallelism`, `caffe-cifar-10`, `mteb-retrieve`,
   `financial-document-processor`) are beyond a 3B-active model's ceiling.
   Detect stagnation and escalate to a stronger model for those tasks only.
4. **Earn the UAP-context lift, measured.** Today it shows none. Either prove
   per-component value with controlled per-snippet A/Bs (multi-seed) and keep
   only what measurably helps, or redesign injection to be higher-signal
   (task-relevant patterns/skills with measured impact). Do **not** expand
   `PATTERN_SNIPPETS` on faith — the git snippet was proven inert.

### B. Improve real UAP usage (where value actually lives)

1. **deliver on real-gate projects.** This is deliver's home: build/test/CI
   repos with real gates. `--keep-best` makes it never-regress; the agentic
   executor + real-gate detection make it converge. Measure on real projects
   (time-to-green, regression rate), not terminal-bench.
2. **Token efficiency.** The MCP router's ~98% tool-schema reduction is a real,
   measurable win independent of pass-rate. Track tokens-per-task as a
   first-class metric — likely where UAP's clearest ROI is.
3. **Reliability & safety.** Enforcement gates, worktree isolation, and
   never-regress delivery are correctness wins that a pass-rate benchmark does
   not capture. Measure defects-prevented / regressions-avoided.
4. **Memory & continuity.** Cross-session recall is a usage-quality win; measure
   repeated-mistake rate across sessions, not single-task accuracy.

### Recommended sequence

1. **Fix the hangs** (cheap, unblocks every future run).
2. **Self-consistency on the quick-6, multi-seed** — the most likely real
   tbench gain, and a clean experiment.
3. **Escalation for the hard-task tail** — addresses the model-ceiling failures.
4. In parallel, **shift UAP-value measurement off pass-rate** to token
   efficiency + real-gate deliver, where the value is demonstrable.
