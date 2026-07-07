/**
 * Persisted telemetry store for dashboard panels that would otherwise read
 * empty in-process singletons.
 *
 * The compression (`globalSessionStats`) and performance (`getPerformanceMonitor`)
 * singletons are only populated inside the MCP-router / model-executor / memory
 * processes. The `uap dash serve` process is a *separate* process, so it sees
 * empty singletons and renders 0/empty Compression + Performance panels.
 *
 * These functions let the producing processes persist their samples to the
 * shared `telemetry.db` (keyed by project cwd) so the dashboard process can read
 * the real, cross-process values instead of the in-memory singleton.
 *
 * All writes are best-effort and fail open — telemetry must never break a hot
 * path or a tool call.
 */
import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { computePercentiles, type PerformanceMetrics } from './performance-monitor.js';

export interface PersistedCompressionStats {
  rawBytes: number;
  contextBytes: number;
  savingsPercent: string;
  totalCalls: number;
}

/** Keep at most this many perf samples per metric (mirrors PerformanceMonitor.maxSamples). */
const PERF_SAMPLES_PER_METRIC = 1000;

/** Cached DB handles, one per project cwd. Reused across calls to avoid open/close churn on hot paths. */
const dbCache = new Map<string, Database.Database>();

let perfInsertCount = 0;

function telemetryDbPath(cwd: string): string {
  return join(cwd, 'agents', 'data', 'memory', 'telemetry.db');
}

/**
 * Open (creating dir + tables) the shared telemetry.db, caching the handle per
 * cwd. Returns null on any failure so callers can fail open.
 */
function openStore(cwd: string): Database.Database | null {
  const cached = dbCache.get(cwd);
  if (cached) return cached;
  try {
    const dbPath = telemetryDbPath(cwd);
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    // WAL + NORMAL so hot-path producer writes and the dash-serve reader don't
    // block each other (this DB is written by 3 producer process families and
    // read by the dashboard). Matches every other cross-process store in the
    // repo (coordination/tasks/analytics).
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('busy_timeout = 10000');
    db.exec(`
      CREATE TABLE IF NOT EXISTS compression_stats (
        tool TEXT PRIMARY KEY,
        calls INTEGER NOT NULL DEFAULT 0,
        raw_bytes INTEGER NOT NULL DEFAULT 0,
        context_bytes INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS perf_samples (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        metric TEXT NOT NULL,
        duration_ms REAL NOT NULL,
        ts TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_perf_samples_metric ON perf_samples(metric);
    `);
    dbCache.set(cwd, db);
    return db;
  } catch {
    return null;
  }
}

/**
 * Record a single compression sample (one tool call) as a running per-tool
 * total. Cheap UPSERT — no per-call row growth.
 */
export function persistCompressionSample(
  cwd: string,
  tool: string,
  rawBytes: number,
  contextBytes: number
): void {
  const db = openStore(cwd);
  if (!db) return;
  try {
    db.prepare(
      `INSERT INTO compression_stats (tool, calls, raw_bytes, context_bytes, updated_at)
       VALUES (?, 1, ?, ?, datetime('now'))
       ON CONFLICT(tool) DO UPDATE SET
         calls = calls + 1,
         raw_bytes = raw_bytes + excluded.raw_bytes,
         context_bytes = context_bytes + excluded.context_bytes,
         updated_at = datetime('now')`
    ).run(tool || 'unknown', Math.max(0, Math.round(rawBytes)), Math.max(0, Math.round(contextBytes)));
  } catch {
    /* best-effort */
  }
}

/**
 * Read aggregate compression totals across all tools. Returns honest zeros
 * (savings '0%') when nothing has been persisted yet.
 */
export function readCompressionStats(cwd: string): PersistedCompressionStats {
  const empty: PersistedCompressionStats = {
    rawBytes: 0,
    contextBytes: 0,
    savingsPercent: '0%',
    totalCalls: 0,
  };
  if (!existsSync(telemetryDbPath(cwd))) return empty;
  const db = openStore(cwd);
  if (!db) return empty;
  try {
    const row = db
      .prepare(
        `SELECT COALESCE(SUM(calls),0) AS calls,
                COALESCE(SUM(raw_bytes),0) AS raw,
                COALESCE(SUM(context_bytes),0) AS ctx
         FROM compression_stats`
      )
      .get() as { calls: number; raw: number; ctx: number };
    const rawBytes = row.raw || 0;
    const contextBytes = row.ctx || 0;
    const savingsPercent =
      rawBytes > 0 ? `${Math.round((1 - contextBytes / rawBytes) * 100)}%` : '0%';
    return { rawBytes, contextBytes, savingsPercent, totalCalls: row.calls || 0 };
  } catch {
    return empty;
  }
}

/**
 * Record a single performance sample. Individual samples are retained (bounded
 * to a rolling window per metric) so read-time percentile computation matches
 * the in-memory PerformanceMonitor.
 */
export function persistPerfSample(cwd: string, metric: string, durationMs: number): void {
  if (!metric || !Number.isFinite(durationMs) || durationMs < 0) return;
  const db = openStore(cwd);
  if (!db) return;
  try {
    db.prepare('INSERT INTO perf_samples (metric, duration_ms) VALUES (?, ?)').run(metric, durationMs);
    // Prune periodically to bound the table (mirror the in-memory rolling window).
    if (++perfInsertCount % 50 === 0) {
      db.prepare(
        `DELETE FROM perf_samples WHERE id IN (
           SELECT id FROM (
             SELECT id, ROW_NUMBER() OVER (PARTITION BY metric ORDER BY id DESC) AS rn
             FROM perf_samples
           ) WHERE rn > ?
         )`
      ).run(PERF_SAMPLES_PER_METRIC);
    }
  } catch {
    /* best-effort */
  }
}

/**
 * Read per-metric performance percentiles from the persisted samples. Mirrors
 * `PerformanceMonitor.exportMetrics()` shape/semantics so the dashboard renders
 * identically whether data comes from the store or the in-process singleton.
 */
export function readPerfMetrics(cwd: string): Record<string, PerformanceMetrics> {
  const result: Record<string, PerformanceMetrics> = {};
  if (!existsSync(telemetryDbPath(cwd))) return result;
  const db = openStore(cwd);
  if (!db) return result;
  try {
    const rows = db
      .prepare('SELECT metric, duration_ms FROM perf_samples ORDER BY metric, id')
      .all() as Array<{ metric: string; duration_ms: number }>;
    const byMetric = new Map<string, number[]>();
    for (const r of rows) {
      const arr = byMetric.get(r.metric) ?? [];
      arr.push(r.duration_ms);
      byMetric.set(r.metric, arr);
    }
    for (const [metric, samples] of byMetric) {
      const stats = computePercentiles(samples);
      if (stats) result[metric] = stats;
    }
    return result;
  } catch {
    return result;
  }
}

/**
 * Close and drop cached DB handles. Test-only cleanup to avoid handle leaks
 * across many temp-dir fixtures.
 */
export function closeTelemetryStores(cwd?: string): void {
  if (cwd) {
    const db = dbCache.get(cwd);
    if (db) {
      try {
        db.close();
      } catch {
        /* ignore */
      }
      dbCache.delete(cwd);
    }
    return;
  }
  for (const db of dbCache.values()) {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
  dbCache.clear();
}
