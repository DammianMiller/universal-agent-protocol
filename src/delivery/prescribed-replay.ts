/**
 * Prescribed-replay preflight (U2)
 *
 * Some missions EXPLICITLY prescribe the deterministic mechanism: "the
 * intended content is recorded as a replayable intent in
 * .uap/pending-deliver.jsonl — replay it with `uap deliver --pending` rather
 * than rewriting it". Executors ignore that instruction: the live failure
 * (run 20261006T042017, rust-pg-ext M1 bench) spent its entire 12-round budget
 * hand-rewriting a broken 19KB bench.rs while the recorded content sat in the
 * pending/applied logs. A model told to replay can choose not to; the runner
 * doing it before turn 1 leaves nothing to chance.
 *
 * Two sources, in order:
 *  1. PENDING intents (never consumed) — replayed via applyPendingIntents.
 *  2. APPLIED intents — when nothing is pending for a mission-named file but
 *     the tree's current content differs from the newest recorded intent
 *     content, the tree has clobbered the prescribed content (an earlier
 *     executor's rewrite). RESTORE it, loudly. Only fires on a fresh run
 *     (never a resume — resumed state may legitimately contain newer work) and
 *     only for files the mission text names. Opt out with
 *     UAP_DELIVER_NO_INTENT_RESTORE=1.
 */

import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from 'fs';
import { basename, dirname, isAbsolute, relative, resolve } from 'path';
import { protectedWritePathReason } from './applier.js';
import {
  applyPendingIntents,
  readAppliedIntents,
  type RootedIntent,
} from './pending-intents.js';

export interface PrescribedReplayResult {
  /** True when the mission text prescribes the pending-intent mechanism. */
  triggered: boolean;
  /** Pending intents replayed this preflight. */
  applied: Array<{ file: string; kind: 'replace' | 'write' }>;
  /** Files restored from the applied log (tree had clobbered them). */
  restored: string[];
  /** Human-readable actions, printed by the CLI. */
  notes: string[];
}

/**
 * Does the mission prescribe the pending-intent replay mechanism? Prose that
 * merely MENTIONS the log ("do not touch .uap/pending-deliver.jsonl") must not
 * trigger a tree-mutating preflight (review arch F12 / quality F12): the
 * trigger requires the prescriptive shape — a replay/recorded verb on the
 * same line as the log path, or the imperative `uap deliver --pending` form.
 */
export function missionPrescribesReplay(instruction: string): boolean {
  return (
    /(?:replay\w*|recorded)[^\n]{0,200}pending-deliver|pending-deliver[^\n]{0,200}(?:replay\w*|recorded)/.test(
      instruction
    ) || /uap\s+deliver\s+--pending/.test(instruction)
  );
}

/**
 * Mission-named path tokens (full slash paths and bare basenames). The
 * restore bound matches on PATH TAILS, not bare basenames (review X4/arch
 * F3): a mission naming `src/bench.rs` must not authorize restoring
 * `vendor/bench.rs`. A bare basename in the mission (no directory part) still
 * falls back to basename matching — the mission gave us nothing narrower.
 */
function missionPathTokens(mission: string): { tails: Set<string>; bases: Set<string> } {
  const tails = new Set<string>();
  const bases = new Set<string>();
  for (const m of mission.matchAll(/[\w.@-]+(?:\/[\w.@-]+)+/g)) {
    const t = m[0].replace(/[.,;:)]+$/, '');
    if (t.includes('//') || t.startsWith('http')) continue;
    if (!t.split('/').pop()?.includes('.')) continue;
    // Slash paths seed TAILS ONLY (review X4): seeding the bare-basename
    // fallback from them too would let a mission naming `src/bench.rs`
    // authorize every `*/bench.rs` in the tree.
    tails.add(t.toLowerCase());
  }
  // Bare basenames: matched only on text with every SLASH PATH removed —
  // otherwise `bench.rs` inside `src/bench.rs` seeds the basename fallback and
  // defeats the tail bound (review X4).
  const bareText = mission.replace(/[\w.@-]+(?:\/[\w.@-]+)+/g, ' ');
  for (const m of bareText.matchAll(/\b[\w-]+\.(?:html|css|md|js|mjs|cjs|ts|tsx|json|py|rs|go)\b/g)) {
    bases.add(m[0].toLowerCase());
  }
  return { tails, bases };
}

/** Does the mission name this project-relative path (tail or bare basename)? */
function missionNamesPath(relPosix: string, tokens: { tails: Set<string>; bases: Set<string> }): boolean {
  const rel = relPosix.toLowerCase();
  for (const tail of tokens.tails) {
    if (rel === tail || rel.endsWith('/' + tail)) return true;
  }
  return tokens.bases.has(basename(rel));
}

/**
 * The same write protections the applier enforces (review X1, CRITICAL): the
 * restore path used raw writeFileSync, so a planted applied-log line could
 * land content in `.git/hooks/`, `.github/workflows/` or through a symlink.
 * Restore is deterministic — nothing reviews these bytes — so it gets the
 * STRONGER guard, not a weaker one.
 */
function restoreWriteRefusal(root: string, abs: string, relPosix: string): string | null {
  const reason = protectedWritePathReason(relPosix);
  if (reason) return `protected path — ${reason}`;
  try {
    if (existsSync(abs) && lstatSync(abs).isSymbolicLink()) return 'target is a symlink';
    const realRoot = realpathSync(root);
    const realParent = realpathSync(dirname(abs));
    if (realParent !== realRoot && !realParent.startsWith(realRoot + '/')) {
      return 'path resolves outside the project root via a symlink';
    }
  } catch {
    return null; // parent missing — the write below creates it or fails loudly
  }
  return null;
}

/**
 * Run the preflight for a mission against projectRoot. Safe to call when the
 * mission does not prescribe the mechanism (returns {triggered: false} without
 * touching anything) and fail-soft on every IO error — a preflight must never
 * block a run it was meant to help.
 */
export function prescribedReplayPreflight(
  projectRoot: string,
  instruction: string,
  opts?: { resume?: boolean }
): PrescribedReplayResult {
  const out: PrescribedReplayResult = { triggered: false, applied: [], restored: [], notes: [] };
  if (!missionPrescribesReplay(instruction)) return out;
  out.triggered = true;
  const root = resolve(projectRoot);

  // 1. Replay pending intents (multi-level lookup is inside).
  try {
    const res = applyPendingIntents(root);
    for (const a of res.applied) {
      out.applied.push({ file: a.file, kind: a.kind });
      out.notes.push(`replayed recorded intent (${a.kind}): ${a.file}`);
    }
    for (const s of res.skipped) {
      if (s.reason.startsWith('already applied')) continue; // idempotent — not news
      out.notes.push(`intent skipped: ${s.file} (${s.reason})`);
    }
  } catch (err) {
    out.notes.push(`pending-intent replay error (continuing): ${err instanceof Error ? err.message : String(err)}`);
  }

  // 2. Restore clobbered prescribed content from the applied log — only on a
  // fresh run, only for mission-named files, only with recorded CONTENT
  // (replace-intents are stale by construction once applied and moved).
  if (opts?.resume || process.env.UAP_DELIVER_NO_INTENT_RESTORE === '1') return out;
  try {
    const tokens = missionPathTokens(instruction);
    if (tokens.bases.size === 0 && tokens.tails.size === 0) return out;
    // Newest recorded intent per file, across all levels.
    const latest = new Map<string, RootedIntent>();
    for (const ri of readAppliedIntents(root)) {
      const edit = ri.intent.edit;
      if (!edit || typeof edit.content !== 'string') continue;
      // Relative paths are relative to the LOG they were recorded in (the
      // delivery gate records at the level it enforced), not to cwd.
      const abs = isAbsolute(ri.intent.file_path)
        ? ri.intent.file_path
        : resolve(ri.root, ri.intent.file_path);
      const rel = relative(root, abs);
      if (rel.startsWith('..')) continue;
      const relPosix = rel.split('\\').join('/');
      if (!missionNamesPath(relPosix, tokens)) continue;
      const prev = latest.get(rel);
      if (!prev || prev.intent.ts <= ri.intent.ts) latest.set(rel, ri);
    }
    for (const [rel, ri] of latest) {
      const abs = resolve(root, rel);
      const relPosix = rel.split('\\').join('/');
      if (!existsSync(abs)) continue; // gone entirely — gates will say so
      const refusal = restoreWriteRefusal(root, abs, relPosix);
      if (refusal) {
        out.notes.push(`restore of ${relPosix} refused (${refusal})`);
        continue;
      }
      let current: string;
      try {
        current = readFileSync(abs, 'utf-8');
      } catch (err) {
        out.notes.push(`restore of ${relPosix} skipped (unreadable: ${err instanceof Error ? err.message : String(err)})`);
        continue;
      }
      const recorded = String(ri.intent.edit?.content);
      if (current === recorded) continue;
      try {
        writeFileSync(abs, recorded, 'utf-8');
      } catch (err) {
        out.notes.push(`restore of ${relPosix} failed (write error: ${err instanceof Error ? err.message : String(err)})`);
        continue;
      }
      out.restored.push(relPosix);
      out.notes.push(
        `restored ${relPosix} from the recorded intent (ts ${ri.intent.ts}) — the tree had clobbered the prescribed content`
      );
    }
  } catch (err) {
    out.notes.push(`applied-intent restore skipped (continuing): ${err instanceof Error ? err.message : String(err)}`);
  }
  return out;
}
