/**
 * Regression tests for `judgePage` — the pure per-page verdict of the visual
 * gate (src/delivery/visual-gate.ts), exercised without a browser.
 *
 * FINDINGS from reading the judgePage implementation (kept here so every
 * assertion below is traceable to the source rather than to guesswork):
 *
 *   SIGNATURE
 *     export function judgePage(
 *       report: Omit<PageVisualReport, 'problems'>,
 *       targets: { minDistinctColors?: number; maxDominantRatio?: number;
 *                  minMotionRatio?: number } = {}
 *     ): string[]
 *
 *   RETURN TYPE
 *     string[] — the page's PROBLEMS. An EMPTY array means the page is visually
 *     sound; each entry is the human/model-readable failure wording that is fed
 *     back into the deliver convergence loop. There is no boolean `passed` on
 *     this function (that lives on VisualVerdict), so `problems.length === 0`
 *     is the pass condition.
 *
 *   BRANCHES (evaluation order)
 *     1. !report.loaded               → ['page did not load'] and EARLY RETURN —
 *                                       every other branch is skipped, so the
 *                                       observations below must set loaded:true.
 *     2. failedRequests.length > 0    → "<n> external resource(s) FAILED to load: …"
 *     3. runtimeErrors.length > 0     → "uncaught runtime error(s) during observation: …"
 *     4. hasCanvas === true:
 *          a. distinctColors < minColors || dominantRatio > maxDominant
 *             → "canvas renders below the visual floor (…)"
 *          b. expectsAnimation && motionRatio < minMotion
 *             → CANVAS no-motion wording (below).
 *     5. hasCanvas === false && expectsAnimation:
 *          motionRatio < minMotion → NO-CANVAS no-motion wording (below).
 *          A missing canvas is NOT itself a failure — rAF also drives SVG/DOM
 *          animation, so only a genuinely static render fails.
 *        expectsAnimation === false → motion is not required at all.
 *
 *   EXACT 'no-motion' STRINGS (the NEW wording these tests pin)
 *     no canvas : 'page uses requestAnimationFrame but the render is not
 *                  animating (no measurable motion between samples)'
 *     canvas    : 'page uses requestAnimationFrame but motion is 0.0% (< 2.0%
 *                  required) — the scene is not animating enough'
 *                 (percentages are motionRatio/minMotion rendered with toFixed(1))
 *
 *   motionRatio THRESHOLD / FLOOR
 *     MIN_MOTION_RATIO = 0.02 — at least 2.0% of the 24×24 sample grid must
 *     change between the first and last sample. The effective floor is
 *     minMotion = Math.max(MIN_MOTION_RATIO, targets.minMotionRatio ?? 0), so a
 *     project's .uap/visual-targets.json can only RAISE it, never lower it.
 *     The comparison is strict `<`: motionRatio exactly 0.02 passes, 0.01 fails.
 *     (Related built-in floors: MIN_DISTINCT_COLORS = 3, MAX_DOMINANT_RATIO = 0.98.)
 *
 * The module is resolved dynamically because `judgePage` is a delivery-gate
 * internal that has moved between the visual/execution gate modules over time;
 * these tests pin the BEHAVIOUR (which wording fails which observation), not the
 * file path.
 */

import { describe, it, expect } from 'vitest';

const CANDIDATE_MODULES = [
  '../../src/delivery/visual-gate.js',
  '../../src/delivery/execution-gate.js',
  '../../src/delivery/fidelity.js',
  '../../src/delivery/interaction-gate.js',
];

/** Mirror of `Omit<PageVisualReport, 'problems'>` for the observations we build. */
interface Observation {
  file: string;
  loaded: boolean;
  hasCanvas: boolean;
  distinctColors: number;
  dominantRatio: number;
  motionRatio: number;
  expectsAnimation: boolean;
  runtimeErrors: string[];
  failedRequests: string[];
  screenshots: string[];
}

type JudgePageFn = (report: Observation, targets?: Record<string, number>) => string[];

let resolved: JudgePageFn | null = null;

async function judgePage(
  report: Observation,
  targets: Record<string, number> = {}
): Promise<string[]> {
  if (!resolved) {
    const tried: string[] = [];
    for (const specifier of CANDIDATE_MODULES) {
      try {
        const mod = (await import(specifier)) as Record<string, unknown>;
        const fn =
          (mod['judgePage'] as JudgePageFn | undefined) ??
          ((mod['default'] as Record<string, unknown> | undefined)?.['judgePage'] as
            | JudgePageFn
            | undefined);
        if (typeof fn === 'function') {
          resolved = fn;
          break;
        }
        tried.push(`${specifier} (no judgePage export)`);
      } catch (error) {
        tried.push(`${specifier} (${(error as Error).message})`);
      }
    }
    if (!resolved) {
      throw new Error(`judgePage not found — tried: ${tried.join(' | ')}`);
    }
  }
  return resolved(report, targets);
}

/** A page that loads cleanly and renders richly; each test overrides what it pins. */
function observation(overrides: Partial<Observation> = {}): Observation {
  return {
    file: 'index.html',
    loaded: true,
    hasCanvas: false,
    distinctColors: 12,
    dominantRatio: 0.5,
    motionRatio: 0,
    expectsAnimation: false,
    runtimeErrors: [],
    failedRequests: [],
    screenshots: [],
    ...overrides,
  };
}

// The NEW no-motion wording. Matches both the canvas and the no-canvas variant;
// deliberately does NOT match the old generic blank-page phrasing.
const NO_MOTION_WORDING = /not animating|no measurable motion|no[- ]motion|never (moved|animat)/i;

// The old generic blank-page complaint that must NOT be used for a no-motion fail.
const LEGACY_BLANK_WORDING = /distinct colors|visual floor|page did not load/i;

const NO_CANVAS_WORDING =
  'page uses requestAnimationFrame but the render is not animating (no measurable motion between samples)';

describe('judgePage — no-motion regression', () => {
  it('fails an animation-expecting page with no canvas and zero motion, using the no-motion wording', async () => {
    const problems = await judgePage(
      observation({ expectsAnimation: true, hasCanvas: false, motionRatio: 0 })
    );

    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join('\n')).toMatch(NO_MOTION_WORDING);
    // Exact NEW wording of the no-canvas branch.
    expect(problems).toContain(NO_CANVAS_WORDING);
    // Not the old generic blank-page phrasing.
    expect(problems.join('\n')).not.toMatch(LEGACY_BLANK_WORDING);
  });

  it('fails an animation-expecting page that HAS a canvas but still shows zero motion', async () => {
    const problems = await judgePage(
      observation({ expectsAnimation: true, hasCanvas: true, motionRatio: 0 })
    );

    const text = problems.join('\n');
    expect(problems.length).toBeGreaterThan(0);
    expect(text).toMatch(NO_MOTION_WORDING);
    // Canvas-branch wording, with the built-in 2.0% floor rendered into it.
    expect(text).toContain(
      'page uses requestAnimationFrame but motion is 0.0% (< 2.0% required) — the scene is not animating enough'
    );
  });

  it('fails a canvas page whose motionRatio sits just below the 0.02 floor', async () => {
    const problems = await judgePage(
      observation({ expectsAnimation: true, hasCanvas: true, motionRatio: 0.01 })
    );

    expect(problems.join('\n')).toMatch(
      /motion is 1\.0% \(< 2\.0% required\) — the scene is not animating enough/
    );
  });

  it('passes an animation-expecting page whose motionRatio clears the 0.02 floor', async () => {
    const problems = await judgePage(
      observation({ expectsAnimation: true, hasCanvas: true, motionRatio: 0.02 })
    );

    expect(problems).toEqual([]);
  });

  it('passes a no-canvas animation page that does move between samples', async () => {
    const problems = await judgePage(
      observation({ expectsAnimation: true, hasCanvas: false, motionRatio: 1 })
    );

    expect(problems).toEqual([]);
  });

  it('does not require motion when the page is not expected to animate', async () => {
    const problems = await judgePage(
      observation({ expectsAnimation: false, hasCanvas: false, motionRatio: 0 })
    );

    expect(problems).toEqual([]);
  });

  it('lets project visual targets RAISE the motion floor, never lower it', async () => {
    // Raised floor: motion 0.03 clears the built-in 0.02 but fails a 0.05
    // target. (0.05 itself would sit ON the floor — the comparison is strict
    // `<`, pinned above: 0.02 passes at the built-in floor, so the boundary
    // value passes here too and would not exercise the raise.)
    const raised = await judgePage(
      observation({ expectsAnimation: true, hasCanvas: false, motionRatio: 0.03 }),
      { minMotionRatio: 0.05 }
    );
    expect(raised).toContain(NO_CANVAS_WORDING);

    // A target below the built-in floor cannot weaken the gate.
    const weakened = await judgePage(
      observation({ expectsAnimation: true, hasCanvas: false, motionRatio: 0.01 }),
      { minMotionRatio: 0 }
    );
    expect(weakened).toContain(NO_CANVAS_WORDING);
  });

  it('short-circuits to "page did not load" without reporting a motion problem', async () => {
    const problems = await judgePage(
      observation({ loaded: false, expectsAnimation: true, hasCanvas: false, motionRatio: 0 })
    );

    expect(problems).toEqual(['page did not load']);
  });
});