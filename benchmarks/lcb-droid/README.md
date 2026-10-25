# LCB-Droid smoke — Phase 0 wiring (arm 2: UAP-in-Droid, local Flash Next)

Assets and validation for the smoke benchmark that runs the local
Qwen3.8-Flash-Next IQ3_S (DavidAU abliterated, strata-served via LiteLLM
`127.0.0.1:4000`) under the UAP operating protocol in headless Droid, on the
exact benchmark GVS5H published on: LiveCodeBench code generation
`release_v6`, the 100 hardest problems, scored pass@1 by the same fork of the
LCB evaluator. GVS5H's orchestration engine is deliberately NOT run; the
comparison is local-UAP-in-Droid vs GVS5H's published numbers.

## Layout

- `vendor/GVS5H/` — benchmark assets vendored from
  `https://github.com/slee-persis/GVS5H` at pinned commit
  `707e21296bfa032250f10bdde4afaff7ec998f71` (see `vendor/GVS5H/PINNED_SHA`):
  - `livecodebench/` — their LiveCodeB runner fork (`lcb_runner`), the scorer
  - `escalation/` — `lcb100_hardest_v6.json` (the 100 problem ids),
    `patched_grader/`, `run_bench.py` (reference for prompt + scoring path),
    run scripts
  - `LICENSE` (MIT, code) + `LICENSE-CC-BY-4.0` (paper/run data)
- `extract_anchors.py` — pins the published comparison numbers from run
  artifacts (see below); writes `anchors.json`
- `anchors.json` — pinned published anchors + provenance + per-problem
  corrected verdicts for the 10-problem smoke subset
- `scorer_sanity.py` — validates the scoring path (reference must pass,
  stub must fail)

## Scoring venv (Phase 0, validated)

The fork's full dependency set is heavy (torch, vllm); the scoring path needs
only `datasets`, `numpy`, `tqdm`:

```sh
uv venv <artifact-dir>/venv-lcb --python 3.12
uv pip install --python <artifact-dir>/venv-lcb/bin/python "datasets>=3.2.0,<4" numpy tqdm
uv pip install --python <artifact-dir>/venv-lcb/bin/python --no-deps \
    -e vendor/GVS5H/livecodebench
```

`datasets` must stay <4: the `livecodebench/code_generation_lite` loader is a
script dataset (`trust_remote_code=True`).

## Phase 0 results

**Scorer sanity — SANE.** `release_v6` loads (1055 problems), and on
`arc196_b` a published-passing reference passes the hidden-test evaluation
while a stub fails (same call shape as `run_bench.py`:
`codegen_metrics(k_list=[1])`).

**Droid→local wiring sanity — SANE with caveats.** Verified twice via
`droid exec --skip-permissions-unsafe --model custom:Qwen3.8-IQ3_S-(UAP-local)-0`
through the LiteLLM generic provider: tool-call parsing, file writes and
multi-turn all work; `sanity.txt` came out with exactly `PHASE0-OK` both times.

- Model identity: the strata service was restarted onto the
  `abliterated-iq3_s` pack during Phase 0 (18:13 AEDT, from the Swift-1.5
  IQ3_S A/B-trial pack that was live since 2026-10-17), so sanity run 1 hit
  the Swift pack and run 2 hit the abliterated pack. The Phase 1 driver must
  snapshot the served model alias into every run record — the repo's own
  `test/model-profiles-qwen38-rails.test.ts` fails on master right now
  precisely because profiles drift from the live backend (pre-existing
  failure, unrelated to this branch).
- Tool discipline: on run 1 the model, after finishing the task, polled
  `TaskOutput` on hallucinated task ids (27 calls) until the UAP proxy's
  ERROR-LOOP guard hard-stopped the session
  (`PROXY_ERROR_LOOP_HARD_LIMIT=3`). Phase 1 therefore restricts the
  toolset: `--only-tools Read,Glob,Grep,LS,Create,Edit,Execute` (verified in
  run 2 — no Task tools available).
- Stop discipline: in both runs the model did not self-terminate promptly
  after completing the task (run 1 polled; run 2 kept generating until the
  20-minute driver kill, file already written at minute 19 on a cold,
  contended GPU). The Phase 1 driver therefore enforces a wall-clock cap
  and collects `solution.py` at cap regardless of session state.
- Latency: a cold single trivial task took ~19 min at full GPU contention;
  warm-state turns are minutes. The 60-min/problem Phase 1 cap is
  justified.

**Pinned published anchors** (pass@1, corrected grader, LCB release_v6
100-hardest, 5 passes, n=100/pass; extracted by `extract_anchors.py` from
`runs/` artifacts, cross-checked against `paper/tab-regrade.tex`):

| Arm | Per-pass | Mean |
|---|---|---|
| Qwen3.8 Flash Next single-call | 84.0 / 84.0 / 82.0 / 86.0 / 85.0 | **84.2** |
| Qwen3.8 Flash Next GVS5H-orchestrated | 93.0 / 92.0 / 94.0 / 92.0 / 94.0 | **93.0** |
| Claude Fable 5 single-call | 89.0 / 90.0 / 90.0 / 91.0 / 92.0 | **90.4** |
| Qwen3.8-27B single / orchestrated | — | **66.8 / 92.4** |

Anchor caveats (mandatory in any comparison): GVS5H's Flash Next ran on a
remote pinned backend (full-precision API model, `reasoning=on`, 128k cap),
not a local quant; their orchestrated arm is ledger-based self-orchestration,
which is a different mechanism from the UAP protocol in Droid; the local arm
is the IQ3_S *abliterated* quant.

## Reproduce Phase 0

```sh
# vendor was cloned once (shallow) and copied in; re-pin with:
git clone --depth 1 https://github.com/slee-persis/GVS5H <checkout>
git -C <checkout> rev-parse HEAD   # 707e21296bfa032250f10bdde4afaff7ec998f71

python3 extract_anchors.py <checkout> --out anchors.json
<venv>/bin/python scorer_sanity.py --problem-id arc196_b --gvs5h-checkout <checkout>
```
