/**
 * Global vitest setup: unit tests must never contend with LIVE delivery
 * infrastructure.
 *
 * Without this, any test that constructs OpenAICompatClient — even with fetch
 * fully mocked — still acquires the cross-process model-slot lease against the
 * SHARED coordination DB. A concurrent `uap deliver` run's adaptive
 * backpressure (recorded 429/timeout exhaustion) throttles that lease, so the
 * mocked test polls for a slot until its own 5s timeout. Observed live:
 * deliver's npm-test gate was reddened by the very deliver run executing it
 * (openai-compat-client + model-opus48 fetch-mock tests "timed out in 5000ms"
 * while the mission churned, then passed once the backend went quiet).
 *
 * Tests that exercise the lease itself re-enable it explicitly
 * (`delete process.env.UAP_MODEL_LEASE` in their beforeEach, plus their own
 * isolated UAP_COORD_DB) — see test/models/openai-compat-lease.test.ts — so
 * this default costs them nothing.
 */
if (process.env.UAP_MODEL_LEASE === undefined) {
  process.env.UAP_MODEL_LEASE = '0';
}
