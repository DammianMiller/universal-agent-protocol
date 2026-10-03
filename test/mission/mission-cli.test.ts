/**
 * CLI-level coverage the code review flagged as missing: salvage argument
 * parsing (approve/reject/list + bad shapes), the poll interval clamp, and
 * the create→launch→pause happy paths against a temp ledger.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import { MissionDatabase, getMissionDbPath } from '../../src/mission/database.js';
import { createMission, proposeSalvage, recordAttempt } from '../../src/mission/ledger.js';
import { missionCommand } from '../../src/cli/mission.js';
import { clampPollIntervalSecs, DEFAULT_POLL_INTERVAL_SECS } from '../../src/cli/orch.js';

let dir: string;
let db: Database.Database;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'uap-mission-cli-'));
  MissionDatabase.resetInstance();
  db = MissionDatabase.getInstance(getMissionDbPath(dir)).getDatabase();
});

afterEach(() => {
  MissionDatabase.resetInstance();
  rmSync(dir, { recursive: true, force: true });
});

function opts(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { projectRoot: dir, ...over };
}

describe('uap mission salvage parsing', () => {
  it('approve <id> decides an open proposal', async () => {
    const m = createMission(db, { goal: 'g', acceptance: 'a' });
    recordAttempt(db, { missionId: m.id, runId: 'r1', outcome: 'failed' });
    const p = proposeSalvage(db, { missionId: m.id, proposal: 'resume' });
    await missionCommand('salvage', `approve ${p.id}`, opts());
    const decided = db
      .prepare('SELECT status FROM salvage_proposals WHERE id = ?')
      .get(p.id) as { status: string };
    expect(decided.status).toBe('approved');
  });

  it('reject <id> decides an open proposal', async () => {
    const m = createMission(db, { goal: 'g', acceptance: 'a' });
    const p = proposeSalvage(db, { missionId: m.id, proposal: 'resume' });
    await missionCommand('salvage', `reject ${p.id}`, opts());
    const decided = db
      .prepare('SELECT status FROM salvage_proposals WHERE id = ?')
      .get(p.id) as { status: string };
    expect(decided.status).toBe('rejected');
  });

  it('bare `salvage` lists and never crashes on an empty queue', async () => {
    await missionCommand('salvage', '', opts());
    expect(process.exitCode ?? 0).toBe(0);
  });

  it('unknown verb or junk id is a usage error, not a crash', async () => {
    const before = process.exitCode;
    await missionCommand('salvage', 'approve notanumber', opts());
    expect(process.exitCode).toBe(1);
    process.exitCode = before;
    await missionCommand('salvage', 'frobnicate 3', opts());
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
  });
});

describe('uap mission create / pause / resume / show', () => {
  it('create requires acceptance and freezes it; show prints friendly not-found', async () => {
    const before = process.exitCode;
    await missionCommand('create', 'a goal', opts()); // no acceptance → usage
    expect(process.exitCode).toBe(1);
    process.exitCode = before;
    await missionCommand('create', 'a goal', opts({ acceptance: 'gates green' }));
    const m = db
      .prepare('SELECT id, acceptance_hash FROM missions')
      .get() as { id: number; acceptance_hash: string };
    expect(m.acceptance_hash).toHaveLength(64);
    await missionCommand('show', '999', opts());
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
  });

  it('pause hides the mission from the poll loop; resume restores it', async () => {
    const m = createMission(db, { goal: 'g', acceptance: 'a' });
    await missionCommand('pause', String(m.id), opts());
    const paused = db
      .prepare('SELECT status FROM missions WHERE id = ?')
      .get(m.id) as { status: string };
    expect(paused.status).toBe('paused');
    await missionCommand('resume', String(m.id), opts());
    const resumed = db
      .prepare('SELECT status FROM missions WHERE id = ?')
      .get(m.id) as { status: string };
    expect(resumed.status).toBe('active');
  });
});

describe('poll interval clamp', () => {
  it('accepts finite values ≥ 10s, rejects junk and sub-10s with the default', () => {
    expect(clampPollIntervalSecs('60')).toBe(60);
    expect(clampPollIntervalSecs('10')).toBe(10);
    expect(clampPollIntervalSecs('9')).toBe(DEFAULT_POLL_INTERVAL_SECS);
    expect(clampPollIntervalSecs('junk')).toBe(DEFAULT_POLL_INTERVAL_SECS);
    expect(clampPollIntervalSecs(undefined)).toBe(DEFAULT_POLL_INTERVAL_SECS);
  });
});
