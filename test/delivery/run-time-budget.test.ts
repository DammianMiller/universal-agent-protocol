/**
 * Nothing bounded a delivery in wall-clock time.
 *
 * `wedgeAfterSec` only fires on SILENCE — a run whose heartbeat is fresh but
 * whose gate score never moves runs forever. Measured 2026-08-13: a run had
 * been going 651 minutes, still on phase 0 of 6, scoring exactly 20% of gates
 * on all four of its turns. Across 61 local runs the longest were 1300–7900
 * minutes (up to five and a half days), every one of them an abandoned husk.
 *
 * The default is calibrated, not chosen. Of those 61 runs, every single one
 * that DELIVERED finished within 119.9 minutes, so a 120-minute budget would
 * have ended 18 futile runs and none that succeeded. A 60-minute one would have
 * cut a successful run, which is why it is not the default.
 *
 * Expiry rides the SAME cooperative stop latch as an operator's stop request:
 * the turn finishes, work is checkpointed, the lock is released. A budget that
 * killed a run mid-write would trade a slow failure for a corrupt tree.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runBudgetMinutes, isRunBudgetExpired, makeStopLatch } from '../../src/delivery/run-state.js';

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop() as string, { recursive: true, force: true });
  delete process.env.UAP_DELIVER_MAX_MINUTES;
});

function project(uap?: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), 'uap-budget-'));
  roots.push(root);
  if (uap) writeFileSync(join(root, '.uap.json'), JSON.stringify(uap));
  return root;
}

describe('the wall-clock budget', () => {
  it('defaults to 120 minutes — every run that ever delivered fit inside it', () => {
    expect(runBudgetMinutes(project())).toBe(120);
  });

  it('is read from .uap.json', () => {
    expect(runBudgetMinutes(project({ delivery: { maxRunMinutes: 45 } }))).toBe(45);
  });

  it('is overridable by environment for a one-off long mission', () => {
    process.env.UAP_DELIVER_MAX_MINUTES = '300';
    expect(runBudgetMinutes(project())).toBe(300);
  });

  it('lets the environment win over the file, so an operator can rescue a run', () => {
    process.env.UAP_DELIVER_MAX_MINUTES = '300';
    expect(runBudgetMinutes(project({ delivery: { maxRunMinutes: 45 } }))).toBe(300);
  });

  it('treats 0 or a negative value as OFF rather than as instant expiry', () => {
    // Instant expiry would make every run stop on turn one — a config typo
    // must not become a total outage.
    expect(runBudgetMinutes(project({ delivery: { maxRunMinutes: 0 } }))).toBe(0);
    expect(isRunBudgetExpired(Date.now() - 10_000_000, 0)).toBe(false);
    expect(isRunBudgetExpired(Date.now() - 10_000_000, -5)).toBe(false);
  });

  it('ignores a garbage value and keeps the default', () => {
    process.env.UAP_DELIVER_MAX_MINUTES = 'soon';
    expect(runBudgetMinutes(project())).toBe(120);
  });

  it('survives an unreadable config', () => {
    const root = mkdtempSync(join(tmpdir(), 'uap-budget-'));
    roots.push(root);
    writeFileSync(join(root, '.uap.json'), '{ not json');
    expect(runBudgetMinutes(root)).toBe(120);
  });
});

describe('expiry', () => {
  it('is false for a run that has just started', () => {
    expect(isRunBudgetExpired(Date.now(), 120)).toBe(false);
  });

  it('is false right up to the limit', () => {
    expect(isRunBudgetExpired(Date.now() - 119 * 60_000, 120)).toBe(false);
  });

  it('is true once past it', () => {
    expect(isRunBudgetExpired(Date.now() - 121 * 60_000, 120)).toBe(true);
  });

  it('catches the 651-minute run that prompted this', () => {
    expect(isRunBudgetExpired(Date.now() - 651 * 60_000, 120)).toBe(true);
  });

  it('does not fire on a long run when the budget is disabled', () => {
    expect(isRunBudgetExpired(Date.now() - 5000 * 60_000, 0)).toBe(false);
  });

  it('tolerates a start time in the future (clock skew) without expiring', () => {
    expect(isRunBudgetExpired(Date.now() + 60_000, 120)).toBe(false);
  });
});

describe('expiry rides the cooperative stop latch', () => {
  it('latches, so every later epic sees it too', () => {
    // Composed exactly as deliver.ts composes it. Without the latch the epic
    // controller would ask again, get a fresh answer, and start another epic.
    const started = Date.now() - 200 * 60_000;
    const latch = makeStopLatch(() => isRunBudgetExpired(started, 120) || false);
    expect(latch()).toBe(true);
    expect(latch(), 'the next epic must not start').toBe(true);
  });

  it('does not stop a run that is inside its budget with no stop file', () => {
    const latch = makeStopLatch(() => isRunBudgetExpired(Date.now(), 120) || false);
    expect(latch()).toBe(false);
  });

  /**
   * A source check, as for the stop latch itself: the composition sits inside
   * `runDeliver`, which takes a whole delivery to invoke, so there is no
   * runtime seam. A regression guard against a future refactor, not a boundary.
   */
  it('deliver.ts folds the budget INTO the latch rather than adding a second mechanism', () => {
    const src = readFileSync(new URL('../../src/cli/deliver.ts', import.meta.url), 'utf8');
    const latch = /makeStopLatch\(\(\) => \{[\s\S]{0,400}?isRunBudgetExpired[\s\S]{0,400}?isStopRequested/;
    expect(src, 'budget and stop request must share one latch').toMatch(latch);
  });

  it('and tells the operator WHY it stopped', () => {
    const src = readFileSync(new URL('../../src/cli/deliver.ts', import.meta.url), 'utf8');
    expect(src).toMatch(/wall-clock budget of \$\{budgetMinutes\} minutes/);
    expect(src, 'a stop with no stated cause is how a caller invents one').toMatch(/did not fail/i);
  });
});
