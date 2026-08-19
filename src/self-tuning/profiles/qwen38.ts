/**
 * Bundled starter tuning profile for qwen3.8-27b — the local executor UAP now
 * raises toward Opus (successor to the qwen3.6-a3b seed in qwen36.ts).
 *
 * Carried over from QWEN36_PROFILE unchanged EXCEPT for concurrency, which is
 * not a preference here but a property of the server: this model is served by
 * `ninfer-serve --max-concurrency 1 --max-pending-requests 16`. There is ONE
 * rail. Requesting 4 slots does not get 4 in flight — it gets one running and
 * three queued behind it, so the extra slots buy latency and a longer wedge
 * window rather than throughput, and the adaptive controller then reads the
 * queueing delay as backpressure and throttles a server that was never
 * saturated. The qwen36 value of 4 was correct for llama.cpp `--parallel`; it
 * is wrong for this engine.
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
  // Concurrency: ONE rail (see the header). Adaptive stays on so a genuinely
  // overloaded server still backs off.
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
