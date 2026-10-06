# ADR 0005: The Ollama-compatible surface — a third inbound dialect on a second port

- Status: Accepted
- Date: 2026-10-06 (branch `feature/340-ollama-compat-endpoint`)
- Guide: `docs/guides/PROXY.md`

## Context

The anthropic proxy already serves two inbound dialects — Anthropic Messages
(`/v1/messages`) and OpenAI Chat Completions (`/v1/chat/completions`) — both
normalized through a single guarded Anthropic pipeline (admission control,
rail semaphore, loop detection, tool narrowing, malformed-tool retry, context
pruning). Ollama-native tooling is a third client family that auto-discovers
`localhost:11434` and generally cannot be re-pointed at a path-prefixed
alternative, so "just document the OpenAI surface" does not reach it.

## Decision

1. **Same process, second listener port.** The Ollama surface is served by the
   SAME FastAPI app on `PROXY_OLLAMA_PORT` (default 11434; 0 disables). A
   second process was rejected on a hard constraint, not taste: admission
   control and the upstream rail semaphore are per-process in-memory state
   (session admission limit=1, upstream slot limit=1), so a second process
   would silently double the concurrency budget the backend was sized for and
   break the rail. Path-prefixing on one port was rejected because Ollama
   tooling cannot be pointed at it.

2. **Translation only, through the shared guarded core.** Ollama requests are
   translated to OpenAI shape and run through `_guarded_openai_completion` —
   the same core the OpenAI route uses — then translated back to Ollama wire
   shapes. This buys a parity guarantee: an Ollama client cannot drift from
   the other surfaces in guardrail coverage, because there is only one
   pipeline. The cost is double translation: only fields that survive BOTH
   hops are mapped (see consequence 4).

3. **Buffered streaming, same tradeoff as the OpenAI surface.** Streaming is
   buffered through the guardrails, then emitted as Ollama NDJSON (one content
   line plus a final `done: true` line) — not token-by-token from upstream.
   Token-granular streaming would require bypassing the pipeline; correctness
   of the guardrails was ranked above stream granularity. This is the same
   call the OpenAI inbound already made; clients see their reply arrive at
   once instead of incrementally.

4. **Default on at 11434.** The surface's target audience auto-discovers that
   port, so default-off would make the feature unreachable by its own users.
   Blast radius is bounded: loopback bind by default, the same auth token
   gates model-serving routes, a busy port disables the surface without
   touching the Anthropic surface, and `PROXY_OLLAMA_PORT=0` is a config-only
   rollback. The known asymmetry: if this proxy binds 11434 first, a
   later-started real Ollama fails to bind and the error appears in Ollama's
   logs, not ours.

## Consequences

- uvicorn serves one app on two ports via a companion listener that installs
  no signal handlers (SIGTERM reaches it by mirroring the primary's exit) and
  runs with `lifespan="off"` so app startup runs exactly once. The proxy
  requires `uvicorn>=0.30.0` for the `capture_signals` override to be
  honored.
- A companion bind failure must never take the primary down: uvicorn signals
  bind failure with `sys.exit(1)` inside `serve()`, and `SystemExit` is a
  `BaseException` that `gather(return_exceptions=True)` does not contain —
  the companion task is therefore wrapped in an explicit containment guard.
- Option mapping is deliberately minimal (`temperature`, `top_p`, `top_k`,
  `stop`, `num_predict`): Ollama's `format` (structured output),
  `min_p`/`repeat_penalty`/`seed` and `num_ctx` are dropped honestly at the
  boundary. Wiring `response_format` through the Anthropic pipeline is a
  tracked contract change that deserves its own schema-diff pass.
- The model card data (`/api/tags`, `/api/show`, `/api/ps`) mirrors only what
  the backend actually exposes (llama.cpp `/props`), cached per model, and
  never invents plausible-looking numbers a client would display as fact.
- The Claude contract ids that `/v1/models` advertises for Anthropic-SDK
  compatibility are protocol fictions and do NOT appear in `/api/tags` — an
  Ollama client must only see ids the backend actually serves.
