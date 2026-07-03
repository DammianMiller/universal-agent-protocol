/**
 * Task staleness reaper: in_progress tasks nobody touched revert to open so
 * the board reflects reality instead of a permanently-stuck 17%.
 *
 * NOTE: TaskDatabase is a process-wide singleton (first dbPath wins), so all
 * cases share one service/DB.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import { TaskService } from '../../src/tasks/service.js';

describe('TaskService.reapStale', () => {
  let dir: string;
  let dbPath: string;
  let service: TaskService;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'uap-reap-'));
    dbPath = join(dir, 'tasks.db');
    service = new TaskService({ dbPath, jsonlPath: join(dir, 'tasks.jsonl') });
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function backdate(id: string, daysAgo: number): void {
    const ts = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
    new Database(dbPath).prepare('UPDATE tasks SET updated_at = ? WHERE id = ?').run(ts, id);
  }

  it('reverts stale in_progress tasks to open with an audit note', () => {
    const stale = service.create({ title: 'stale work' });
    service.update(stale.id, { status: 'in_progress' });
    backdate(stale.id, 90);

    const fresh = service.create({ title: 'fresh work' });
    service.update(fresh.id, { status: 'in_progress' });

    const reaped = service.reapStale(14);
    expect(reaped.map((t) => t.id)).toEqual([stale.id]);
    expect(service.get(stale.id)!.status).toBe('open');
    expect(service.get(stale.id)!.notes).toContain('auto-reaped');
    // Recently-touched work is untouched.
    expect(service.get(fresh.id)!.status).toBe('in_progress');
  });

  it('is idempotent and ignores non-in_progress statuses', () => {
    const done = service.create({ title: 'done work' });
    service.update(done.id, { status: 'done' });
    backdate(done.id, 90);

    expect(service.reapStale(14)).toEqual([]);
    expect(service.reapStale(14)).toEqual([]);
    expect(service.get(done.id)!.status).toBe('done');
  });
});
