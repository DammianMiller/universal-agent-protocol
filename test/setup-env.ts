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
import { tmpdir } from 'os';
import { join } from 'path';

if (process.env.UAP_MODEL_LEASE === undefined) {
  process.env.UAP_MODEL_LEASE = '0';
}

/**
 * Follow-poll journals must never land in the DEVELOPER's real cache.
 *
 * A timed-out follow journals to `~/.cache/uap/follow-polls/<hash>` so the
 * do-not-kill briefing is sent once rather than on every poll. Any test that
 * drives a timed-out follow therefore writes one directory per temp project
 * root — measured: 129 directories in `~/.cache` after a single suite run, from
 * test files that never mention journals at all.
 *
 * Set here rather than per-file for the same reason UAP_MODEL_LEASE is: the
 * tests that leak are the ones not thinking about this, so the default has to
 * cover them. Tests asserting ON journal contents override it with their own
 * isolated base (see test/delivery/follow-poll-journal.test.ts).
 */
if (process.env.UAP_FOLLOW_POLL_DIR === undefined) {
  process.env.UAP_FOLLOW_POLL_DIR = join(tmpdir(), `uap-test-follow-polls-${process.pid}`);
}
