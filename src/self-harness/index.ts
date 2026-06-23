/**
 * Self-Harness — a self-improving harness for UAP.
 *
 * Autonomous mine -> propose -> validate loop that rewrites UAP's own harness
 * from failure traces, grounding the Self-Harness paper (arXiv:2606.09498) in
 * UAP's existing HALO trace analysis (weakness mining) and paired benchmark
 * (proposal validation). See docs/design/SELF_HARNESS.md.
 *
 * P0 ships the foundational types: the Mod DSL and the weakness/signature model.
 * The orchestrator (P1+) builds on these.
 */

export * from './mods.js';
export * from './weakness.js';
export * from './mine.js';
export * from './propose.js';
export * from './decide.js';
export * from './profile.js';
export * from './orchestrator.js';
