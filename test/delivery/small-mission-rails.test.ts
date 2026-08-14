import { describe, expect, it } from 'vitest';
import { measureQueryComplexity } from '../../src/utils/query-complexity.js';
import { planAutoOptimization, DELIVERY_COMPLEXITY_THRESHOLDS } from '../../src/delivery/auto-optimizer.js';
import { classifyComplexity } from '../../src/models/complexity.js';

/**
 * Rails must scale with mission SCOPE, not instruction verbosity.
 *
 * Measured (bench r4, 2026-08-14): every kata-scale instruction scored
 * complex on length + tech words, deliver's auto-plan enabled the full aid
 * stack, 47/50 cells hit the 15-minute guillotine in BOTH arms, and the full
 * stack came out -16pp (CI [-32,-4]) because rails consumed the budget before
 * implementation landed. The scope cap makes a one-file, single-step mission
 * `simple` regardless of how precisely it is specified — and `simple` already
 * means: plain single-shot loop, no exploration/critic/HALO, no acceptance
 * judge, and (deliver.ts) no model-driven user-path mining.
 */

const KATA_FLATTEN =
  'Implement flatten(arr) in flatten.js: return a new array with all nested arrays flattened to a single level, preserving order, to arbitrary depth. E.g. [1,[2,[3,[4]],5]] -> [1,2,3,4,5]; [] -> []. Do not mutate the input. Keep the CommonJS export shape.';
const KATA_RLE =
  "Implement rleEncode(s) in rle.js. Return the run-length encoding: each maximal run of one character becomes that character followed by the run length (e.g. 'aaabbc' -> 'a3b2c1', 'x' -> 'x1'). The empty string returns ''. Keep the CommonJS export shape.";
const TWO_FILE_MISSION =
  'Add two functions to src/stats.js: mode(values) returning the most frequent value and range(values). Export both, and add test cases for them to test/stats.test.js.';
const MULTI_STEP =
  'Implement parse(input) in parser.js and then wire it into the CLI entrypoint and update the error handling after that.';
const DESCRIPTIVE_FOLLOWED_BY =
  "Implement rleEncode(s) in rle.js: each maximal run of one character becomes that character followed by the run length. The empty string returns ''.";
const BROAD_SCOPE =
  'Refactor the authentication service in auth.js to support the new token architecture across the codebase.';

describe('query-complexity scope cap', () => {
  it('caps one-file single-step katas to simple regardless of verbosity', () => {
    expect(measureQueryComplexity(KATA_FLATTEN, DELIVERY_COMPLEXITY_THRESHOLDS)).toBe('simple');
    expect(measureQueryComplexity(KATA_RLE, DELIVERY_COMPLEXITY_THRESHOLDS)).toBe('simple');
  });

  it('descriptive "followed by" (a format spec, not a step) does not defeat the cap', () => {
    expect(measureQueryComplexity(DESCRIPTIVE_FOLLOWED_BY, DELIVERY_COMPLEXITY_THRESHOLDS)).toBe('simple');
  });

  it('does NOT cap two-file, multi-step, or broad-scope missions', () => {
    expect(measureQueryComplexity(TWO_FILE_MISSION, DELIVERY_COMPLEXITY_THRESHOLDS)).not.toBe('simple');
    expect(measureQueryComplexity(MULTI_STEP, DELIVERY_COMPLEXITY_THRESHOLDS)).not.toBe('simple');
    expect(measureQueryComplexity(BROAD_SCOPE, DELIVERY_COMPLEXITY_THRESHOLDS)).not.toBe('simple');
  });

  it('scope-expander phrasings cannot game the cap (review F2)', () => {
    // Each phrased to CROSS the moderate score floor (a too-short evasion is
    // simple by SCORE, pre-existing behavior out of the cap's scope) — the
    // assertion is that the CAP refuses to fire on breadth signals.
    for (const evasion of [
      'Rewrite the module resolution in index.js and carefully update everything it imports to the new async API, fixing each import site to build cleanly',
      'Change the export shape of utils.js to named exports and fix all callers across the test files so the build and test gates pass',
      'Implement flatten(arr) with arbitrary depth in flatten.js and also wire it into the CLI argument parser so the build passes',
      'Debug and fix the recurring memory leak in our node.js worker: the heap grows on every request batch until the process is OOM-killed',
      'Build a complete snake game in game.html: canvas rendering, keyboard controls, collision detection, score display, and a game-over screen',
    ]) {
      expect(measureQueryComplexity(evasion, DELIVERY_COMPLEXITY_THRESHOLDS)).not.toBe('simple');
    }
  });

  it('the cap is OPT-IN: consumers without scopeCap keep score-based verdicts (review F4)', () => {
    expect(measureQueryComplexity(KATA_FLATTEN, { moderate: 1, complex: 2 })).not.toBe('simple');
  });
});

describe('auto-plan follows the capped tier', () => {
  it('gives katas the plain single-shot plan: no aids, no acceptance judge', () => {
    const plan = planAutoOptimization(KATA_FLATTEN);
    expect(plan.complexity).toBe('simple');
    expect(plan.candidates).toBeUndefined();
    expect(plan.critic).toBe(false);
    expect(plan.halo).toBe(false);
    expect(plan.ideate).toBe(false);
    expect(plan.acceptance).toBe(false);
  });

  it('keeps the aid stack for multi-file missions', () => {
    const plan = planAutoOptimization(TWO_FILE_MISSION);
    expect(plan.complexity).not.toBe('simple');
  });
});

describe('routing tier follows the cap', () => {
  it('classifies katas below high', () => {
    expect(classifyComplexity({ instruction: KATA_FLATTEN }).tier).not.toBe('high');
  });
});
