/**
 * Paired UAP benchmark harness — public surface.
 *
 * A controlled A/B that holds the base model + agent constant and toggles the
 * UAP scaffold on/off over the same task suite & seeds, reporting a vector of
 * paired deltas (accuracy + efficiency) with confidence intervals, a McNemar
 * gate-value 2x2, and per-component ablation.
 */

export * from './types.js';
export * from './stats.js';
export * from './suite.js';
export * from './scaffold.js';
export * from './adapter.js';
export * from './runner.js';
export * from './report.js';
export * from './ablation.js';
