/**
 * LLM Self-Tuning — raising a small model (qwen3.6) toward Opus 4.8 by tuning
 * UAP's own flag surface with a closed, benchmark-validated loop.
 *
 * Pipeline (see docs/design/LLM_SELF_TUNING_ANALYSIS.md):
 *   P0 quality-scorer  — a multi-dimensional quality signal beyond pass/fail
 *   P1 llm-tuner       — LLM-guided flag proposals over the search space
 *      search-reducer  — a real Gaussian-process Bayesian optimizer + pruning
 *      flag-writer     — atomic, validated, rollback-safe config writes
 *      tuning-profile  — model-specific best-config storage
 *   P2 orchestrator/run— the propose → apply → validate → decide → learn loop
 *   P4 realtime-adaptor— per-session flag adaptation over the live signal channel
 */

export * from './judge.js';
export * from './quality-scorer.js';
export * from './flags.js';
export * from './flag-writer.js';
export * from './tuning-profile.js';
export * from './search-reducer.js';
export * from './llm-tuner.js';
export * from './orchestrator.js';
export * from './paired-validator.js';
export * from './run.js';
export * from './realtime-adaptor.js';
