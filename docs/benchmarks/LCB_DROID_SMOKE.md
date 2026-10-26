# LCB-Droid Smoke — 10 problems × 1 pass, arm 2 (UAP-in-Droid)

**Result: 10/10 = 100% pass@1 on hidden tests. All 10 public gates green. All 10 scorer-control references green. 9/10 agents self-stopped; 1/10 hit the wall cap with a gate-green solution collected at cap.**

Run: 2026-10-27, started ~01:21 local, 284 min serial wall time (~4.7 h).
Model: `abliterated-iq3_s` (DavidAU Qwen3.8-Flash-Next IQ3_S abliterated)
served by strata on `:8080`. Chain:
`droid exec` → `uap-anthropic-proxy` `:4000` → strata. Arm 2 only: the
UAP operating protocol (AGENTS.md) with restricted tools
(`Read,Glob,Grep,LS,Create,Edit,Execute`), 60-min wall cap with
collect-at-cap, concurrency 1. Scoring: the vendored LCB fork's
`codegen_metrics` (hidden tests, k=1, `release_v6`), each attempt scored
alongside the published passing reference as a per-problem control.

## Caveats — read before comparing any number below

1. **The abliteration delta is unmeasured and is the strongest confound.**
   The local model is the *abliterated* IQ3_S quant, not the pristine
   Flash Next the published numbers describe. Abliteration can move
   code-generation reasoning in either direction; no local A/B measures it.
2. **Local quant vs remote full precision.** GVS5H's published Flash Next
   ran on a pinned remote backend (full-precision API model,
   `reasoning=on`, 128k cap). The local arm is IQ3_S.
3. **Different mechanism.** GVS5H's orchestrated arm is ledger-based
   self-orchestration in their scaffold; arm 2 is the UAP protocol inside
   the Droid harness (droid exec + gates + tool restrictions). Same
   benchmark, different agent machinery.
4. **This subset is published-solved.** The published orchestrated arm
   scores 10/10 on pass 1 over these exact 10 problems (9 of them 5/5).
   A local 10/10 therefore **validates the pipeline and reaches the subset
   ceiling — it does not establish parity or superiority on the full 100**,
   where the published orchestrated mean is 93.0 and single-call is 84.2.
5. **n = 1 pass.** No variance measured. Published per-pass spread on the
   full 100 is 92–94 (orchestrated) and 82–86 (single).
6. **One wall-capped problem.** `abc399_e` ran to the 60-min cap; its
   collected-at-cap solution passes both public and hidden tests, but the
   session never self-terminated (result doc killed before emission, so
   whether it kept working past a green gate is unobservable).
7. **Token usage is unmeasurable on this chain** — the local proxy reports
   zero usage counters, so no cost/efficiency comparison is possible.

## Per-problem results

| Problem | Style | Wall | Turns | Stop | Public gate | Hidden | Pub. orchestrated p1 | Pub. single p1 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| arc196_b | stdin | 19.1 min | 60 | done | PASS | **PASS** | True (5/5) | True |
| arc196_c | stdin | 56.4 min | 81 | done | PASS | **PASS** | True (5/5) | True |
| arc196_a | stdin | 15.3 min | 53 | done | PASS | **PASS** | True (5/5) | True |
| arc196_d | stdin | 57.3 min | 43 | done | PASS | **PASS** | True (5/5) | True |
| 3777 | leetcode | 8.9 min | 81 | done | PASS | **PASS** | True (4/5) | True |
| abc400_e | stdin | 5.9 min | 43 | done | PASS | **PASS** | True (5/5) | True |
| abc400_g | stdin | 48.5 min | 81 | done | PASS | **PASS** | True (5/5) | True |
| 3717 | leetcode | 5.1 min | 43 | done | PASS | **PASS** | True (5/5) | **False** |
| 3765 | leetcode | 7.6 min | 81 | done | PASS | **PASS** | True (5/5) | True |
| abc399_e | stdin | 60 min (cap) | — | wall-cap | PASS | **PASS** | True (5/5) | True |

Smoke pass@1: **10/10 (100%)** on this subset. Published orchestrated p1
on the same subset: 10/10. Published single-call p1 on the same subset:
9/10 (missed 3717, which the local arm solved).

## Anchors (published, full 100-hardest, release_v6, pass@1)

| Arm | Published pass@1 (full 100) |
| --- | --- |
| Qwen3.8 Flash Next single-call | 84.2 |
| Qwen3.8 Flash Next orchestrated | **93.0** |
| Claude Fable 5 single-call | 90.4 |
| Qwen3.8-27B single / orchestrated | 66.8 / 92.4 |

The local smoke subset (10 problems) is not comparable to these full-100
means; it is listed here because these are the anchors any full run will
be judged against.

## Interpretation

The smoke's purpose (per spec) was end-to-end pipeline validation, and
that succeeded completely: rendering, verbatim prompt fidelity, public-test
gates, UAP stop discipline (9/10 self-stops plus one collect-at-cap
rescue), served-model snapshots, resumable records, and hidden-test
scoring with per-problem reference controls all worked with zero
infrastructure blockers.

The 10/10 is at the subset ceiling — consistent with the published
orchestrated arm, but this subset cannot discriminate arms. Any claim
about local-vs-published performance requires the full 100 (or a
randomly drawn, not published-solved, subset).

Runtime scale for follow-on decisions (measured, serial, concurrency 1):
mean 28.4 min/problem, total 284 min for 10. Extrapolations: 50×3 pilot
≈ 71 h; full 100×5 ≈ 237 h (~10 days). Two problems ran near the 60-min
cap, so a full run should expect some wall-caps and keep collect-at-cap.

## Artifacts

- `benchmarks/lcb-droid/results/smoke-10/` — `summary.json`,
  `records.jsonl` (per-attempt records with served-model snapshots),
  `smoke-scored.jsonl` (official verdicts + controls), `solutions/*.py`
  (the 10 collected model outputs), `droid-results/*.json` (droid result
  docs per completed session; abc399_e's was killed at cap).
- `benchmarks/lcb-droid/render_tasks.py`, `run_smoke.py`, `score_smoke.py`
  — reproduce with the recipe in `benchmarks/lcb-droid/README.md`.
- `benchmarks/lcb-droid/anchors.json` — published anchors and per-problem
  verdicts (GVS5H @ 707e2129).

## Decision gate (requires explicit go)

1. **Stop** — smoke goal met, archive as-is.
2. **Pilot 50×3** — ~71 h serial; adds variance signal.
3. **Full 100×5** — ~237 h serial; directly comparable to published means.
4. **Add arm 1** (no AGENTS.md protocol) — isolates the protocol's
   contribution on the same chain; any of the above can be combined with it.
