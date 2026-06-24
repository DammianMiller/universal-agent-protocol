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

export interface NormalizeOptions {
  /**
   * Max Levenshtein distance (on the basename) for the typo fallback to fire.
   * Defaults to max(2, 30% of basename length).
   */
  maxEditDistance?: number;
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
  if (cp === '') return true; // bare known path — safe to snap to
  return squash(parentDir(proposed)) === squash(cp);
}

function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const prev = new Array(n + 1);
  const cur = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= n; j++) prev[j] = cur[j];
  }
  return prev[n];
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
  opts: NormalizeOptions = {},
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

  // 4) Edit-distance fallback for genuine typos. Fire only when the best match
  //    is meaningfully better than the runner-up (avoids ambiguous snaps).
  const maxD = opts.maxEditDistance ?? Math.max(2, Math.floor(base.length * 0.3));
  const ranked = safe(workdirFiles)
    .map((f) => ({ f, d: editDistance(base.toLowerCase(), basename(f).toLowerCase()) }))
    .sort((x, y) => x.d - y.d);
  if (
    ranked.length > 0 &&
    ranked[0].d <= maxD &&
    (ranked.length < 2 || ranked[1].d > ranked[0].d)
  ) {
    return snap(ranked[0].f, `nearest filename by edit distance (${ranked[0].d})`);
  }

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
  opts: NormalizeOptions = {},
): { input: Record<string, unknown>; corrections: { key: string; from: string; to: string; reason: string }[] } {
  const corrections: { key: string; from: string; to: string; reason: string }[] = [];
  const out = { ...input };
  for (const key of PATH_ARG_KEYS) {
    const v = out[key];
    if (typeof v !== 'string') continue;
    const r = normalizeToolPath(v, workdirFiles, opts);
    if (r.changed) {
      out[key] = r.path;
      corrections.push({ key, from: v, to: r.path, reason: r.reason ?? '' });
    }
  }
  return { input: out, corrections };
}
