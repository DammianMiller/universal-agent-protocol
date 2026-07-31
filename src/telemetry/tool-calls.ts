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
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  classifyToolResult,
  componentForTool,
  isFailureClass,
  type HarnessComponent,
  type ToolOutcomeClass,
} from './tool-failure.js';

/** Rolling cap: the corpus is a diagnosis aid, not an audit log. */
const MAX_TOOL_CALL_ROWS = 20_000;

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
        detail TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_tool_calls_run ON tool_calls(run_id);
      CREATE INDEX IF NOT EXISTS idx_tool_calls_outcome ON tool_calls(outcome);
      CREATE INDEX IF NOT EXISTS idx_tool_calls_component ON tool_calls(component);
    `);
    // Prune on OPEN, not on an insert counter: a deliver process records ~12
    // rows and exits, so a `% 100` counter reset per process meant the row cap
    // was never enforced and the table grew without bound across runs.
    try {
      db.prepare('DELETE FROM tool_calls WHERE id <= (SELECT MAX(id) - ? FROM tool_calls)').run(
        MAX_TOOL_CALL_ROWS,
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
    db.prepare(
      `INSERT INTO tool_calls
         (run_id, task_id, component, tool, outcome, failed, turn, path, latency_ms, bytes, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    );
    if (++insertCount % 100 === 0) {
      db.prepare(
        `DELETE FROM tool_calls WHERE id <= (SELECT MAX(id) - ? FROM tool_calls)`,
      ).run(MAX_TOOL_CALL_ROWS);
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
