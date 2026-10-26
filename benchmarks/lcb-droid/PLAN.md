# LCB-Droid smoke — plan and status (resume here)

**Mission**: benchmark UAP-in-Droid on the local Qwen3.8-Flash-Next IQ3_S
(abliterated pack, strata-served via LiteLLM `127.0.0.1:4000`) against
GVS5H's *published* numbers on their exact benchmark: LiveCodeBench code
generation `release_v6`, the 100 hardest problems, pass@1 by their
corrected scorer. GVS5H's engine is NOT run — only its benchmark assets
(vendored here) and its published figures are used.

**Approved spec** (with user modification): smoke = 10 problems × 1 pass ×
**arm 2 ONLY** (Droid + UAP AGENTS.md protocol). Arm 1 (Droid-bare) is
deferred until arm 2 proves successful, then used to measure Droid impact.
Full spec: `~/.factory/specs/2026-10-25-lcb-droid-smoke-local-flash-next-uap-in-droid-vs-gvs5h-published-anchors.md`

## Status

| Phase | State | Evidence |
|---|---|---|
| 0. Wiring + scorer validation | **DONE** (commit `1153f35a`) | README.md below, `anchors.json`, artifact dir |
| 1. Build runner (arm-2 driver) | not started | design constraints below |
| 1. Smoke run 10 × 1 pass, arm 2 | not started | needs runner first |
| 2. Report + findings doc | not started | see Phase 2 requirements |

## Phase 0 — done, evidence

- Worktree `368-lcb-droid-smoke`, branch `feature/368-lcb-droid-smoke`.
- Vendor at pinned SHA `707e2129` (see `vendor/GVS5H/PINNED_SHA`); scoring
  venv recipe in README.md; artifact dir:
  `benchmark-results/lcb-droid-smoke-20261025-175708/` (gitignored; contains
  `venv-lcb`, sanity transcripts, session logs).
- Scorer sane: reference passes / stub fails on `arc196_b`; all 10 smoke ids
  present in `release_v6` (1–4 public tests each, all difficulty=hard).
- Anchors pinned in `anchors.json`: FN single **84.2**, FN orchestrated
  **93.0**, Fable-5 single **90.4**, 27B **66.8→92.4** (corrected grader;
  cross-checked vs `paper/tab-regrade.tex`); per-problem published verdicts
  for the smoke-10 included.
- Wiring verified twice; the strata backend restarted onto the
  `abliterated-iq3_s` pack mid-Phase-0 (18:13 AEDT 2026-10-25), which the
  spec assumes. Driver MUST snapshot the live alias per record.

## Phase 1 — runner design (constraints learned in Phase 0)

Per-problem workdir under the artifact dir (gitignored):

- `problem.md` — GVS5H's exact `build_code_prompt` text (copy verbatim from
  `vendor/GVS5H/escalation/run_bench.py`).
- `public_tests/` + a `run_gate.sh` running ONLY the public tests (the
  visible gate; GVS5H workers also see public tests).
- `solution.py` — the target file the model writes.
- `AGENTS.md` — the UAP operating protocol text from
  `benchmarks/terminal_bench/uap_droid_agent.py` (`AGENTS_MD` constant) in
  the MAIN checkout — drop it in per-problem (arm 2 mechanism).

Driver invocation (per problem):

```sh
droid exec --skip-permissions-unsafe \
  --model "custom:Qwen3.8-IQ3_S-(UAP-local)-0" \
  --only-tools Read,Glob,Grep,LS,Create,Edit,Execute \
  --output-format json --cwd <problem-workdir> "<task prompt>"
```

Mandatory driver behaviors (each from an observed Phase-0 failure):
1. **Restricted tools** — the model polls `TaskOutput` on hallucinated ids
   when allowed (27 calls until the proxy ERROR-LOOP guard killed it).
2. **Wall-clock cap per problem** (60 min) + hard kill; **collect
   `solution.py` at cap regardless of session state** — the model does not
   self-terminate after finishing (run 2 kept generating past the kill with
   the task done).
3. **Snapshot the live served-model alias** (`http://127.0.0.1:8080/props`)
   + LiteLLM health into every record — profiles drift from the live
   backend (repo test `model-profiles-qwen38-rails` currently fails on
   master for exactly this reason).
4. **Checkpoint JSONL**, resumable (GVS5H's own pattern); record pass/fail,
   tokens, turns, wall time, stop reason, final solution hash.
5. Concurrency 2 (GPU slots); smoke subset = first 10 ids in
   `vendor/GVS5H/escalation/lcb100_hardest_v6.json` (deterministic, logged).

Scoring: same path as `scorer_sanity.py` (venv `lcb_runner`,
`codegen_metrics(k_list=[1])` against `release_v6` hidden tests), scoring
each problem's collected `solution.py`.

## Phase 2 — report requirements

- Per-problem table (id, pass/fail, turns, tokens, wall time, stop reason)
  + arm-2 pass@1 on the 10-subset; side-by-side with the published
  per-problem verdicts from `anchors.json`.
- **Mandatory caveat box**: local **IQ3_S abliterated quant** ≠ paper's
  full-precision remote flash-next; UAP-protocol-as-prompt ≠ GVS5H ledger
  self-orchestration (different mechanism); 10-of-100 subset, 1 pass —
  everything labeled descriptive/underpowered.
- Deliverables: `docs/benchmarks/LCB_DROID_SMOKE.md`,
  `benchmark-results/lcb-droid-smoke-<ts>/` (records.jsonl, report.md),
  UAP memory stores.

## Decision gate after smoke (explicit go required)

Stop / pilot 50×3 / full 100×5 — presented with smoke data. Arm 1
(Droid-bare, same 10 problems) becomes an option here per the user's
"if that proves successful we can do arm 1 to determine the Droid impact".

## Known blockers / notes

- **Version bump deferred**: `npm test` fails on master (pre-existing, live
  backend drift vs the Swift-1.5 trial profile). Bump once the profile is
  reconciled with whichever pack stays live. Branch adds no TS.
- GPU is shared: a cold trivial task took ~19 min at 100% contention.
  Confirm the 3090 is free before launching the smoke.
- The correct Droid model ref is `custom:Qwen3.8-IQ3_S-(UAP-local)-0`
  (derived from the BYOK display name).

## Resume recipe

```sh
cd /home/cogtek/dev/miller-tech/universal-agent-protocol
# branch feature/368-lcb-droid-smoke, worktree .worktrees/368-lcb-droid-smoke
ART=.worktrees/368-lcb-droid-smoke/benchmark-results/lcb-droid-smoke-20261025-175708
source $ART/venv-lcb/bin/activate   # scoring venv
# next: build the Phase-1 runner per the design above, then run 10×1 arm 2
uap memory query "LCB-Droid GVS5H"  # session memory trail
```
