/**
 * Completion Ledger (Option B) — the persistent, objective "definition of done"
 * for a huge multi-epic build.
 *
 * A single deliver run judges one task; a huge build is many epics/tasks that
 * can span many turns and many sessions. The ledger externalizes the whole
 * build's DAG + per-item status to `.uap/completion-ledger.json`, so the
 * hands-free machinery (Stop-hook block, reactor injection) can answer one
 * question at any moment: "is the WHOLE build 100% done, and if not, what
 * remains?" — independent of any model's self-assessment.
 *
 * Pure + fail-soft: every reader tolerates a missing/corrupt file by returning
 * null, so the ledger can never wedge a session on its own.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { dirname, join } from 'path';

export type LedgerStatus = 'pending' | 'in_progress' | 'done' | 'failed';
export type LedgerKind = 'epic' | 'task' | 'criterion';

export interface LedgerItem {
  id: string;
  title: string;
  kind: LedgerKind;
  status: LedgerStatus;
  /** ids this item depends on (informational; the build order lives upstream). */
  deps?: string[];
  /** acceptance criteria for this item (used by the judge / reporting). */
  criteria?: string[];
  /** last status note (e.g. a failure summary). */
  note?: string;
  updatedAt?: string;
}

export interface CompletionLedger {
  mission: string;
  createdAt: string;
  updatedAt: string;
  items: LedgerItem[];
}

/** Where the ledger lives for a project. */
export function ledgerPath(cwd: string = process.cwd()): string {
  return join(cwd, '.uap', 'completion-ledger.json');
}

export function ledgerExists(cwd: string = process.cwd()): boolean {
  return existsSync(ledgerPath(cwd));
}

/** Load the ledger, or null when absent/unreadable/corrupt (fail-soft). */
export function loadLedger(cwd: string = process.cwd()): CompletionLedger | null {
  try {
    const p = ledgerPath(cwd);
    if (!existsSync(p)) return null;
    const raw = JSON.parse(readFileSync(p, 'utf-8')) as CompletionLedger;
    if (!raw || !Array.isArray(raw.items)) return null;
    return raw;
  } catch {
    return null;
  }
}

export function saveLedger(cwd: string, ledger: CompletionLedger): void {
  const p = ledgerPath(cwd);
  mkdirSync(dirname(p), { recursive: true });
  ledger.updatedAt = nowISO();
  writeFileSync(p, JSON.stringify(ledger, null, 2) + '\n');
}

export function clearLedger(cwd: string = process.cwd()): void {
  try {
    const p = ledgerPath(cwd);
    if (existsSync(p)) rmSync(p);
  } catch {
    /* best-effort */
  }
}

export interface NewItem {
  id: string;
  title: string;
  kind?: LedgerKind;
  deps?: string[];
  criteria?: string[];
}

/**
 * Create (or replace) the ledger for a mission from a set of items. Existing
 * items with the same id preserve their status so re-planning is non-destructive.
 */
export function initLedger(cwd: string, mission: string, items: NewItem[]): CompletionLedger {
  const prior = loadLedger(cwd);
  const priorById = new Map((prior?.items ?? []).map((i) => [i.id, i]));
  const ledger: CompletionLedger = {
    mission: mission.slice(0, 500),
    createdAt: prior?.createdAt ?? nowISO(),
    updatedAt: nowISO(),
    items: items.map((it) => {
      const existing = priorById.get(it.id);
      return {
        id: it.id,
        title: it.title.slice(0, 200),
        kind: it.kind ?? 'epic',
        status: existing?.status ?? 'pending',
        ...(it.deps && it.deps.length ? { deps: it.deps } : {}),
        ...(it.criteria && it.criteria.length ? { criteria: it.criteria } : {}),
        ...(existing?.note ? { note: existing.note } : {}),
        updatedAt: existing?.updatedAt ?? nowISO(),
      };
    }),
  };
  saveLedger(cwd, ledger);
  return ledger;
}

/** Update one item's status. No-op (returns false) if the ledger/item is absent. */
export function markItem(cwd: string, id: string, status: LedgerStatus, note?: string): boolean {
  const ledger = loadLedger(cwd);
  if (!ledger) return false;
  const item = ledger.items.find((i) => i.id === id);
  if (!item) return false;
  item.status = status;
  item.updatedAt = nowISO();
  if (note !== undefined) item.note = note.slice(0, 300);
  saveLedger(cwd, ledger);
  return true;
}

/** Items that are not yet done (pending / in_progress / failed). */
export function remainingItems(ledger: CompletionLedger): LedgerItem[] {
  return ledger.items.filter((i) => i.status !== 'done');
}

/** The whole build is complete only when EVERY item is done. */
export function isComplete(ledger: CompletionLedger): boolean {
  return ledger.items.length > 0 && ledger.items.every((i) => i.status === 'done');
}

export interface LedgerProgress {
  total: number;
  done: number;
  failed: number;
  pending: number;
  pct: number;
}

export function progress(ledger: CompletionLedger): LedgerProgress {
  const total = ledger.items.length;
  const done = ledger.items.filter((i) => i.status === 'done').length;
  const failed = ledger.items.filter((i) => i.status === 'failed').length;
  const pending = total - done - failed;
  return { total, done, failed, pending, pct: total ? Math.round((done / total) * 100) : 0 };
}

/** A compact, model-facing summary of what still needs doing. */
export function formatRemaining(ledger: CompletionLedger, max = 12): string {
  const rem = remainingItems(ledger);
  if (rem.length === 0) return 'All ledger items complete.';
  const p = progress(ledger);
  const lines = rem.slice(0, max).map((i) => {
    const mark = i.status === 'failed' ? 'x' : i.status === 'in_progress' ? '~' : ' ';
    return `  [${mark}] ${i.id}: ${i.title}${i.note ? ` (${i.note})` : ''}`;
  });
  const more = rem.length > max ? `\n  ...and ${rem.length - max} more` : '';
  return `Build progress ${p.done}/${p.total} (${p.pct}%). REMAINING:\n${lines.join('\n')}${more}`;
}

function nowISO(): string {
  // Date.now/new Date are fine at runtime (not inside a workflow script).
  return new Date().toISOString();
}
