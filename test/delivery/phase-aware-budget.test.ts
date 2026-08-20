/**
 * The wall-clock budget was calibrated on runs that executed ONE mission.
 *
 * A decomposed run executes N missions in sequence and nothing scaled the clock
 * to match, so the 120-minute default silently became "long enough for the first
 * few epics". Measured live (2026-08-20, rust-pg-ext, 7 epics on qwen3.8-27b):
 * 16.2 min/epic sustained — 4 epics done at 65 minutes, ~114 minutes needed for
 * all 7 against a 120-minute cap. That finishes on a coin flip; a 9-epic plan at
 * the same rate (146 min) could not finish at all, and the failure looks exactly
 * like the model being incapable rather than the clock being wrong.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  phaseAwareRunBudgetMinutes,
  isRunBudgetExplicit,
  PER_PHASE_BUDGET_MINUTES,
  MAX_SCALED_RUN_BUDGET_MINUTES,
  DEFAULT_RUN_BUDGET_MINUTES,
} from '../../src/delivery/run-state.js';

const roots: string[] = [];
// SAVE/RESTORE, not delete. These assertions are about what the DEFAULT does, so
// an ambient UAP_DELIVER_MAX_MINUTES (a debugging session, a CI job) silently
// flips them — verified: `UAP_DELIVER_MAX_MINUTES=90 vitest -t "is false for a
// project that sets no budget"` failed before this. Clearing it in afterEach is
// also too late for the first test, and deleting an operator's variable outright
// leaks the other way into whatever runs next.
const savedMaxMinutes = process.env.UAP_DELIVER_MAX_MINUTES;
beforeEach(() => {
  delete process.env.UAP_DELIVER_MAX_MINUTES;
});
afterEach(() => {
  while (roots.length) rmSync(roots.pop() as string, { recursive: true, force: true });
  if (savedMaxMinutes === undefined) delete process.env.UAP_DELIVER_MAX_MINUTES;
  else process.env.UAP_DELIVER_MAX_MINUTES = savedMaxMinutes;
});

function project(uap?: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), 'uap-phase-budget-'));
  roots.push(root);
  if (uap) writeFileSync(join(root, '.uap.json'), JSON.stringify(uap));
  return root;
}

describe('phase-aware run budget', () => {
  it('grants a 7-epic plan more than the 120-minute single-mission default', () => {
    // The measured case: 7 epics needed ~114 min and the cap was 120.
    const scaled = phaseAwareRunBudgetMinutes(DEFAULT_RUN_BUDGET_MINUTES, 7);
    expect(scaled).toBe(7 * PER_PHASE_BUDGET_MINUTES);
    expect(scaled).toBeGreaterThan(DEFAULT_RUN_BUDGET_MINUTES);
  });

  it('leaves an undecomposed run on the calibrated default', () => {
    // 0 and 1 phase are not sequences — the 61-run calibration still applies.
    for (const n of [0, 1]) {
      expect(phaseAwareRunBudgetMinutes(120, n)).toBe(120);
    }
  });

  it('never SHRINKS the budget for a small plan', () => {
    // 2 phases x 20 = 40, which is less than 120. Scaling down would cut runs
    // the calibration proved need the full default.
    expect(phaseAwareRunBudgetMinutes(120, 2)).toBe(120);
  });

  it('caps a runaway decomposition rather than buying unbounded time', () => {
    expect(phaseAwareRunBudgetMinutes(120, 500)).toBe(MAX_SCALED_RUN_BUDGET_MINUTES);
  });

  it('keeps a disabled budget disabled', () => {
    // 0/negative means OFF. Scaling it would switch expiry back on.
    expect(phaseAwareRunBudgetMinutes(0, 9)).toBe(0);
    expect(phaseAwareRunBudgetMinutes(-1, 9)).toBe(-1);
  });

  it('ignores a non-finite phase count instead of producing NaN', () => {
    expect(phaseAwareRunBudgetMinutes(120, NaN)).toBe(120);
    expect(phaseAwareRunBudgetMinutes(120, Infinity)).toBe(120);
  });
});

describe('isRunBudgetExplicit — the scaler must never override a human', () => {
  it('is false for a project that sets no budget', () => {
    expect(isRunBudgetExplicit(project())).toBe(false);
  });

  it('is true when .uap.json names one', () => {
    expect(isRunBudgetExplicit(project({ delivery: { maxRunMinutes: 60 } }))).toBe(true);
  });

  it('is true when the env names one', () => {
    process.env.UAP_DELIVER_MAX_MINUTES = '45';
    expect(isRunBudgetExplicit(project())).toBe(true);
  });

  it('is false when the config value is not a number', () => {
    // A typo must not read as an operator decision and freeze the clock.
    expect(isRunBudgetExplicit(project({ delivery: { maxRunMinutes: 'soon' } }))).toBe(false);
  });
});
