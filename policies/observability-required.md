# Observability Required

New production code paths SHOULD ship with the telemetry necessary to debug them in production within five minutes at 3am. Logs, metrics, traces — pick the right pillar for each concern.

## Rules

1. **Structured logs on error boundaries.** Every `catch` block on a production code path emits a structured log with: stable event name, error type, request/trace ID, action being attempted. No bare `console.log` / `print` / `fmt.Println` allowed in production code.

2. **RED metrics on new request handlers.** New HTTP, RPC, or worker handlers SHOULD emit Rate, Errors, Duration metrics with stable labels. Endpoint name and status code are required labels; user_id / tenant_id only if cardinality budget permits.

3. **Trace propagation across service boundaries.** When the change introduces a new outbound call to another service or async worker, the trace context (`traceparent` header or equivalent) is propagated.

4. **SLO / error-budget reference.** For new user-facing endpoints, the PR references which SLO covers the endpoint (existing or proposed).

5. **No high-cardinality labels added casually.** Labels with cardinality > 1000 unique values require sign-off from `observability-engineer`.

## Triggers

This policy applies when the diff adds or modifies:

- HTTP / RPC route handlers
- Background workers, queue consumers, cron jobs
- Files under `**/handlers/**`, `**/routes/**`, `**/workers/**`
- Files under `**/telemetry/**`, `**/metrics/**`, `**/logging/**`
- External service integrations (new outbound calls)

## Why

Code that can't be debugged in production is code that becomes a permanent incident-tax. Each pillar (logs, metrics, traces) answers a different question; using the wrong pillar (e.g., scraping logs to compute rates) is a frequent source of slow incident response and observability cost overrun.

This is RECOMMENDED to allow gradual adoption — promoting to REQUIRED for a given service is done once the team has confirmed cardinality budgets and downstream tooling.

## How to Apply

1. **Invoke `observability-engineer`** when designing the new code path:
   ```
   Task(subagent_type: "observability-engineer",
        prompt: "Review observability for new endpoint <path>")
   ```

2. **Adopt the structured logging shape** (TS/JS example):
   ```typescript
   logger.info('policy_check_executed', {
     policy_id: policy.id,
     tool_name: toolName,
     stage,
     duration_ms: Date.now() - start,
     request_id: ctx.requestId,
     trace_id: ctx.traceId,
     result: 'allowed' | 'blocked',
   });
   ```

3. **Emit RED metrics** for new handlers:
   ```typescript
   metrics.increment('http_requests_total', { endpoint, status });
   metrics.histogram('http_request_duration_ms', durationMs, { endpoint });
   ```

4. **Propagate trace context** through async boundaries (deploy-batcher queues, worker dispatches, cross-service RPCs).

5. **Add or reference an SLO** under `observability/slos/` for the service.

## Exceptions

This policy does not apply when:

- The change is purely internal (no production behavior)
- Existing observability already covers the new path (e.g., a thin wrapper)
- The service has documented opt-out (e.g., dev-only tools)

Note observability-cost concerns to `cost-engineer` for review.

## Anti-Patterns

DO NOT:

- Log entire request bodies "for debugging"
- Add `user_id` as a metric label on a multi-million-user service
- Use `console.log` in production code paths
- Rely on grep-the-logs to compute aggregate rates (use a metric)
- Sample DEBUG logs in production (they should be off)
- Wrap errors in `try { ... } catch (e) { logger.error(e) }` without action context
- Add metrics without units in the name (`request_duration` → `request_duration_ms`)

## Enforcement Level

[RECOMMENDED]

A service may opt in to REQUIRED enforcement by adding an entry to its service config. The `observability-engineer` droid may also escalate a recommendation to a block if cardinality budgets are at risk.

## Related Policies

- `architecture-review-required` — New cross-cutting observability primitives need ADR
- `completion-gate` — Observability hooks are part of "done" for user-facing changes
