/**
 * Mission ledger service — typed operations over the mission database.
 *
 * The ledger is the durable goal layer: a mission's acceptance criteria are
 * FROZEN at creation (sha256) and only change through an explicit, recorded
 * replan. Attempt history feeds the struggle metric; failed attempts seed
 * approval-gated salvage proposals.
 */

import { createHash } from 'crypto';
import type Database from 'better-sqlite3';
import { MissionDatabase, getMissionDbPath } from './database.js';
import type {
  Mission,
  MissionAttempt,
  MissionAttemptOutcome,
  MissionStatus,
  SalvageProposal,
  SalvageStatus,
  AcceptanceRevision,
} from '../types/mission.js';

/** sha256 of the trimmed acceptance text — the freeze-time hash. */
export function hashAcceptance(acceptance: string): string {
  return createHash('sha256').update(acceptance.trim()).digest('hex');
}

/**
 * Exponential relaunch backoff (minutes): 15, 30, 60, ... capped at one day.
 * A crash-looping mission must not burn cycles every poll — the same lesson
 * as the systemd start-rate limiter: back off, don't hammer.
 */
export function relaunchBackoffMinutes(relaunchCount: number): number {
  return Math.min(15 * 2 ** relaunchCount, 1440);
}

interface MissionRow {
  id: number;
  goal: string;
  acceptance: string;
  acceptance_hash: string;
  status: MissionStatus;
  preset_id: string | null;
  latest_run_id: string | null;
  launch_count: number;
  relaunch_count: number;
  last_launch_at: string | null;
  launch_pid: number | null;
  created_at: string;
  updated_at: string;
}

interface AttemptRow {
  id: number;
  mission_id: number;
  run_id: string | null;
  task_ref: string | null;
  outcome: MissionAttemptOutcome;
  summary: string | null;
  observed_at: string | null;
  created_at: string;
}

interface SalvageRow {
  id: number;
  mission_id: number;
  from_attempt_id: number | null;
  task_ref: string | null;
  proposal: string;
  status: SalvageStatus;
  created_at: string;
  decided_at: string | null;
}

interface RevisionRow {
  id: number;
  mission_id: number;
  prior_acceptance: string;
  prior_hash: string;
  reason: string;
  created_at: string;
}

function rowToMission(r: MissionRow): Mission {
  return {
    id: r.id,
    goal: r.goal,
    acceptance: r.acceptance,
    acceptanceHash: r.acceptance_hash,
    status: r.status,
    ...(r.preset_id !== null ? { presetId: r.preset_id } : {}),
    ...(r.latest_run_id !== null ? { latestRunId: r.latest_run_id } : {}),
    launchCount: r.launch_count,
    relaunchCount: r.relaunch_count,
    ...(r.last_launch_at !== null ? { lastLaunchAt: r.last_launch_at } : {}),
    ...(r.launch_pid !== null ? { launchPid: r.launch_pid } : {}),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function rowToAttempt(r: AttemptRow): MissionAttempt {
  return {
    id: r.id,
    missionId: r.mission_id,
    ...(r.run_id !== null ? { runId: r.run_id } : {}),
    ...(r.task_ref !== null ? { taskRef: r.task_ref } : {}),
    outcome: r.outcome,
    ...(r.summary !== null ? { summary: r.summary } : {}),
    ...(r.observed_at !== null ? { observedAt: r.observed_at } : {}),
    createdAt: r.created_at,
  };
}

function rowToSalvage(r: SalvageRow): SalvageProposal {
  return {
    id: r.id,
    missionId: r.mission_id,
    ...(r.from_attempt_id !== null ? { fromAttemptId: r.from_attempt_id } : {}),
    ...(r.task_ref !== null ? { taskRef: r.task_ref } : {}),
    proposal: r.proposal,
    status: r.status,
    createdAt: r.created_at,
    ...(r.decided_at !== null ? { decidedAt: r.decided_at } : {}),
  };
}

function rowToRevision(r: RevisionRow): AcceptanceRevision {
  return {
    id: r.id,
    missionId: r.mission_id,
    priorAcceptance: r.prior_acceptance,
    priorHash: r.prior_hash,
    reason: r.reason,
    createdAt: r.created_at,
  };
}

/** Open (or reuse) the mission database for a project root. PURE-ish: no writes. */
export function openMissionDb(projectRoot: string): Database.Database {
  return MissionDatabase.getInstance(getMissionDbPath(projectRoot)).getDatabase();
}

/** Test seam: reset the singleton so a new path is honored. */
export function resetMissionDb(): void {
  MissionDatabase.resetInstance();
}

/** Create a mission with frozen acceptance criteria. */
export function createMission(
  db: Database.Database,
  input: { goal: string; acceptance: string; presetId?: string }
): Mission {
  const now = new Date().toISOString();
  const hash = hashAcceptance(input.acceptance);
  const info = db
    .prepare(
      `INSERT INTO missions (goal, acceptance, acceptance_hash, status, preset_id, created_at, updated_at)
       VALUES (?, ?, ?, 'active', ?, ?, ?)`
    )
    .run(input.goal, input.acceptance, hash, input.presetId ?? null, now, now);
  return getMission(db, Number(info.lastInsertRowid));
}

export function getMission(db: Database.Database, id: number): Mission {
  const row = db
    .prepare('SELECT * FROM missions WHERE id = ?')
    .get(id) as MissionRow | undefined;
  if (!row) throw new Error(`mission #${id} not found`);
  return rowToMission(row);
}

export function listMissions(
  db: Database.Database,
  opts: { status?: MissionStatus; limit?: number } = {}
): Mission[] {
  const rows = opts.status
    ? db
        .prepare('SELECT * FROM missions WHERE status = ? ORDER BY id DESC LIMIT ?')
        .all(opts.status, opts.limit ?? 100) as MissionRow[]
    : db
        .prepare('SELECT * FROM missions ORDER BY id DESC LIMIT ?')
        .all(opts.limit ?? 100) as MissionRow[];
  return rows.map(rowToMission);
}

export function setMissionStatus(db: Database.Database, id: number, status: MissionStatus): boolean {
  const info = db
    .prepare('UPDATE missions SET status = ?, updated_at = ? WHERE id = ?')
    .run(status, new Date().toISOString(), id);
  return info.changes > 0;
}

/**
 * Explicit replan: supersede the frozen acceptance criteria. The prior text
 * and hash move to the revisions history — never a silent change. The run
 * link and backoff counters RESET: the prior run embeds the OLD criteria, so
 * resuming it could deliver against superseded acceptance. The next poll
 * launches a fresh run under the new criteria (new marker, new pid).
 */
export function replanAcceptance(
  db: Database.Database,
  id: number,
  newAcceptance: string,
  reason: string
): Mission {
  const mission = getMission(db, id);
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO acceptance_revisions (mission_id, prior_acceptance, prior_hash, reason, created_at)
       VALUES (?, ?, ?, ?, ?)`
    ).run(id, mission.acceptance, mission.acceptanceHash, reason, now);
    db.prepare(
      `UPDATE missions
       SET acceptance = ?, acceptance_hash = ?, latest_run_id = NULL, launch_pid = NULL,
           relaunch_count = 0, updated_at = ?
       WHERE id = ?`
    ).run(newAcceptance, hashAcceptance(newAcceptance), now, id);
  });
  tx();
  return getMission(db, id);
}

/** Does `acceptance` match the mission's frozen criteria? (merge-gate hook). */
export function verifyAcceptanceHash(db: Database.Database, id: number, acceptance: string): boolean {
  const row = db
    .prepare('SELECT acceptance_hash FROM missions WHERE id = ?')
    .get(id) as { acceptance_hash: string } | undefined;
  return row !== undefined && row.acceptance_hash === hashAcceptance(acceptance);
}

export function listAcceptanceRevisions(db: Database.Database, missionId: number): AcceptanceRevision[] {
  const rows = db
    .prepare('SELECT * FROM acceptance_revisions WHERE mission_id = ? ORDER BY id DESC')
    .all(missionId) as RevisionRow[];
  return rows.map(rowToRevision);
}

/**
 * How recent a claim blocks another: two concurrent cycles (daemon poll +
 * `uap mission create --launch`) must not both spawn. The conditional UPDATE
 * below makes the claim atomic; this window (not the 10-min decision grace)
 * is the anti-race guard.
 */
export const LAUNCH_CLAIM_MS = 60_000;

/**
 * Atomically claim the right to launch/resume. Returns the launch stamp when
 * this cycle WON the claim, null when another cycle launched within the
 * window (the caller must NOT spawn). Single-statement conditional update —
 * no read-then-write race. `nowMs` is the poll cycle's clock (injected for
 * tests; decisions and claims must share one timeline).
 */
export function claimLaunch(
  db: Database.Database,
  id: number,
  kind: 'fresh' | 'resume',
  nowMs: number = Date.now()
): string | null {
  const now = new Date(nowMs).toISOString();
  const cutoff = new Date(nowMs - LAUNCH_CLAIM_MS).toISOString();
  const info =
    kind === 'fresh'
      ? db
          .prepare(
            `UPDATE missions
             SET launch_count = launch_count + 1, last_launch_at = ?, updated_at = ?
             WHERE id = ? AND (last_launch_at IS NULL OR last_launch_at <= ?)`
          )
          .run(now, now, id, cutoff)
      : db
          .prepare(
            `UPDATE missions
             SET launch_count = launch_count + 1, relaunch_count = relaunch_count + 1,
                 last_launch_at = ?, updated_at = ?
             WHERE id = ? AND (last_launch_at IS NULL OR last_launch_at <= ?)`
          )
          .run(now, now, id, cutoff);
  return info.changes > 0 ? now : null;
}

/**
 * Record the pid of the launch we spawned, guarded by OUR claim stamp so a
 * concurrent winner's stamp is never overwritten.
 */
export function setLaunchPid(db: Database.Database, id: number, stamp: string, pid: number): void {
  db.prepare('UPDATE missions SET launch_pid = ?, updated_at = ? WHERE id = ? AND last_launch_at = ?').run(
    pid,
    new Date().toISOString(),
    id,
    stamp
  );
}

/**
 * Link a discovered deliver run to the mission WITHOUT counting a launch:
 * the poll cycle finds the run the mission's own launch created (by its
 * embedded `mission:#<id>` marker) and records the linkage.
 */
export function linkRun(db: Database.Database, id: number, runId: string): boolean {
  const info = db
    .prepare('UPDATE missions SET latest_run_id = ?, updated_at = ? WHERE id = ?')
    .run(runId, new Date().toISOString(), id);
  return info.changes > 0;
}

/**
 * Record an attempt outcome.
 *
 * Rows tied to a RUN dedupe on (mission, run, outcome, taskRef, observedAt):
 * a poll cycle that re-observes the SAME terminal run state (same
 * updatedAt/exit time) cannot double-count it, while a genuinely NEW event
 * for the same run (a resumed run failing again, a later exit) accumulates
 * into the struggle metric. Without observedAt in the key, a crash-looping
 * run could contribute at most one 'failed' row ever and never reach the
 * struggle threshold (code review P1). Whole-mission notes (no runId) are
 * never deduped: each occurrence is a distinct event.
 */
export function recordAttempt(
  db: Database.Database,
  input: {
    missionId: number;
    runId?: string;
    taskRef?: string;
    outcome: MissionAttemptOutcome;
    summary?: string;
    /** What this observation saw (run.updatedAt / exit.at). */
    observedAt?: string;
  }
): void {
  if (input.runId) {
    const dup = db
      .prepare(
        `SELECT 1 FROM mission_attempts
         WHERE mission_id = ? AND outcome = ? AND run_id = ?
           AND ifnull(task_ref, '') = ifnull(?, '')
           AND ifnull(observed_at, '') = ifnull(?, '')`
      )
      .get(input.missionId, input.outcome, input.runId, input.taskRef ?? null, input.observedAt ?? null);
    if (dup) return;
  }
  db.prepare(
    `INSERT INTO mission_attempts (mission_id, run_id, task_ref, outcome, summary, observed_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.missionId,
    input.runId ?? null,
    input.taskRef ?? null,
    input.outcome,
    input.summary ?? null,
    input.observedAt ?? null,
    new Date().toISOString()
  );
}

export function listAttempts(db: Database.Database, missionId: number): MissionAttempt[] {
  const rows = db
    .prepare('SELECT * FROM mission_attempts WHERE mission_id = ? ORDER BY id')
    .all(missionId) as AttemptRow[];
  return rows.map(rowToAttempt);
}

/** Struggle metric: failed attempts, whole-mission (no taskRef) or per ref. */
export function failedAttemptCount(
  db: Database.Database,
  missionId: number,
  taskRef?: string
): number {
  const row = taskRef
    ? db
        .prepare(
          `SELECT COUNT(*) AS n FROM mission_attempts
           WHERE mission_id = ? AND outcome = 'failed' AND task_ref = ?`
        )
        .get(missionId, taskRef) as { n: number }
    : db
        .prepare(
          `SELECT COUNT(*) AS n FROM mission_attempts
           WHERE mission_id = ? AND outcome IN ('failed', 'interrupted')`
        )
        .get(missionId) as { n: number };
  return row.n;
}

export function proposeSalvage(
  db: Database.Database,
  input: {
    missionId: number;
    fromAttemptId?: number;
    taskRef?: string;
    proposal: string;
  }
): SalvageProposal {
  const now = new Date().toISOString();
  const info = db
    .prepare(
      `INSERT INTO salvage_proposals (mission_id, from_attempt_id, task_ref, proposal, status, created_at)
       VALUES (?, ?, ?, ?, 'proposed', ?)`
    )
    .run(
      input.missionId,
      input.fromAttemptId ?? null,
      input.taskRef ?? null,
      input.proposal,
      now
    );
  const row = db
    .prepare('SELECT * FROM salvage_proposals WHERE id = ?')
    .get(Number(info.lastInsertRowid)) as SalvageRow;
  return rowToSalvage(row);
}

/** True when an OPEN proposal already cites the same attempt (dedupe). */
export function hasOpenSalvageForAttempt(
  db: Database.Database,
  missionId: number,
  attemptId?: number
): boolean {
  if (attemptId === undefined) return false;
  const row = db
    .prepare(
      `SELECT 1 FROM salvage_proposals
       WHERE mission_id = ? AND from_attempt_id = ? AND status = 'proposed'`
    )
    .get(missionId, attemptId);
  return row !== undefined;
}

export function decideSalvage(
  db: Database.Database,
  id: number,
  status: 'approved' | 'rejected'
): SalvageProposal {
  const info = db
    .prepare('UPDATE salvage_proposals SET status = ?, decided_at = ? WHERE id = ?')
    .run(status, new Date().toISOString(), id);
  if (info.changes === 0) throw new Error(`salvage proposal #${id} not found`);
  const row = db.prepare('SELECT * FROM salvage_proposals WHERE id = ?').get(id) as SalvageRow;
  return rowToSalvage(row);
}

export function listSalvage(
  db: Database.Database,
  opts: { missionId?: number; status?: SalvageStatus } = {}
): SalvageProposal[] {
  // One fixed, fully literal statement per filter combination — nothing is
  // ever assembled at runtime, and all values are bound parameters.
  const rows: SalvageRow[] =
    opts.missionId !== undefined && opts.status !== undefined
      ? (db
          .prepare(
            'SELECT * FROM salvage_proposals WHERE mission_id = ? AND status = ? ORDER BY id DESC LIMIT 200'
          )
          .all(opts.missionId, opts.status) as SalvageRow[])
      : opts.missionId !== undefined
        ? (db
            .prepare(
              'SELECT * FROM salvage_proposals WHERE mission_id = ? ORDER BY id DESC LIMIT 200'
            )
            .all(opts.missionId) as SalvageRow[])
        : opts.status !== undefined
          ? (db
              .prepare(
                'SELECT * FROM salvage_proposals WHERE status = ? ORDER BY id DESC LIMIT 200'
              )
              .all(opts.status) as SalvageRow[])
          : (db
              .prepare('SELECT * FROM salvage_proposals ORDER BY id DESC LIMIT 200')
              .all() as SalvageRow[]);
  return rows.map(rowToSalvage);
}
