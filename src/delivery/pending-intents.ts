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

import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync, appendFileSync } from 'fs';
import { join, resolve, relative, isAbsolute, dirname } from 'path';
import { protectedWritePathReason } from './applier.js';

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

/**
 * An intent plus the log it was read from. The pending log lives at the repo
 * level the DELIVERY GATE was enforcing, while a deliver mission's projectRoot
 * can sit deeper (a crate inside a monorepo). Observed live (run
 * 20261006T042017): the mission prescribed replaying
 * `.uap/pending-deliver.jsonl`, the intents lived at the MONOREPO root's
 * `.uap/`, and a crate-rooted lookup found nothing — the executor then
 * hand-wrote a broken 19KB replacement for content that was already recorded.
 */
export interface RootedIntent {
  root: string;
  intent: PendingIntent;
}

/**
 * Directories from projectRoot up to (and including) the git root whose
 * `.uap/pending-deliver.jsonl` exists. Closest first.
 */
export function pendingLogRoots(projectRoot: string): string[] {
  const start = resolve(projectRoot);
  const roots: string[] = [];
  let dir = start;
  let foundGit = false;
  for (let hops = 0; hops < 16; hops++) {
    if (existsSync(join(dir, PENDING_LOG))) roots.push(dir);
    if (existsSync(join(dir, '.git'))) {
      foundGit = true;
      break; // the git root is the boundary
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // No git boundary anywhere in reach (review X5/arch F5): the climb was about
  // to walk straight out of the project into unrelated ancestors — $HOME/.uap
  // pending logs from OTHER projects would merge into this run's replay set.
  // Keep only the project root's own log; crossing repos is the git boundary's
  // job, and there is none.
  if (!foundGit) return roots.filter((r) => r === start);
  return roots;
}

/** Parse one log file into intents (tolerating garbage lines). */
function parseIntentsFile(path: string): PendingIntent[] {
  if (!existsSync(path)) return [];
  const intents: PendingIntent[] = [];
  for (const line of readFileSync(path, 'utf-8').split('\n')) {
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
 * Read all recorded intents, oldest first, merging every pending log from
 * projectRoot up to the git root and deduping identical intents recorded at
 * more than one level. Unparseable lines are ignored.
 */
export function readPendingIntents(projectRoot: string): PendingIntent[] {
  const seen = new Set<string>();
  const merged: PendingIntent[] = [];
  const rooted: RootedIntent[] = [];
  for (const root of pendingLogRoots(projectRoot)) {
    for (const intent of parseIntentsFile(join(root, PENDING_LOG))) {
      const key = intentKey(intent);
      if (seen.has(key)) continue;
      seen.add(key);
      rooted.push({ root, intent });
    }
  }
  rooted.sort((a, b) => a.intent.ts - b.intent.ts);
  for (const r of rooted) merged.push(r.intent);
  return merged;
}

/**
 * The archived (already-applied) intents, newest last, from every log level —
 * the restore source for a mission that prescribes recorded content the tree
 * has since clobbered (see prescribed-replay.ts).
 */
export function readAppliedIntents(projectRoot: string): RootedIntent[] {
  const seen = new Set<string>();
  const out: RootedIntent[] = [];
  let dir = resolve(projectRoot);
  for (let hops = 0; hops < 16; hops++) {
    if (existsSync(join(dir, APPLIED_LOG))) {
      for (const intent of parseIntentsFile(join(dir, APPLIED_LOG))) {
        const key = intentKey(intent);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ root: dir, intent });
      }
    }
    if (existsSync(join(dir, '.git'))) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return out;
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
 * Intents are read from EVERY pending log between projectRoot and the git
 * root (see pendingLogRoots) — the delivery gate records at the level it was
 * enforcing, which may be above a mission's projectRoot.
 *
 * Applied (and detected-already-applied) intents are consumed from the log
 * they were read from — replay is idempotent across runs. Stale-anchor and
 * pre-D1 skips are NOT consumed: they stay visible until an operator resolves
 * or clears them.
 */
export function applyPendingIntents(projectRoot: string, file?: string): PendingApplyResult {
  const root = resolve(projectRoot);
  const wanted = file ? resolve(root, file) : null;
  const result: PendingApplyResult = { applied: [], skipped: [] };
  const consumedByRoot = new Map<string, PendingIntent[]>();

  // Merged oldest-first across levels, so a lower log cannot reorder history.
  const seen = new Set<string>();
  const rooted: RootedIntent[] = [];
  for (const logRoot of pendingLogRoots(root)) {
    for (const intent of parseIntentsFile(join(logRoot, PENDING_LOG))) {
      const key = intentKey(intent);
      if (seen.has(key)) continue;
      seen.add(key);
      rooted.push({ root: logRoot, intent });
    }
  }
  rooted.sort((a, b) => a.intent.ts - b.intent.ts);

  const markConsumed = (logRoot: string, intent: PendingIntent): void => {
    const bucket = consumedByRoot.get(logRoot) ?? [];
    bucket.push(intent);
    consumedByRoot.set(logRoot, bucket);
  };

  /**
   * Deterministic replay gets the SAME write protections the model's writes
   * get (review X1, CRITICAL): a planted `.uap/pending-deliver.jsonl` line
   * previously landed its content in `.git/hooks/`, `.github/workflows/` or
   * through a symlinked path with zero review, because replay used raw
   * writeFileSync with only a lexical containment bound. Replay is the
   * STRONGER trust case, not a weaker one — nothing looked at these bytes.
   */
  const replayWriteRefusal = (abs: string, rel: string): string | null => {
    const reason = protectedWritePathReason(rel);
    if (reason) return `protected path — ${reason}`;
    try {
      if (existsSync(abs) && lstatSync(abs).isSymbolicLink()) return 'target is a symlink';
      const realRoot = realpathSync(root);
      const realParent = realpathSync(dirname(abs));
      if (realParent !== realRoot && !realParent.startsWith(realRoot + '/')) {
        return 'path resolves outside the project root via a symlink';
      }
    } catch {
      // Parent not on disk yet — the plain write below will create it (or fail
      // loudly, caught per-intent).
    }
    return null;
  };

  for (const { root: logRoot, intent } of rooted) {
    const abs = isAbsolute(intent.file_path) ? intent.file_path : resolve(logRoot, intent.file_path);
    if (wanted && resolve(abs) !== wanted) continue;
    const rel = relative(root, abs);
    if (rel.startsWith('..')) {
      result.skipped.push({ file: intent.file_path, ts: intent.ts, reason: 'outside project root' });
      continue;
    }
    const refusal = replayWriteRefusal(abs, rel.split('\\').join('/'));
    if (refusal) {
      result.skipped.push({ file: rel, ts: intent.ts, reason: refusal });
      continue; // NOT consumed — a protected write stays visible for an operator to resolve
    }
    const edit = intent.edit;
    if (!edit || (typeof edit.content !== 'string' && typeof edit.old_string !== 'string')) {
      result.skipped.push({ file: rel, ts: intent.ts, reason: 'no replayable content recorded (pre-D1 intent)' });
      continue;
    }
    if (typeof edit.content === 'string') {
      if (existsSync(abs) && readFileSync(abs, 'utf-8') === edit.content) {
        result.skipped.push({ file: rel, ts: intent.ts, reason: 'already applied (content identical)' });
        markConsumed(logRoot, intent);
        continue;
      }
      try {
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, edit.content, 'utf-8');
      } catch (err) {
        result.skipped.push({
          file: rel,
          ts: intent.ts,
          reason: `write failed: ${err instanceof Error ? err.message : String(err)}`,
        });
        continue; // not consumed — stays visible
      }
      result.applied.push({ file: rel, ts: intent.ts, kind: 'write' });
      markConsumed(logRoot, intent);
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
      markConsumed(logRoot, intent);
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
    try {
      writeFileSync(abs, current.replace(oldStr, newStr), 'utf-8');
    } catch (err) {
      result.skipped.push({
        file: rel,
        ts: intent.ts,
        reason: `write failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue; // not consumed — stays visible
    }
    result.applied.push({ file: rel, ts: intent.ts, kind: 'replace' });
    markConsumed(logRoot, intent);
  }

  for (const [logRoot, consumed] of consumedByRoot) consumeIntents(logRoot, consumed);
  return result;
}
