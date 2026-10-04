/**
 * Bundled starter tuning profile for qwen3.8-27b — the local executor UAP now
 * raises toward Opus (successor to the qwen3.6-a3b seed in qwen36.ts).
 *
 * Carried over from QWEN36_PROFILE unchanged EXCEPT for concurrency, which is
 * not a preference here but a property of the server.
 *
 * HISTORY: corrected 2026-09-21 (ninfer-serve -> buun-llama-cpp, 1 -> 2
 * rails), then SUPERSEDED 2026-10-04 — the backend is now the strata serve
 * layer on :8080 (flash-next IQ3_XXS pack), which runs ONE rail over a
 * 131072-cell pool. Slots drop 2 -> 1 for the same reason they rose 1 -> 2:
 * slots must track what the server and proxy will actually run in parallel.
 * Declaring MORE than that does not get more in flight — it gets one running
 * and the rest queued, the extra slots buy latency and a longer wedge window
 * rather than throughput, and the adaptive controller then reads the
 * queueing delay as backpressure and throttles a server that was never
 * saturated.
 *
 * Whether a future second strata rail EARNS anything is a separate question
 * from whether it exists: `uap inference health` (backend strata) answers it
 * once one does.
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
  // Concurrency: ONE rail (see the header) — matches the strata server's
  // single slot and the proxy's concurrency/admission limits. Adaptive stays
  // on so a genuinely overloaded server still backs off.
  'modelConcurrency.slots': 1,
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
