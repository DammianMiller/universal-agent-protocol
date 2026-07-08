/**
 * Task Board hierarchy: getTaskData resolves each item's group (root
 * ancestor) and depth from parent_id linkage so the kanban can cluster
 * epic/story/task families — the same linkage the Orchestration panel uses.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import { getTaskData } from '../src/dashboard/data-service.js';

const DDL = `CREATE TABLE tasks (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT,
  type TEXT NOT NULL DEFAULT 'task', status TEXT NOT NULL DEFAULT 'open',
  priority INTEGER NOT NULL DEFAULT 2, assignee TEXT, worktree_branch TEXT,
  labels TEXT, notes TEXT, parent_id TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  due_date TEXT, closed_at TEXT, closed_reason TEXT
)`;

describe('task board hierarchy (getTaskData)', () => {
  let root: string;
  let db: Database.Database;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'kb-hier-'));
    mkdirSync(join(root, '.uap', 'tasks'), { recursive: true });
    db = new Database(join(root, '.uap', 'tasks', 'tasks.db'));
    db.exec(DDL);
  });
  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  function insert(id: string, title: string, opts: { type?: string; status?: string; parent?: string | null } = {}) {
    db.prepare(
      "INSERT INTO tasks (id, title, type, status, parent_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))"
    ).run(id, title, opts.type ?? 'task', opts.status ?? 'open', opts.parent ?? null);
  }

  it('resolves group root, title, and depth across an epic → story → task chain', () => {
    insert('E1', 'Ship the oracle', { type: 'epic' });
    insert('S1', 'Org model types', { type: 'story', parent: 'E1' });
    insert('T1', 'Define Role struct', { parent: 'S1', status: 'in_progress' });
    insert('LONER', 'Unrelated chore');

    const items = getTaskData(root).items;
    const byId = new Map(items.map((i) => [i.id, i]));

    expect(byId.get('E1')).toMatchObject({ groupId: 'E1', groupTitle: 'Ship the oracle', depth: 0, parentId: null });
    expect(byId.get('S1')).toMatchObject({ groupId: 'E1', groupTitle: 'Ship the oracle', depth: 1, parentId: 'E1' });
    expect(byId.get('T1')).toMatchObject({ groupId: 'E1', groupTitle: 'Ship the oracle', depth: 2, parentId: 'S1' });
    expect(byId.get('LONER')).toMatchObject({ groupId: 'LONER', depth: 0 });
  });

  it('children still resolve to the root even when the root falls outside the item window', () => {
    // Root is done (falls into the 10-item done window regardless), but more
    // importantly the linkage map is read independently of the item windows.
    insert('E1', 'Big epic', { type: 'epic', status: 'done' });
    insert('C1', 'Child one', { parent: 'E1' });

    const items = getTaskData(root).items;
    const child = items.find((i) => i.id === 'C1');
    expect(child).toMatchObject({ groupId: 'E1', groupTitle: 'Big epic', depth: 1 });
  });

  it('treats a dangling parent_id as a root instead of dropping the item', () => {
    insert('ORPHAN', 'Parent was deleted', { parent: 'GONE' });
    const items = getTaskData(root).items;
    expect(items.find((i) => i.id === 'ORPHAN')).toMatchObject({
      groupId: 'ORPHAN',
      groupTitle: 'Parent was deleted',
      depth: 0,
    });
  });

  it('keeps on-board (newest) tasks resolvable past the 5000-row linkage cap', () => {
    // 5100 old filler rows, then a fresh epic+child: newest-first truncation
    // must keep the board's own tasks in the linkage map.
    const stmt = db.prepare(
      "INSERT INTO tasks (id, title, type, status, parent_id, created_at, updated_at) VALUES (?, ?, 'task', 'done', NULL, datetime('now','-1 year'), datetime('now','-1 year'))"
    );
    const fill = db.transaction(() => {
      for (let n = 0; n < 5100; n++) stmt.run(`old-${n}`, `Old task ${n}`);
    });
    fill();
    insert('E-NEW', 'Fresh epic', { type: 'epic' });
    insert('C-NEW', 'Fresh child', { parent: 'E-NEW' });

    const items = getTaskData(root).items;
    expect(items.find((i) => i.id === 'C-NEW')).toMatchObject({
      groupId: 'E-NEW',
      groupTitle: 'Fresh epic',
      depth: 1,
    });
  });

  it('exposes the direct parent title for breadcrumbs', () => {
    insert('E1', 'Epic', { type: 'epic' });
    insert('S1', 'Story one', { type: 'story', parent: 'E1' });
    insert('T1', 'Leaf', { parent: 'S1' });
    const items = getTaskData(root).items;
    expect(items.find((i) => i.id === 'T1')).toMatchObject({ parentTitle: 'Story one', depth: 2 });
    expect(items.find((i) => i.id === 'E1')).toMatchObject({ parentTitle: null });
  });

  it('terminates on a parent_id cycle instead of hanging', () => {
    insert('A', 'Node A', { parent: 'B' });
    insert('B', 'Node B', { parent: 'A' });
    const items = getTaskData(root).items;
    const a = items.find((i) => i.id === 'A');
    expect(a).toBeDefined();
    expect(['A', 'B']).toContain(a!.groupId);
  });
});
