/**
 * Per-tool-call evidence corpus (harness plan areas D1/D3, 2026-07-31).
 *
 * Before this module, UAP's telemetry recorded sessions, routing decisions and
 * time series — but NOT what happened inside the agent loop. The self-harness
 * propose stage therefore had no evidence to reason from, which is why it could
 * only search inference-server knobs: those are the only thing it could measure.
 *
 * Agentic Harness Engineering (arXiv 2604.25850) calls this layer "experience
 * observability": distil trajectories into a layered corpus with per-task failure
 * analysis and a benchmark-level overview, so mutation proposal is grounded
 * rather than blind. This is that corpus, at the resolution that matters — one
 * row per tool call, attributed to a harness component and a stable failure
 * class.
 *
 * Every write is best-effort and fails open. Telemetry must never break the
 * agent loop it is observing.
 */
import Database from 'better-sqlite3';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  classifyToolResult,
  componentForTool,
  isFailureClass,
  type HarnessComponent,
  type ToolOutcomeClass,
} from './tool-failure.js';

/**
 * Rolling cap: the corpus is a diagnosis aid, not an audit log.
 * `UAP_TOOL_CORPUS_MAX_ROWS` overrides it (same override family as
 * `UAP_TOOL_CORPUS_DIR`) so turnover is drivable in small-cap tests and
 * paired-bench cells without 20k inserts.
 */
function maxToolCallRows(): number {
  const parsed = parseInt(process.env.UAP_TOOL_CORPUS_MAX_ROWS ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : 20_000;
}

const dbCache = new Map<string, Database.Database>();
/**
 * Handle cap. A paired bench runs each cell in its own temp dir, so an unbounded
 * per-cwd cache leaks a better-sqlite3 handle (x3 files with WAL/SHM) per cell
 * and hits the fd limit on a 200-cell run.
 */
const MAX_CACHED_DBS = 8;
let insertCount = 0;

/**
 * Where the corpus lives.
 *
 * NOT under the target project. Two reasons, both found in review:
 *
 *  - A paired bench runs every cell in a throwaway temp dir, so a project-rooted
 *    corpus is written into directories that are deleted moments later. The
 *    evidence from the exact workload the loop is meant to learn from vanished,
 *    and `uap harness evidence` read a different path again (`process.cwd()`).
 *  - On a customer repo it created `agents/data/memory/telemetry.db` inside
 *    their tree — untracked noise at best, committed by an `add -A` at worst.
 *
 * A single per-user store keeps the corpus continuous across runs, which is what
 * cross-run failure ranking needs. `UAP_TOOL_CORPUS_DIR` overrides it (tests).
 */
export function toolCorpusRoot(): string {
  return process.env.UAP_TOOL_CORPUS_DIR || join(homedir(), '.uap', 'telemetry');
}

function dbPathFor(root: string): string {
  return join(root, 'tool-calls.db');
}

function eraHistoryPath(root: string): string {
  return join(root, 'era-history.jsonl');
}

/**
 * Day-level aggregates of the rows about to leave the rolling cap, appended
 * to era-history.jsonl beside the corpus. The cap (and a wiped/recreated
 * tool-calls.db — seen live on 2026-11-21) erases raw rows; the era table
 * is the before/after instrument, so the days it compares must survive the
 * turnover that removes their evidence rows. Append-only, one JSON object
 * per line; readers merge duplicate day lines (a re-prune of the same rows
 * is additive there, not double-counted by anything else).
 *
 * Best-effort, like every write in this module: archival must never break
 * the prune it precedes or the tool call that triggered it.
 */
function archivePrunedEra(db: Database.Database, root: string): void {
  try {
    const rows = db
      .prepare(
        `SELECT substr(ts, 1, 10) AS day, COUNT(*) AS calls, COALESCE(SUM(failed),0) AS failures
         FROM tool_calls WHERE id <= (SELECT MAX(id) - ? FROM tool_calls)
         GROUP BY day ORDER BY day`,
      )
      .all(maxToolCallRows()) as Array<{ day: string; calls: number; failures: number }>;
    if (rows.length === 0) return;
    appendFileSync(
      eraHistoryPath(root),
      rows.map((r) => JSON.stringify({ day: r.day, calls: r.calls, failures: r.failures })).join('\n') + '\n',
    );
  } catch {
    /* best-effort */
  }
}

/** Merged day aggregates from era-history.jsonl; empty map when absent. */
function readEraHistory(root: string): Map<string, { calls: number; failures: number }> {
  const out = new Map<string, { calls: number; failures: number }>();
  try {
    for (const line of readFileSync(eraHistoryPath(root), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as { day?: unknown; calls?: unknown; failures?: unknown };
        if (typeof r.day !== 'string' || typeof r.calls !== 'number' || typeof r.failures !== 'number') continue;
        const agg = out.get(r.day) ?? { calls: 0, failures: 0 };
        agg.calls += r.calls;
        agg.failures += r.failures;
        out.set(r.day, agg);
      } catch {
        /* skip a corrupt line; the table must not die on one */
      }
    }
  } catch {
    /* no history yet */
  }
  return out;
}

function openStore(cwd: string): Database.Database | null {
  const cached = dbCache.get(cwd);
  if (cached) return cached;
  try {
    const dbPath = dbPathFor(cwd);
    mkdirSync(dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    // Same pragmas as the other producers of this file: WAL so the dashboard
    // reader never blocks the agent loop, and a SHORT busy timeout because a
    // dropped telemetry row beats stalling a tool call.
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('busy_timeout = 2000');
    db.exec(`
      CREATE TABLE IF NOT EXISTS tool_calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL DEFAULT (datetime('now')),
        run_id TEXT,
        task_id TEXT,
        component TEXT NOT NULL,
        tool TEXT NOT NULL,
        outcome TEXT NOT NULL,
        failed INTEGER NOT NULL DEFAULT 0,
        turn INTEGER,
        path TEXT,
        latency_ms INTEGER,
        bytes INTEGER,
        detail TEXT,
        run_kind TEXT NOT NULL DEFAULT 'live'
      );
      CREATE INDEX IF NOT EXISTS idx_tool_calls_run ON tool_calls(run_id);
      CREATE INDEX IF NOT EXISTS idx_tool_calls_outcome ON tool_calls(outcome);
      CREATE INDEX IF NOT EXISTS idx_tool_calls_component ON tool_calls(component);
    `);
    // D.3 migration: a corpus written before run_kind existed keeps every
    // legacy row in the 'live' bucket; new rows carry what the recorder says.
    try {
      const cols = db.prepare('PRAGMA table_info(tool_calls)').all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === 'run_kind')) {
        db.exec("ALTER TABLE tool_calls ADD COLUMN run_kind TEXT NOT NULL DEFAULT 'live'");
      }
    } catch {
      /* best-effort */
    }
    // Prune on OPEN, not on an insert counter: a deliver process records ~12
    // rows and exits, so a `% 100` counter reset per process meant the row cap
    // was never enforced and the table grew without bound across runs.
    // Archive first: the pruned rows' days must survive in era-history.jsonl.
    try {
      archivePrunedEra(db, cwd);
      db.prepare('DELETE FROM tool_calls WHERE id <= (SELECT MAX(id) - ? FROM tool_calls)').run(
        maxToolCallRows(),
      );
    } catch {
      /* best-effort */
    }
    if (dbCache.size >= MAX_CACHED_DBS) {
      const oldest = dbCache.keys().next().value;
      if (oldest !== undefined) {
        try {
          dbCache.get(oldest)?.close();
        } catch {
          /* ignore */
        }
        dbCache.delete(oldest);
      }
    }
    dbCache.set(cwd, db);
    return db;
  } catch {
    return null;
  }
}

export interface ToolCallRecord {
  runId?: string;
  taskId?: string;
  tool: string;
  /** Raw result string handed back to the model — classified, then discarded. */
  result: string;
  turn?: number;
  path?: string;
  latencyMs?: number;
  bytes?: number;
  /** Override the derived component (e.g. a middleware-attributed call). */
  component?: HarnessComponent;
  /**
   * D.3 run-kind segmentation: 'benchmark' for fixture/benchmark traffic,
   * 'live' for real agent sessions. When omitted it derives from
   * UAP_RUN_KIND=benchmark, so a benchmark harness tags its whole corpus
   * with one env var.
   */
  runKind?: 'benchmark' | 'live';
}

/**
 * Record one tool call. Returns the class it was filed under so callers can
 * assert on it in tests without reading the DB back.
 */
export function recordToolCall(rec: ToolCallRecord, root = toolCorpusRoot()): ToolOutcomeClass {
  const outcome = classifyToolResult(rec.tool, rec.result);
  const db = openStore(root);
  if (!db) return outcome;
  try {
    const component = rec.component ?? componentForTool(rec.tool);
    // Only failures keep a detail excerpt, and only the FIRST LINE of one.
    // The full text of an edit-miss now embeds `nearestMatchReport` — numbered
    // lines of the user's current source — which this table would otherwise
    // persist indefinitely, and into the target repo's tree at that. The first
    // line carries the reason; the source body carries risk and no signal.
    const detail = isFailureClass(outcome)
      ? String(rec.result ?? '').split('\n')[0].slice(0, 300)
      : null;
    const runKind =
      rec.runKind ?? (process.env.UAP_RUN_KIND === 'benchmark' ? 'benchmark' : 'live');
    db.prepare(
      `INSERT INTO tool_calls
         (run_id, task_id, component, tool, outcome, failed, turn, path, latency_ms, bytes, detail, run_kind)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      rec.runId ?? null,
      rec.taskId ?? null,
      component,
      rec.tool,
      outcome,
      isFailureClass(outcome) ? 1 : 0,
      rec.turn ?? null,
      rec.path ?? null,
      rec.latencyMs ?? null,
      rec.bytes ?? null,
      detail,
      runKind,
    );
    if (++insertCount % 100 === 0) {
      // The rows leaving the cap take their days' era numbers with them
      // unless archived first.
      archivePrunedEra(db, root);
      db.prepare(
        `DELETE FROM tool_calls WHERE id <= (SELECT MAX(id) - ? FROM tool_calls)`,
      ).run(maxToolCallRows());
    }
  } catch {
    /* best-effort */
  }
  return outcome;
}

export interface ToolFailureRow {
  component: HarnessComponent | string;
  tool: string;
  outcome: ToolOutcomeClass | string;
  count: number;
}

export interface EvidenceSummary {
  totalCalls: number;
  failedCalls: number;
  /** Share of calls that failed, 0..1. The headline harness-health number. */
  failureRate: number;
  /** Failure counts grouped by component, most-costly first. */
  byComponent: Array<{ component: string; failures: number; calls: number }>;
  /** D.3: benchmark vs live segmentation of the same window. */
  byRunKind: Array<{ runKind: string; calls: number; failures: number }>;
  /** Failure classes, most frequent first — the evolve stage's work queue. */
  topFailures: ToolFailureRow[];
  /** Edit-tool specific health, because it is the highest-leverage surface. */
  editHealth: {
    attempts: number;
    exact: number;
    tolerant: number;
    misses: number;
    ambiguous: number;
    /** Share of edit attempts that landed at all, 0..1. */
    successRate: number;
  };
}

const EMPTY_SUMMARY: EvidenceSummary = {
  totalCalls: 0,
  failedCalls: 0,
  failureRate: 0,
  byComponent: [],
  byRunKind: [],
  topFailures: [],
  editHealth: { attempts: 0, exact: 0, tolerant: 0, misses: 0, ambiguous: 0, successRate: 0 },
};

/**
 * Distil the corpus into the layered view the propose stage consumes: an
 * overall health number, per-component attribution, a ranked failure queue, and
 * the edit-tool detail.
 *
 * `runId` scopes the summary to a single run; omit it for the whole corpus.
 */
export function summarizeToolCalls(runId?: string, root = toolCorpusRoot()): EvidenceSummary {
  if (!existsSync(dbPathFor(root))) return EMPTY_SUMMARY;
  const db = openStore(root);
  if (!db) return EMPTY_SUMMARY;
  const where = runId ? 'WHERE run_id = ?' : '';
  const params = runId ? [runId] : [];
  try {
    const totals = db
      .prepare(
        `SELECT COUNT(*) AS calls, COALESCE(SUM(failed),0) AS failures FROM tool_calls ${where}`,
      )
      .get(...params) as { calls: number; failures: number };
    if (!totals || totals.calls === 0) return EMPTY_SUMMARY;

    const byComponent = db
      .prepare(
        `SELECT component, COUNT(*) AS calls, COALESCE(SUM(failed),0) AS failures
         FROM tool_calls ${where}
         GROUP BY component ORDER BY failures DESC, calls DESC`,
      )
      .all(...params) as Array<{ component: string; calls: number; failures: number }>;

    // D.3: COALESCE folds pre-migration NULLs (and rows written by an older
    // recorder between CREATE and ALTER) into 'live'.
    const byRunKind = db
      .prepare(
        `SELECT COALESCE(run_kind,'live') AS run_kind, COUNT(*) AS calls,
                COALESCE(SUM(failed),0) AS failures
         FROM tool_calls ${where}
         GROUP BY COALESCE(run_kind,'live') ORDER BY calls DESC`,
      )
      .all(...params) as Array<{ run_kind: string; calls: number; failures: number }>;

    const topFailures = db
      .prepare(
        `SELECT component, tool, outcome, COUNT(*) AS count
         FROM tool_calls ${where ? `${where} AND failed = 1` : 'WHERE failed = 1'}
         GROUP BY component, tool, outcome ORDER BY count DESC LIMIT 20`,
      )
      .all(...params) as ToolFailureRow[];

    const editRows = db
      .prepare(
        `SELECT outcome, COUNT(*) AS count FROM tool_calls
         ${where ? `${where} AND` : 'WHERE'} tool IN ('edit_file','edit_range')
         GROUP BY outcome`,
      )
      .all(...params) as Array<{ outcome: string; count: number }>;

    const editCount = (o: string) => editRows.find((r) => r.outcome === o)?.count ?? 0;
    const exact = editCount('ok');
    const tolerant = editCount('ok-tolerant');
    const misses = editCount('edit-miss');
    const ambiguous = editCount('edit-ambiguous');
    const attempts = editRows.reduce((n, r) => n + r.count, 0);

    return {
      totalCalls: totals.calls,
      failedCalls: totals.failures,
      failureRate: totals.calls > 0 ? totals.failures / totals.calls : 0,
      byComponent: byComponent.map((r) => ({
        component: r.component,
        failures: r.failures,
        calls: r.calls,
      })),
      byRunKind: byRunKind.map((r) => ({
        runKind: r.run_kind,
        failures: r.failures,
        calls: r.calls,
      })),
      topFailures,
      editHealth: {
        attempts,
        exact,
        tolerant,
        misses,
        ambiguous,
        successRate: attempts > 0 ? (exact + tolerant) / attempts : 0,
      },
    };
  } catch {
    return EMPTY_SUMMARY;
  }
}

/**
 * Render the summary as the prose block the propose stage puts in front of a
 * model. Kept here (not in the prompt) so evidence and its formatting version
 * together, and so a human can read the same text with `uap harness evidence`.
 */
export function renderEvidence(summary: EvidenceSummary): string {
  if (summary.totalCalls === 0) return 'No tool-call evidence recorded yet.';
  const lines: string[] = [];
  lines.push(
    `Tool calls: ${summary.totalCalls} | failed: ${summary.failedCalls} ` +
      `(${(summary.failureRate * 100).toFixed(1)}%)`,
  );
  if (summary.byComponent.length > 0) {
    lines.push('');
    lines.push('By harness component (failures/calls):');
    for (const c of summary.byComponent) {
      lines.push(`  ${c.component.padEnd(10)} ${c.failures}/${c.calls}`);
    }
  }
  if (summary.byRunKind.length > 1) {
    // D.3: only worth a line once the corpus actually MIXES the kinds — a
    // corpus that is all-live says nothing a reader does not already know.
    lines.push('');
    lines.push('By run kind (failed/calls):');
    for (const r of summary.byRunKind) {
      lines.push(`  ${r.runKind.padEnd(10)} ${r.failures}/${r.calls}`);
    }
  }
  const e = summary.editHealth;
  if (e.attempts > 0) {
    lines.push('');
    lines.push(
      `Edit tool: ${e.attempts} attempts | exact ${e.exact} | tolerant ${e.tolerant} | ` +
        `miss ${e.misses} | ambiguous ${e.ambiguous} | success ${(e.successRate * 100).toFixed(1)}%`,
    );
  }
  if (summary.topFailures.length > 0) {
    lines.push('');
    lines.push('Top failure classes:');
    for (const f of summary.topFailures.slice(0, 10)) {
      lines.push(`  ${String(f.count).padStart(4)}x ${f.tool}/${f.outcome} [${f.component}]`);
    }
  }
  return lines.join('\n');
}

export interface ToolRateRow {
  tool: string;
  calls: number;
  failures: number;
  failureRate: number;
}

/**
 * Per-tool call/failure rates, highest failure count first. The write-path
 * uplifts are measured against this table (the 2026-11-14 monitoring found
 * 83% of failures in the write/edit family here).
 */
export function toolFailureRates(root = toolCorpusRoot()): ToolRateRow[] {
  if (!existsSync(dbPathFor(root))) return [];
  const db = openStore(root);
  if (!db) return [];
  try {
    const rows = db
      .prepare(
        `SELECT tool, COUNT(*) AS calls, COALESCE(SUM(failed),0) AS failures
         FROM tool_calls GROUP BY tool ORDER BY failures DESC, calls DESC`,
      )
      .all() as Array<{ tool: string; calls: number; failures: number }>;
    return rows.map((r) => ({
      tool: r.tool,
      calls: r.calls,
      failures: r.failures,
      failureRate: r.calls > 0 ? r.failures / r.calls : 0,
    }));
  } catch {
    return [];
  }
}

export interface DailyToolCallRate {
  day: string;
  calls: number;
  failures: number;
  failureRate: number;
}

/**
 * Per-day call/failure rates over the corpus — the era table. The corpus is
 * rolling-capped (maxToolCallRows()) and test runs are corpus-isolated, so
 * days whose rows have turned over live on in era-history.jsonl (written when
 * the prune drops them); this table unions history and live rows, so a
 * before/after comparison survives the turnover that erased its evidence.
 */
export function dailyToolCallRates(days = 14, root = toolCorpusRoot()): DailyToolCallRate[] {
  const windowDays = Math.max(1, Math.trunc(days));
  // The earliest day the window can still show, in the corpus's own UTC
  // `YYYY-MM-DD` day keys (substr(ts,1,10)).
  const cutoffDay = new Date(Date.now() - windowDays * 86_400_000).toISOString().slice(0, 10);
  // Open (and thus prune) BEFORE reading history: the prune-on-open may
  // archive this call's own turnover, and reading history first would
  // under-count exactly the rows it just archived (they are in neither the
  // stale history map nor the post-delete live select).
  const db = existsSync(dbPathFor(root)) ? openStore(root) : null;
  const byDay = readEraHistory(root);
  if (db) {
    try {
      const rows = db
        .prepare(
          `SELECT substr(ts, 1, 10) AS day, COUNT(*) AS calls, COALESCE(SUM(failed),0) AS failures
           FROM tool_calls WHERE ts >= datetime('now', ?)
           GROUP BY day`,
        )
        .all(`-${windowDays} days`) as Array<{
        day: string;
        calls: number;
        failures: number;
      }>;
      for (const r of rows) {
        const agg = byDay.get(r.day) ?? { calls: 0, failures: 0 };
        agg.calls += r.calls;
        agg.failures += r.failures;
        byDay.set(r.day, agg);
      }
    } catch {
      /* fall back to history-only */
    }
  }
  return [...byDay.entries()]
    .filter(([day]) => day >= cutoffDay)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, agg]) => ({
      day,
      calls: agg.calls,
      failures: agg.failures,
      failureRate: agg.calls > 0 ? agg.failures / agg.calls : 0,
    }));
}

/** Test-only: close cached handles so temp-dir fixtures do not leak. */
export function closeToolCallStores(root?: string): void {
  if (root) {
    const db = dbCache.get(root);
    if (db) {
      try {
        db.close();
      } catch {
        /* ignore */
      }
      dbCache.delete(root);
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
