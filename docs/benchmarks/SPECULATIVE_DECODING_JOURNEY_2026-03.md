# Speculative Decoding Journey (2026-03)

This document records the end-to-end speculative decoding stabilization journey across `llama.cpp` runtime tuning and `uap-anthropic-proxy` guardrails, including fixes, benchmark results, and the production profile now in use.

## Scope

- Runtime: `llama.cpp` with Qwen3.5 models, CUDA, `ctx-size=262144`.
- Gateway: Anthropic-compatible proxy (`tools/agents/scripts/anthropic_proxy.py`).
- Client behavior: agentic coding loops with tool calls (Claude Code style).

## Goals

1. Preserve high speculative decoding throughput.
2. Eliminate pathological loops and malformed visible output.
3. Keep tool-call behavior reliable under long sessions.
4. Keep production context window at `262144`.

## Phase 1 - Llama.cpp Speculative Stability

### Problems Observed

- Rollback loops and instability under aggressive speculative settings.
- `find_slot` and related server warnings during long agentic sessions.
- Throughput regressions compared to known fast baseline.

### Work Performed

- Implemented and tested multiple rollback strategies in `llama.cpp` worktree branches.
- Compared baseline fast commit vs newer speculative logic.
- Restored proven fast runtime path for production service while preserving learned guardrails.

### Key Runtime Decisions

- Keep production on fast validated binary lineage (`029edcafc` baseline family).
- Use strict balanced speculative profile for 35B operations:
  - `speculative.n_max=12`
  - `speculative.n_min=2`
  - `speculative.p_min=0.80`

### Representative Throughput Findings

- Qwen3.5-27B, `ctx=262144`, q4 KV cache:
  - No spec: ~43 tok/s coding, ~41 tok/s pattern.
  - Spec (balanced): ~43 tok/s coding, ~102 tok/s pattern.
  - Main uplift appears in pattern-heavy turns, not all coding turns.

## Phase 2 - Proxy Reasoning Fallback Leak Fix

### Problems Observed

- Empty visible output (`output_tokens=0`) with large hidden reasoning payloads.
- Proxy emitted malformed chain-of-thought text as fallback, causing user-visible garbage:
  - repeated fragments like `</parameter>`, tool schema echoes, policy text loops.

### Fixes Implemented

- Added explicit streaming fallback policy:
  - `PROXY_STREAM_REASONING_FALLBACK=off|sanitized|visible`
  - `PROXY_STREAM_REASONING_MAX_CHARS`
- Set production default to `off`.

### Result

- Malformed reasoning fallback leakage is suppressed by default.
- Debugging remains possible with `sanitized`/`visible` modes when intentionally enabled.

## Phase 3 - Token Floor and Prune Controls

### Problems Observed

- Hardcoded `max_tokens` floor (`16384`) forced very long failure turns.
- Pruning threshold flag alone could trigger pruning path without meaningful message reduction.

### Fixes Implemented

- Added configurable max token floor:
  - `PROXY_MAX_TOKENS_FLOOR` (`0` disables floor)
- Added configurable prune target:
  - `PROXY_CONTEXT_PRUNE_TARGET_FRACTION`

### Live A/B Result (Production-Like)

`PROXY_MAX_TOKENS_FLOOR=16384` vs `4096`:

- Silent reasoning-heavy turn:
  - `16384`: avg `78.749s`
  - `4096`: avg `19.777s`
  - Latency reduction: ~`74.9%`
  - Predicted throughput unchanged (~`208 tok/s` class)
- Normal tool turns remained stable and slightly faster with `4096`.

## Phase 4 - Malformed Tool-Loop Hardening

### Problem Pattern

Under adversarial or degraded prompt states, the model can emit pseudo-tool text instead of valid tool calls, e.g.:

- `</parameter>` fragments
- echoed policy snippets (`you MUST call a tool...`)
- long no-progress text with no `tool_calls`

### Feature Set Added (Flag Controlled)

1. **Malformed tool guardrail + retry**
   - `PROXY_MALFORMED_TOOL_GUARDRAIL`
   - `PROXY_MALFORMED_TOOL_RETRY_MAX`
   - `PROXY_MALFORMED_TOOL_RETRY_MAX_TOKENS`
   - `PROXY_MALFORMED_TOOL_RETRY_TEMPERATURE`

2. **Strict stream guardrail path**
   - `PROXY_MALFORMED_TOOL_STREAM_STRICT`
   - For stream+tools requests, proxy runs guarded non-stream upstream call, then replays SSE.

3. **Tool narrowing (optional)**
   - `PROXY_TOOL_NARROWING`
   - `PROXY_TOOL_NARROWING_KEEP`
   - `PROXY_TOOL_NARROWING_MIN_TOOLS`

4. **Disable thinking on tool turns (optional)**
   - `PROXY_DISABLE_THINKING_ON_TOOL_TURNS`

5. **Session contamination breaker (optional safety net)**
   - `PROXY_SESSION_CONTAMINATION_BREAKER`
   - `PROXY_SESSION_CONTAMINATION_THRESHOLD`
   - `PROXY_SESSION_CONTAMINATION_KEEP_LAST`

6. **Agentic supplement mode**
   - `PROXY_AGENTIC_SUPPLEMENT_MODE=clean|legacy`

### Test Coverage

- Unit tests in `tools/agents/tests/test_anthropic_proxy_streaming.py`
- Current targeted suite count in this workstream: `16` passing tests.

## Benchmark Highlights (Per-Option Toggles)

### Artifact Stress Benchmark (v3)

Source: `/tmp/proxy_visibility_benchmark_v3.json`

| Mode | Key Flags | Outcome Summary |
| --- | --- | --- |
| Baseline | none | no tool call, policy-echo text surfaced |
| Option 1 | malformed guardrail + strict stream | malformed detected and retried; returned `tool_use` with empty visible text |
| Option 2 | tool narrowing only | not sufficient alone in stress case |
| Option 3 | disable thinking only | not sufficient alone in stress case |
| Option 4 | contamination breaker only | not sufficient alone in this synthetic workload |
| Option 5 | clean supplement only | not sufficient alone in stress case |

### Practical Conclusion

- Strongest primary mitigation: **Option 1** (malformed guardrail + strict stream + bounded retry).
- Other options are secondary tuning aids and should not replace Option 1 for this failure class.

## 10-Turn Live Stability Soak

Source: `/tmp/proxy_10turn_soak_results.json`

- 10 turns, alternating malformed-stress and normal tool-call turns, single live session id.
- Results:
  - Error rate: `0.0%`
  - Malformed visible output rate (stress turns): `0.0%`
  - Normal tool-call success rate: `100.0%`
  - Duration p50/p95: `10.2s` / `21.366s`
  - Stop reasons: `tool_use=6`, `max_tokens=3`, `end_turn=1`

## Production Profile (Current)

File: `/home/cogtek/.config/uap/anthropic-proxy.env`

```bash
PROXY_MAX_TOKENS_FLOOR=4096
PROXY_STREAM_REASONING_FALLBACK=off

PROXY_MALFORMED_TOOL_GUARDRAIL=on
PROXY_MALFORMED_TOOL_STREAM_STRICT=on
PROXY_MALFORMED_TOOL_RETRY_MAX=1
PROXY_MALFORMED_TOOL_RETRY_MAX_TOKENS=512
PROXY_MALFORMED_TOOL_RETRY_TEMPERATURE=0

PROXY_TOOL_NARROWING=off
PROXY_DISABLE_THINKING_ON_TOOL_TURNS=off
PROXY_SESSION_CONTAMINATION_BREAKER=off
PROXY_AGENTIC_SUPPLEMENT_MODE=legacy
```

Rationale:

- Keep the strongest practical fix enabled (malformed guardrail + strict stream path).
- Keep latency-optimized floor (`4096`).
- Keep optional secondary heuristics off unless new evidence warrants enablement.

## Reproduction Checklist

1. Restart services:

```bash
systemctl --user restart uap-llama-server.service
systemctl --user restart uap-anthropic-proxy.service
```

2. Run targeted unit tests:

```bash
python3 -m pytest tools/agents/tests/test_anthropic_proxy_streaming.py -q
```

3. Run soak script (or equivalent alternating malformed/normal stream sequence).

4. Validate logs:

- `MALFORMED TOOL PAYLOAD`
- `MALFORMED RETRY ...`
- `STRICT STREAM GUARDRAIL`
- Absence of user-visible malformed fragments.

## Open Follow-Ups

- Add a dedicated persistent benchmark harness under `scripts/` for this exact soak profile.
- Add branch/commit links from `llama.cpp` worktrees for cross-repo traceability.
- Optionally evaluate enabling `PROXY_TOOL_NARROWING` in production only after longer mixed-workload soak data.
