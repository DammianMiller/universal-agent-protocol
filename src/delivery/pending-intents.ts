/**
 * Pending edit intents (plan D1, 2026-07-13)
 *
 * When the delivery-enforcement gate blocks a direct source edit, the
 * autoroute hook records the edit\'s ACTUAL content (old/new strings or full
 * file content) to `.uap/pending-deliver.jsonl`. `uap deliver --pending
 * <file>` replays those intents DETERMINISTICALLY — exact-anchor replacement,
 * no model involved — then the caller runs the project gates as usual. A
 * mismatched anchor fails loudly (the tree moved since the intent was
 * recorded); nothing is ever fuzzily applied.
 *
 * Replay is REPLAY-ONCE (2026-07-18): an intent that applies (or is detected
 * as already applied) is CONSUMED — removed from the pending log and archived
 * to `.uap/pending-deliver.applied.jsonl`. Before this, every replay run
 * re-scanned the full log and re-applied any intent whose anchor still
 * matched; for insertion-style edits (old_string surviving as a prefix of
 * new_string) that duplicated the inserted hunk on EVERY run — observed
 * 2026-07-18 as a 4x-duplicated block from one intent replayed by
 * hook-detached + manual runs. Stale-anchor skips stay in the log so they
 * remain loudly visible.
 */

import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'fs';
import { join, resolve, relative, isAbsolute } from 'path';

export interface PendingIntent {
  ts: number;
  tool: string;
  file_path: string;
  hint?: string;
  edit?: { old_string?: string; new_string?: string; content?: string };
}

export interface PendingApplyResult {
  applied: Array<{ file: string; ts: number; kind: 'replace' | 'write' }>;
  skipped: Array<{ file: string; ts: number; reason: string }>;
}

const PENDING_LOG = '.uap/pending-deliver.jsonl';
const APPLIED_LOG = '.uap/pending-deliver.applied.jsonl';

/** Read all recorded intents, oldest first. Unparseable lines are ignored. */
export function readPendingIntents(projectRoot: string): PendingIntent[] {
  const log = join(projectRoot, PENDING_LOG);
  if (!existsSync(log)) return [];
  const intents: PendingIntent[] = [];
  for (const line of readFileSync(log, 'utf-8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const parsed = JSON.parse(t) as PendingIntent;
      if (parsed && typeof parsed.file_path === 'string') intents.push(parsed);
    } catch {
      /* ignore garbage lines */
    }
  }
  return intents;
}

/** Stable identity for consume-filtering (ts + file + exact edit content). */
function intentKey(i: PendingIntent): string {
  return JSON.stringify({ ts: i.ts, file_path: i.file_path, edit: i.edit ?? null });
}

/**
 * Remove consumed intents from the pending log (re-reading it first, so lines
 * appended by a concurrent gate hook during this run survive) and archive
 * them to the applied log for audit.
 */
function consumeIntents(root: string, consumed: PendingIntent[]): void {
  if (consumed.length === 0) return;
  const keys = new Set(consumed.map(intentKey));
  const log = join(root, PENDING_LOG);
  const remaining: string[] = [];
  if (existsSync(log)) {
    for (const line of readFileSync(log, 'utf-8').split('\n')) {
      const t = line.trim();
      if (!t) continue;
      let keep = true;
      try {
        const parsed = JSON.parse(t) as PendingIntent;
        if (parsed && typeof parsed.file_path === 'string' && keys.has(intentKey(parsed))) keep = false;
      } catch {
        /* keep garbage lines — readPendingIntents ignores them anyway */
      }
      if (keep) remaining.push(t);
    }
  }
  writeFileSync(log, remaining.length ? remaining.join('\n') + '\n' : '', 'utf-8');
  appendFileSync(
    join(root, APPLIED_LOG),
    consumed.map((i) => JSON.stringify({ ...i, applied_at: Date.now() })).join('\n') + '\n',
    'utf-8',
  );
}

/**
 * Deterministically apply the recorded intents for `file` (or every file when
 * omitted). Replace-intents require the old_string to match EXACTLY ONCE in
 * the current content; content-intents overwrite the file whole (that is what
 * the blocked Write would have done). Multiple intents for one file apply in
 * recorded order, so a sequence of blocked Edits replays faithfully.
 *
 * Applied (and detected-already-applied) intents are consumed from the log —
 * replay is idempotent across runs. Stale-anchor and pre-D1 skips are NOT
 * consumed: they stay visible until an operator resolves or clears them.
 */
export function applyPendingIntents(projectRoot: string, file?: string): PendingApplyResult {
  const root = resolve(projectRoot);
  const wanted = file ? resolve(root, file) : null;
  const result: PendingApplyResult = { applied: [], skipped: [] };
  const consumed: PendingIntent[] = [];

  for (const intent of readPendingIntents(root)) {
    const abs = isAbsolute(intent.file_path) ? intent.file_path : resolve(root, intent.file_path);
    if (wanted && resolve(abs) !== wanted) continue;
    const rel = relative(root, abs);
    if (rel.startsWith('..')) {
      result.skipped.push({ file: intent.file_path, ts: intent.ts, reason: 'outside project root' });
      continue;
    }
    const edit = intent.edit;
    if (!edit || (typeof edit.content !== 'string' && typeof edit.old_string !== 'string')) {
      result.skipped.push({ file: rel, ts: intent.ts, reason: 'no replayable content recorded (pre-D1 intent)' });
      continue;
    }
    if (typeof edit.content === 'string') {
      if (existsSync(abs) && readFileSync(abs, 'utf-8') === edit.content) {
        result.skipped.push({ file: rel, ts: intent.ts, reason: 'already applied (content identical)' });
        consumed.push(intent);
        continue;
      }
      writeFileSync(abs, edit.content, 'utf-8');
      result.applied.push({ file: rel, ts: intent.ts, kind: 'write' });
      consumed.push(intent);
      continue;
    }
    if (!existsSync(abs)) {
      result.skipped.push({ file: rel, ts: intent.ts, reason: 'file does not exist' });
      continue;
    }
    const current = readFileSync(abs, 'utf-8');
    const oldStr = String(edit.old_string);
    const newStr = String(edit.new_string ?? '');
    // Idempotency guard for insertion-style edits (old_string survives inside
    // new_string): after application the anchor STILL matches, so a naive
    // re-run would insert the hunk again. If the new content is already on
    // disk, the intent has been applied — consume it. Edits whose application
    // removes the anchor never reach this branch falsely (their old is not
    // contained in new).
    if (newStr && newStr.includes(oldStr) && current.includes(newStr)) {
      result.skipped.push({ file: rel, ts: intent.ts, reason: 'already applied (new content present)' });
      consumed.push(intent);
      continue;
    }
    const count = current.split(oldStr).length - 1;
    if (count !== 1) {
      result.skipped.push({
        file: rel,
        ts: intent.ts,
        reason: count === 0 ? 'anchor not found (tree moved since intent was recorded)' : `anchor matches ${count} times (need exactly 1)`,
      });
      continue;
    }
    writeFileSync(abs, current.replace(oldStr, newStr), 'utf-8');
    result.applied.push({ file: rel, ts: intent.ts, kind: 'replace' });
    consumed.push(intent);
  }

  consumeIntents(root, consumed);
  return result;
}
