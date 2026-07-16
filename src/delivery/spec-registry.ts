/**
 * Acceptance-spec registry — ONE owner for "what does the judge grade, and
 * against what evidence", per project root. Extracted from deliver.ts where
 * the same state lived as four coupled locals (a shared spec variable, a
 * per-root spec map, a per-root write-evidence map, and a per-spec breaker
 * cache) that every runner adapter mutated directly.
 *
 * Semantics preserved exactly:
 * - Parallel orchestrated tasks run in ISOLATED worktree roots; each loop's
 *   judge must grade against ITS task's spec, not a shared mutable. The gate
 *   resolves by the root it is invoked with; the phased and epic paths
 *   (single loop at a time) keep using the SHARED spec, which defaults to the
 *   mission text.
 * - Write evidence (files applied since the current spec began) is per ROOT:
 *   concurrent loops must not zero or inflate each other's evidence — an
 *   inflated count could let the churn breaker accept a task with zero writes
 *   of its own. The shared root's slot is the historic counter the phased and
 *   epic paths keep using; evidence resets wherever a spec is (re)pointed,
 *   EXCEPT on end(): restoring the mission-level spec after a task must not
 *   erase the evidence a later re-converge pass judges against.
 * - Churn-breaker state is per (SPEC, ROOT): one shared instance would thrash
 *   its current-spec slot under parallel dispatch and could then never trip.
 *   (The historic deliver.ts cache keyed by spec ALONE, which bound the first
 *   caller's root into every later caller's evidence guard — two parallel
 *   tasks with identical prompts shared flip counts and consulted the wrong
 *   root's writes. Fixed here, at the seam that made the defect visible.)
 */

import { createAcceptanceChurnBreaker } from './acceptance-judge.js';

/** Mutable write-evidence slot for one root (shared by reference with the breaker). */
export interface WriteEvidence {
  writes: number;
}

export interface SpecRegistryOptions {
  /** The mission text — the spec every root falls back to. */
  initialSpec: string;
  /** The primary project root (owns the shared single-loop evidence slot). */
  sharedRoot: string;
  /** Consecutive judge-rejections-of-green-turns bound, per spec. */
  flipLimit: number;
}

export interface SpecRegistry {
  /** What the acceptance gate grades `root` against (per-root ?? shared). */
  resolve(root: string): string;
  /** Current shared spec (mission text unless a phase/epic re-pointed it). */
  sharedSpec(): string;
  /**
   * Re-point the SHARED spec (phased/epic single-loop paths and the watch-ci
   * mission restore) and reset the shared root's evidence — the breaker's
   * zero-diff guard needs fresh evidence wherever the spec re-points.
   */
  setShared(spec: string): void;
  /**
   * Begin a per-root task spec (parallel orchestrated dispatch). An in-tree
   * task (root === sharedRoot) also re-points the shared spec. Evidence for
   * the root resets — a fresh spec starts with zero writes.
   */
  begin(root: string, spec: string): void;
  /**
   * End a per-root task spec. An in-tree task restores the shared spec to
   * `restoreShared` (the mission text) so a later watch-ci re-converge never
   * judges against a stale task prompt. Evidence is deliberately NOT reset.
   */
  end(root: string, restoreShared: string): void;
  /** The (mutable, identity-stable) write-evidence slot for a root. */
  evidence(root: string): WriteEvidence;
  /** Feed the breaker's zero-diff guard: files applied under `root`. */
  recordWrites(root: string, count: number): void;
  /** The churn breaker for a (spec, root) pair — cached per (spec, root). */
  breaker(spec: string, root: string): ReturnType<typeof createAcceptanceChurnBreaker>;
}

/** Bound on cached per-spec breakers before the runaway guard clears the cache. */
const MAX_CACHED_BREAKERS = 100;

export function createSpecRegistry(opts: SpecRegistryOptions): SpecRegistry {
  let shared = opts.initialSpec;
  const specByRoot = new Map<string, string>();
  const evidenceByRoot = new Map<string, WriteEvidence>();
  const breakers = new Map<string, ReturnType<typeof createAcceptanceChurnBreaker>>();

  const evidence = (root: string): WriteEvidence => {
    let e = evidenceByRoot.get(root);
    if (!e) {
      e = { writes: 0 };
      evidenceByRoot.set(root, e);
    }
    return e;
  };

  return {
    resolve: (root) => specByRoot.get(root) ?? shared,
    sharedSpec: () => shared,
    setShared: (spec) => {
      shared = spec;
      evidence(opts.sharedRoot).writes = 0;
    },
    begin: (root, spec) => {
      specByRoot.set(root, spec);
      if (root === opts.sharedRoot) shared = spec;
      evidence(root).writes = 0;
    },
    end: (root, restoreShared) => {
      specByRoot.delete(root);
      if (root === opts.sharedRoot) shared = restoreShared;
    },
    evidence,
    recordWrites: (root, count) => {
      if (count > 0) evidence(root).writes += count;
    },
    breaker: (spec, root) => {
      const key = `${spec}\u0000${root}`; // NUL-joined: unambiguous pair key
      let b = breakers.get(key);
      if (!b) {
        if (breakers.size > MAX_CACHED_BREAKERS) breakers.clear(); // runaway guard
        b = createAcceptanceChurnBreaker(opts.flipLimit, () => evidence(root).writes > 0);
        breakers.set(key, b);
      }
      return b;
    },
  };
}
