/**
 * Model Analytics
 *
 * Tracks per-model, per-task-type performance metrics in SQLite.
 * Used by the dashboard to show model usage, cost, and success rates.
 */

import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import type { TaskComplexity } from './types.js';

/**
 * S1 ETA rows (orchestrated task attempts, delivery/eta.ts) carry REAL
 * durations and success but no token/cost data — the convergence loop's
 * totals are not visible at the orchestrated-mission seam. Cost, token and
 * task-count aggregates must not be diluted by zero-filled rows, so those
 * views filter them out; duration/success views (getSuccessRate,
 * getAvgLatency, recentDurations) deliberately keep them — the samples are
 * genuine and feed the ETA estimator.
 */
const EXCLUDE_SYNTHETIC_ETA_ROWS =
  "NOT (taskType = 'orchestrated' AND tokensIn = 0 AND tokensOut = 0 AND cost = 0)";

export interface TaskOutcome {
  modelId: string;
  taskType: string;
  complexity: TaskComplexity;
  success: boolean;
  durationMs: number;
  /** Turns spent on the attempt (ETA estimator input); 0 when unknown. */
  turns?: number;
  tokensUsed: { input: number; output: number };
  cost: number;
  taskId?: string;
  timestamp?: string;
}

export interface ModelMetrics {
  modelId: string;
  taskType: string;
  totalTasks: number;
  successes: number;
  failures: number;
  successRate: number;
  avgDurationMs: number;
  totalTokensIn: number;
  totalTokensOut: number;
  totalCost: number;
}

export interface CostBreakdown {
  modelId: string;
  totalCost: number;
  taskCount: number;
  avgCostPerTask: number;
  totalTokensIn: number;
  totalTokensOut: number;
}

export interface SessionModelUsage {
  modelId: string;
  taskCount: number;
  totalTokensIn: number;
  totalTokensOut: number;
  totalCost: number;
  successRate: number;
}

export class ModelAnalytics {
  private db: InstanceType<typeof Database>;

  constructor(dbPath?: string) {
    const resolvedPath =
      dbPath || join(process.cwd(), 'agents', 'data', 'memory', 'model_analytics.db');
    const dir = join(resolvedPath, '..');
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(resolvedPath);
    this.db.pragma('journal_mode = WAL');
    this.initialize();
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS task_outcomes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        modelId TEXT NOT NULL,
        taskType TEXT NOT NULL,
        complexity TEXT NOT NULL,
        success INTEGER NOT NULL,
        durationMs INTEGER NOT NULL,
        turns INTEGER NOT NULL DEFAULT 0,
        tokensIn INTEGER NOT NULL DEFAULT 0,
        tokensOut INTEGER NOT NULL DEFAULT 0,
        cost REAL NOT NULL DEFAULT 0,
        taskId TEXT,
        timestamp TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_outcomes_model ON task_outcomes(modelId);
      CREATE INDEX IF NOT EXISTS idx_outcomes_type ON task_outcomes(taskType);
      CREATE INDEX IF NOT EXISTS idx_outcomes_time ON task_outcomes(timestamp);
      CREATE INDEX IF NOT EXISTS idx_outcomes_task ON task_outcomes(taskId);
    `);
    // S1 ETA migration: databases created before `turns` existed lack the
    // column; add it in place so the ETA estimator can query historical rows.
    const columns = this.db.prepare('PRAGMA table_info(task_outcomes)').all() as Array<{
      name: string;
    }>;
    if (!columns.some((c) => c.name === 'turns')) {
      this.db.exec('ALTER TABLE task_outcomes ADD COLUMN turns INTEGER NOT NULL DEFAULT 0');
    }
  }

  /**
   * Record a task outcome
   */
  recordOutcome(outcome: TaskOutcome): void {
    const sql = `INSERT INTO task_outcomes (modelId, taskType, complexity, success, durationMs, turns, tokensIn, tokensOut, cost, taskId, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    this.db
      .prepare(sql)
      .run(
        outcome.modelId,
        outcome.taskType,
        outcome.complexity,
        outcome.success ? 1 : 0,
        outcome.durationMs,
        outcome.turns ?? 0,
        outcome.tokensUsed.input,
        outcome.tokensUsed.output,
        outcome.cost,
        outcome.taskId || null,
        outcome.timestamp || new Date().toISOString()
      );
  }

  /**
   * Get success rate for a model, optionally filtered by task type
   */
  getSuccessRate(modelId: string, taskType?: string): number {
    let sql =
      'SELECT COUNT(*) as total, SUM(success) as successes FROM task_outcomes WHERE modelId = ?';
    const params: unknown[] = [modelId];
    if (taskType) {
      sql += ' AND taskType = ?';
      params.push(taskType);
    }
    const row = this.db.prepare(sql).get(...params) as
      | { total: number; successes: number }
      | undefined;
    if (!row || row.total === 0) return 0;
    return row.successes / row.total;
  }

  /**
   * Get average latency for a model
   */
  getAvgLatency(modelId: string, taskType?: string): number {
    let sql = 'SELECT AVG(durationMs) as avg FROM task_outcomes WHERE modelId = ?';
    const params: unknown[] = [modelId];
    if (taskType) {
      sql += ' AND taskType = ?';
      params.push(taskType);
    }
    const row = this.db.prepare(sql).get(...params) as { avg: number | null } | undefined;
    return row?.avg || 0;
  }

  /**
   * Get metrics grouped by model and task type
   */
  getMetrics(modelId?: string): ModelMetrics[] {
    let sql = `
      SELECT
        modelId,
        taskType,
        COUNT(*) as totalTasks,
        SUM(success) as successes,
        COUNT(*) - SUM(success) as failures,
        CAST(SUM(success) AS REAL) / COUNT(*) as successRate,
        AVG(durationMs) as avgDurationMs,
        SUM(tokensIn) as totalTokensIn,
        SUM(tokensOut) as totalTokensOut,
        SUM(cost) as totalCost
      FROM task_outcomes
    `;
    const params: unknown[] = [];
    sql += ` WHERE ${EXCLUDE_SYNTHETIC_ETA_ROWS}`;
    if (modelId) {
      sql += ' AND modelId = ?';
      params.push(modelId);
    }
    sql += ' GROUP BY modelId, taskType ORDER BY modelId, totalTasks DESC';
    return this.db.prepare(sql).all(...params) as ModelMetrics[];
  }

  /**
   * Get cost breakdown per model
   */
  getCostBreakdown(since?: Date): CostBreakdown[] {
    let sql = `
      SELECT
        modelId,
        SUM(cost) as totalCost,
        COUNT(*) as taskCount,
        AVG(cost) as avgCostPerTask,
        SUM(tokensIn) as totalTokensIn,
        SUM(tokensOut) as totalTokensOut
      FROM task_outcomes
      WHERE ${EXCLUDE_SYNTHETIC_ETA_ROWS}
    `;
    const params: unknown[] = [];
    if (since) {
      sql += ' AND timestamp >= ?';
      params.push(since.toISOString());
    }
    sql += ' GROUP BY modelId ORDER BY totalCost DESC';
    return this.db.prepare(sql).all(...params) as CostBreakdown[];
  }

  /**
   * Get session model usage (all outcomes in current session)
   */
  getSessionUsage(): SessionModelUsage[] {
    const sql = `
      SELECT
        modelId,
        COUNT(*) as taskCount,
        SUM(tokensIn) as totalTokensIn,
        SUM(tokensOut) as totalTokensOut,
        SUM(cost) as totalCost,
        CAST(SUM(success) AS REAL) / COUNT(*) as successRate
      FROM task_outcomes
      WHERE ${EXCLUDE_SYNTHETIC_ETA_ROWS}
      GROUP BY modelId
      ORDER BY taskCount DESC
    `;
    return this.db.prepare(sql).all() as SessionModelUsage[];
  }

  /**
   * Get outcomes for a specific task
   */
  getTaskOutcomes(taskId: string): TaskOutcome[] {
    const rows = this.db
      .prepare('SELECT * FROM task_outcomes WHERE taskId = ? ORDER BY timestamp')
      .all(taskId) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      modelId: (r.modelId as string) ?? '',
      taskType: (r.taskType as string) ?? '',
      complexity: (r.complexity as TaskComplexity) ?? 'low',
      success: r.success === 1,
      durationMs: (r.durationMs as number) ?? 0,
      tokensUsed: { input: (r.tokensIn as number) ?? 0, output: (r.tokensOut as number) ?? 0 },
      cost: (r.cost as number) ?? 0,
      taskId: (r.taskId as string) ?? '',
      timestamp: (r.timestamp as string) ?? new Date().toISOString(),
    }));
  }

  /**
   * Get optimal routing suggestion based on historical data
   */
  getOptimalRouting(): Record<string, string> {
    const sql = `
      SELECT taskType, modelId, CAST(SUM(success) AS REAL) / COUNT(*) as rate, COUNT(*) as cnt
      FROM task_outcomes
      WHERE ${EXCLUDE_SYNTHETIC_ETA_ROWS}
      GROUP BY taskType, modelId
      HAVING cnt >= 3
      ORDER BY taskType, rate DESC
    `;
    const rows = this.db.prepare(sql).all() as Array<{
      taskType: string;
      modelId: string;
      rate: number;
    }>;
    const result: Record<string, string> = {};
    for (const row of rows) {
      if (!result[row.taskType]) {
        result[row.taskType] = row.modelId;
      }
    }
    return result;
  }

  /**
   * Get total session cost
   */
  getTotalCost(): number {
    const row = this.db.prepare('SELECT SUM(cost) as total FROM task_outcomes').get() as
      | { total: number | null }
      | undefined;
    return row?.total || 0;
  }

  /**
   * S1 ETA: recent per-attempt durations for one (model, taskType,
   * complexity) key, newest first — the sample stream the ETA estimator
   * (delivery/eta) folds into forecasts.
   */
  recentDurations(
    modelId: string,
    taskType: string,
    complexity: string,
    limit = 50
  ): Array<{ durationMs: number; success: boolean; turns: number; timestamp: string }> {
    const rows = this.db
      .prepare(
        `SELECT durationMs, success, turns, timestamp FROM task_outcomes
         WHERE modelId = ? AND taskType = ? AND complexity = ?
         ORDER BY id DESC LIMIT ?`
      )
      .all(modelId, taskType, complexity, Math.max(1, limit)) as Array<{
      durationMs: number;
      success: number;
      turns: number;
      timestamp: string;
    }>;
    return rows.map((r) => ({
      durationMs: r.durationMs,
      success: r.success === 1,
      turns: r.turns ?? 0,
      timestamp: r.timestamp,
    }));
  }

  close(): void {
    this.db.close();
  }
}

// Lazy singleton
let _instance: ModelAnalytics | null = null;
export function getModelAnalytics(): ModelAnalytics {
  if (!_instance) {
    _instance = new ModelAnalytics();
  }
  return _instance;
}
