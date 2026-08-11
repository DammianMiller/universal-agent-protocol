/**
 * A fresh run must not inherit the previous run's done marks.
 *
 * `initLedger` preserved a same-id item's status so that re-planning inside a
 * run stayed non-destructive. That was safe while re-planning minted new epic
 * slugs each time — ids rarely collided ACROSS runs. They collide constantly
 * now: every mission short enough to skip planning runs as the single epic
 * `mission` (decompose.singleEpicFor), so relaunching one found `mission`
 * already marked done and started at 100%.
 *
 * Measured before the fix (three relaunch scenarios, real ledger API):
 *
 *   single-epic relaunch  -> status: done         isComplete at launch: TRUE
 *   reused-plan relaunch  -> done,done,pending    isComplete at launch: false
 *   re-planned relaunch   -> pending,pending      isComplete at launch: false
 *
 * The first line is the bug. `isComplete` is what the hands-free Stop hook
 * reads to decide a build is finished (cli/handsfree.ts), so a relaunched short
 * mission could report "build complete — all ledger items done" having done
 * nothing at all.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  initLedger,
  markItem,
  loadLedger,
  saveLedger,
  isComplete,
  progress,
} from '../../src/delivery/completion-ledger.js';
import { singleEpicFor } from '../../src/delivery/decompose.js';
import { isEpicResume, type DeliverRunState } from '../../src/delivery/run-state.js';

const roots: string[] = [];
function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'uap-ledger-fresh-'));
  roots.push(root);
  return root;
}
afterEach(() => {
  while (roots.length) rmSync(roots.pop() as string, { recursive: true, force: true });
});

const MISSION = 'Add #[pg_extern] before fn join_by_i_time_sql';
const single = () => singleEpicFor(MISSION).map((p) => ({ id: p.id, title: p.title }));

describe('a fresh run starts its own ledger', () => {
  it('does NOT report a relaunched short mission as already complete', () => {
    const root = project();
    initLedger(root, MISSION, single());
    markItem(root, 'mission', 'done');

    const relaunch = initLedger(root, MISSION, single(), { carryPriorStatus: false });
    expect(relaunch.items[0]!.status).toBe('pending');
    expect(isComplete(relaunch), 'the hands-free Stop hook reads exactly this').toBe(false);
  });

  it('does not carry PARTIAL progress into a fresh multi-epic run either', () => {
    const root = project();
    const plan = [
      { id: 'p1', title: 'One' },
      { id: 'p2', title: 'Two' },
      { id: 'p3', title: 'Three' },
    ];
    initLedger(root, 'long mission', plan);
    markItem(root, 'p1', 'done');
    markItem(root, 'p2', 'done');

    const fresh = initLedger(root, 'long mission', plan, { carryPriorStatus: false });
    expect(fresh.items.map((i) => i.status)).toEqual(['pending', 'pending', 'pending']);
    expect(progress(fresh).done).toBe(0);
  });

  it('drops a stale note along with the stale status', () => {
    // A note explains a status. Carrying "failed: cargo build broke" onto a
    // pending item of a run that has not built anything is the same lie.
    const root = project();
    initLedger(root, MISSION, single());
    markItem(root, 'mission', 'failed', 'cargo build broke');
    const fresh = initLedger(root, MISSION, single(), { carryPriorStatus: false });
    expect(fresh.items[0]!.note).toBeUndefined();
  });

  it('starts the ledger clock now, rather than backdating to the run it replaced', () => {
    // Backdate the prior ledger by a day so "now" and "inherited" are far
    // apart — two calls in the same millisecond cannot tell them apart.
    const root = project();
    const first = initLedger(root, MISSION, single());
    const YESTERDAY = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    saveLedger(root, { ...first, createdAt: YESTERDAY });

    const fresh = initLedger(root, MISSION, single(), { carryPriorStatus: false });
    expect(fresh.createdAt).not.toBe(YESTERDAY);
    expect(Date.now() - Date.parse(fresh.createdAt)).toBeLessThan(60_000);
  });

  it('a carrying init keeps the original clock, so a resume reports true elapsed time', () => {
    // Separate root: the fresh init above rewrites the stored ledger, so the
    // two clocks cannot be observed on one.
    const root = project();
    const first = initLedger(root, MISSION, single());
    const YESTERDAY = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    saveLedger(root, { ...first, createdAt: YESTERDAY });

    const resumed = initLedger(root, MISSION, single(), { carryPriorStatus: true });
    expect(resumed.createdAt).toBe(YESTERDAY);
  });
});

describe('re-planning inside a run stays non-destructive', () => {
  it('carries status by default — this is what resume and mid-run re-planning need', () => {
    const root = project();
    initLedger(root, 'long mission', [
      { id: 'p1', title: 'One' },
      { id: 'p2', title: 'Two' },
    ]);
    markItem(root, 'p1', 'done');

    // Re-plan mid-run: p1 survives, p3 is new.
    const replanned = initLedger(root, 'long mission', [
      { id: 'p1', title: 'One' },
      { id: 'p3', title: 'Three' },
    ]);
    expect(replanned.items.find((i) => i.id === 'p1')!.status).toBe('done');
    expect(replanned.items.find((i) => i.id === 'p3')!.status).toBe('pending');
  });

  it('carries explicitly when asked, so resume keeps its marks', () => {
    const root = project();
    initLedger(root, MISSION, single());
    markItem(root, 'mission', 'done');
    const resumed = initLedger(root, MISSION, single(), { carryPriorStatus: true });
    expect(resumed.items[0]!.status).toBe('done');
    expect(isComplete(resumed)).toBe(true);
  });

  it('is a RESUME that carries, and nothing else — the one predicate deliver wires', () => {
    // deliver passes `carryPriorStatus: isEpicResume(resumeState)`, the same
    // predicate that seeds the plan, the done set and the phase summaries. The
    // four have to agree, so the answer lives in one place.
    const epic = { runnerKind: 'epic' } as Pick<DeliverRunState, 'runnerKind'>;
    const phased = { runnerKind: 'phased' } as Pick<DeliverRunState, 'runnerKind'>;
    expect(isEpicResume(epic)).toBe(true);
    expect(isEpicResume(phased), 'a phased run is not an epic resume').toBe(false);
    expect(isEpicResume(null), 'a FRESH run has no resume state').toBe(false);
    expect(isEpicResume(undefined)).toBe(false);
    expect(isEpicResume({} as Pick<DeliverRunState, 'runnerKind'>)).toBe(false);
  });

  it('persists what it returns — the next reader sees the same ledger', () => {
    const root = project();
    initLedger(root, MISSION, single());
    markItem(root, 'mission', 'done');
    initLedger(root, MISSION, single(), { carryPriorStatus: false });
    expect(loadLedger(root)!.items[0]!.status).toBe('pending');
  });
});
