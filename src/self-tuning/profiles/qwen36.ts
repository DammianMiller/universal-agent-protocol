/**
 * Bundled starter tuning profile for qwen3.6-a3b (the small executor UAP raises
 * toward Opus). This is the design's hypothesis config (LLM_SELF_TUNING_ANALYSIS
 * §Phase 3) — guardrail-heavy, judge-backed fusion, aggressive hands-free — used
 * as the seed config and as the first thing the tuning loop tries to beat.
 *
 * Values are keyed by settings-registry key (see src/self-tuning/flags.ts).
 */

import type { FlagConfig } from '../flags.js';

export const QWEN36_PROFILE: FlagConfig = {
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
  // Concurrency.
  'modelConcurrency.slots': 4,
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
