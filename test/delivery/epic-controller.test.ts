/**
 * Epic controller (P7): the outer loop that runs each epic as a fresh mission,
 * injecting only prior epics' summaries, and loops with fresh sessions
 * (retries) until an epic is accepted or the attempt budget is spent.
 */
import { describe, it, expect } from 'vitest';
import { runEpics, type Epic, type EpicRunResult } from '../../src/delivery/epic-controller.js';

const ok = (summary: string, turns = 1): EpicRunResult => ({ success: true, summary, turns });
const fail = (summary: string, turns = 1): EpicRunResult => ({ success: false, summary, turns });

describe('runEpics', () => {
  it('runs epics in dependency order, injecting only prior summaries into each fresh run', async () => {
    const seen: Array<{ id: string; priors: string[] }> = [];
    const epics: Epic[] = [
      { id: 'build', title: 'Build', goal: 'build it', deps: ['design'] },
      { id: 'design', title: 'Design', goal: 'design it' },
      { id: 'ship', title: 'Ship', goal: 'ship it', deps: ['build'] },
    ];
    const res = await runEpics({
      mission: 'make the thing',
      epics,
      runEpic: async (epic, ctx) => {
        seen.push({ id: epic.id, priors: ctx.priorSummaries });
        return ok(`${epic.id} done`);
      },
    });
    expect(res.success).toBe(true);
    expect(seen.map((s) => s.id)).toEqual(['design', 'build', 'ship']);
    // design sees nothing; build sees design; ship sees design + build
    expect(seen[0].priors).toEqual([]);
    expect(seen[1].priors.some((p) => p.includes('Design'))).toBe(true);
    expect(seen[2].priors.length).toBe(2);
  });

  it('retries a failing epic with a fresh session, feeding back the last failure, until it passes', async () => {
    const attemptsFor: Record<string, number> = {};
    const failuresSeen: string[] = [];
    const res = await runEpics({
      mission: 'm',
      epics: [{ id: 'e', title: 'E', goal: 'g' }],
      maxAttemptsPerEpic: 3,
      runEpic: async (epic, ctx) => {
        attemptsFor[epic.id] = ctx.attempt;
        if (ctx.lastFailure) failuresSeen.push(ctx.lastFailure);
        // fail the first two attempts, pass the third
        return ctx.attempt < 3 ? fail(`broke on ${ctx.attempt}`) : ok('fixed');
      },
    });
    expect(res.success).toBe(true);
    expect(attemptsFor.e).toBe(3);
    expect(failuresSeen.length).toBe(2); // attempts 2 and 3 saw prior failure
    expect(failuresSeen[0]).toContain('failed to deliver');
  });

  it('declares an epic failed after exhausting the attempt budget and skips its dependents', async () => {
    const ran: string[] = [];
    const res = await runEpics({
      mission: 'm',
      epics: [
        { id: 'core', title: 'Core', goal: 'g' },
        { id: 'ext', title: 'Ext', goal: 'g', deps: ['core'] },
      ],
      maxAttemptsPerEpic: 2,
      runEpic: async (epic) => {
        ran.push(epic.id);
        return fail('always broken');
      },
    });
    expect(res.success).toBe(false);
    expect(res.failed).toContain('core');
    expect(res.failed).toContain('ext');
    // core attempted twice; ext never ran (dependency failed)
    expect(ran).toEqual(['core', 'core']);
  });

  it('treats a delivered-but-not-accepted run as not done and retries (Generator≠Evaluator)', async () => {
    let calls = 0;
    const res = await runEpics({
      mission: 'm',
      epics: [{ id: 'e', title: 'E', goal: 'g' }],
      maxAttemptsPerEpic: 2,
      runEpic: async () => {
        calls++;
        return ok('delivered');
      },
      // first attempt rejected by the judge, second accepted
      checkAcceptance: () => calls >= 2,
    });
    expect(res.success).toBe(true);
    expect(calls).toBe(2);
  });

  it('fail-soft: a throwing acceptance check is treated as not accepted (retry, never wedge)', async () => {
    let calls = 0;
    const res = await runEpics({
      mission: 'm',
      epics: [{ id: 'e', title: 'E', goal: 'g' }],
      maxAttemptsPerEpic: 2,
      runEpic: async () => { calls++; return ok('delivered'); },
      checkAcceptance: () => { throw new Error('judge down'); },
    });
    expect(res.success).toBe(false); // never accepted
    expect(calls).toBe(2); // but it retried the full budget rather than crashing
  });

  it('(#4b) defaults to 3 fresh-session attempts per epic', async () => {
    let calls = 0;
    const res = await runEpics({
      mission: 'm',
      epics: [{ id: 'e', title: 'E', goal: 'g' }],
      // no maxAttemptsPerEpic → default
      runEpic: async () => { calls++; return fail('nope'); },
    });
    expect(calls).toBe(3);
    expect(res.success).toBe(false);
  });
});
