/**
 * Mission ledger: frozen acceptance, attempt history (struggle metric),
 * approval-gated salvage, replan supersede, launch bookkeeping.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import {
  MissionDatabase,
  getMissionDbPath,
} from '../../src/mission/database.js';
import {
  createMission,
  claimLaunch,
  decideSalvage,
  failedAttemptCount,
  getMission,
  hasOpenSalvageForAttempt,
  hashAcceptance,
  linkRun,
  listAcceptanceRevisions,
  listAttempts,
  listMissions,
  listSalvage,
  proposeSalvage,
  recordAttempt,
  relaunchBackoffMinutes,
  replanAcceptance,
  setLaunchPid,
  setMissionStatus,
  verifyAcceptanceHash,
} from '../../src/mission/ledger.js';

let dir: string;
let db: Database.Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'uap-mission-ledger-'));
  MissionDatabase.resetInstance();
  db = MissionDatabase.getInstance(getMissionDbPath(dir)).getDatabase();
});

afterEach(() => {
  MissionDatabase.resetInstance();
  rmSync(dir, { recursive: true, force: true });
});

function mission(id: number): ReturnType<typeof getMission> {
  return getMission(db, id);
}

describe('createMission + frozen acceptance', () => {
  it('freezes the sha256 of the trimmed acceptance text', () => {
    const m = createMission(db, { goal: 'g', acceptance: '  all tests pass  ' });
    expect(m.status).toBe('active');
    expect(m.acceptanceHash).toBe(hashAcceptance('all tests pass'));
    expect(verifyAcceptanceHash(db, m.id, 'all tests pass')).toBe(true);
    expect(verifyAcceptanceHash(db, m.id, 'all tests fail')).toBe(false);
  });

  it('rejects nothing on empty acceptance (caller validates) but stores it verbatim', () => {
    const m = createMission(db, { goal: 'g', acceptance: '' });
    expect(m.acceptance).toBe('');
    expect(m.acceptanceHash).toBe(hashAcceptance(''));
  });
});

describe('replanAcceptance', () => {
  it('supersedes with a recorded revision — never a silent change', () => {
    const m = createMission(db, { goal: 'g', acceptance: 'v1' });
    const updated = replanAcceptance(db, m.id, 'v2', 'scope widened');
    expect(updated.acceptance).toBe('v2');
    expect(verifyAcceptanceHash(db, m.id, 'v1')).toBe(false);
    expect(verifyAcceptanceHash(db, m.id, 'v2')).toBe(true);
    const revs = listAcceptanceRevisions(db, m.id);
    expect(revs).toHaveLength(1);
    expect(revs[0].priorAcceptance).toBe('v1');
    expect(revs[0].reason).toBe('scope widened');
  });

  it('resets the run link and backoff so resume cannot deliver against superseded acceptance', () => {
    const m = createMission(db, { goal: 'g', acceptance: 'v1' });
    const stamp = claimLaunch(db, m.id, 'fresh');
    setLaunchPid(db, m.id, stamp!, 4242);
    linkRun(db, m.id, 'run-old');
    claimLaunch(db, m.id, 'resume'); // relaunchCount: 1
    const updated = replanAcceptance(db, m.id, 'v2', 'criteria rewritten');
    expect(updated.latestRunId).toBeUndefined();
    expect(updated.launchPid).toBeUndefined();
    expect(updated.relaunchCount).toBe(0);
  });
});

describe('status + launch bookkeeping', () => {
  it('pause and resume flip status; list filters', () => {
    const m = createMission(db, { goal: 'g', acceptance: 'a' });
    expect(setMissionStatus(db, m.id, 'paused')).toBe(true);
    expect(listMissions(db, { status: 'active' })).toHaveLength(0);
    expect(listMissions(db, { status: 'paused' })[0].id).toBe(m.id);
    setMissionStatus(db, m.id, 'active');
    expect(listMissions(db, { status: 'active' })).toHaveLength(1);
  });

  it('claimLaunch is exclusive within the window and counts fresh vs resume', () => {
    const m = createMission(db, { goal: 'g', acceptance: 'a' });
    const stamp = claimLaunch(db, m.id, 'fresh');
    expect(stamp).toBeTruthy();
    let now = mission(m.id);
    expect(now.launchCount).toBe(1);
    expect(now.relaunchCount).toBe(0);
    expect(now.lastLaunchAt).toBeTruthy();
    // A second claim inside the window is refused — concurrent cycles cannot
    // both spawn.
    expect(claimLaunch(db, m.id, 'fresh')).toBeNull();
    expect(mission(m.id).launchCount).toBe(1);
    expect(claimLaunch(db, m.id, 'resume')).toBeNull();
    // setLaunchPid is guarded by OUR stamp and records the provenance pid.
    setLaunchPid(db, m.id, stamp!, 4242);
    expect(mission(m.id).launchPid).toBe(4242);
  });

  it('claimLaunch resumes and fresh-launches again once the window elapses', () => {
    const m = createMission(db, { goal: 'g', acceptance: 'a' });
    const stamp = claimLaunch(db, m.id, 'fresh');
    expect(stamp).toBeTruthy();
    // Backdate the stamp past the claim window.
    db.prepare('UPDATE missions SET last_launch_at = ? WHERE id = ?').run(
      new Date(Date.now() - 120_000).toISOString(),
      m.id
    );
    expect(claimLaunch(db, m.id, 'resume')).toBeTruthy();
    expect(mission(m.id).launchCount).toBe(2);
    expect(mission(m.id).relaunchCount).toBe(1);
  });

  it('linkRun records the run WITHOUT counting a launch', () => {
    const m = createMission(db, { goal: 'g', acceptance: 'a' });
    expect(linkRun(db, m.id, 'run-abc')).toBe(true);
    const now = mission(m.id);
    expect(now.latestRunId).toBe('run-abc');
    expect(now.launchCount).toBe(0);
    expect(linkRun(db, 999, 'run-x')).toBe(false);
  });
});

describe('attempts + struggle', () => {
  it('records outcomes and counts failed/interrupted as struggle', () => {
    const m = createMission(db, { goal: 'g', acceptance: 'a' });
    recordAttempt(db, { missionId: m.id, runId: 'r1', outcome: 'launched' });
    recordAttempt(db, { missionId: m.id, runId: 'r1', outcome: 'failed', summary: 'gate red' });
    recordAttempt(db, { missionId: m.id, runId: 'r2', outcome: 'interrupted' });
    expect(failedAttemptCount(db, m.id)).toBe(2);
    expect(listAttempts(db, m.id)).toHaveLength(3);
  });

  it('dedupes identical RE-observations of a run, but not genuinely new events', () => {
    const m = createMission(db, { goal: 'g', acceptance: 'a' });
    recordAttempt(db, { missionId: m.id, runId: 'r1', outcome: 'launched' });
    // Same run, same observation time: one row (re-observed terminal state).
    recordAttempt(db, { missionId: m.id, runId: 'r1', outcome: 'failed', observedAt: 't1' });
    recordAttempt(db, { missionId: m.id, runId: 'r1', outcome: 'failed', observedAt: 't1' });
    // Same run, NEW failure event: a new row — the struggle metric must
    // accumulate across crash-loop relaunches of one run (code review P1).
    recordAttempt(db, { missionId: m.id, runId: 'r1', outcome: 'failed', observedAt: 't2' });
    recordAttempt(db, { missionId: m.id, runId: 'r1', outcome: 'interrupted', observedAt: 't1' });
    expect(listAttempts(db, m.id)).toHaveLength(4);
    expect(failedAttemptCount(db, m.id)).toBe(3);
  });

  it('runId-less whole-mission notes are never deduped (each is a distinct event)', () => {
    const m = createMission(db, { goal: 'g', acceptance: 'a' });
    recordAttempt(db, { missionId: m.id, outcome: 'failed', summary: 'no run state' });
    recordAttempt(db, { missionId: m.id, outcome: 'failed', summary: 'no run state' });
    recordAttempt(db, { missionId: m.id, outcome: 'failed', summary: 'no run state' });
    expect(failedAttemptCount(db, m.id)).toBe(3);
  });

  it('same outcome on a DIFFERENT run is a new attempt row', () => {
    const m = createMission(db, { goal: 'g', acceptance: 'a' });
    recordAttempt(db, { missionId: m.id, runId: 'r1', outcome: 'failed' });
    recordAttempt(db, { missionId: m.id, runId: 'r2', outcome: 'failed' });
    expect(failedAttemptCount(db, m.id)).toBe(2);
  });

  it('per-task-ref struggle is independent of whole-mission struggle', () => {
    const m = createMission(db, { goal: 'g', acceptance: 'a' });
    recordAttempt(db, { missionId: m.id, runId: 'r1', outcome: 'failed', taskRef: 'phase-2' });
    recordAttempt(db, { missionId: m.id, runId: 'r2', outcome: 'failed', taskRef: 'phase-3' });
    expect(failedAttemptCount(db, m.id, 'phase-2')).toBe(1);
    expect(failedAttemptCount(db, m.id)).toBe(2);
  });
});

describe('salvage', () => {
  it('proposes, approves, and rejects — approval-gated by design', () => {
    const m = createMission(db, { goal: 'g', acceptance: 'a' });
    recordAttempt(db, { missionId: m.id, runId: 'r1', outcome: 'failed' });
    const attemptId = listAttempts(db, m.id)[0].id;
    const p = proposeSalvage(db, {
      missionId: m.id,
      fromAttemptId: attemptId,
      proposal: 'resume the run; salvage partial work',
    });
    expect(p.status).toBe('proposed');
    expect(hasOpenSalvageForAttempt(db, m.id, attemptId)).toBe(true);
    expect(decideSalvage(db, p.id, 'approved').status).toBe('approved');
    expect(hasOpenSalvageForAttempt(db, m.id, attemptId)).toBe(false);
    expect(listSalvage(db, { missionId: m.id, status: 'approved' })).toHaveLength(1);
  });

  it('deciding a missing proposal throws', () => {
    expect(() => decideSalvage(db, 999, 'rejected')).toThrow(/not found/);
  });

  it('hasOpenSalvageForAttempt is false without an attempt id', () => {
    const m = createMission(db, { goal: 'g', acceptance: 'a' });
    expect(hasOpenSalvageForAttempt(db, m.id)).toBe(false);
  });
});

describe('relaunch backoff', () => {
  it('doubles per relaunch and caps at one day', () => {
    expect(relaunchBackoffMinutes(0)).toBe(15);
    expect(relaunchBackoffMinutes(1)).toBe(30);
    expect(relaunchBackoffMinutes(2)).toBe(60);
    expect(relaunchBackoffMinutes(10)).toBe(1440);
  });
});
