/**
 * Poll-cycle executor — applies decideMissionActions through injectable seams.
 *
 * Production seams: ledger + run-state stores (real), runSupervisor (once
 * mode), spawnDeliverRun (detached, deliver-detach's discipline: own session,
 * stdio to a file, never a pipe). Tests inject stubs, so the orchestration
 * logic runs without models or databases.
 *
 * Run linkage is PROVENANCE-CHECKED (security review P1): a discovered run
 * only links to its mission when its instruction carries the mission's
 * marker (which embeds the acceptance hash, so a replan cannot relink old
 * runs) AND its pid matches the pid the orchestrator itself spawned. A
 * planted run-state file cannot know the future child pid, so it can never
 * steer the daemon. The launch claim (ledger.claimLaunch) makes concurrent
 * cycles (daemon + `create --launch`) atomic: only one spawns.
 */

import { spawn } from 'child_process';
import { closeSync, mkdirSync, openSync, realpathSync } from 'fs';
import { join } from 'path';
import type Database from 'better-sqlite3';
import { loadRunState, listRuns, type DeliverRunState } from '../delivery/run-state.js';
import { DETACH_ENV } from '../cli/deliver-detach.js';
import { runSupervisor } from '../supervise/loop.js';
import { SupervisorError } from '../supervise/config.js';
import {
  claimLaunch,
  failedAttemptCount,
  getMission,
  hasOpenSalvageForAttempt,
  linkRun,
  listAttempts,
  listMissions,
  openMissionDb,
  proposeSalvage,
  recordAttempt,
  setLaunchPid,
  setMissionStatus,
} from './ledger.js';
import { decideMissionActions, type PollAction, type PollView } from './poll-cycle.js';
import type { Mission } from '../types/mission.js';

/** signal-0 liveness probe; EPERM means alive but not ours. */
export function pidAlive(pid: number | undefined): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** A launch the executor performed. */
export interface SpawnResult {
  pid: number;
}

export interface PollSeams {
  /** Launch a fresh deliver run for a mission goal. */
  launchDeliver: (input: {
    projectRoot: string;
    instruction: string;
    presetId?: string;
  }) => SpawnResult | null;
  /** Resume an interrupted/failed durable run. */
  resumeDeliver: (input: { projectRoot: string; runId: string }) => SpawnResult | null;
  /** One supervisor cycle over a live run; returns the action taken (or error note). */
  superviseOnce: (input: { projectRoot: string; runId: string }) => Promise<string | null>;
  /** Post a note to the collaboration board (best-effort, never throws). */
  postBoardNote: (text: string) => void;
}

/** Where detached orch-launched runs stream their output. */
export function orchLogPath(projectRoot: string, stamp: string): string {
  return join(projectRoot, '.uap', 'orch-logs', `orch-${stamp}.log`);
}

/**
 * Spawn a detached `uap deliver …` process (own session, stdio to a file) so
 * the mission outlives the poll cycle and any daemon restart. Returns null
 * when the CLI entrypoint cannot be resolved — the caller records nothing.
 */
export function spawnDeliverRun(args: {
  projectRoot: string;
  deliverArgs: string[];
  stamp: string;
}): SpawnResult | null {
  let cliPath: string;
  try {
    cliPath = realpathSync(process.argv[1] ?? '');
  } catch {
    return null;
  }
  const logPath = orchLogPath(args.projectRoot, args.stamp);
  mkdirSync(join(args.projectRoot, '.uap', 'orch-logs'), { recursive: true });
  // 0600: the log streams full run output; supervisor state/events use the
  // same discipline.
  const fd = openSync(logPath, 'a', 0o600);
  const child = spawn(process.execPath, [cliPath, 'deliver', ...args.deliverArgs], {
    detached: true,
    stdio: ['ignore', fd, fd],
    cwd: args.projectRoot,
    // The child must not re-detach (infinite recursion); it is already in its
    // own session and no wrapper will be holding its stdio.
    env: { ...process.env, [DETACH_ENV]: '1' },
  });
  child.unref();
  // The child holds its own dup of the fd; the parent must not leak it
  // (daemon mode spawns for days).
  closeSync(fd);
  return { pid: child.pid ?? -1 };
}

/**
 * The mission marker links a deliver run back to its owning mission. The
 * acceptance-hash slice makes it replan-scoped: after a replan the hash
 * changes, so discovery can never relink a run that embeds the OLD criteria
 * — and goal text that merely mentions another mission's marker cannot
 * collide (code review P2).
 */
export function missionMarker(mission: Mission): string {
  return `[mission:#${mission.id}:${mission.acceptanceHash.slice(0, 8)}]`;
}

/**
 * The mission's acceptance criteria travel inside the instruction text. The
 * marker prefix also guarantees the argv token can never start with `-`, so
 * commander cannot misread it as a flag.
 */
export function missionInstruction(mission: Mission): string {
  return `${missionMarker(mission)} ${mission.goal}\n\nAcceptance criteria (frozen):\n${mission.acceptance}`;
}

export function defaultSeams(): PollSeams {
  return {
    launchDeliver: ({ projectRoot, instruction, presetId }) => {
      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
      return spawnDeliverRun({
        projectRoot,
        deliverArgs: [
          instruction,
          '--acceptance',
          '--project-root',
          projectRoot,
          ...(presetId ? ['-m', presetId] : []),
        ],
        stamp,
      });
    },
    resumeDeliver: ({ projectRoot, runId }) => {
      const stamp = `${runId}-resume-${Date.now()}`;
      return spawnDeliverRun({
        projectRoot,
        deliverArgs: ['--resume', runId, '--project-root', projectRoot],
        stamp,
      });
    },
    superviseOnce: async ({ projectRoot, runId }) => {
      try {
        const result = await runSupervisor({ projectRoot, runId, once: true });
        return result.decision.action;
      } catch (e) {
        return `supervisor-error: ${e instanceof SupervisorError ? e.message : String(e)}`;
      }
    },
    postBoardNote: (text) => {
      // Best-effort: a missing/unhealthy coordination DB must never break a
      // poll cycle. Imported lazily to keep this module decoupled from it.
      import('../coordination/service.js')
        .then(({ CoordinationService }) => {
          new CoordinationService().postBoard('orchestrator', text, 'note');
        })
        .catch(() => undefined);
    },
  };
}

/** One line summarizing a poll cycle for logs and the --json output. */
export interface PollMissionReport {
  missionId: number;
  actions: string[];
  notes: string[];
}

function viewFor(
  mission: Mission,
  run: DeliverRunState | null,
  db: Database.Database,
  nowMs: number
): PollView {
  const failed = failedAttemptCount(db, mission.id);
  const lastMs = mission.lastLaunchAt ? Date.parse(mission.lastLaunchAt) : 0;
  return {
    mission,
    run,
    runPidAlive: pidAlive(run?.pid),
    failedAttempts: failed,
    sinceLastLaunchMs: Math.max(0, nowMs - (Number.isFinite(lastMs) ? lastMs : 0)),
  };
}

/**
 * Find the durable run a fresh launch created. PROVENANCE-CHECKED (security
 * review P1): the run must carry this mission's marker (replan-scoped via
 * the acceptance-hash slice), its pid must match the pid the orchestrator
 * spawned (a planted state file cannot know a future child pid), and it must
 * have been created at/after the launch. Status is not filtered — a short
 * mission can deliver inside one poll interval and must still be linked.
 */
export function discoverRunForMission(
  projectRoot: string,
  mission: Mission
): DeliverRunState | null {
  const marker = missionMarker(mission);
  if (mission.launchPid === undefined) return null;
  const sinceMs = mission.lastLaunchAt ? Date.parse(mission.lastLaunchAt) - 60_000 : 0;
  const candidates = listRuns(projectRoot)
    .filter(
      (r) =>
        r.instruction.includes(marker) &&
        r.pid === mission.launchPid &&
        Date.parse(r.createdAt) >= sinceMs
    )
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  return candidates[0] ?? null;
}

/** Sync terminal run states into the attempt ledger before deciding. */
function syncAttempt(db: Database.Database, mission: Mission, run: DeliverRunState | null): void {
  if (!run) return;
  if (run.status === 'running' && !pidAlive(run.pid)) {
    recordAttempt(db, {
      missionId: mission.id,
      runId: run.runId,
      outcome: 'interrupted',
      summary: `stale running state — pid ${run.pid ?? '?'} is gone (crash without marking)`,
      observedAt: run.updatedAt,
    });
    return;
  }
  if (run.status === 'interrupted' || run.status === 'failed' || run.status === 'delivered') {
    recordAttempt(db, {
      missionId: mission.id,
      runId: run.runId,
      outcome: run.status,
      ...(run.exit?.reason ? { summary: run.exit.reason } : {}),
      observedAt: run.updatedAt,
    });
  }
}

async function applyAction(
  db: Database.Database,
  projectRoot: string,
  mission: Mission,
  action: PollAction,
  seams: PollSeams,
  report: PollMissionReport,
  nowMs: number
): Promise<void> {
  switch (action.kind) {
    case 'supervise':
      report.actions.push(`supervise ${action.runId}`);
      await seams.superviseOnce({ projectRoot, runId: action.runId });
      break;
    case 'launch': {
      report.actions.push('launch fresh run');
      // Claim FIRST (atomic), spawn only when won: concurrent cycles cannot
      // both spawn (code review P2).
      const stamp = claimLaunch(db, mission.id, 'fresh', nowMs);
      if (!stamp) {
        report.actions.push('claim-lost');
        report.notes.push('another cycle launched within the claim window — skipping');
        return;
      }
      const res = seams.launchDeliver({
        projectRoot,
        instruction: missionInstruction(mission),
        ...(mission.presetId ? { presetId: mission.presetId } : {}),
      });
      if (res) {
        setLaunchPid(db, mission.id, stamp, res.pid);
        // A prior launch that produced no run state is a failed attempt —
        // without it, a launch-loop would retry silently forever and never
        // accumulate the struggle that escalates it (architect P1-2).
        if (mission.lastLaunchAt) {
          recordAttempt(db, {
            missionId: mission.id,
            outcome: 'failed',
            summary: 'previous launch produced no run state before the grace window elapsed',
          });
        }
        recordAttempt(db, {
          missionId: mission.id,
          outcome: 'launched',
          summary: `pid ${res.pid}`,
        });
        report.notes.push(`launched pid ${res.pid}`);
      } else {
        report.notes.push('launch failed: could not resolve CLI entrypoint');
      }
      break;
    }
    case 'relaunch': {
      report.actions.push(`relaunch ${action.runId}`);
      const stamp = claimLaunch(db, mission.id, 'resume', nowMs);
      if (!stamp) {
        report.actions.push('claim-lost');
        report.notes.push('another cycle resumed within the claim window — skipping');
        return;
      }
      const res = seams.resumeDeliver({ projectRoot, runId: action.runId });
      if (res) {
        setLaunchPid(db, mission.id, stamp, res.pid);
        recordAttempt(db, {
          missionId: mission.id,
          runId: action.runId,
          outcome: 'launched',
          summary: `resume pid ${res.pid}`,
        });
        report.notes.push(`resumed ${action.runId} as pid ${res.pid}`);
      } else {
        report.notes.push(`relaunch of ${action.runId} failed: could not resolve CLI entrypoint`);
      }
      break;
    }
    case 'close-delivered':
      report.actions.push(`close-delivered ${action.runId}`);
      setMissionStatus(db, mission.id, 'delivered');
      seams.postBoardNote(`mission #${mission.id} delivered — ${mission.goal.slice(0, 120)}`);
      break;
    case 'salvage-proposal': {
      const attempts = listAttempts(db, mission.id);
      const last = attempts[attempts.length - 1];
      // Dedupe (architect review P1-1): a mission waiting out a backoff
      // window is re-decided every cycle; without this gate one failure
      // could seed hundreds of duplicate proposals and board notes.
      if (last && hasOpenSalvageForAttempt(db, mission.id, last.id)) {
        report.actions.push('salvage-proposal (open)');
        return;
      }
      report.actions.push('salvage-proposal');
      proposeSalvage(db, {
        missionId: mission.id,
        ...(last ? { fromAttemptId: last.id } : {}),
        proposal: action.escalate
          ? `${action.summary} — STRUGGLING: consider escalating the preset or decomposing before the next relaunch.`
          : `${action.summary} — resume the run; salvage the partial work if the resume fails again.`,
      });
      if (action.escalate) {
        seams.postBoardNote(
          `mission #${mission.id} struggling (${action.summary}) — approve a salvage/replan or escalate the preset`
        );
      }
      break;
    }
    case 'wait-backoff':
      report.actions.push(`wait-backoff ${action.minutes}m`);
      report.notes.push(action.reason);
      break;
    case 'none':
      report.actions.push('none');
      report.notes.push(action.reason);
      break;
  }
}

/** Run ONE poll cycle over active missions. Returns per-mission reports. */
export async function runPollCycle(
  projectRoot: string,
  seams: PollSeams = defaultSeams(),
  nowMs: number = Date.now(),
  opts: { missionIds?: number[] } = {}
): Promise<PollMissionReport[]> {
  const db = openMissionDb(projectRoot);
  let missions = listMissions(db, { status: 'active' });
  if (opts.missionIds && opts.missionIds.length > 0) {
    missions = missions.filter((m) => opts.missionIds?.includes(m.id));
  }
  const reports: PollMissionReport[] = [];
  for (const mission of missions) {
    const report: PollMissionReport = { missionId: mission.id, actions: [], notes: [] };
    let run = mission.latestRunId ? loadRunState(projectRoot, mission.latestRunId) : null;
    if (!mission.latestRunId) {
      // Fresh-launch discovery: link the run this mission's own launch
      // created before deciding anything (or we would double-launch).
      const found = discoverRunForMission(projectRoot, mission);
      if (found) {
        linkRun(db, mission.id, found.runId);
        run = found;
      }
    }
    syncAttempt(db, mission, run);
    const fresh = getMission(db, mission.id);
    const view = viewFor(fresh, run, db, nowMs);
    for (const action of decideMissionActions(view)) {
      await applyAction(db, projectRoot, fresh, action, seams, report, nowMs);
    }
    reports.push(report);
  }
  return reports;
}
