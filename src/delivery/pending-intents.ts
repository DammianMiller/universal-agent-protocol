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
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
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

/**
 * Deterministically apply the recorded intents for `file` (or every file when
 * omitted). Replace-intents require the old_string to match EXACTLY ONCE in
 * the current content; content-intents overwrite the file whole (that is what
 * the blocked Write would have done). Multiple intents for one file apply in
 * recorded order, so a sequence of blocked Edits replays faithfully.
 */
export function applyPendingIntents(projectRoot: string, file?: string): PendingApplyResult {
  const root = resolve(projectRoot);
  const wanted = file ? resolve(root, file) : null;
  const result: PendingApplyResult = { applied: [], skipped: [] };

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
      writeFileSync(abs, edit.content, 'utf-8');
      result.applied.push({ file: rel, ts: intent.ts, kind: 'write' });
      continue;
    }
    if (!existsSync(abs)) {
      result.skipped.push({ file: rel, ts: intent.ts, reason: 'file does not exist' });
      continue;
    }
    const current = readFileSync(abs, 'utf-8');
    const oldStr = String(edit.old_string);
    const count = current.split(oldStr).length - 1;
    if (count !== 1) {
      result.skipped.push({
        file: rel,
        ts: intent.ts,
        reason: count === 0 ? 'anchor not found (tree moved since intent was recorded)' : `anchor matches ${count} times (need exactly 1)`,
      });
      continue;
    }
    writeFileSync(abs, current.replace(oldStr, String(edit.new_string ?? '')), 'utf-8');
    result.applied.push({ file: rel, ts: intent.ts, kind: 'replace' });
  }
  return result;
}
