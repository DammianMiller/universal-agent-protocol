/**
 * A cooperative stop could not stop an epic mission.
 *
 * `shouldStop` existed on the convergence loop and was checked per TURN.
 * Nothing on the epic path ever consulted it — `grep -c shouldStop` in
 * epic-controller.ts and epic-mission.ts both returned 0 — so a mission that
 * completes EPICS without completing turns never reached the check at all.
 *
 * Measured live on 2026-08-12: a 16-epic run at a gateless root was sent two
 * `touch .uap/deliver-runs/STOP` requests. Both markers were consumed. The run
 * carried on from epic 9 to epic 13, writing Rust that did not compile.
 *
 * That is worse than an inconvenience. The cooperative stop is the alternative
 * the kill-guard names — "to STOP a run and KEEP the work, request the
 * cooperative stop" — so with this unchecked, an operator watching an epic
 * mission produce nothing had no sanctioned way to end it.
 */
import { describe, it, expect } from 'vitest';
import { runEpics, type Epic, type EpicRunResult } from '../../src/delivery/epic-controller.js';
import { makeStopLatch } from '../../src/delivery/run-state.js';

const epic = (id: string, over: Partial<Epic> = {}): Epic => ({
  id,
  title: id,
  goal: `deliver ${id}`,
  ...over,
});

const ok = (over: Partial<EpicRunResult> = {}): EpicRunResult =>
  ({ success: true, turns: 1, summary: 'done', ...over }) as EpicRunResult;

function base(over: Partial<Parameters<typeof runEpics>[0]> = {}) {
  return {
    mission: 'build the thing',
    epics: [epic('a'), epic('b'), epic('c')],
    runEpic: async () => ok(),
    maxAttemptsPerEpic: 1,
    splitDepth: 0,
    splitOnAnyFailure: false,
    ...over,
  } as Parameters<typeof runEpics>[0];
}

describe('the epic controller honours a cooperative stop', () => {
  it('stops BETWEEN epics instead of running them all', async () => {
    const ran: string[] = [];
    const r = await runEpics(base({
      runEpic: async (e) => { ran.push(e.id); return ok(); },
      shouldStop: () => ran.length >= 1,   // stop after the first epic finishes
    }));
    expect(ran, 'the second epic must never start').toEqual(['a']);
    expect(r.stopped).toBe(true);
  });

  it('stops even when the stop signal is ONE-SHOT', async () => {
    // The project-level stop file is CONSUMED the moment it is observed, so a
    // shouldStop wired straight to it answers true exactly once. The epic that
    // saw it ends, the controller asks again for the next epic, the file is
    // gone, and the run carries on — measured live 2026-08-12, turn counter
    // back at 1 on a fresh epic. The caller must hand in a LATCHED signal.
    const ran: string[] = [];
    let reads = 0;
    const oneShot = () => ++reads === 1;
    const r = await runEpics(base({
      runEpic: async (e) => { ran.push(e.id); return ok(); },
      shouldStop: makeStopLatch(oneShot),
    }));
    expect(ran, 'nothing may run after a stop, however briefly the flag was up').toEqual([]);
    expect(r.stopped).toBe(true);
  });

  it('does NOT report success for a run it cut short', async () => {
    // Reporting success would tell the caller the mission is finished when
    // most of it was never attempted — the failure this whole subsystem exists
    // to avoid, in reverse.
    const r = await runEpics(base({ shouldStop: () => true }));
    expect(r.success).toBe(false);
    expect(r.stopped).toBe(true);
    expect(r.completed).toEqual([]);
  });

  it('keeps the work already accepted', async () => {
    const r = await runEpics(base({
      epics: [epic('a'), epic('b'), epic('c')],
      runEpic: async () => ok(),
      shouldStop: () => false,
    }));
    expect(r.completed).toEqual(['a', 'b', 'c']);
    expect(r.stopped).toBeUndefined();
    expect(r.success).toBe(true);
  });

  it('honours a stop even while REPLAYING already-accepted epics on resume', async () => {
    // The resume path skips accepted epics without calling runEpic. Checking
    // after that skip would make a stop wait for the first unfinished epic —
    // on a long resume, indistinguishable from being ignored.
    let calls = 0;
    const r = await runEpics(base({
      epics: [epic('a'), epic('b'), epic('c')],
      initialDone: ['a', 'b'],
      runEpic: async () => { calls += 1; return ok(); },
      shouldStop: () => true,
    }));
    expect(calls, 'nothing should have been executed').toBe(0);
    expect(r.stopped).toBe(true);
  });

  it('runs normally when no stop hook is supplied at all', async () => {
    const r = await runEpics(base());
    expect(r.success).toBe(true);
    expect(r.completed).toHaveLength(3);
  });

  it('asks the hook again for each epic rather than caching the first answer', async () => {
    // A stop requested mid-mission has to take effect at the NEXT boundary.
    let asked = 0;
    const ran: string[] = [];
    await runEpics(base({
      epics: [epic('a'), epic('b'), epic('c'), epic('d')],
      runEpic: async (e) => { ran.push(e.id); return ok(); },
      shouldStop: () => { asked += 1; return asked > 2; },
    }));
    expect(ran).toEqual(['a', 'b']);
    expect(asked).toBeGreaterThan(2);
  });
});
