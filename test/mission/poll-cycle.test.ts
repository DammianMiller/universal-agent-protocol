/**
 * Poll-cycle decision core — the pure decision table for one active mission.
 * No I/O: every case feeds a PollView and asserts the returned actions.
 */

import { describe, it, expect } from 'vitest';
import {
  LAUNCH_GRACE_MS,
  STRUGGLE_THRESHOLD,
  backoffRemainingMs,
  decideMissionActions,
  type PollView,
} from '../../src/mission/poll-cycle.js';
import type { Mission } from '../../src/types/mission.js';
import type { DeliverRunState } from '../../src/delivery/run-state.js';

function mission(over: Partial<Mission> = {}): Mission {
  return {
    id: 1,
    goal: 'g',
    acceptance: 'a',
    acceptanceHash: 'h',
    status: 'active',
    launchCount: 0,
    relaunchCount: 0,
    createdAt: '2026-10-03T00:00:00.000Z',
    updatedAt: '2026-10-03T00:00:00.000Z',
    ...over,
  };
}

function run(over: Partial<DeliverRunState> = {}): DeliverRunState {
  return {
    runId: 'run-1',
    instruction: '[mission:#1] g',
    presetId: 'qwen35-a3b',
    projectRoot: '/tmp/x',
    status: 'running',
    createdAt: '2026-10-03T00:00:00.000Z',
    updatedAt: '2026-10-03T00:00:00.000Z',
    ...over,
  };
}

function view(over: Partial<PollView> = {}): PollView {
  return {
    mission: mission(),
    run: null,
    runPidAlive: false,
    failedAttempts: 0,
    sinceLastLaunchMs: 0,
    ...over,
  };
}

describe('decideMissionActions', () => {
  it('inactive missions get no action', () => {
    const acts = decideMissionActions(view({ mission: mission({ status: 'paused' }) }));
    expect(acts).toEqual([{ kind: 'none', reason: 'mission is paused' }]);
  });

  it('never-launched missions launch a fresh run', () => {
    expect(decideMissionActions(view())).toEqual([{ kind: 'launch' }]);
  });

  it('a recent launch with no run yet waits (grace — no double launch)', () => {
    const acts = decideMissionActions(
      view({ mission: mission({ lastLaunchAt: '2026-10-03T00:00:00.000Z' }), sinceLastLaunchMs: 60_000 })
    );
    expect(acts).toHaveLength(1);
    expect(acts[0].kind).toBe('wait-backoff');
    if (acts[0].kind === 'wait-backoff') {
      expect(acts[0].reason).toContain('in flight');
    }
  });

  it('a launch whose grace elapsed launches again (previous produced no run)', () => {
    const acts = decideMissionActions(
      view({ mission: mission({ lastLaunchAt: '2026-10-03T00:00:00.000Z' }), sinceLastLaunchMs: LAUNCH_GRACE_MS + 1 })
    );
    expect(acts).toEqual([{ kind: 'launch' }]);
  });

  it('a live running run is supervised, not driven', () => {
    const acts = decideMissionActions(view({ run: run(), runPidAlive: true }));
    expect(acts).toEqual([{ kind: 'supervise', runId: 'run-1' }]);
  });

  it('a running run with a dead pid is treated as interrupted (crash without marking)', () => {
    const acts = decideMissionActions(view({ run: run(), runPidAlive: false }));
    expect(acts.map((a) => a.kind)).toEqual(['salvage-proposal', 'relaunch']);
  });

  it('an interrupted run relaunches immediately when no backoff is owed', () => {
    const acts = decideMissionActions(view({ run: run({ status: 'interrupted' }) }));
    expect(acts.map((a) => a.kind)).toEqual(['salvage-proposal', 'relaunch']);
  });

  it('an interrupted run under backoff waits instead of hammering', () => {
    const acts = decideMissionActions(
      view({
        mission: mission({ relaunchCount: 1 }),
        run: run({ status: 'interrupted' }),
        sinceLastLaunchMs: 60_000, // owed 15m - 1m
      })
    );
    expect(acts.map((a) => a.kind)).toEqual(['salvage-proposal', 'wait-backoff']);
    if (acts[1].kind === 'wait-backoff') {
      expect(acts[1].minutes).toBe(14);
      expect(acts[1].reason).toContain('1 relaunch');
    }
  });

  it('a failed run with struggle at/over threshold flags escalation in the salvage proposal', () => {
    const acts = decideMissionActions(
      view({
        run: run({ status: 'failed', exit: { at: 'x', reason: 'gates red' } }),
        failedAttempts: STRUGGLE_THRESHOLD,
      })
    );
    const salvage = acts[0];
    expect(salvage.kind).toBe('salvage-proposal');
    if (salvage.kind === 'salvage-proposal') {
      expect(salvage.escalate).toBe(true);
      expect(salvage.summary).toContain('gates red');
    }
  });

  it('a delivered run closes the mission', () => {
    expect(decideMissionActions(view({ run: run({ status: 'delivered' }) }))).toEqual([
      { kind: 'close-delivered', runId: 'run-1' },
    ]);
  });
});

describe('backoffRemainingMs', () => {
  it('is zero until the first resume, then doubles per relaunch', () => {
    expect(backoffRemainingMs(view())).toBe(0);
    // relaunchCount counts SPENT resumes: 0 → the first relaunch is immediate;
    // 1 → the second has waited 15m; 2 → the third waits 30m.
    expect(backoffRemainingMs(view({ mission: mission({ relaunchCount: 1 }) }))).toBe(15 * 60_000);
    expect(backoffRemainingMs(view({ mission: mission({ relaunchCount: 2 }) }))).toBe(30 * 60_000);
  });
});
