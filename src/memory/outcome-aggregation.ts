/**
 * Delivery-outcome aggregation (proof plan O1, descriptive).
 *
 * Every deliver outcome is already recorded as a structured lesson —
 * `[deliver] <outcome> after N turn(s), best X% of gates — model M — task: T`
 * — but it lives scattered across the memory substrates, so no round could
 * ever answer "which model delivers what share of gates" without a notebook
 * SQL pass. This module aggregates those lessons from every substrate that
 * is REACHABLE at collection time and labels the coverage, per the
 * proof-options house rule: the output is descriptive evidence, never a
 * causal claim, and a degraded substrate narrows coverage rather than
 * silently shrinking the dataset.
 *
 * Substrates, in reliability order:
 *   1. The daily-log corpus (SQLite — every store lands there first).
 *   2. The memory-bridge mirrors (CLAUDE.md / AGENTS.md
 *      UAP-MEMORY-BRIDGE blocks — auto-mirrored recent memories; lines are
 *      truncated by the bridge, which costs task-text tail, not the
 *      outcome/turns/gates/model fields).
 *
 * All parsing follows the deliver loop's own emission contract; nothing
 * here knows about any project, model, or domain.
 */

import Database from 'better-sqlite3';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { memoryRoot, shortTermDbPath } from './paths.js';
import type { AgentContextConfig } from '../types/index.js';

export type DeliverOutcomeKind = 'delivered' | 'not-delivered' | 'stopped';

export interface DeliverOutcomeRow {
  outcome: DeliverOutcomeKind;
  turns: number;
  /** Best share of gates passed, 0..100; null when the lesson omitted it. */
  gatesPct: number | null;
  model: string;
  task: string;
  /** Which substrate the row came from — coverage travels with the data. */
  source: 'daily-log' | 'bridge-mirror';
}

export interface DeliverOutcomeAggregate {
  model: string;
  runs: number;
  delivered: number;
  notDelivered: number;
  stopped: number;
  /** Mean of the non-null best-gates values; null when no run reported gates. */
  bestGatesMean: number | null;
  /** The highest best-gates value any run reached for this model. */
  bestGatesBest: number | null;
  turnsMean: number;
}

export interface DeliverOutcomeDataset {
  rows: DeliverOutcomeRow[];
  aggregates: DeliverOutcomeAggregate[];
  /** Every substrate consulted and whether it contributed. */
  coverage: Array<{ source: string; reachable: boolean; rows: number }>;
}

/**
 * Parse one lesson line. Returns null when the essential fields (outcome,
 * turns, model) are absent — an unparseable lesson is left out rather than
 * miscounted (fail-closed accounting).
 */
export function parseDeliverLesson(line: string): Omit<DeliverOutcomeRow, 'source'> | null {
  const marker = line.indexOf('[deliver]');
  if (marker === -1) return null;
  const body = line.slice(marker + '[deliver]'.length);

  let outcome: DeliverOutcomeKind;
  if (/^\s*delivered in/.test(body)) outcome = 'delivered';
  else if (/^\s*NOT delivered/.test(body)) outcome = 'not-delivered';
  else if (/^\s*STOPPED/.test(body)) outcome = 'stopped';
  else return null;

  const turnsMatch = body.match(/(\d+)\s*turn\(s\)/);
  if (!turnsMatch) return null;
  const turns = parseInt(turnsMatch[1], 10);

  const gatesMatch = body.match(/best\s+(\d+)%\s*of\s*gates/);
  const gatesPct = gatesMatch ? parseInt(gatesMatch[1], 10) : null;

  const modelMatch = body.match(/—\s*model\s+(\S+)\s*—/);
  if (!modelMatch) return null;

  const taskMatch = body.match(/—\s*task:\s*(.*)$/);
  const task = taskMatch ? taskMatch[1].trim() : '';

  return { outcome, turns, gatesPct, model: modelMatch[1], task };
}

/** Dedup key: the normalized lesson fields, truncated where bridges truncate. */
function lessonKey(row: Omit<DeliverOutcomeRow, 'source'>): string {
  return [
    row.outcome,
    row.turns,
    row.gatesPct ?? '-',
    row.model,
    row.task.slice(0, 60),
  ].join('|');
}

/** Collect the reachable substrates. Duplicate lessons count once. */
export function collectDeliverOutcomes(
  cwd: string,
  config?: AgentContextConfig | null
): DeliverOutcomeDataset {
  const rows: DeliverOutcomeRow[] = [];
  const seen = new Set<string>();
  const coverage: DeliverOutcomeDataset['coverage'] = [];

  // Substrate 1: the daily-log corpus.
  const dbPath = shortTermDbPath(cwd, config?.memory?.shortTerm?.path);
  let dbRows = 0;
  if (existsSync(dbPath)) {
    try {
      const db = new Database(dbPath, { readonly: true });
      try {
        const entries = db
          .prepare("SELECT content FROM daily_log WHERE content LIKE '%[deliver]%' ORDER BY id")
          .all() as Array<{ content: string }>;
        for (const e of entries) {
          const parsed = parseDeliverLesson(e.content);
          if (!parsed) continue;
          const key = lessonKey(parsed);
          if (seen.has(key)) continue;
          seen.add(key);
          rows.push({ ...parsed, source: 'daily-log' });
          dbRows++;
        }
      } finally {
        db.close();
      }
    } catch {
      // Unreadable store — coverage records it as empty, never throws.
    }
  }
  coverage.push({ source: 'daily-log', reachable: existsSync(dbPath), rows: dbRows });

  // Substrate 2: the memory-bridge mirrors (the recent-memories block the
  // bridge keeps in CLAUDE.md / AGENTS.md).
  const root = memoryRoot(cwd);
  let bridgeRows = 0;
  let bridgeReachable = false;
  for (const mirror of ['CLAUDE.md', 'AGENTS.md']) {
    const path = join(root, mirror);
    if (!existsSync(path)) continue;
    bridgeReachable = true;
    const text = readFileSync(path, 'utf-8');
    for (const line of text.split('\n')) {
      const trimmed = line.replace(/^\s*-\s*\((\w+),\s*i\d+\)\s*/, '');
      if (!trimmed.includes('[deliver]')) continue;
      const parsed = parseDeliverLesson(trimmed);
      if (!parsed) continue;
      const key = lessonKey(parsed);
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({ ...parsed, source: 'bridge-mirror' });
      bridgeRows++;
    }
  }
  coverage.push({ source: 'bridge-mirror', reachable: bridgeReachable, rows: bridgeRows });

  return { rows, aggregates: aggregateDeliverOutcomes(rows), coverage };
}

/** Model-level aggregation, most-attempted first. */
export function aggregateDeliverOutcomes(
  rows: DeliverOutcomeRow[]
): DeliverOutcomeAggregate[] {
  const byModel = new Map<string, DeliverOutcomeRow[]>();
  for (const r of rows) {
    const list = byModel.get(r.model) ?? [];
    list.push(r);
    byModel.set(r.model, list);
  }
  const out: DeliverOutcomeAggregate[] = [];
  for (const [model, list] of byModel) {
    const gates = list.map((r) => r.gatesPct).filter((g): g is number => g !== null);
    out.push({
      model,
      runs: list.length,
      delivered: list.filter((r) => r.outcome === 'delivered').length,
      notDelivered: list.filter((r) => r.outcome === 'not-delivered').length,
      stopped: list.filter((r) => r.outcome === 'stopped').length,
      bestGatesMean: gates.length > 0 ? gates.reduce((a, b) => a + b, 0) / gates.length : null,
      bestGatesBest: gates.length > 0 ? Math.max(...gates) : null,
      turnsMean: list.reduce((a, r) => a + r.turns, 0) / list.length,
    });
  }
  return out.sort((a, b) => b.runs - a.runs || a.model.localeCompare(b.model));
}
