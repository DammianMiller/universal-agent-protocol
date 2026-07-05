/**
 * Dashboard real-data analytics: per-influence token savings + orchestration
 * hierarchy tree. Both fail-soft (no data => safe empty, never throw) and build
 * correct results when data exists.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { getSavingsByInfluence } from '../src/dashboard/savings.js';
import { getOrchestrationTree } from '../src/dashboard/orchestration-tree.js';

describe('getSavingsByInfluence', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'uap-sav-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('is fail-soft with no sources and returns influence rows + totals', () => {
    const sv = getSavingsByInfluence(dir);
    expect(sv.influences.length).toBeGreaterThanOrEqual(3);
    expect(typeof sv.totalTokensSaved).toBe('number');
    const routing = sv.influences.find((i) => i.influence.startsWith('Model routing'))!;
    expect(routing.quality).toBe('unmeasured');
    expect(routing.costSavedUsd).toBe(0);
  });

  it('computes the routing counterfactual vs the frontier model (measured)', () => {
    const mdir = join(dir, 'agents', 'data', 'memory');
    mkdirSync(mdir, { recursive: true });
    const db = new Database(join(mdir, 'model_analytics.db'));
    db.exec(`CREATE TABLE task_outcomes (modelId TEXT, taskType TEXT, complexity TEXT, success INTEGER, durationMs INTEGER, tokensIn INTEGER, tokensOut INTEGER, cost REAL, taskId TEXT, timestamp TEXT);`);
    db.prepare('INSERT INTO task_outcomes VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run('qwen35-a3b', 'coding', 'medium', 1, 100, 1_000_000, 1_000_000, 0.0, 't1', new Date().toISOString());
    db.close();
    const routing = getSavingsByInfluence(dir).influences.find((i) => i.influence.startsWith('Model routing'))!;
    expect(routing.quality).toBe('measured');
    expect(routing.costSavedUsd).toBeCloseTo(45, 0); // 1M*7.5/1e6 + 1M*37.5/1e6
  });
});

describe('getOrchestrationTree', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'uap-tree-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('is fail-soft with no data', () => {
    const t = getOrchestrationTree(dir);
    expect(t.missions).toEqual([]);
    expect(t.hasHierarchy).toBe(false);
  });

  it('builds a parent -> child tree from tasks.db parent_id', () => {
    const tdir = join(dir, '.uap', 'tasks');
    mkdirSync(tdir, { recursive: true });
    const db = new Database(join(tdir, 'tasks.db'));
    db.exec(`CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT, type TEXT, status TEXT, assignee TEXT, parent_id TEXT, created_at TEXT);`);
    const ins = db.prepare('INSERT INTO tasks VALUES (?,?,?,?,?,?,?)');
    ins.run('m1', 'Mission', 'epic', 'in_progress', null, null, '2026-07-05T00:00:00Z');
    ins.run('t1', 'Build API', 'task', 'done', null, 'm1', '2026-07-05T00:01:00Z');
    ins.run('t2', 'Write tests', 'task', 'open', null, 'm1', '2026-07-05T00:02:00Z');
    db.close();
    const t = getOrchestrationTree(dir);
    expect(t.hasHierarchy).toBe(true);
    const mission = t.missions.find((m) => m.id === 'm1')!;
    expect(mission.children.map((c) => c.id).sort()).toEqual(['t1', 't2']);
  });

  it('folds in the completion ledger as the active-build tree', () => {
    const uap = join(dir, '.uap');
    mkdirSync(uap, { recursive: true });
    writeFileSync(join(uap, 'completion-ledger.json'), JSON.stringify({
      mission: 'Big build', createdAt: 'x', updatedAt: 'x',
      items: [{ id: 'e1', title: 'Design', kind: 'epic', status: 'done' }, { id: 'e2', title: 'Build', kind: 'epic', status: 'pending', deps: ['e1'] }],
    }));
    const t = getOrchestrationTree(dir);
    expect(t.ledger!.total).toBe(2);
    expect(t.ledger!.pct).toBe(50);
    expect(t.hasHierarchy).toBe(true);
  });
});
