/**
 * Tests for templates/hooks/coordinate-file.sh — the always-on file-coordination
 * helper that announces edits to the shared coordination DB and blocks a LIVE
 * same-file conflict (hybrid policy: block live, warn stale).
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(__dirname, '../templates/hooks/coordinate-file.sh');

const tmpDirs: string[] = [];
afterAll(() => tmpDirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function sql(db: string, statement: string): string {
  const r = spawnSync('sqlite3', [db, statement], { encoding: 'utf-8' });
  if (r.status !== 0) throw new Error(`sqlite3 failed: ${r.stderr}`);
  return (r.stdout ?? '').trim();
}

const SCHEMA = `
CREATE TABLE agent_registry (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, session_id TEXT NOT NULL,
  status TEXT NOT NULL, current_task TEXT, worktree_branch TEXT,
  started_at TEXT NOT NULL, last_heartbeat TEXT NOT NULL, capabilities TEXT
);
CREATE TABLE work_announcements (
  id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, agent_name TEXT,
  worktree_branch TEXT, intent_type TEXT NOT NULL, resource TEXT NOT NULL,
  description TEXT, files_affected TEXT, estimated_completion TEXT,
  announced_at TEXT NOT NULL, completed_at TEXT
);
`;

function newDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'coord-test-'));
  tmpDirs.push(dir);
  const db = join(dir, 'coordination.db');
  sql(db, SCHEMA);
  return db;
}

function runHook(
  db: string,
  agent: string,
  rel: string,
  abs = '/abs/' + rel
): { status: number; stderr: string } {
  const r = spawnSync('bash', [SCRIPT, db, agent, 'agent', 'feat/x', rel, abs], {
    encoding: 'utf-8',
  });
  return { status: r.status ?? -1, stderr: r.stderr ?? '' };
}

const REL = 'src/x.ts';

describe('coordinate-file.sh', () => {
  let db: string;
  beforeEach(() => {
    db = newDb();
  });

  it('allows and announces when no one else holds the file', () => {
    const r = runHook(db, 'claude-A', REL);
    expect(r.status).toBe(0);
    const open = sql(
      db,
      `SELECT COUNT(*) FROM work_announcements WHERE agent_id='claude-A' AND resource='${REL}' AND completed_at IS NULL;`
    );
    expect(open).toBe('1');
  });

  it('BLOCKS when another LIVE agent is editing the same file', () => {
    // Other agent: active registry + fresh announcement on REL.
    sql(
      db,
      `INSERT INTO agent_registry (id,name,session_id,status,started_at,last_heartbeat)
       VALUES ('claude-B','b','b','active',datetime('now'),datetime('now'));
       INSERT INTO work_announcements (agent_id,agent_name,intent_type,resource,announced_at)
       VALUES ('claude-B','b','editing','${REL}',datetime('now'));`
    );
    const r = runHook(db, 'claude-A', REL);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/COORDINATION/);
    expect(r.stderr).toMatch(/claude-B/);
    // We must NOT have announced our own edit while blocked.
    const mine = sql(
      db,
      `SELECT COUNT(*) FROM work_announcements WHERE agent_id='claude-A' AND completed_at IS NULL;`
    );
    expect(mine).toBe('0');
  });

  it('WARNS and allows when the other announcement is stale, self-healing it', () => {
    sql(
      db,
      `INSERT INTO agent_registry (id,name,session_id,status,started_at,last_heartbeat)
       VALUES ('claude-C','c','c','active',datetime('now','-1 hour'),datetime('now','-1 hour'));
       INSERT INTO work_announcements (agent_id,agent_name,intent_type,resource,announced_at)
       VALUES ('claude-C','c','editing','${REL}',datetime('now','-1 hour'));`
    );
    const r = runHook(db, 'claude-A', REL);
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/WARNING/);
    // Stale announcement self-healed (completed), ours is now open.
    const staleOpen = sql(
      db,
      `SELECT COUNT(*) FROM work_announcements WHERE agent_id='claude-C' AND completed_at IS NULL;`
    );
    expect(staleOpen).toBe('0');
    const mineOpen = sql(
      db,
      `SELECT COUNT(*) FROM work_announcements WHERE agent_id='claude-A' AND completed_at IS NULL;`
    );
    expect(mineOpen).toBe('1');
  });

  it('does not self-block or duplicate when the same agent re-edits', () => {
    runHook(db, 'claude-A', REL); // first announce
    const r = runHook(db, 'claude-A', REL); // re-edit
    expect(r.status).toBe(0);
    const open = sql(
      db,
      `SELECT COUNT(*) FROM work_announcements WHERE agent_id='claude-A' AND resource='${REL}' AND completed_at IS NULL;`
    );
    expect(open).toBe('1'); // still exactly one open announcement, not two
  });

  it('fails open (allows) when the DB does not exist', () => {
    const r = runHook('/nonexistent/path/coordination.db', 'claude-A', REL);
    expect(r.status).toBe(0);
  });
});
