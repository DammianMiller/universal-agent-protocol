/**
 * Poll-cycle decision core (PURE — unit-tested, no I/O).
 *
 * One orchestrator poll asks, per active mission: given the mission's ledger
 * state and its latest durable run, what should happen RIGHT NOW? The
 * executor (poll-executor.ts) applies the returned actions through injected
 * seams, so this module stays testable without models, daemons, or databases.
 *
 * The decision table (Choir's poll loop, UAP's primitives):
 *   no run            → launch a fresh deliver run for the goal
 *   run running, pid alive   → one supervisor cycle (watch, don't drive)
 *   run running, pid gone    → the process died without marking the run:
 *                               record interrupted, salvage, relaunch
 *   run interrupted/failed   → record, salvage, relaunch (with backoff)
 *   run delivered     → close the mission
 * A relaunch only fires after the exponential backoff elapses, so a
 * crash-looping mission waits instead of hammering the machine.
 */

import type { DeliverRunState } from '../delivery/run-state.js';
import type { Mission } from '../types/mission.js';
import { relaunchBackoffMinutes } from './ledger.js';

/** Failed/interrupted attempts before salvage proposes an escalation too. */
export const STRUGGLE_THRESHOLD = 3;

/**
 * Grace window after a fresh launch: `uap deliver` needs time to register its
 * durable run state. Within the window a mission with no run is "launch in
 * flight", not "launch again" — without this the next poll double-launches.
 */
export const LAUNCH_GRACE_MS = 10 * 60_000;

export type PollAction =
  | { kind: 'supervise'; runId: string }
  | { kind: 'relaunch'; runId: string }
  | { kind: 'launch' }
  | { kind: 'close-delivered'; runId: string }
  | { kind: 'salvage-proposal'; summary: string; escalate: boolean }
  | { kind: 'wait-backoff'; minutes: number; reason: string }
  | { kind: 'none'; reason: string };

export interface PollView {
  mission: Mission;
  /** Latest durable run attached to the mission (null = never launched). */
  run: DeliverRunState | null;
  /** Is the run's owning pid still alive? (ignored when run is null). */
  runPidAlive: boolean;
  /** Struggle metric: failed/interrupted attempts recorded so far. */
  failedAttempts: number;
  /** ms since the mission's last launch (0 when never launched). */
  sinceLastLaunchMs: number;
}

/**
 * Backoff still owed for this mission right now (0 = free to relaunch).
 *
 * The FIRST relaunch is immediate — an interrupted run resuming cleanly is
 * the common healthy case, not a crash loop. Backoff then doubles per
 * relaunch: 15 min after one resume, 30 after two, and so on.
 */
export function backoffRemainingMs(view: PollView): number {
  if (view.mission.relaunchCount === 0) return 0;
  const owed = relaunchBackoffMinutes(view.mission.relaunchCount - 1) * 60_000;
  return Math.max(0, owed - view.sinceLastLaunchMs);
}

function salvageSummary(view: PollView, outcome: 'failed' | 'interrupted'): string {
  return (
    `run ${view.run?.runId ?? '?'} ${outcome}` +
    (view.run?.exit?.reason ? ` — ${view.run.exit.reason}` : '') +
    `; ${view.failedAttempts} failed attempt(s) so far`
  );
}

/** Decide what the orchestrator should do for one active mission. PURE. */
export function decideMissionActions(view: PollView): PollAction[] {
  if (view.mission.status !== 'active') {
    return [{ kind: 'none', reason: `mission is ${view.mission.status}` }];
  }
  if (view.run === null) {
    if (view.mission.lastLaunchAt && view.sinceLastLaunchMs < LAUNCH_GRACE_MS) {
      return [
        {
          kind: 'wait-backoff',
          minutes: Math.ceil((LAUNCH_GRACE_MS - view.sinceLastLaunchMs) / 60_000),
          reason: 'fresh launch in flight — run state not yet registered',
        },
      ];
    }
    return [{ kind: 'launch' }];
  }
  const escalate = view.failedAttempts >= STRUGGLE_THRESHOLD;
  const backoff = backoffRemainingMs(view);
  switch (view.run.status) {
    case 'running':
      if (view.runPidAlive) {
        return [{ kind: 'supervise', runId: view.run.runId }];
      }
      // 'running' with a dead pid is a crash that never got to mark itself.
      return terminal(view, 'interrupted', backoff, escalate, 'owner pid is gone');
    case 'interrupted':
      return terminal(view, 'interrupted', backoff, escalate, 'run interrupted');
    case 'failed':
      return terminal(view, 'failed', backoff, escalate, 'run failed');
    case 'delivered':
      return [{ kind: 'close-delivered', runId: view.run.runId }];
  }
}

function terminal(
  view: PollView,
  outcome: 'failed' | 'interrupted',
  backoffMs: number,
  escalate: boolean,
  reason: string
): PollAction[] {
  const actions: PollAction[] = [
    {
      kind: 'salvage-proposal',
      summary: salvageSummary(view, outcome),
      escalate,
    },
  ];
  if (backoffMs > 0) {
    actions.push({
      kind: 'wait-backoff',
      minutes: Math.ceil(backoffMs / 60_000),
      reason: `${reason}; backoff after ${view.mission.relaunchCount} relaunch(es)`,
    });
  } else {
    actions.push({ kind: 'relaunch', runId: view.run?.runId ?? '' });
  }
  return actions;
}
