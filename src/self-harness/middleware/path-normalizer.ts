/**
 * Self-Harness middleware — tool-call path normalizer.
 *
 * The mechanical fix for `toolcall.path.garbled`: a small quant fat-fingers the
 * file path in Write/Edit/Read tool calls (case changes, dropped/altered
 * extension, stray subdirectory, trailing whitespace/newline), so the edit lands
 * nowhere and the task never completes. No prompt/param Mod fixes this (the model
 * can't reliably follow "use the exact path"); a deterministic normalizer that
 * snaps the proposed path to the nearest REAL file in the workdir does.
 *
 * This module is the pure, filesystem-free core (the snapping algorithm) so it is
 * unit-testable against the real garble cases observed this cycle. The runner
 * (a Claude Code PreToolUse hook) supplies the actual workdir file list. See
 * docs/design/SELF_HARNESS.md §4 (P2).
 */

export interface NormalizeResult {
  /** The resolved path (possibly corrected). */
  path: string;
  changed: boolean;
  /** Why it was changed, or null if unchanged. */
  reason: string | null;
}

/** Collapse to comparable form: lowercase, strip every non-alphanumeric char. */
function squash(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function basename(p: string): string {
  const parts = p.split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : p;
}

function parentDir(p: string): string {
  const parts = p.split('/').filter(Boolean);
  return parts.slice(0, -1).join('/');
}

/**
 * Whether snapping `proposed` to `candidate` is safe w.r.t. directories. We only
 * fix the FILENAME (or strip a wrong absolute prefix), never RELOCATE across
 * structurally-different directory trees. A bare workdir-relative candidate (no
 * parent dir) is always safe; otherwise the parent dirs must match. This blocks
 * the observed harm where a garbled write to `octopus_invaders/js/config.js`
 * was snapped to a different known dir `octopus-invader/space-shooter/js/...`.
 */
function dirCompatible(proposed: string, candidate: string): boolean {
  const cp = parentDir(candidate);
  if (cp === '') return true; // bare workdir-relative file — safe to snap to
  // EXACT parent match only. A previous version compared squash(parent), which
  // collapsed punctuation/case and let writes relocate between genuinely
  // different directories (e.g. `s-space-shooter` vs `s space-shooter`).
  return parentDir(proposed) === cp;
}

/**
 * Snap `proposed` to the nearest real file in `workdirFiles` (paths relative to
 * the workdir). Returns `proposed` unchanged if it already resolves or no
 * confident match exists — the normalizer never invents a target, so a genuinely
 * new file (a legitimate create) is left alone.
 */
export function normalizeToolPath(
  proposed: string,
  workdirFiles: string[],
): NormalizeResult {
  const unchanged: NormalizeResult = { path: proposed, changed: false, reason: null };
  if (!proposed || workdirFiles.length === 0) return unchanged;

  const trimmed = proposed.replace(/\s+$/g, '').replace(/^\s+/g, '');

  // 0) Already an exact relative match (only whitespace differed).
  if (workdirFiles.includes(trimmed)) {
    return trimmed === proposed
      ? unchanged
      : { path: trimmed, changed: true, reason: 'trimmed surrounding whitespace' };
  }

  const base = basename(trimmed);

  // Helper: a unique match means we can confidently snap.
  const snap = (target: string, reason: string): NormalizeResult =>
    target === proposed ? unchanged : { path: target, changed: true, reason };
  const unique = (cands: string[]) => (cands.length === 1 ? cands[0] : null);
  // Only consider candidates we can safely snap to without relocating dirs.
  const safe = (cands: string[]) => cands.filter((f) => dirCompatible(trimmed, f));

  // 1) Exact basename match (handles stray leading directory components).
  let hit = unique(safe(workdirFiles.filter((f) => basename(f) === base)));
  if (hit) return snap(hit, 'stray path components removed');

  // 2) Case-insensitive basename (handles capitalization garble).
  hit = unique(safe(workdirFiles.filter((f) => basename(f).toLowerCase() === base.toLowerCase())));
  if (hit) return snap(hit, 'case-normalized to the real filename');

  // 3) Punctuation/extension-squashed basename (handles dropped/altered dot or
  //    extension, e.g. "titlecasejs" -> "titlecase.js").
  const sb = squash(base);
  hit = unique(safe(workdirFiles.filter((f) => squash(basename(f)) === sb)));
  if (hit) return snap(hit, 'extension/punctuation-normalized to the real filename');

  // No edit-distance fallback: guessing the "nearest" filename produced wrong
  // snaps (e.g. `oct` -> `octop`). A garble we cannot resolve by exact basename /
  // case / punctuation match is left unchanged so it fails loud and self-corrects.
  return unchanged;
}

/** Tool-call argument keys that carry a file path, by Claude Code tool name. */
export const PATH_ARG_KEYS = ['file_path', 'path', 'filePath', 'notebook_path'] as const;

/**
 * Normalize any path-bearing argument in a tool-call input object in place.
 * Returns the corrections made (empty when nothing changed). Pure w.r.t. the
 * filesystem — `workdirFiles` is supplied by the caller (the hook).
 */
export function normalizeToolInput(
  input: Record<string, unknown>,
  workdirFiles: string[],
): { input: Record<string, unknown>; corrections: { key: string; from: string; to: string; reason: string }[] } {
  const corrections: { key: string; from: string; to: string; reason: string }[] = [];
  const out = { ...input };
  for (const key of PATH_ARG_KEYS) {
    const v = out[key];
    if (typeof v !== 'string') continue;
    const r = normalizeToolPath(v, workdirFiles);
    if (r.changed) {
      out[key] = r.path;
      corrections.push({ key, from: v, to: r.path, reason: r.reason ?? '' });
    }
  }
  return { input: out, corrections };
}
