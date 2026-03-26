# Speculative Decoding in llama.cpp: Real Speedups Without Breaking Agentic Reliability

Speculative decoding can look like free performance - until it meets long-context, tool-heavy agent workflows. This write-up covers what improved throughput, what regressed, and which operational changes restored stability across `llama.cpp` and an Anthropic-compatible proxy.

## Why This Matters

Speculative decoding is strongest when generated text has predictable structure or repetition. But in real coding sessions, throughput alone is not enough: the system must preserve clean output, reliable tool-call behavior, and long-session continuity.

In practice, this is one runtime boundary:

- `llama.cpp` speculative behavior
- parameter profile and rollback mode
- proxy streaming/fallback policies
- agentic tool-loop control behavior

## Baseline Environment

- Runtime: `llama.cpp` + CUDA + Qwen3.5 GGUF
- Context window: `262144`
- Spec type: `ngram-cache`
- Gateway: Anthropic-compatible proxy forwarding to OpenAI-compatible server

Related runbooks:

- `docs/deployment/UAP_LLAMA_ANTHROPIC_PROXY_BOOTSTRAP.md`
- `docs/benchmarks/SPECULATIVE_DECODING_JOURNEY_2026-03.md`

## What We Observed

### Throughput Gains Were Workload-Dependent

Speculation did not uniformly improve all turns. Coding/tool turns often saw small uplift; repetition-heavy turns saw large gains.

Representative 27B snapshot (`ctx=262144`):

- No spec: ~43 tok/s coding, ~41 tok/s pattern
- Balanced spec (`12/2/0.80`): ~43 tok/s coding, ~102 tok/s pattern

Takeaway: benchmark by workload class, not one blended average.

### Newer Lineage Produced Noisier Warnings

Under identical settings, newer builds emitted warnings such as:

- `find_slot: non-consecutive token position`

This correlated with lower effective throughput and less stable long-session behavior in A/B comparisons.

### Proxy Fallback Could Leak Malformed Internal Text

When upstream returned reasoning-heavy but empty visible output, weak fallback policy could expose malformed fragments (pseudo-tool text, schema/policy echoes) to end users.

Patterns included:

- `</parameter>`-style fragments
- non-JSON pseudo-tool content
- repetitive policy-like loops with no valid `tool_calls`

## Immediate Fixes That Worked

### Safe Production Defaults

The highest-leverage stabilization profile was:

- `PROXY_STREAM_REASONING_FALLBACK=off`
- `PROXY_MALFORMED_TOOL_GUARDRAIL=on`
- `PROXY_MALFORMED_TOOL_STREAM_STRICT=on`
- `PROXY_MAX_TOKENS_FLOOR=4096`

Why:

- `fallback=off` suppresses malformed reasoning leakage.
- malformed-tool guardrail + strict stream path recovers bad stream+tools turns.
- lower token floor reduces long failure-turn latency while preserving normal turns.

### Balanced Speculative Profile for Daily Agentic Work

- `spec-type=ngram-cache`
- `draft-max=12`
- `draft-min=2`
- `draft-p-min=0.80`
- rollback mode: `strict`

This profile is less aggressive than max-throughput tuning, but significantly safer for long coding sessions.

## Benchmark Method That Prevents False Wins

A useful speculative benchmark protocol should include:

1. Prompt classes
   - coding/tool-call tasks
   - repetition/pattern-heavy tasks
2. Repeats and warmup
   - fixed run count
   - warmup policy
   - p50/p95 latency, not only mean tok/s
3. Required metrics
   - decode throughput (`eval tok/s`)
   - prefill throughput (`prompt eval tok/s`)
   - acceptance/rejection behavior
   - malformed-turn incidence
   - stop reason distribution
4. Profile matrix
   - no-spec baseline
   - aggressive profile
   - balanced profile

Without this, speculative tuning can appear faster while degrading real agentic reliability.

## Practical Playbook

### Use for Daily Agentic Coding

- balanced `ngram-cache` (`12/2/0.80`)
- strict malformed-tool stream guardrail
- reasoning fallback disabled
- reduced token floor (`4096`)

### Use for Max Throughput Exploration

- hybrid rollback
- larger draft windows
- tightly scoped benchmark prompts

Then promote only if long-session tool-loop soak remains stable.

## What llama.cpp Docs Should Add Next

Mechanics are documented well today. The next improvement is operational clarity:

- implementation selection matrix by workload
- troubleshooting by signature (`find_slot`, rollback spikes, acceptance collapse)
- reproducible benchmark protocol and output schema
- rollout/canary/rollback criteria
- proxy compatibility appendix for stream+tools environments

## Final Takeaway

Speculative decoding in production is a systems problem, not just a decoding primitive. Treating runtime + transport + tool-loop behavior as one boundary is what makes speculative speedups both real and reliable.
