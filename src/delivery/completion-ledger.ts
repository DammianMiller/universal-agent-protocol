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

export interface InitLedgerOptions {
  /**
   * Carry a same-id item's status over from the previous ledger.
   *
   * True is right for re-planning INSIDE a run (that is what makes re-planning
   * non-destructive) and for resume, where the prior marks describe work this
   * same run already did.
   *
   * False is right for a fresh run, where carrying them over is a lie about
   * work this run has not done. Ids collide across runs far more often than the
   * original "re-planning mints new slugs" assumption allowed: every short
   * mission is now the single epic `mission` (see decompose.singleEpicFor), so
   * relaunching one inherited a ledger that was already 100% done — and
   * `isComplete` is what the hands-free Stop hook reads to decide a build is
   * finished. It would report "build complete" for a run that had done nothing.
   */
  carryPriorStatus?: boolean;
}

/**
 * Create (or replace) the ledger for a mission from a set of items. By default
 * existing items with the same id preserve their status, so re-planning within
 * a run is non-destructive; pass `carryPriorStatus: false` for a fresh run.
 */
export function initLedger(
  cwd: string,
  mission: string,
  items: NewItem[],
  options: InitLedgerOptions = {}
): CompletionLedger {
  const carry = options.carryPriorStatus !== false;
  const prior = loadLedger(cwd);
  const priorById = carry
    ? new Map((prior?.items ?? []).map((i) => [i.id, i]))
    : new Map<string, LedgerItem>();
  const ledger: CompletionLedger = {
    mission: mission.slice(0, 500),
    // A fresh run's ledger is a new ledger, so it is not backdated to the one
    // it replaced — `createdAt` reads as "when this build started".
    createdAt: (carry ? prior?.createdAt : undefined) ?? nowISO(),
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


export interface TodoInput {
  content: string;
  status?: 'pending' | 'in_progress' | 'completed';
}

/** Slugify a todo's content into a stable ledger id. */
function todoSlug(content: string, index: number): string {
  const base = content
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return base || `item-${index + 1}`;
}

function mapTodoStatus(s: TodoInput['status']): LedgerStatus {
  if (s === 'completed') return 'done';
  if (s === 'in_progress') return 'in_progress';
  return 'pending';
}

/**
 * Mirror a model's plan (Claude Code TodoWrite list) into the completion
 * ledger — the auto-seed for interactive multi-step builds. The todo list IS
 * the plan-in-progress, with authoritative statuses, so the ledger simply
 * tracks it: created on first sync, statuses updated on every sync, and the
 * mission/createdAt preserved across syncs. Duplicate slugs are de-collided.
 * Returns the resulting ledger, or null when there is nothing to seed.
 */
export function syncLedgerFromTodos(
  cwd: string,
  todos: TodoInput[],
  mission?: string
): CompletionLedger | null {
  const clean = (todos || []).filter((t) => t && typeof t.content === 'string' && t.content.trim());
  if (clean.length === 0) return null;

  const prior = loadLedger(cwd);
  const seen = new Set<string>();
  const items: LedgerItem[] = clean.map((t, i) => {
    let id = todoSlug(t.content, i);
    while (seen.has(id)) id = `${id}-${i}`;
    seen.add(id);
    return {
      id,
      title: t.content.trim().slice(0, 200),
      kind: 'task' as const,
      status: mapTodoStatus(t.status),
      updatedAt: nowISO(),
    };
  });

  const ledger: CompletionLedger = {
    mission: (prior?.mission || mission || 'Interactive multi-step build').slice(0, 500),
    createdAt: prior?.createdAt ?? nowISO(),
    updatedAt: nowISO(),
    items,
  };
  saveLedger(cwd, ledger);
  return ledger;
}
