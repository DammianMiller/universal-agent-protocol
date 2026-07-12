/**
 * Reference tuning profile for Claude Opus 4.8 — the quality UPPER BOUND the
 * small-model tuner aims toward (LLM_SELF_TUNING_ANALYSIS §Phase 3). A frontier
 * model is self-sufficient, so most guardrail/scaffold knobs are relaxed: it
 * needs neither fusion nor aggressive hands-free to produce Opus-level output.
 * Useful as the "what good looks like" comparison in reports and as a sanity
 * anchor (the tuner should never propose Opus-style relaxation for qwen).
 */

import type { FlagConfig } from '../flags.js';

export const OPUS48_PROFILE: FlagConfig = {
  'recipes.enabled': false,
  'recipes.recipe': 'auto',
  'recipes.confidenceThreshold': 0.5,
  'recipes.fusionN': 3,
  'recipes.allowSelfJudge': true,
  'handsfree.enabled': false,
  'handsfree.intensity': 'normal',
  UAP_HANDSFREE_STAGNATION_LIMIT: 8,
  'modelConcurrency.slots': 4,
  'modelConcurrency.adaptive': true,
  'memory.shortTerm.maxEntries': 50,
  'memory.patternRag.enabled': false,
  'delivery.runtimeVerify': false,
  PROXY_RECON_CONVERGENCE_THRESHOLD: 60,
  PROXY_LOOP_BREAKER: true,
  PROXY_STUCK_BREAK: true,
};
