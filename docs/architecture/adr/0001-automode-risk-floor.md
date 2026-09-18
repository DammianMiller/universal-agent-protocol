# ADR 0001: AutoMode risk classification ships as a Python heuristic floor ahead of the TS SYS1 head

- Status: Accepted
- Date: 2026-07-13 (uplift 1.3, branch `feature/304-automode-risk`)

## Context

AutoMode needs risk classification of tool calls **before dispatch** —
ahead of the verb/regex heuristics in the client-side enforcer chain
(`src/policies/enforcers/*.py`). The designed classifier is the TypeScript
SYS1 head (`src/classify/`, PR #807, branch `feature/301-sys1-classifier`),
but that branch is **unmerged and unreachable from Python**: the proxy
(`tools/agents/scripts/anthropic_proxy.py`) and the enforcers are Python,
and there is no TS→Python bridge in the serving path. Blocking AutoMode on
the TS merge would leave the proxy/enforcer stack with no risk signal at
all.

Two further constraints shaped the decision:

1. The deterministic enforcers are the blocking floor and must stay exactly
   as strict — any classifier output is **advisory only**.
2. A wrong signal is asymmetric: a *missed* destructive call is the
   unacceptable error; a false positive costs one advisory log line.

## Decision

Ship a **Python-resident calibrated heuristic scorer**
(`tools/agents/scripts/tool_risk.py`) behind a stable contract,
`classify_tool_call(tool_name, tool_input) -> RiskAssessment`, wired
advisory-only into the proxy's three outbound tool_use interception points
(debug log per call; `dashboard_events` telemetry for score ≥ 4; never
blocks, never mutates the stream; `PROXY_AUTOMODE_RISK=off` hatch).

- **Vocabulary inspired by, not ported from, the TS baseline.** The SYS1
  `baseline.ts` scores prose state descriptions; this scorer parses shell
  structure (verbs, flags, redirects, launchers). The domains differ, so we
  do not claim cross-stack parity.
- **Deliberate duplication against `enforcement_self_protect.py`.** The
  scorer re-implements launcher step-over, find-mutating flags, and the
  sed `-i` conditional rather than importing the enforcer, because the
  enforcer is a blocking gate with repo-root side effects and the scorer
  must stay pure and importable from the proxy hot path. The mitigation for
  the copy-divergence risk is a **drift-guard test**
  (`EnforcerParityDriftGuardTest` in `test_tool_risk.py`) that imports both
  modules and asserts the launcher sets, find-mutating semantics, and sed
  `-i` semantics agree — divergence becomes a CI failure, not silent drift.
- **Deferred consumption.** For now the classification is consumed only by
  logs and telemetry. The follow-up that produces *production* calibration
  data is enforcer consumption plus a shadow-disagreement signal: run the
  scorer beside the enforcers, record where advisory and floor disagree,
  and let that corpus — not hand-labeled fixtures alone — calibrate the
  promoted head.
- **Real promotion path.** The SYS1 head, when it lands, is a
  Python-resident model (or a local sidecar) behind the same
  `classify_tool_call` contract, gated by
  `tools/agents/scripts/tool_risk_calibrate.py` at held-out destructive
  recall 1.0 on a corpus that by then includes production disagreement
  data. Wiring, harness, and doctrine do not change.

## Consequences

- The proxy/enforcer stack gets AutoMode risk classification now, with
  measured latency (p95 ≈ 0.03 ms over 10k calls) far under the 50 ms
  budget reserved for a future model call.
- The advisory path fails **open** (classifier exception → warning +
  pass-through) precisely because the enforcer floor fails **closed**; a
  dead scorer degrades to today's behavior plus one startup warning if the
  import itself failed.
- The heuristic floor's perfect fixture numbers are a *contrast baseline*
  on a small, hand-labeled probe (held-out n=4–10 per class), explicitly
  caveated in `docs/performance/automode-risk-calibration.md`; they are not
  evidence of model-grade generalization.
- The duplication debt against `enforcement_self_protect.py` is real but
  bounded and guarded; if the enforcer grows a new evasion shape, the
  drift-guard test forces the scorer to follow.
