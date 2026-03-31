# Architecture

System architecture and high-level invariants for the Qwen3.5 optimization mission.

**What belongs here:** components, relationships, runtime control points, invariants, and how the benchmark workflow moves through the stack.
**What does NOT belong here:** step-by-step implementation tasks or per-feature checklists.

---

## Stack Overview

```text
Droid / OpenCode CLI session
        |
        | Anthropic Messages API-compatible requests
        v
UAP Anthropic proxy (:4000)
        |
        | OpenAI-compatible chat/completions requests
        v
llama.cpp llama-server (:8080)
        |
        v
Qwen3.5 35B A3B GGUF runtime
```

## Primary Control Planes

### 1. Client plane
- `opencode.json` and `.opencode/config.json` decide which endpoint/model the CLI uses, output/token budgets, and thinking defaults.
- The benchmark prompt enters the system here.
- Client-level retry and continuation behavior is visible in CLI transcripts and must remain bounded.

### 2. Proxy plane
- `tools/agents/scripts/anthropic_proxy.py` translates Anthropic-style requests to the llama.cpp OpenAI-compatible API.
- The proxy is responsible for loop control, tool-turn guardrails, failure shaping, and endpoint visibility through `/health`.
- The proxy is the main runtime stabilizer between a tool-using client and a model that may emit malformed or empty tool-adjacent responses.

### 3. Runtime plane
- `llama-server` on `:8080` owns model execution, decode speed, speculative behavior, context usage, and direct inference correctness.
- Runtime tuning affects throughput, latency, and the quality/stability of tool-capable responses.
- Direct probes against `:8080` isolate llama.cpp behavior from proxy/client behavior.

## Key Invariants

- Port `4000` has exactly one intended active proxy owner during validation and benchmark runs.
- Port `8080` has exactly one intended active llama.cpp owner during validation and benchmark runs.
- The proxy `/health` payload, the active process list, and the client config must all agree on the same intended runtime path.
- The benchmark prompt and benchmark conditions must remain stable across before/after performance comparisons.
- End-to-end success requires the full client → proxy → llama.cpp path to work; direct llama success alone is insufficient.
- If direct llama.cpp probes succeed but proxy-mediated validation fails, treat the issue as a proxy/client-plane problem rather than a runtime-plane success.
- Streaming and non-streaming validation paths must remain behaviorally equivalent enough that a passing non-stream fallback does not hide a user-visible streaming failure.
- When `opencode.json` and `.opencode/config.json` disagree, the effective client routing used by the real benchmark run must be measured and recorded explicitly; no worker may assume precedence without runtime evidence.
- Bounded failure is acceptable; ambiguous hanging or repeated indistinguishable retry loops are not.

## Main Failure Classes

- Duplicate proxy ownership or port races on `:4000`
- Endpoint drift between `127.0.0.1` and `192.168.1.165`
- Empty-visible streaming retries / tiny follow-up loops
- Malformed or missing tool-call outputs during active tool turns
- Oversized client budgets or thinking modes that increase latency and retry pressure
- llama.cpp parameter choices that hurt correctness or throughput for this specific workload

## Validation Evidence Flow

- CLI transcript proves user-visible success, failure shape, or looping.
- Proxy health/models/messages + logs prove routing, guardrail behavior, and classification.
- llama health/models/completions + logs prove direct runtime health and throughput.
- PID/port ownership ties the benchmark run back to the intended active processes.
