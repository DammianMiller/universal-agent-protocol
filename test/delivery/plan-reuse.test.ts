/**
 * Same instruction, same project, recent — same plan.
 *
 * Planning is a model call, so a relaunch re-plans and gets something
 * different every time. Measured over four hours in `cognition-engine` on
 * 2026-08-11, while the agent relaunched near-identical instructions after
 * killing each run:
 *
 *   "Add pgrx bindings for join_by_i_sql … to lib.rs"     (68 chars)  ->  5 phases
 *   "Add pgrx bindings for join_by_i_sql … to lib.rs - …" (121 chars) ->  0 phases
 *   "Create …setup_optimizations.sql with 4 functions"    (74 chars)  ->  0 phases
 *   "Create …setup_optimizations.sql with 4 functions …"  (130 chars) ->  8 phases
 *
 * Resume already refuses to replan, because "replanning would mint new epic
 * ids … and draw new boundaries over already-built work". A relaunch of the
 * same instruction has the same problem and had no equivalent protection.
 *
 * Scope, stated up front: every instruction above is under 200 characters, and
 * those no longer reach the planner at all — `shouldPlanEpicPhases` runs them
 * as one epic. Replayed against the corpus this was built from, reuse fires
 * ZERO times. What is left is the expensive version of the same failure: a
 * relaunch storm on a LONG mission, where redrawing a 10-phase plan costs far
 * more than a 2-phase one. The last describe block pins that ordering, because
 * a reuse lookup on a short mission would be pure overhead.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  instructionKey,
  planReuseDisabled,
  planReuseNotice,
  planWithReuse,
  reusablePlan,
  PLAN_REUSE_MAX_AGE_MS,
  PLAN_REUSE_OFF_ENV,
} from '../../src/delivery/plan-reuse.js';
import {
  resolveEpicPlan,
  singleEpicFor,
  AUTO_DECOMPOSE_MIN_CHARS,
} from '../../src/delivery/decompose.js';

const roots: string[] = [];
function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'uap-planreuse-'));
  roots.push(root);
  mkdirSync(join(root, '.uap', 'deliver-runs'), { recursive: true });
  return root;
}
afterEach(() => {
  while (roots.length) rmSync(roots.pop() as string, { recursive: true, force: true });
});

const PHASES = [
  { id: 'p1', title: 'one', goal: 'g' },
  { id: 'p2', title: 'two', goal: 'g' },
];

/** A prior run, as run-state on disk. */
function priorRun(
  root: string,
  runId: string,
  instruction: string,
  over: Record<string, unknown> = {}
): void {
  const dir = join(root, '.uap', 'deliver-runs', runId);
  mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(
    join(dir, 'state.json'),
    JSON.stringify({
      runId,
      instruction,
      presetId: 'p',
      projectRoot: root,
      status: 'running',
      runnerKind: 'epic',
      createdAt: now,
      updatedAt: now,
      phases: PHASES,
      ...over,
    })
  );
}

const TASK = 'Add pgrx bindings for join_by_i_sql and join_by_i_time_sql to lib.rs';

describe('reusablePlan', () => {
  it('carries the plan over for an identical instruction', () => {
    const root = project();
    priorRun(root, 'run-20260811T000000-aaaaaa', TASK);
    const got = reusablePlan(root, TASK);
    expect(got?.phases).toEqual(PHASES);
    expect(got?.fromRunId).toBe('run-20260811T000000-aaaaaa');
  });

  it('ignores trailing whitespace, which is not a different mission', () => {
    const root = project();
    priorRun(root, 'run-20260811T000000-aaaaaa', TASK);
    expect(reusablePlan(root, `  ${TASK}\n`)?.phases).toEqual(PHASES);
  });

  it('does NOT reuse across a reworded instruction', () => {
    // The pathology was the caller rewording and getting a different plan — but
    // a reworded mission IS a different question, and silently answering it
    // with the old plan would be worse than replanning.
    const root = project();
    priorRun(root, 'run-20260811T000000-aaaaaa', TASK);
    expect(reusablePlan(root, TASK + ' - these functions already exist')).toBeNull();
  });

  it('does NOT reuse an EMPTY plan', () => {
    // A zero-phase run is the planner having produced nothing. Reusing that
    // would make "no phases" permanent for that instruction — the exact
    // failure this must not manufacture.
    const root = project();
    priorRun(root, 'run-20260811T000000-aaaaaa', TASK, { phases: [] });
    expect(reusablePlan(root, TASK)).toBeNull();
  });

  it('does NOT reuse a ONE-phase plan, which is how a planner failure lands', () => {
    // A planner that produced nothing does not reach disk as []: the epic
    // runner reshapes a degenerate plan into the single `mission` epic BEFORE
    // persisting. So the failure to guard against is one phase, not zero —
    // otherwise a planner failure is cached for the whole window and the notice
    // announces "1 phase carried over" as though a plan had been carried.
    const root = project();
    priorRun(root, 'run-20260811T000000-aaaaaa', TASK, {
      phases: singleEpicFor(TASK),
    });
    expect(reusablePlan(root, TASK)).toBeNull();
  });

  it('does NOT reuse an ORCHESTRATED run, whose phases are a grown task DAG', () => {
    // The orchestrated path APPENDS discovered tasks to the same field as it
    // runs. Handing that to the epic controller would run every discovered
    // sub-task as a top-level epic with its own attempt budget and gates.
    const root = project();
    priorRun(root, 'run-20260811T000000-aaaaaa', TASK, { runnerKind: 'orchestrated' });
    expect(reusablePlan(root, TASK)).toBeNull();
  });

  it('does NOT reuse a plan from a FAILED run — the plan may be why it failed', () => {
    const root = project();
    priorRun(root, 'run-20260811T000000-aaaaaa', TASK, { status: 'failed' });
    expect(reusablePlan(root, TASK)).toBeNull();
  });

  it('DOES reuse from an interrupted run — that is the relaunch this exists for', () => {
    const root = project();
    priorRun(root, 'run-20260811T000000-aaaaaa', TASK, { status: 'interrupted' });
    expect(reusablePlan(root, TASK)?.phases).toEqual(PHASES);
  });

  it('ages a plan from when it was DRAWN, not from the run\'s last heartbeat', () => {
    // updatedAt is rewritten on every checkpoint, so a long-lived run would
    // make a day-old plan read as one minute old and the window would stop
    // bounding anything.
    const root = project();
    const drawn = new Date(Date.now() - PLAN_REUSE_MAX_AGE_MS - 60_000).toISOString();
    priorRun(root, 'run-20260811T000000-aaaaaa', TASK, {
      createdAt: drawn,
      updatedAt: new Date().toISOString(), // still checkpointing
    });
    expect(reusablePlan(root, TASK)).toBeNull();
  });

  it('matches an instruction longer than the persistence cap', () => {
    // saveRunState writes the instruction verbatim; readState truncates it at
    // MAX_INSTRUCTION_CHARS. Hashing raw text on one side and truncated text on
    // the other would make every mission over that cap silently unmatchable —
    // the longest missions, which is where a redraw costs the most.
    const root = project();
    const huge = 'Rebuild the extension end to end. ' + 'x'.repeat(9000);
    priorRun(root, 'run-20260811T000000-aaaaaa', huge);
    expect(reusablePlan(root, huge)?.phases).toEqual(PHASES);
  });

  it('does NOT reuse a plan older than the window', () => {
    const root = project();
    const old = new Date(Date.now() - PLAN_REUSE_MAX_AGE_MS - 60_000).toISOString();
    priorRun(root, 'run-20260811T000000-aaaaaa', TASK, { createdAt: old, updatedAt: old });
    expect(reusablePlan(root, TASK)).toBeNull();
  });

  it('does NOT reuse a plan stamped in the future', () => {
    // A planted or skewed clock is not a fresh plan.
    const root = project();
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    priorRun(root, 'run-20260811T000000-aaaaaa', TASK, { createdAt: future, updatedAt: future });
    expect(reusablePlan(root, TASK)).toBeNull();
  });

  it('takes the NEWEST matching plan when several exist', () => {
    const root = project();
    const older = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    priorRun(root, 'run-20260811T000000-old', TASK, {
      createdAt: older, updatedAt: older,
      phases: [{ id: 'stale', title: 'stale', goal: 'g' }],
    });
    priorRun(root, 'run-20260811T010000-new', TASK);
    expect(reusablePlan(root, TASK)?.fromRunId).toBe('run-20260811T010000-new');
  });

  it('picks the newest even when the runs arrive OUT of order', () => {
    // reusablePlan takes an injectable runs array, so it must not lean on the
    // caller's ordering. listRuns happens to sort newest-first, which made a
    // mutant that took the first match indistinguishable — this passes them
    // oldest-first so the comparison is what decides.
    const now = Date.now();
    const mk = (runId: string, ageMs: number, phases: unknown[]) => ({
      runId,
      instruction: TASK,
      presetId: 'p',
      projectRoot: '/x',
      status: 'running' as const,
      runnerKind: 'epic' as const,
      createdAt: new Date(now - ageMs).toISOString(),
      updatedAt: new Date(now - ageMs).toISOString(),
      phases,
    });
    // Every decoy must itself be REUSABLE (>= 2 phases, epic, not failed),
    // otherwise a filter silently leaves one candidate and "take the first
    // match" becomes indistinguishable from "take the newest" again.
    const two = (tag: string) => [
      { id: `${tag}1`, title: tag, goal: 'g' },
      { id: `${tag}2`, title: tag, goal: 'g' },
    ];
    const unsorted = [
      mk('run-oldest', 3 * 60 * 60 * 1000, two('stale')),
      mk('run-newest', 60 * 1000, PHASES),
      mk('run-middle', 60 * 60 * 1000, two('mid')),
    ];
    const got = reusablePlan('/x', TASK, now, unsorted as never);
    expect(got?.fromRunId).toBe('run-newest');
    expect(got?.phases).toEqual(PHASES);
  });

  it('returns null in a project with no runs at all', () => {
    expect(reusablePlan(project(), TASK)).toBeNull();
  });
});

describe('the switch and the notice', () => {
  it('is off by default, so reuse is the behaviour unless asked otherwise', () => {
    expect(planReuseDisabled({})).toBe(false);
  });

  it('honours the documented spellings, and nothing else', () => {
    for (const v of ['1', 'true', 'on', 'yes']) {
      expect(planReuseDisabled({ [PLAN_REUSE_OFF_ENV]: v }), v).toBe(true);
    }
    for (const v of ['0', 'false', 'off', '', 'maybe']) {
      expect(planReuseDisabled({ [PLAN_REUSE_OFF_ENV]: v }), v).toBe(false);
    }
  });

  it('never reuses silently — the notice names the source and the escape', () => {
    const n = planReuseNotice('run-20260811T000000-aaaaaa', 2);
    expect(n).toContain('run-20260811T000000-aaaaaa');
    expect(n).toContain('2 phases');
    expect(n).toContain(PLAN_REUSE_OFF_ENV);
  });

  it('says "1 phase", not "1 phases"', () => {
    expect(planReuseNotice('run-x', 1)).toContain('1 phase ');
  });
});

describe('instructionKey', () => {
  it('is stable for the same text and different for different text', () => {
    expect(instructionKey(TASK)).toBe(instructionKey(TASK));
    expect(instructionKey(TASK)).not.toBe(instructionKey(TASK + '!'));
  });
});

describe('planWithReuse — the composition deliver actually wires', () => {
  const FRESH = [
    { id: 'f1', title: 'Fresh one', goal: 'g' },
    { id: 'f2', title: 'Fresh two', goal: 'g' },
  ];

  it('reuses INSTEAD of planning, not after it', async () => {
    const root = project();
    priorRun(root, 'run-20260811T000000-aaaaaa', TASK);
    let planned = 0;
    const phases = await planWithReuse(root, TASK, async () => { planned += 1; return FRESH; });
    expect(planned, 'the planning call is the cost being avoided').toBe(0);
    expect(phases).toEqual(PHASES);
  });

  it('plans when there is nothing to reuse', async () => {
    let planned = 0;
    const phases = await planWithReuse(project(), TASK, async () => { planned += 1; return FRESH; });
    expect(planned).toBe(1);
    expect(phases).toEqual(FRESH);
  });

  it('plans when the switch is off, and says nothing', async () => {
    const root = project();
    priorRun(root, 'run-20260811T000000-aaaaaa', TASK);
    const notices: string[] = [];
    const phases = await planWithReuse(
      root, TASK, async () => FRESH, (n) => notices.push(n),
      { [PLAN_REUSE_OFF_ENV]: '1' }
    );
    expect(phases).toEqual(FRESH);
    expect(notices).toEqual([]);
  });

  it('never reuses silently', async () => {
    const root = project();
    priorRun(root, 'run-20260811T000000-aaaaaa', TASK);
    const notices: string[] = [];
    await planWithReuse(root, TASK, async () => FRESH, (n) => notices.push(n));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('run-20260811T000000-aaaaaa');
  });

  it('lets a planner failure surface rather than degrading silently', async () => {
    await expect(
      planWithReuse(project(), TASK, async () => { throw new Error('planner exploded'); })
    ).rejects.toThrow('planner exploded');
  });

  it('is never reached for a mission short enough to skip planning', async () => {
    // deliver passes planWithReuse as resolveEpicPlan's planner, so a short
    // mission short-circuits first. Reuse walks every persisted run — wasted
    // work for a mission that was never going to be planned.
    const root = project();
    priorRun(root, 'run-20260811T000000-aaaaaa', 'short one');
    let lookups = 0;
    const phases = await resolveEpicPlan('short one', () =>
      planWithReuse(root, 'short one', async () => FRESH, () => { lookups += 1; })
    );
    expect(lookups).toBe(0);
    expect(phases).toEqual(singleEpicFor('short one'));
  });
});
