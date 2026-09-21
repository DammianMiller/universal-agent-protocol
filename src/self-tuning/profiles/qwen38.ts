/**
 * Bundled starter tuning profile for qwen3.8-27b — the local executor UAP now
 * raises toward Opus (successor to the qwen3.6-a3b seed in qwen36.ts).
 *
 * Carried over from QWEN36_PROFILE unchanged EXCEPT for concurrency, which is
 * not a preference here but a property of the server.
 *
 * CORRECTED 2026-09-21. This header said the model was served by
 * `ninfer-serve --max-concurrency 1` and that there was ONE rail. That engine
 * is not what runs: the backend is buun-llama-cpp behind
 * uap-gsq-rco-server.service with `-np 2`, and the proxy was raised to match
 * (PROXY_CONCURRENCY_LIMIT / UAP_MODEL_SLOTS / PROXY_SESSION_ADMISSION_LIMIT
 * all 2). The reasoning below still holds, only the number changed: slots must
 * track what the server and proxy will actually run in parallel. Declaring
 * MORE than that does not get more in flight — it gets one running and the
 * rest queued, the extra slots buy latency and a longer wedge window rather
 * than throughput, and the adaptive controller then reads the queueing delay
 * as backpressure and throttles a server that was never saturated.
 *
 * Whether the second rail EARNS anything is a separate question from whether
 * it exists: check llamacpp:n_busy_slots_per_decode in /metrics (>1 means
 * requests genuinely overlapped), or `uap inference health`.
 *
 * Everything else is deliberately identical to the qwen36 seed: nothing has
 * been re-measured on 3.8 yet, and the tuning loop's job is to beat this seed,
 * not to inherit guesses dressed up as findings. Re-tune with `uap tune`.
 *
 * Values are keyed by settings-registry key (see src/self-tuning/flags.ts).
 */

import type { FlagConfig } from '../flags.js';

export const QWEN38_PROFILE: FlagConfig = {
  // Recipes: fusion with a strong distinct judge is the small-model lever.
  'recipes.enabled': true,
  'recipes.recipe': 'fusion',
  'recipes.confidenceThreshold': 0.6,
  'recipes.fusionN': 3,
  'recipes.allowSelfJudge': false,
  // Hands-free: a small model gives up early; push hard toward the ledger.
  'handsfree.enabled': true,
  'handsfree.intensity': 'aggressive',
  UAP_HANDSFREE_STAGNATION_LIMIT: 6,
  // Concurrency: TWO rails (see the header) — matches `-np 2` on the server
  // and the proxy's concurrency/admission limits. Adaptive stays on so a
  // genuinely overloaded server still backs off.
  'modelConcurrency.slots': 2,
  'modelConcurrency.adaptive': true,
  // Memory: bigger short-term window + pattern RAG compensate for weak planning.
  'memory.shortTerm.maxEntries': 80,
  'memory.patternRag.enabled': true,
  // Verification: prove it runs (catches "declared done but never ran").
  'delivery.runtimeVerify': true,
  // Proxy guardrails: converge sooner, keep loop/stuck breakers on.
  PROXY_RECON_CONVERGENCE_THRESHOLD: 30,
  PROXY_LOOP_BREAKER: true,
  PROXY_STUCK_BREAK: true,
};
