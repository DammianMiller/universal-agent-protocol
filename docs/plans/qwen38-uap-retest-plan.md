# Qwen3.8-27B — With-UAP vs Without-UAP Comparison Plan (UAP v1.224.x)

**Status:** Proposed (no benchmark runs start without an explicit go)
**Date:** 2026-09-02
**Supersedes:** nothing — extends [PAIRED_FINDINGS.md](../benchmarks/PAIRED_FINDINGS.md) to the current model and current UAP

## Goal

Run the **same Qwen3.8-27B model, same tasks, same seeds, twice — once with
UAP, once without** — and quantify the difference. The model under test is the
current production local stack: **Qwen3.8-27B (dense, UD-IQ4_XS, native
draft-mtp)** on llama.cpp, and the UAP under test is the **latest (v1.224.x)**.

Every experiment below produces one headline number: the **paired delta
(UAP-on minus UAP-off)** for accuracy, with the cost side of the ledger
(tokens, turns, latency) reported alongside it. Two questions the existing
findings cannot answer:

1. **Replication:** does the decisive non-agentic gate-loop result — **+20pp
   accuracy [95% CI +8, +32], p=0.008**, measured on qwen36-35b-a3b — hold on
   this denser, stronger 27B model, or was it partly a property of the older
   MoE?
2. **Regression check:** the findings predate the two biggest recent ships —
   the quality-metrics gate (v1.223.0) and the deliver-pipeline hardening
   (v1.224.0: scoped rollback, declared gates, polyglot execution, config
   routing, liveness, signed overrides). The paired harness's gate loop is the
   `uap deliver` mechanism in miniature; confirm the hardened pipeline did not
   regress the measured lift or its token economics.

## Why now

- **Model changed under the findings.** Production serving switched
  2026-08-20 from qwen36-35b-a3b (MoE, ~3B active) to Qwen3.8-27B (dense,
  qwen35-arch, native MTP head, 60–91% draft acceptance) — profile
  `config/llama-profiles/qwen38-27b-mtp.env`, served as alias `Qwen3.8-27B`
  on `:8080` (legacy aliases retained, so old client configs still resolve).
- **UAP changed under the findings.** The paired runs are from the v1.21x era;
  the deliver loop they exercise has since been substantially hardened.
- **Newer suites exist that were not in the findings.** `real-gate-medium`,
  `real-gate-power`, `real-gate-brutal`, and `real-gate-heldout` directly
  address the findings' own ceiling-effect caveat (agentic baseline pinned at
  100% on the older suites, so UAP showed 0pp there).

## Stack preflight (Phase 0 — before any measurement)

1. Bring up / verify the serving stack:
   `scripts/bootstrap/bootstrap-uap-llama-proxy-stack.sh` (llama-server
   `:8080` + anthropic proxy `:4100`). Server is currently live with
   `Qwen3.8-27B` loaded (131072 ctx/slot, 2 slots); the proxy did not answer
   `/v1/models` at plan time — confirm it is up and routing.
2. Confirm tool-call plumbing: `uap tool-calls status` (qwen-sharp.jinja
   active, `--jinja` on).
3. Freeze the served model id used by every run (`Qwen3.8-27B` or the proxy's
   advertised id — verify once via `/props`, then hold it fixed across all
   arms and phases so the paired design is not contaminated by an alias swap).
4. Plumbing check with the deterministic mock adapter:
   `uap bench paired --suite benchmarks/suites/smoke --adapter mock --epochs 8`.
5. Concurrency discipline: the box is a single RTX 3090 with **2 server
   slots** — run the harness at `--concurrency 2` max and keep
   `PROXY_CONCURRENCY_LIMIT` == slot count. Latency numbers remain
   queue-confounded (known caveat from the prior findings); we read
   correctness and token deltas, not wall-clock.

## Experimental design — the two arms

Every run pair toggles **only** the UAP surface. Model (`Qwen3.8-27B`),
serving stack, task fixture, seed, and prompt are identical in both arms.

| | **WITHOUT UAP** (baseline arm) | **WITH UAP** (treatment arm) |
|---|---|---|
| Raw (non-agentic) experiments | One raw completion endpoint call; whatever the model writes is final | The UAP gate loop (the `uap deliver` mechanism in miniature): execute → run the visible in-repo gate → feed failures back → regenerate until green |
| Agentic experiments (opencode adapter) | Bare opencode on the same model and prompt, no UAP files injected | Identical opencode run plus the paired-harness UAP surface: `AGENTS.md` operating protocol, `.uap-bench.json` manifest, `UAP_BENCH_COMPONENTS` env — the inspectable, diffable "treatment" |
| Deliver-path spot check (E4) | Model without the deliver pipeline | The actual hardened v1.224.0 `uap deliver` surface: scoped rollback, declared gates, liveness |

What "the difference" means, precisely, per run:

- **Accuracy Δ** — UAP-on success rate minus UAP-off success rate, with a
  bootstrap 95% CI and permutation p-value; McNemar 2×2 ("UAP fixed" vs
  "UAP regressed") on discordant pairs.
- **Cost Δ** — paired deltas for tokens, turns, tool-calls, latency. A win is
  higher accuracy at acceptable cost, or equal accuracy at lower cost.
- **Ablation (E2)** — the WITH-UAP arm decomposed: leave-one-out per
  component (gates / worktree / memory / experts / skills / patterns) so we
  can see which parts of UAP earn their token overhead on this model.

All scoring is deterministic `verifyCmd` (no LLM judge). Artifacts land in
`benchmark-results/paired-qwen38-*`. Statistics per the established format:
bootstrap 95% CI (10k seeded resamples) + sign-flip permutation p.

## Experiments

| # | Question | Suite | Adapter | WITHOUT UAP | WITH UAP |
|---|---|---|---|---|---|
| E1 | Does the gate loop still rescue one-shot failures? | `real-gate-gated` × 10 epochs | raw | single-shot | gate loop |
| E2 | Does UAP cost or add anything on a self-verifying agent? | `real-gate-hard` × 4 epochs | opencode | bare opencode | opencode + UAP surface (+ per-component ablation) |
| E3 | Is there headroom for UAP lift on harder/held-out tasks? | `real-gate-heldout`, `-power`, `-medium`, `-brutal` | raw + opencode | both baselines | both treatments |
| E4 | Does the hardened v1.224.0 deliver path converge as well as the miniature? | `real-gate-gated` subset | raw → deliver | no deliver | full deliver surface |

### E1 — Headline replication (raw adapter, non-agentic gate value)

```bash
UAP_RAW_TEMPERATURE=0.6 uap bench paired \
  --adapter raw --model "Qwen3.8-27B" \
  --suite benchmarks/suites/real-gate-gated \
  --epochs 10 --concurrency 2
```

Identical design to the decisive qwen36 run (5 edge-case tasks ×
{single-shot, gate-loop} × 10 epochs, temp 0.6). The comparison to beat:
**+20.0pp [+8.0, +32.0], McNemar net +10, +1,072 tokens / +0.3 turns.**
Hypotheses to distinguish: (a) lift replicates ≈ +20pp — gate value is
model-independent; (b) lift shrinks because the stronger model one-shots more
edge cases (baseline above 78%) — ceiling moves, gate still nets positive on
the remainder; (c) lift vanishes — report honestly.

### E2 — Agentic ceiling check + component ablation (opencode adapter)

```bash
uap bench paired --adapter opencode --model "Qwen3.8-27B" \
  --suite benchmarks/suites/real-gate-hard --ablation --epochs 4
```

Replicates the 0pp-at-ceiling agentic result and re-ranks per-component token
overhead (gates / worktree / memory / experts / skills / patterns) on the new
model. Watch for the known harness wedge (detached opencode process tree
surviving SIGTERM) — the process-group SIGKILL fix is in, but flag any
158–190/192-style shortfall.

### E3 — Headroom re-openers (the suites the findings never saw)

Paired runs (raw + opencode adapters) over, in priority order:

1. `real-gate-heldout` — held-out tasks; guards against suite overfitting of
   the E1/E2 conclusions.
2. `real-gate-power` — designed for statistical power; the primary candidate
   for a tighter CI on the agentic delta.
3. `real-gate-medium`, then `real-gate-brutal` — harder multi-file tasks
   where even a self-verifying agentic baseline should drop below 100%,
   re-opening the headroom the older suites lacked. This is the run that can
   show UAP lift *inside* an agentic harness, which the prior findings could
   not measure.

### E4 — Deliver-pipeline spot check (post-hardening)

E1's gate loop is the deliver mechanism in miniature; it does not exercise
the actual v1.224.0 deliver path (scoped rollback, declared gates, liveness).
Unit/integration coverage for those shipped with the feature (90+ tests), so
E4 is a small paired run where the UAP arm routes through the **current full
deliver surface** rather than the raw miniature, confirming the hardened loop
converges at least as well on the same suite. If the paired harness cannot
drive the real deliver path today, note the gap and scope the adapter
extension instead of hand-waving it.

## Analysis plan

- Primary claims are the **with-UAP vs without-UAP paired deltas** (E1–E4),
  each with CI + p, in the `PAIRED_FINDINGS.md` report format. The summary
  table leads with one row per experiment: suite, UAP-off accuracy, UAP-on
  accuracy, Δ, CI, p, token Δ.
- Cross-model (qwen36 → qwen38) comparisons are **not paired** — report as
  side-by-side findings with the confound named (model, serving stack, and
  UAP version all moved).
- Success criteria, decided in advance: E1 CI excludes 0 with the same sign
  as before; E3 shows at least one suite where the agentic baseline leaves
  headroom (else the 0pp agentic conclusion stands, strengthened); E4 shows
  no convergence regression vs E1's loop.
- Write-up lands as an update section in `docs/benchmarks/PAIRED_FINDINGS.md`
  (new runs, same tables), not a parallel document.

## Cost

Local GPU, so the currency is wall-clock, not dollars. Rough budget on one
RTX 3090 at 2-slot concurrency: E1 ≈ 100 runs, E2 ≈ 192 runs (ablation), E3
similar order per suite. Expect several GPU-hours per experiment; schedule
sequentially, keep `--concurrency 2`, and watch the host's kernel OOM-kill
history at the 131072-ctx tier (~0.95 GiB free VRAM) — drop to 65536/slot if
instability appears, and re-derive `PROXY_CONTEXT_WINDOW` to match.

## Risks

| Risk | Mitigation |
|---|---|
| Proxy `:4100` not answering at plan time | Phase 0 preflight before any run |
| Stronger model lifts the non-agentic baseline, shrinking measurable headroom | Expected; report baseline→UAP pair regardless, lean on E3 suites for headroom |
| Thin VRAM headroom at 131072 ctx/slot under harness load | Drop to 65536/slot tier, re-derive proxy limits |
| Alias confusion (`Qwen3.8-27B` vs legacy qwen35/36 aliases on the same server) | Freeze one id in Phase 0, assert it in run metadata |
| Harness process-tree wedge under opencode adapter | Group-SIGKILL fix is in; verify completion counts per run |

## Deliverables when executed

1. `benchmark-results/paired-qwen38-*` artifacts (records.jsonl, report.json,
   report.md) for E1–E4
2. An update to `docs/benchmarks/PAIRED_FINDINGS.md` adding the qwen38 /
   UAP-v1.224.x tables alongside the qwen36 originals
3. If E4 surfaces the deliver-path adapter gap: a scoped follow-up task for
   the paired-harness extension
