/**
 * Self-Harness — a self-improving harness for UAP.
 *
 * Autonomous mine -> propose -> validate -> decide loop that rewrites UAP's own
 * harness from failure traces, grounding the Self-Harness paper (arXiv:2606.09498)
 * in UAP's existing HALO trace analysis (weakness mining) and paired benchmark
 * (proposal validation). See docs/design/SELF_HARNESS.md.
 *
 * The closed loop ships across `orchestrator` (one iteration), `validate` (the
 * real paired-bench validator), and `run` (the committing loop + versioned
 * profile snapshot). Cross-model transfer + online gating live in `transfer`,
 * `trace-mine`, and `pending`.
 */

export * from './mods.js';
export * from './weakness.js';
export * from './mine.js';
export * from './propose.js';
export * from './decide.js';
export * from './profile.js';
export * from './orchestrator.js';
export * from './validate.js';
export * from './run.js';
export * from './transfer.js';
export * from './trace-mine.js';
export * from './pending.js';
export * from './middleware/path-normalizer.js';
