import { describe, it, expect } from 'vitest';
import { verdict } from '../../src/benchmarks/paired/stats.js';
import type { PairedDeltaResult } from '../../src/benchmarks/paired/stats.js';

/**
 * The bootstrap CI and the significance test can disagree. When they do, the
 * report used to consult only the CI, so a result whose interval cleared zero
 * by a hair was badged a confident 🟢 WIN even at p=0.064.
 *
 * That is not hypothetical: the 6-epoch replication on real-gate-power landed
 * at +12.2pp with CI [0.011, 0.233] and p=0.064 — a genuinely equivocal result
 * printed as a win. Collapsing it to TIE would be just as wrong in the other
 * direction, since the point estimate is a real +12pp. It gets its own verdict.
 */
const R = (over: Partial<PairedDeltaResult> = {}): PairedDeltaResult => ({
  meanDelta: 0.122,
  ci: { lower: 0.011, upper: 0.233 },
  pValue: 0.064,
  n: 90,
  significant: true,
  ...over,
});

describe('borderline verdict when the CI and the p-value disagree', () => {
  it('does NOT badge a p=0.064 result as a win', () => {
    expect(verdict(R())).toBe('borderline');
  });

  it('still calls it a win once the p-value clears alpha', () => {
    expect(verdict(R({ pValue: 0.005 }))).toBe('win');
  });

  it('honours an explicit alpha', () => {
    expect(verdict(R(), { alpha: 0.1 })).toBe('win');
    expect(verdict(R({ pValue: 0.04 }), { alpha: 0.01 })).toBe('borderline');
  });

  it('leaves a CI spanning zero a plain tie, not borderline', () => {
    // Borderline means "the interval cleared zero but the test did not agree",
    // NOT "weak result". An interval containing zero has nothing to disagree
    // about and must stay a tie.
    expect(verdict(R({ ci: { lower: -0.04, upper: 0.18 }, significant: false }))).toBe('tie');
  });

  it('applies in the loss direction too', () => {
    expect(verdict(R({ meanDelta: -0.122, ci: { lower: -0.233, upper: -0.011 } }))).toBe(
      'borderline'
    );
    expect(
      verdict(R({ meanDelta: -0.122, ci: { lower: -0.233, upper: -0.011 }, pValue: 0.001 }))
    ).toBe('loss');
  });

  it('does not fabricate a verdict when no p-value was computed', () => {
    // NaN p-value means the test did not run, which is not the same as the test
    // disagreeing. Fall back to the CI rather than inventing an equivocation.
    expect(verdict(R({ pValue: NaN }))).toBe('win');
  });

  it('keeps the ROPE margin dominant over the p-value', () => {
    // A delta inside the practical-equivalence band is a tie no matter how
    // significant it is — operational triviality outranks statistics.
    expect(verdict(R({ pValue: 0.001 }), { margin: 0.5 })).toBe('tie');
  });
});
