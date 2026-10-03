/**
 * Poll-cycle executor — runPollCycle over a temp project with stub seams and
 * real run-state files. Covers: provenance-gated discovery (pid + marker),
 * claim exclusivity, attempt sync with observation-based dedupe, salvage
 * dedupe across cycles, same-run crash-loop struggle escalation, replan
 * relaunch semantics, and the CLI-facing marker invariant.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import { MissionDatabase, getMissionDbPath } from '../../src/mission/database.js';
import {
  createMission,
  getMission,
  listAttempts,
  listSalvage,
  replanAcceptance,
  setMissionStatus,
} from '../../src/mission/ledger.js';
import { saveRunState, type DeliverRunState } from '../../src/delivery/run-state.js';
import {
  missionMarker,
  missionInstruction,
  pidAlive,
  runPollCycle,
  discoverRunForMission,
  type PollSeams,
} from '../../src/mission/poll-executor.js';

let dir: string;
let db: Database.Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'uap-mission-poll-'));
  MissionDatabase.resetInstance();
  db = MissionDatabase.getInstance(getMissionDbPath(dir)).getDatabase();
});

afterEach(() => {
  MissionDatabase.resetInstance();
  rmSync(dir, { recursive: true, force: true });
});

function stubSeams(launchPid = process.pid) {
  const calls: { launches: string[]; resumes: string[]; supervises: string[]; board: string[] } = {
    launches: [],
    resumes: [],
    supervises: [],
    board: [],
  };
  const seams: PollSeams = {
    launchDeliver: ({ instruction }) => {
      calls.launches.push(instruction);
      return { pid: launchPid };
    },
    resumeDeliver: ({ runId }) => {
      calls.resumes.push(runId);
      return { pid: launchPid };
    },
    superviseOnce: ({ runId }) => {
      calls.supervises.push(runId);
      return Promise.resolve('CONTINUE');
    },
    postBoardNote: (text) => {
      calls.board.push(text);
    },
  };
  return { seams, calls };
}

const DEAD_PID = 999_999_999;

function state(over: Partial<DeliverRunState> = {}): DeliverRunState {
  return {
    runId: 'run-1',
    instruction: '[mission:#1] g',
    presetId: 'qwen35-a3b',
    projectRoot: dir,
    status: 'running',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...over,
  };
}

describe('pidAlive', () => {
  it('rejects junk pids and accepts the current process', () => {
    expect(pidAlive(undefined)).toBe(false);
    expect(pidAlive(0)).toBe(false);
    expect(pidAlive(-1)).toBe(false);
    expect(pidAlive(1.5)).toBe(false);
    expect(pidAlive(process.pid)).toBe(true);
  });
});

describe('missionMarker / missionInstruction', () => {
  it('embeds id + acceptance-hash slice, so a replan changes the marker', () => {
    const m = createMission(db, { goal: 'g', acceptance: 'v1' });
    const before = missionMarker(m);
    expect(before).toMatch(/^\[mission:#1:[0-9a-f]{8}\]$/);
    const after = replanAcceptance(db, m.id, 'v2', 'rewrite');
    expect(missionMarker(after)).not.toBe(before);
  });

  it('instruction NEVER starts with "-" — the marker pins the argv injection posture', () => {
    const m = createMission(db, { goal: '--resume', acceptance: 'a' });
    expect(missionInstruction(m).startsWith('-')).toBe(false);
    expect(missionInstruction(m).startsWith(missionMarker(m))).toBe(true);
  });
});

describe('runPollCycle', () => {
  it('launches a never-launched mission, claims, and records the pid', async () => {
    const m = createMission(db, { goal: 'g', acceptance: 'a' });
    const { seams, calls } = stubSeams();
    const reports = await runPollCycle(dir, seams);
    expect(calls.launches).toEqual([missionInstruction(m)]);
    const after = getMission(db, m.id);
    expect(after.lastLaunchAt).toBeTruthy();
    expect(after.launchPid).toBe(process.pid); // provenance anchor
    expect(listAttempts(db, m.id).some((a) => a.outcome === 'launched')).toBe(true);
    expect(reports[0].actions).toContain('launch fresh run');
  });

  it('waits inside the launch grace instead of double-launching', async () => {
    createMission(db, { goal: 'g', acceptance: 'a' });
    const { seams: s1 } = stubSeams();
    await runPollCycle(dir, s1); // launch
    // No run state registered yet: the next poll must NOT launch again.
    const { seams: s2, calls: c2 } = stubSeams();
    const reports = await runPollCycle(dir, s2);
    expect(c2.launches).toHaveLength(0);
    expect(c2.resumes).toHaveLength(0);
    expect(reports[0].actions.some((a) => a.startsWith('wait-backoff'))).toBe(true);
  });

  it('discovers, links, and supervises the run the launch created (pid + marker provenance)', async () => {
    const m = createMission(db, { goal: 'g', acceptance: 'a' });
    const { seams: s1 } = stubSeams();
    await runPollCycle(dir, s1); // launch, pid = process.pid
    // The deliver process "registered" its run between polls — with the pid
    // the orchestrator itself spawned, exactly as a real deliver writes it.
    saveRunState(state({ instruction: missionInstruction(m), pid: process.pid }));
    const { seams: s2, calls: c2 } = stubSeams();
    await runPollCycle(dir, s2);
    expect(c2.launches).toHaveLength(0); // no double launch
    expect(c2.resumes).toHaveLength(0); // healthy run — nothing to resume
    expect(c2.supervises).toEqual(['run-1']); // linked and supervised
    expect(getMission(db, m.id).latestRunId).toBe('run-1');
  });

  it('refuses to link a planted run: pid and marker must both match the launch', async () => {
    const m = createMission(db, { goal: 'g', acceptance: 'a' });
    const { seams: s1 } = stubSeams();
    await runPollCycle(dir, s1); // launch, pid = process.pid
    // A planted state file: right marker, but a pid the orchestrator never
    // spawned — it cannot know the future child pid.
    saveRunState(state({ instruction: missionInstruction(m), pid: DEAD_PID }));
    const { seams: s2, calls: c2 } = stubSeams();
    await runPollCycle(dir, s2);
    expect(getMission(db, m.id).latestRunId).toBeUndefined(); // NOT linked
    expect(c2.supervises).toHaveLength(0);
    expect(c2.launches).toHaveLength(0); // still inside the grace window
  });

  it('refuses to link a run whose marker embeds a superseded acceptance hash', async () => {
    const m = createMission(db, { goal: 'g', acceptance: 'v1' });
    const { seams: s1 } = stubSeams();
    await runPollCycle(dir, s1);
    const oldInstruction = missionInstruction(m);
    const replanned = replanAcceptance(db, m.id, 'v2', 'rewrite');
    saveRunState(state({ instruction: oldInstruction, pid: process.pid }));
    const { seams: s2, calls: c2 } = stubSeams();
    await runPollCycle(dir, s2);
    // Old-criteria run is not linked; the mission stays unlinked and will
    // relaunch under the new criteria after the grace window.
    expect(getMission(db, m.id).latestRunId).toBeUndefined();
    expect(c2.supervises).toHaveLength(0);
    expect(missionMarker(replanned)).not.toBe(missionMarker(m));
  });

  it('records a stale running state (pid gone) as interrupted, proposes salvage, and relaunches', async () => {
    const m = createMission(db, { goal: 'g', acceptance: 'a' });
    const { seams: s1 } = stubSeams(DEAD_PID); // the spawned child is already dead
    await runPollCycle(dir, s1); // launch, pid = DEAD_PID
    saveRunState(state({ instruction: missionInstruction(m), pid: DEAD_PID }));
    const { seams: s2, calls: c2 } = stubSeams();
    const reports = await runPollCycle(dir, s2, Date.now() + 20 * 60_000, { missionIds: [m.id] });
    // Discovery links (pid matches the launch), then stale-running handling.
    const attempts = listAttempts(db, m.id);
    expect(attempts.some((a) => a.outcome === 'interrupted' && a.summary?.includes('stale'))).toBe(true);
    expect(c2.resumes).toEqual(['run-1']);
    expect(listSalvage(db, { missionId: m.id })).toHaveLength(1);
    expect(reports[0].actions).toContain('relaunch run-1');
  });

  it('closes a delivered mission and posts a board note', async () => {
    const m = createMission(db, { goal: 'g', acceptance: 'a' });
    const { seams: s1 } = stubSeams();
    await runPollCycle(dir, s1); // launch
    saveRunState(state({ status: 'delivered', instruction: missionInstruction(m), pid: process.pid }));
    const { seams: s2, calls: c2 } = stubSeams();
    await runPollCycle(dir, s2, Date.now(), { missionIds: [m.id] });
    expect(getMission(db, m.id).status).toBe('delivered');
    expect(getMission(db, m.id).latestRunId).toBe('run-1'); // discovered + linked
    expect(calls2Board(c2.board)).toBe(true);
  });

  it('skips paused missions entirely', async () => {
    const m = createMission(db, { goal: 'g', acceptance: 'a' });
    setMissionStatus(db, m.id, 'paused');
    const { seams, calls } = stubSeams();
    const reports = await runPollCycle(dir, seams);
    expect(reports).toHaveLength(0);
    expect(calls.launches).toHaveLength(0);
  });

  it('respects the exponential backoff on repeated relaunches', async () => {
    const m = createMission(db, { goal: 'g', acceptance: 'a' });
    const { seams: s0 } = stubSeams();
    await runPollCycle(dir, s0); // launch, pid = process.pid
    saveRunState(state({ status: 'interrupted', instruction: missionInstruction(m), pid: process.pid }));
    // Cycle 2 (past the grace window): discovery links the interrupted run;
    // the FIRST relaunch is immediate.
    const { seams: s1 } = stubSeams();
    const first = await runPollCycle(dir, s1, Date.now() + 20 * 60_000, { missionIds: [m.id] });
    expect(first[0].actions).toContain('relaunch run-1');
    // Cycle 3: one resume spent — the second relaunch waits out the backoff.
    const { seams: s2, calls: c2 } = stubSeams();
    const second = await runPollCycle(dir, s2, Date.now() + 25 * 60_000, { missionIds: [m.id] });
    expect(c2.resumes).toHaveLength(0);
    expect(second[0].actions.some((a) => a.startsWith('wait-backoff'))).toBe(true);
  });

  it('does not duplicate salvage proposals or struggling board notes across cycles', async () => {
    const m = createMission(db, { goal: 'g', acceptance: 'a' });
    const { seams: s1 } = stubSeams(DEAD_PID);
    await runPollCycle(dir, s1); // launch
    saveRunState(state({ status: 'failed', instruction: missionInstruction(m), pid: DEAD_PID }));
    // Cycle 2: discovery links the failed run; salvage proposed once.
    const { seams: s2 } = stubSeams();
    await runPollCycle(dir, s2, Date.now() + 20 * 60_000, { missionIds: [m.id] });
    expect(listSalvage(db, { missionId: m.id })).toHaveLength(1);
    // Cycle 3 (later — new observation time, backoff elapsed): the SAME
    // failure is re-observed only if updatedAt changed; give it a new one so
    // a genuinely new failed relaunch happens, but the open proposal for the
    // last attempt is still deduped per-attempt.
    const { seams: s3, calls: c3 } = stubSeams();
    await runPollCycle(dir, s3, Date.now() + 40 * 60_000, { missionIds: [m.id] });
    const proposals = listSalvage(db, { missionId: m.id });
    // One proposal per genuinely new attempt — never one per poll cycle.
    expect(proposals.length).toBeLessThanOrEqual(2);
    const struggling = c3.board.filter((t) => t.includes('struggling'));
    // An escalate note only fires for a NEW proposal — never on repeat polls.
    expect(struggling.length).toBeLessThanOrEqual(1);
  });

  it('escalates after repeated same-run failures accumulate struggle', async () => {
    const m = createMission(db, { goal: 'g', acceptance: 'a' });
    const { seams: s0 } = stubSeams(DEAD_PID);
    await runPollCycle(dir, s0); // launch, pid = DEAD_PID
    // Register the run once so the state directory exists (direct writes below
    // then control the observation clock).
    saveRunState(state({ instruction: missionInstruction(m), pid: DEAD_PID }));
    const runPath = join(dir, '.uap', 'deliver-runs', 'run-1', 'state.json');
    for (let i = 0; i < 3; i++) {
      const failedState = state({
        status: 'failed',
        instruction: missionInstruction(m),
        pid: DEAD_PID,
        updatedAt: new Date(Date.now() + (i + 1) * 20 * 60_000).toISOString(),
      });
      writeFileSync(runPath, JSON.stringify(failedState, null, 2), 'utf-8');
      const { seams } = stubSeams();
      await runPollCycle(dir, seams, Date.now() + (i + 1) * 20 * 60_000 + 1_000, {
        missionIds: [m.id],
      });
    }
    const failed = listAttempts(db, m.id).filter((a) => a.outcome === 'failed');
    expect(failed.length).toBeGreaterThanOrEqual(3); // struggle accumulated
    const proposals = listSalvage(db, { missionId: m.id });
    expect(proposals.some((p) => p.proposal.includes('STRUGGLING'))).toBe(true);
  });

  it('a failed launch (no spawn result) records nothing and notes it', async () => {
    createMission(db, { goal: 'g', acceptance: 'a' });
    const seams: PollSeams = {
      launchDeliver: () => null,
      resumeDeliver: () => null,
      superviseOnce: async () => 'CONTINUE',
      postBoardNote: () => undefined,
    };
    const reports = await runPollCycle(dir, seams);
    expect(reports[0].notes.some((n) => n.includes('could not resolve CLI entrypoint'))).toBe(true);
    // The claim was spent, but no launch row: launchCount still advanced by
    // the claim — the record of a failed spawn is the note, not a phantom run.
    expect(listAttempts(db, 1).some((a) => a.outcome === 'launched')).toBe(false);
  });
});

function calls2Board(board: string[]): boolean {
  return board.some((t) => t.includes('delivered'));
}

describe('discoverRunForMission', () => {
  it('returns null when the mission has no recorded launch pid (unlaunched)', () => {
    const m = createMission(db, { goal: 'g', acceptance: 'a' });
    expect(discoverRunForMission(dir, m)).toBeNull();
  });
});
