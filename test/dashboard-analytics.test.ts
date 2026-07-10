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
import { getSavingsByInfluence, __setRtkRunnerForTest } from '../src/dashboard/savings.js';
import { getOrchestrationTree } from '../src/dashboard/orchestration-tree.js';
import { dashboardBundle } from './helpers/dashboard-bundle.js';

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

  it('makes the empty routing state explicit (why it is idle), not a silent zero', () => {
    const routing = getSavingsByInfluence(dir).influences.find((i) => i.influence.startsWith('Model routing'))!;
    expect(routing.quality).toBe('unmeasured');
    expect(routing.detail).toMatch(/inactive/i);
    expect(routing.detail).toMatch(/no UAP-routed tasks/i);
  });

  it('reports exists-but-empty analytics as unmeasured (dimmed), not measured $0 (D)', () => {
    const mdir = join(dir, 'agents', 'data', 'memory');
    mkdirSync(mdir, { recursive: true });
    const db = new Database(join(mdir, 'model_analytics.db'));
    db.exec('CREATE TABLE task_outcomes (modelId TEXT, taskType TEXT, complexity TEXT, success INTEGER, durationMs INTEGER, tokensIn INTEGER, tokensOut INTEGER, cost REAL, taskId TEXT, timestamp TEXT);');
    db.close(); // table present, zero rows
    const routing = getSavingsByInfluence(dir).influences.find((i) => i.influence.startsWith('Model routing'))!;
    expect(routing.quality).toBe('unmeasured');
    expect(routing.costSavedUsd).toBe(0);
    expect(routing.detail).toMatch(/no UAP-routed tasks/i);
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

describe('dashboard savings table — explicit idle state', () => {
  it('renders unmeasured influences as a dimmed em-dash, not a $0 cell', () => {
    // PR #410 (dashboard-uplift): renderSavings moved from inline
    // dashboard.html into the Memory tab of web/dash/tabs.js (the
    // "Token Savings by Influence" panel); the shared idleCell constant
    // became inline muted em-dash spans in the idle branch.
    const src = dashboardBundle();
    const start = src.indexOf("'Token Savings by Influence'");
    expect(start).toBeGreaterThan(-1);
    const block = src.slice(start, start + 1400);
    // idle rows are branched on quality and rendered as dimmed em-dashes,
    // never through the real cost/token formatting.
    expect(block).toContain("i.quality === 'unmeasured'");
    expect(block).toMatch(/idle \? el\('span', \{ class: 'muted', text: '—' \}\)/);
  });
});

describe('rtk savings cache (perf)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'uap-rtk-')); });
  afterEach(() => { __setRtkRunnerForTest(null); rmSync(dir, { recursive: true, force: true }); });

  it('runs `rtk gain` at most once across rapid dashboard refreshes (cached)', () => {
    let calls = 0;
    __setRtkRunnerForTest(() => { calls += 1; return JSON.stringify({ summary: { total_saved: 1000, avg_savings_pct: 60, total_commands: 42 } }); });
    const a = getSavingsByInfluence(dir);
    getSavingsByInfluence(dir);
    getSavingsByInfluence(dir);
    expect(calls).toBe(1); // 3 reads, one subprocess (was 3 * ~1.9s -> ~1.9s once/TTL)
    const rtk = a.influences.find((i) => i.influence.startsWith('RTK'))!;
    expect(rtk.quality).toBe('measured');
    expect(rtk.tokensSaved).toBe(1000);
  });

  it('clears the cache when the runner is swapped (fresh value)', () => {
    let calls = 0;
    __setRtkRunnerForTest(() => { calls += 1; return JSON.stringify({ summary: { total_saved: 5 } }); });
    expect(getSavingsByInfluence(dir).influences.find((i) => i.influence.startsWith('RTK'))!.tokensSaved).toBe(5);
    __setRtkRunnerForTest(() => { calls += 1; return JSON.stringify({ summary: { total_saved: 9 } }); });
    expect(getSavingsByInfluence(dir).influences.find((i) => i.influence.startsWith('RTK'))!.tokensSaved).toBe(9);
    expect(calls).toBe(2);
  });

  it('caches failures too (a broken rtk does not re-run every refresh)', () => {
    let calls = 0;
    __setRtkRunnerForTest(() => { calls += 1; throw new Error('rtk missing'); });
    const a = getSavingsByInfluence(dir).influences.find((i) => i.influence.startsWith('RTK'))!;
    getSavingsByInfluence(dir);
    expect(calls).toBe(1);
    expect(a.quality).toBe('unmeasured');
  });
});
