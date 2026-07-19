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

describe('structured budget signal (EpicRunResult.budgetStopped)', () => {
  it('the split fires on budgetStopped WITHOUT the marker substring in the summary', async () => {
    const { runEpics } = await import('../../src/delivery/epic-controller.js');
    const splitGoals: string[] = [];
    const result = await runEpics({
      mission: 'm',
      epics: [{ id: 'big', title: 'Big', goal: 'g' }],
      maxAttemptsPerEpic: 1,
      splitDepth: 1,
      splitEpic: async (epic) => {
        splitGoals.push(epic.id);
        return [
          { id: 'p1', title: 'P1', goal: 'g1' },
          { id: 'p2', title: 'P2', goal: 'g2' },
        ];
      },
      runEpic: async (epic) =>
        epic.id === 'big'
          ? { success: false, summary: 'clean summary, no marker', turns: 1, budgetStopped: true }
          : { success: true, summary: `${epic.id} done`, turns: 1 },
    });
    expect(splitGoals).toEqual(['big']); // structured field triggered the split
    expect(result.success).toBe(true);
  });
});


describe('runEpics — onProgress persistence hook + resume skip', () => {
  it('fires with CUMULATIVE progress (summaries + done ids) after each accepted epic, never on failures', async () => {
    const snapshots: Array<{ summaries: string[]; completed: string[] }> = [];
    const res = await runEpics({
      mission: 'm',
      epics: [
        { id: 'a', title: 'A', goal: 'a' },
        { id: 'bad', title: 'Bad', goal: 'b' },
        { id: 'c', title: 'C', goal: 'c' },
      ],
      maxAttemptsPerEpic: 1,
      runEpic: async (epic) =>
        epic.id === 'bad' ? fail('nope') : ok(`${epic.id} done`),
      onProgress: (progress) => snapshots.push(progress),
    });
    expect(res.success).toBe(false);
    expect(snapshots).toHaveLength(2); // a and c only
    expect(snapshots[0].completed).toEqual(['a']);
    expect(snapshots[1].completed).toEqual(['a', 'c']);
    expect(snapshots[1].summaries[0]).toContain('A: a done');
    expect(snapshots[1].summaries[1]).toContain('C: c done');
  });

  it('initialDone epics are SKIPPED (0 attempts, accepted) and unblock their dependents', async () => {
    const ran: string[] = [];
    const outcomes: Array<{ epicId: string; accepted: boolean; attempts: number }> = [];
    const res = await runEpics({
      mission: 'm',
      epics: [
        { id: 'auth', title: 'Auth', goal: 'a' },
        { id: 'ui', title: 'UI', goal: 'u', deps: ['auth'] },
      ],
      initialDone: ['auth'],
      initialPriorSummaries: ['Auth: login shipped'],
      runEpic: async (epic, ctx) => {
        ran.push(epic.id);
        expect(ctx.priorSummaries).toContain('Auth: login shipped');
        return ok(`${epic.id} done`);
      },
      onEpic: (_e, o) => outcomes.push({ epicId: o.epicId, accepted: o.accepted, attempts: o.attempts }),
    });
    expect(res.success).toBe(true);
    expect(ran).toEqual(['ui']); // auth never re-run
    expect(outcomes[0]).toEqual({ epicId: 'auth', accepted: true, attempts: 0 });
    expect(res.completed.sort()).toEqual(['auth', 'ui']);
  });

  it('a skipped epic emits NO onProgress push (its summary already rode in as a prior)', async () => {
    const snapshots: Array<{ completed: string[] }> = [];
    await runEpics({
      mission: 'm',
      epics: [{ id: 'done-one', title: 'D', goal: 'd' }],
      initialDone: ['done-one'],
      runEpic: async () => ok('never runs'),
      onProgress: (p) => snapshots.push(p),
    });
    expect(snapshots).toHaveLength(0);
  });

  it('seeds from initialPriorSummaries — a resumed mission persists priors + new completions', async () => {
    const snapshots: Array<{ summaries: string[] }> = [];
    await runEpics({
      mission: 'm',
      epics: [{ id: 'next', title: 'Next', goal: 'n' }],
      initialPriorSummaries: ['Done-before: earlier epic'],
      runEpic: async (epic, ctx) => {
        expect(ctx.priorSummaries).toContain('Done-before: earlier epic');
        return ok(`${epic.id} done`);
      },
      onProgress: (p) => snapshots.push(p),
    });
    expect(snapshots[0].summaries).toEqual(['Done-before: earlier epic', expect.stringContaining('Next:')]);
  });

  it('is NOT forwarded through split recursion — persisted progress stays at epic granularity', async () => {
    const snapshots: Array<{ summaries: string[]; completed: string[] }> = [];
    const res = await runEpics({
      mission: 'm',
      epics: [{ id: 'big', title: 'Big', goal: 'huge' }],
      maxAttemptsPerEpic: 1,
      splitDepth: 1,
      runEpic: async (epic) =>
        epic.id === 'big'
          ? { success: false, summary: 'over', turns: 1, budgetStopped: true }
          : ok(`${epic.id} done`),
      splitEpic: async () => [
        { id: 'p1', title: 'P1', goal: 'part 1' },
        { id: 'p2', title: 'P2', goal: 'part 2' },
      ],
      onProgress: (p) => snapshots.push(p),
    });
    expect(res.success).toBe(true);
    // Two sub-epics completed inside the recursion but only the PARENT epic
    // pushed a persisted snapshot (one call, parent id only).
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].completed).toEqual(['big']);
  });
});

describe('runEpics: prior-changes state (anti-no-op rail)', () => {
  const saveFlag = () => {
    const prev = process.env.UAP_EPIC_PRIOR_CHANGES;
    delete process.env.UAP_EPIC_PRIOR_CHANGES;
    return () => {
      if (prev === undefined) delete process.env.UAP_EPIC_PRIOR_CHANGES;
      else process.env.UAP_EPIC_PRIOR_CHANGES = prev;
    };
  };

  it('seeds UAP_EPIC_PRIOR_CHANGES from initialPriorChanged so a fresh controller can inherit prior work', async () => {
    const restore = saveFlag();
    const seen: Array<string | undefined> = [];
    try {
      await runEpics({
        mission: 'm',
        epics: [{ id: 'a', title: 'A', goal: 'g' }],
        initialPriorChanged: true,
        runEpic: async () => {
          seen.push(process.env.UAP_EPIC_PRIOR_CHANGES);
          return ok('done');
        },
      });
    } finally {
      restore();
    }
    expect(seen).toEqual(['1']);
  });

  it('sub-epic recursion inherits the parent prior-changes state instead of clobbering it to 0', async () => {
    const restore = saveFlag();
    const flags: Record<string, string | undefined> = {};
    try {
      await runEpics({
        mission: 'm',
        epics: [
          { id: 'first', title: 'First', goal: 'g' },
          { id: 'second', title: 'Second', goal: 'g' },
        ],
        maxAttemptsPerEpic: 1,
        splitOnAnyFailure: true,
        splitEpic: async () => [
          { id: 'sub1', title: 'Sub 1', goal: 'g' },
          { id: 'sub2', title: 'Sub 2', goal: 'g' },
        ],
        runEpic: async (epic) => {
          flags[epic.id] = process.env.UAP_EPIC_PRIOR_CHANGES;
          if (epic.id === 'second') return fail('cannot deliver whole');
          return ok(`${epic.id} done`);
        },
      });
    } finally {
      restore();
    }
    expect(flags['first']).toBe('0'); // nothing accepted yet
    expect(flags['second']).toBe('1'); // first epic accepted
    // The regression: the recursive runEpics call recomputed prior-changes from
    // its own empty outcome list, so sub-epics of a trailing epic saw '0' and
    // the anti-no-op rail withheld acceptance on already-satisfied goals.
    expect(flags['second.sub1']).toBe('1');
    expect(flags['second.sub2']).toBe('1');
  });
});

describe('runEpics: finality seeding (initialNonFinal) + env exception-safety', () => {
  const saveEnv = () => {
    const prevNF = process.env.UAP_EPIC_NONFINAL;
    const prevPC = process.env.UAP_EPIC_PRIOR_CHANGES;
    delete process.env.UAP_EPIC_NONFINAL;
    delete process.env.UAP_EPIC_PRIOR_CHANGES;
    return () => {
      if (prevNF === undefined) delete process.env.UAP_EPIC_NONFINAL;
      else process.env.UAP_EPIC_NONFINAL = prevNF;
      if (prevPC === undefined) delete process.env.UAP_EPIC_PRIOR_CHANGES;
      else process.env.UAP_EPIC_PRIOR_CHANGES = prevPC;
    };
  };

  it('initialNonFinal marks EVERY epic non-final, including the last', async () => {
    const restore = saveEnv();
    const flags: Record<string, string | undefined> = {};
    try {
      await runEpics({
        mission: 'm',
        epics: [
          { id: 'a', title: 'A', goal: 'g' },
          { id: 'b', title: 'B', goal: 'g' },
        ],
        initialNonFinal: true,
        runEpic: async (epic) => {
          flags[epic.id] = process.env.UAP_EPIC_NONFINAL;
          return ok(`${epic.id} done`);
        },
      });
    } finally {
      restore();
    }
    expect(flags['a']).toBe('1');
    expect(flags['b']).toBe('1'); // last epic, but the parent is non-final
  });

  it('split recursion: sub-epics of a NON-final parent are all non-final; final parent keeps its last sub-epic final', async () => {
    const restore = saveEnv();
    const flags: Record<string, string | undefined> = {};
    try {
      await runEpics({
        mission: 'm',
        epics: [
          { id: 'mid', title: 'Mid', goal: 'g' }, // non-final parent — will split
          { id: 'last', title: 'Last', goal: 'g' }, // final parent — will split
        ],
        maxAttemptsPerEpic: 1,
        splitOnAnyFailure: true,
        splitEpic: async () => [
          { id: 's1', title: 'S1', goal: 'g' },
          { id: 's2', title: 'S2', goal: 'g' },
        ],
        runEpic: async (epic) => {
          flags[epic.id] = process.env.UAP_EPIC_NONFINAL;
          // both top-level epics fail so both split; sub-epics succeed
          return epic.id === 'mid' || epic.id === 'last' ? fail('split me') : ok('done');
        },
      });
    } finally {
      restore();
    }
    // Sub-epics of the NON-final parent must ALL be non-final — before the fix
    // the child run computed finality from its own ordering and ran the
    // whole-mission gates on 'mid.s2', mid-mission.
    expect(flags['mid.s1']).toBe('1');
    expect(flags['mid.s2']).toBe('1');
    // The FINAL parent's last sub-epic still runs the whole-mission gates.
    expect(flags['last.s1']).toBe('1');
    expect(flags['last.s2']).toBe('0');
  });

  it('a throwing runEpic no longer leaks the epic env flags (try/finally restore)', async () => {
    const restore = saveEnv();
    try {
      process.env.UAP_EPIC_NONFINAL = 'ambient-nf';
      process.env.UAP_EPIC_PRIOR_CHANGES = 'ambient-pc';
      await expect(
        runEpics({
          mission: 'm',
          epics: [{ id: 'boom', title: 'Boom', goal: 'g' }],
          runEpic: async () => {
            throw new Error('executor crashed');
          },
        })
      ).rejects.toThrow('executor crashed');
      expect(process.env.UAP_EPIC_NONFINAL).toBe('ambient-nf');
      expect(process.env.UAP_EPIC_PRIOR_CHANGES).toBe('ambient-pc');
    } finally {
      restore();
    }
  });
});

describe('runEpics: prior-ATTEMPT changes stand the anti-no-op rail down on retries', () => {
  const saveFlag = () => {
    const prev = process.env.UAP_EPIC_PRIOR_CHANGES;
    delete process.env.UAP_EPIC_PRIOR_CHANGES;
    return () => {
      if (prev === undefined) delete process.env.UAP_EPIC_PRIOR_CHANGES;
      else process.env.UAP_EPIC_PRIOR_CHANGES = prev;
    };
  };

  it('a failed first attempt that WROTE files flips the flag for attempt 2 (first epic, no prior epics)', async () => {
    const restore = saveFlag();
    const perAttempt: Array<string | undefined> = [];
    try {
      await runEpics({
        mission: 'm',
        epics: [{ id: 'first', title: 'First', goal: 'g' }],
        maxAttemptsPerEpic: 3,
        runEpic: async (_epic, ctx) => {
          perAttempt.push(process.env.UAP_EPIC_PRIOR_CHANGES);
          // attempt 1 writes but is not accepted; attempt 2 zero-diffs and passes
          if (ctx.attempt === 1) return { success: false, summary: 'wrote 11 files, judge rejected', turns: 5, changedTree: true };
          return ok('accepted on retry');
        },
      });
    } finally {
      restore();
    }
    expect(perAttempt[0]).toBe('0'); // truly nothing before attempt 1
    expect(perAttempt[1]).toBe('1'); // attempt 1's writes count — rail stands down, judge decides
  });

  it('sub-epics inherit prior-ATTEMPT changes when the parent wrote before splitting', async () => {
    const restore = saveFlag();
    const flags: Record<string, string | undefined> = {};
    try {
      await runEpics({
        mission: 'm',
        epics: [{ id: 'solo', title: 'Solo', goal: 'g' }],
        maxAttemptsPerEpic: 1,
        splitOnAnyFailure: true,
        splitEpic: async () => [
          { id: 's1', title: 'S1', goal: 'g' },
          { id: 's2', title: 'S2', goal: 'g' },
        ],
        runEpic: async (epic) => {
          flags[epic.id] = process.env.UAP_EPIC_PRIOR_CHANGES;
          if (epic.id === 'solo') return { success: false, summary: 'wrote then failed', turns: 5, changedTree: true };
          return ok('done');
        },
      });
    } finally {
      restore();
    }
    expect(flags['solo']).toBe('0');
    // Before the fix these saw '0' (no ACCEPTED epic) despite the parent's real writes.
    expect(flags['solo.s1']).toBe('1');
    expect(flags['solo.s2']).toBe('1');
  });
});

describe('runEpics — P1 contract carry + lint', () => {
  const okr = (s: string): EpicRunResult => ({ success: true, summary: s, turns: 1 });

  it('injects the shared contract VERBATIM into every epic run', async () => {
    const seen: Array<string | undefined> = [];
    const CONTRACT = 'CONFIG.player.width:number; class Audio { play(): void }';
    await runEpics({
      mission: 'm',
      epics: [
        { id: 'a', title: 'A', goal: 'a' },
        { id: 'b', title: 'B', goal: 'b', deps: ['a'] },
      ],
      readContract: () => CONTRACT,
      runEpic: async (_e, ctx) => { seen.push(ctx.contract); return okr('done'); },
    });
    expect(seen).toEqual([CONTRACT, CONTRACT]); // verbatim, not a summary, to every epic
  });

  it('contract-lint violations fail the epic and are fed back; a clean re-run is accepted', async () => {
    let attempt = 0;
    const failures: Array<string | undefined> = [];
    const res = await runEpics({
      mission: 'm',
      epics: [{ id: 'a', title: 'A', goal: 'a' }],
      readContract: () => 'CONTRACT',
      runEpic: async (_e, ctx) => { attempt++; failures.push(ctx.lastFailure); return okr(`attempt ${attempt}`); },
      contractLint: () => (attempt === 1 ? ['references undefined CONFIG.foo'] : []),
    });
    expect(attempt).toBe(2);
    expect(res.completed).toContain('a');
    expect(failures[1]).toMatch(/contract violations/);
  });

  it('no readContract/contractLint => contract undefined, behavior unchanged', async () => {
    const seen: Array<string | undefined> = [];
    const res = await runEpics({
      mission: 'm',
      epics: [{ id: 'a', title: 'A', goal: 'a' }],
      runEpic: async (_e, ctx) => { seen.push(ctx.contract); return okr('done'); },
    });
    expect(seen).toEqual([undefined]);
    expect(res.completed).toContain('a');
  });

  it('a throwing contractLint is fail-soft (does not block acceptance)', async () => {
    const res = await runEpics({
      mission: 'm',
      epics: [{ id: 'a', title: 'A', goal: 'a' }],
      readContract: () => 'CONTRACT',
      runEpic: async () => okr('done'),
      contractLint: () => { throw new Error('linter broke'); },
    });
    expect(res.completed).toContain('a');
  });
});
