/**
 * S1a · ETA instrumentation — the fail-soft timing recorder, its analytics
 * store rows, and the orchestrated-mission seam that feeds it.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createEtaRecorder, type TaskTiming } from '../../src/delivery/eta.js';
import { ModelAnalytics } from '../../src/models/analytics.js';
import { runOrchestratedMission, type OrchestratedMissionDeps } from '../../src/delivery/orchestrated-mission.js';
import type { DeliveryResult } from '../../src/delivery/convergence-loop.js';
import type { OrchestratorTask } from '../../src/delivery/task-orchestrator.js';

const dirs: string[] = [];
function tmp(): string {
  const d = join(tmpdir(), `uap-eta-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(d, { recursive: true });
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env.UAP_ETA_OFF;
});

describe('createEtaRecorder', () => {
  it('writes per-attempt rows keyed by model/type/complexity, newest first', () => {
    const db = join(tmp(), 'analytics.db');
    const record = createEtaRecorder({ dbPath: db, modelId: 'qwen35-a3b', taskType: 'orchestrated', complexity: 'high' });
    record({ taskId: 't1', success: true, durationMs: 1000, turns: 2 });
    record({ taskId: 't2', success: false, durationMs: 3000, turns: 5 });
    record({ taskId: 't3', success: true, durationMs: 2000, turns: 3 });

    const analytics = new ModelAnalytics(db);
    const rows = analytics.recentDurations('qwen35-a3b', 'orchestrated', 'high');
    expect(rows).toHaveLength(3);
    // Newest first: the LAST recorded attempt is the FIRST sample.
    expect(rows[0].durationMs).toBe(2000);
    expect(rows[0].success).toBe(true);
    expect(rows[0].turns).toBe(3);
    expect(rows[2].durationMs).toBe(1000);
    // Failed attempts are part of the sample stream — ETAs must know the slow path.
    expect(rows.some((r) => r.success === false && r.durationMs === 3000)).toBe(true);
    expect(analytics.getSuccessRate('qwen35-a3b', 'orchestrated')).toBeCloseTo(2 / 3);
    analytics.close();
  });

  it('defaults the type/complexity keys to orchestrated/medium', () => {
    const db = join(tmp(), 'analytics.db');
    createEtaRecorder({ dbPath: db, modelId: 'm1' })({
      taskId: 't1', success: true, durationMs: 10, turns: 1,
    });
    const analytics = new ModelAnalytics(db);
    expect(analytics.recentDurations('m1', 'orchestrated', 'medium')).toHaveLength(1);
    // A different key must not see the sample.
    expect(analytics.recentDurations('m1', 'orchestrated', 'high')).toHaveLength(0);
    analytics.close();
  });

  it('is fail-soft: an unopenable store disables the sink without throwing', () => {
    const dirAsDb = join(tmp(), 'not-a-db'); // a directory, not a database file
    const record = createEtaRecorder({ dbPath: dirAsDb, modelId: 'm1' });
    expect(() =>
      record({ taskId: 't1', success: true, durationMs: 1, turns: 1 })
    ).not.toThrow();
    // The broken latch holds: later attempts skip silently too.
    expect(() =>
      record({ taskId: 't2', success: true, durationMs: 1, turns: 1 })
    ).not.toThrow();
  });

  it('migrates a pre-turns database in place', async () => {
    const db = join(tmp(), 'legacy.db');
    // A database created before the `turns` column existed (old schema).
    const Database = (await import('better-sqlite3')).default;
    const raw = new Database(db);
    raw.exec(`
      CREATE TABLE task_outcomes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        modelId TEXT NOT NULL,
        taskType TEXT NOT NULL,
        complexity TEXT NOT NULL,
        success INTEGER NOT NULL,
        durationMs INTEGER NOT NULL,
        tokensIn INTEGER NOT NULL DEFAULT 0,
        tokensOut INTEGER NOT NULL DEFAULT 0,
        cost REAL NOT NULL DEFAULT 0,
        taskId TEXT,
        timestamp TEXT NOT NULL
      );
    `);
    raw
      .prepare(
        'INSERT INTO task_outcomes (modelId, taskType, complexity, success, durationMs, timestamp) VALUES (?,?,?,?,?,?)'
      )
      .run('m1', 'orchestrated', 'medium', 1, 500, '2026-01-01T00:00:00.000Z');
    raw.close();

    // Opening through ModelAnalytics migrates: the legacy row reads turns=0,
    // and new rows record turns.
    const analytics = new ModelAnalytics(db);
    const legacy = analytics.recentDurations('m1', 'orchestrated', 'medium');
    expect(legacy).toHaveLength(1);
    expect(legacy[0]).toMatchObject({ durationMs: 500, success: true, turns: 0 });
    analytics.recordOutcome({
      modelId: 'm1',
      taskType: 'orchestrated',
      complexity: 'medium' as never,
      success: true,
      durationMs: 10,
      turns: 7,
      tokensUsed: { input: 0, output: 0 },
      cost: 0,
    });
    expect(analytics.recentDurations('m1', 'orchestrated', 'medium')[0]).toMatchObject({
      durationMs: 10,
      turns: 7,
    });
    analytics.close();
  });

  it('UAP_ETA_OFF=1 installs a no-op sink that writes nothing', () => {
    process.env.UAP_ETA_OFF = '1';
    const db = join(tmp(), 'analytics.db');
    createEtaRecorder({ dbPath: db, modelId: 'm1' })({
      taskId: 't1', success: true, durationMs: 1, turns: 1,
    });
    expect(existsSync(db)).toBe(false);
  });
});

describe('orchestrated-mission recordTiming seam', () => {
  const missionTask = (id: string, deps?: string[]): OrchestratorTask => ({
    id,
    title: id,
    goal: `build ${id}`,
    ...(deps ? { deps } : {}),
  });
  const loopResult = (over: Partial<DeliveryResult> = {}): DeliveryResult => ({
    success: true,
    alreadyDelivered: false,
    turns: 1,
    bestScore: 1,
    bestTurn: 1,
    history: [],
    finalFeedback: '',
    finalOutput: '',
    totalDurationMs: 1,
    ...over,
  });

  it('emits one sample per task attempt, failures included', async () => {
    const timings: TaskTiming[] = [];
    const deps: OrchestratedMissionDeps = {
      instruction: 'mission',
      projectRoot: '/main',
      tasks: [missionTask('a'), missionTask('b')],
      parallelTasks: 1,
      workspaceManager: null,
      runLoop: async ({ taskId }) =>
        taskId === 'a'
          ? loopResult({ totalDurationMs: 4242, turns: 3 })
          : loopResult({ totalDurationMs: 99, turns: 1, success: false }),
      recordTiming: (t) => timings.push(t),
    };
    const result = await runOrchestratedMission(deps);
    expect(result.success).toBe(false);
    // THREE samples, not two: the orchestrator's default minimal repair
    // (UAP_ORCH_TASK_REPAIRS fallback 1) re-executes the failed node, and a
    // repair attempt is an attempt — the ETA sample stream must see it.
    expect(timings).toHaveLength(3);
    expect(timings.find((t) => t.taskId === 'a')).toEqual({
      taskId: 'a', success: true, durationMs: 4242, turns: 3,
    });
    expect(
      timings.filter((t) => t.success === false && t.durationMs === 99 && t.turns === 1)
    ).toHaveLength(2);
  });
});
