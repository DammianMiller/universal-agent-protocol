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

/**
 * Tier resolution must never inherit the operator's REAL fleet-global store.
 *
 * resolveTiers() reads UAP_TIER_STORE (else ~/.uap/quality/tiers.json) so a
 * published fleet tier applies to every project — the auto-apply feature. In
 * the test sandbox that inheritance is contamination: any test asserting a
 * fresh project's known-tier list or a no-tier seam sees the LIVE store
 * instead (observed the day the feature shipped: publishing
 * visual-scene/fable-high to the real fleet store reddened 8 tests across 3
 * files that never mention tiers). Tests that exercise the global store
 * itself pass their own env or set UAP_TIER_STORE explicitly
 * (test/quality/tier-autoapply.test.ts). The path below never exists, so the
 * default is an empty global — resolveTiers fails soft to the project view.
 */
if (process.env.UAP_TIER_STORE === undefined) {
  process.env.UAP_TIER_STORE = join(tmpdir(), `uap-test-no-fleet-tiers-${process.pid}.json`);
}

/**
 * Built-in class priors (U-I frontier regimes) resolve for every tier-less
 * class by default in production — the reference-free floor. In the test
 * sandbox that default rewrites the seams the pre-prior tests pin (the tier
 * gate's 'no derived tiers' skip, the empty known-tier list), so priors
 * default OFF here and the tests asserting ON them pass their own env
 * (test/quality/class-priors.test.ts) — the same idiom as the fleet store
 * above. Production keeps priors ON; UAP_TIER_PRIORS=off is the operator
 * escape hatch there too.
 */
if (process.env.UAP_TIER_PRIORS === undefined) {
  process.env.UAP_TIER_PRIORS = 'off';
}

/**
 * The tool-call corpus is PRODUCTION telemetry — test runs must not write it.
 *
 * runTool records every call to ~/.uap/telemetry/tool-calls.db, the machine-
 * scoped corpus the write-path failure classes are measured against. Any
 * test that drives the executor — hundreds per suite run, with fixture
 * paths and synthetic refusals — appends fixture rows to the real corpus.
 * Measured after the 2026-11-21 v2.67.0 validation: the machine corpus held
 * 630 rows, 100% of them test-fixture traffic (`.worktrees/003-...` paths,
 * `src/big.ts`, protected-path refusals) — every era and failure-class
 * number derived from that box since is fixture noise. Same pattern as the
 * tiers above: tests asserting ON the corpus set their own
 * UAP_TOOL_CORPUS_DIR (test/telemetry/tool-calls.test.ts).
 */
if (process.env.UAP_TOOL_CORPUS_DIR === undefined) {
  process.env.UAP_TOOL_CORPUS_DIR = join(tmpdir(), `uap-test-tool-corpus-${process.pid}`);
}

/**
 * Memory-health telemetry is machine-scoped too. `uap memory query` on a
 * degraded backend records the outage transition to
 * ~/.uap/telemetry/memory-health.jsonl; a test that drives the query path
 * on this box (Qdrant reachable? embeddings down?) would record a
 * fictional outage into the real machine's history. Tests asserting ON the
 * transitions set their own UAP_MEMORY_TELEMETRY_DIR
 * (test/memory/recall-health.test.ts).
 */
if (process.env.UAP_MEMORY_TELEMETRY_DIR === undefined) {
  process.env.UAP_MEMORY_TELEMETRY_DIR = join(tmpdir(), `uap-test-memory-health-${process.pid}`);
}
