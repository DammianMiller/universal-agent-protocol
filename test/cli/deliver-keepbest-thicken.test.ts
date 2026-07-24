/**
 * Two harness gaps surfaced by driving a capable-but-unstable local model on
 * octopus_invaders_v3 (2026-07-23):
 *
 *  1. --keep-best only compared end-vs-START required-gate score, so a run that
 *     PEAKED mid-way (100% of gates at turn 1) then regressed lost the peak —
 *     the end-of-run rollback restored the start. bestKeepFastScore is the
 *     scoring primitive behind advancing the rollback target to the best turn.
 *
 *  2. The acceptance judge kept the loop going PAST objective-green, and the
 *     thin-gate thickening re-enabled it even when the operator set
 *     UAP_DELIVER_ACCEPTANCE=0 to stop exactly that. decideThickenWithAcceptance
 *     makes the explicit opt-out win.
 */
import { describe, it, expect } from 'vitest';
import { decideThickenWithAcceptance, bestKeepFastScore } from '../../src/cli/deliver.js';

describe('decideThickenWithAcceptance — UAP_DELIVER_ACCEPTANCE=0 must win over thickening', () => {
  const base = {
    noRealGates: false,
    requiredRungCount: 1,
    thickenDisabled: false,
    acceptanceDisabled: false,
    acceptanceAlreadyDecided: false,
  };

  it('thickens a thin gate set by default (the P6 behaviour)', () => {
    expect(decideThickenWithAcceptance({ ...base, requiredRungCount: 1 })).toBe(true);
    expect(decideThickenWithAcceptance({ ...base, requiredRungCount: 0 })).toBe(true);
  });

  it('does NOT thicken when the operator disabled acceptance (the fix)', () => {
    // The exact octopus regression: ACCEPTANCE=0 was silently overridden.
    expect(decideThickenWithAcceptance({ ...base, acceptanceDisabled: true })).toBe(false);
  });

  it('does NOT thicken a rich gate set (>1 required rung)', () => {
    expect(decideThickenWithAcceptance({ ...base, requiredRungCount: 2 })).toBe(false);
  });

  it('honours UAP_DELIVER_THICKEN=0 and an already-decided acceptance option', () => {
    expect(decideThickenWithAcceptance({ ...base, thickenDisabled: true })).toBe(false);
    expect(decideThickenWithAcceptance({ ...base, acceptanceAlreadyDecided: true })).toBe(false);
  });

  it('does NOT thicken when there are no real gates (self-gate path owns that)', () => {
    expect(decideThickenWithAcceptance({ ...base, noRealGates: true })).toBe(false);
  });
});

describe('bestKeepFastScore — score a turn on the fast-tier gates it already ran', () => {
  const fastIds = new Set(['execution', 'build', 'test']);
  const r = (id: string, passed: boolean) => ({ id, passed });

  it('is the fraction of fast-tier gates passed this turn', () => {
    expect(bestKeepFastScore([r('execution', true), r('build', true), r('test', true)], fastIds)).toBe(1);
    expect(bestKeepFastScore([r('execution', true), r('build', false)], fastIds)).toBe(0.5);
    expect(bestKeepFastScore([r('execution', false)], fastIds)).toBe(0);
  });

  it('ignores non-fast-tier gates (visual/user-validation/acceptance)', () => {
    // Only the fast-tier `execution` counts; the slower gates are excluded so
    // the metric matches the baseline snapshot's fast-tier score.
    const res = [r('execution', true), r('user-validation', false), r('acceptance', false)];
    expect(bestKeepFastScore(res, fastIds)).toBe(1);
  });

  it('returns null when NO scored gate ran (not scoreable → do not advance)', () => {
    expect(bestKeepFastScore([r('user-validation', true)], fastIds)).toBeNull();
    expect(bestKeepFastScore([], fastIds)).toBeNull();
  });

  it('scores execution + user-path when the keep-best set spans the objective gates', () => {
    // Production now populates the set from the deterministic objective gates
    // (fast + runtime execution + final user-path), so a project whose only real
    // gates are runtime/final is scoreable. A fully-functional turn (both pass)
    // must strictly outscore one that regressed the HUD wiring (user-path fails)
    // — the exact octopus case where the 100%-functional lazy turn was discarded.
    const objIds = new Set(['execution', 'user-validation']);
    const functional = bestKeepFastScore([r('execution', true), r('user-validation', true)], objIds)!;
    const regressed = bestKeepFastScore([r('execution', true), r('user-validation', false)], objIds)!;
    expect(functional).toBe(1);
    expect(regressed).toBe(0.5);
    expect(functional).toBeGreaterThan(regressed);
  });

  it('a peak turn outscores a later regressed turn — the advance/keep signal', () => {
    const peak = bestKeepFastScore([r('execution', true), r('build', true)], fastIds)!;
    const regressed = bestKeepFastScore([r('execution', false), r('build', false)], fastIds)!;
    expect(peak).toBeGreaterThan(regressed);
    // The loop advances the rollback snapshot only on a strict improvement.
    expect(peak > 0).toBe(true);
    expect(regressed > peak).toBe(false);
  });
});
