# User Testing

User-facing validation surface and runtime verification guidance for the Qwen3.5 optimization mission.

**What belongs here:** testable surfaces, benchmark prompt, evidence to collect, and concurrency/resource guidance.
**What does NOT belong here:** low-level implementation notes or service commands.

---

## Validation Surface

### CLI session surface
- Run the real benchmark prompt through the local client path.
- Primary command surface: `opencode run` (or equivalent Droid CLI run) configured to use the local proxy-backed model.
- When client startup is inconsistent, use `opencode run --print-logs` to capture bootstrap/plugin failures before attributing the issue only to proxy or llama behavior.
- Required evidence: transcript, exit outcome, wall-clock timing, whether tool activity occurred, and whether startup was clean or emitted repeated plugin bootstrap exceptions.

### Proxy surface
- Health: `curl -sS http://127.0.0.1:4000/health`
- Models: `curl -sS http://127.0.0.1:4000/v1/models`
- Messages: scripted `POST /v1/messages`
- Required evidence: health payload, response payloads, terminal loop classifications, retry markers

### llama.cpp direct surface
- Health: `curl -sS http://127.0.0.1:8080/health`
- Models: `curl -sS http://127.0.0.1:8080/v1/models`
- Direct completions: scripted `POST /v1/completions` or `POST /v1/chat/completions`
- Required evidence: status, timings, and log excerpts for long-context runs

## Benchmark Prompt
- `analyze uap proxy and llamacpp running instance for errors or performance improvement opportunities with tuning the parameters`

## Validation Concurrency
- End-to-end validator concurrency: `1`
- Rationale: the active llama.cpp runtime is single-slot (`--parallel 1`) and the benchmark workflow is heavy; concurrent benchmark sessions would contaminate measurements and failure attribution.

## Resource Cost
- Dry-run baseline showed ample system headroom (roughly 77 GB available memory and modest system load), but a single end-to-end run remains heavyweight because it drives a 35B model through a single active inference slot.
- Use one benchmark run at a time for all before/after comparisons.

## Required Comparison Rules
- Keep prompt, client entrypoint, model, tool availability, and session-state rules constant for before/after measurements.
- Record whether the run was warm or cold, and keep that state aligned across baseline vs tuned comparisons.
- Correlate the run with active proxy and llama PIDs plus log lines to avoid attributing success to the wrong process.

## Success Gating
- Fallback/apology output is a failure for the exact benchmark prompt whenever the contract requires a final actionable answer.
- Exit code 0 or HTTP 200 alone is insufficient evidence of benchmark success.
- Repeated bootstrap exceptions from `~/.opencode/plugin/*.ts` are a failure for the real-client startup surface unless the plugins were intentionally disabled and that disablement is explicit in the evidence.
- A one-line planning or stub answer after a streamed `too_many_requests` error is also a failure; acceptable outcomes are substantive final output or an explicit bounded failure.
