/**
 * Tool-call path normalization for deliver's agentic executor.
 *
 * Small/local quants garble file paths in write_file/read_file calls — a mangled
 * absolute PREFIX (/home/cogtek→/home/cogtec, octopus_invaders→octus_invaders) or
 * a mangled SUBDIR (space-shooter→space-shootr) — so the write lands nowhere or
 * escapes the project. The UAP Anthropic proxy fixes this for Claude Code via
 * tools/agents/scripts/toolcall_path_normalizer.py, but deliver's agentic path
 * goes direct to the model and bypassed it. This is the TS port, adapted for the
 * case where deliver already KNOWS the workdir (the project root) — so it
 * contains garbled paths back onto a known root instead of deriving one.
 *
 * Kept behavior-compatible with the python (cross-checked in tests):
 *   - squash-equality + a similarity ratio for fuzzy component matching
 *   - contain-to-workdir (prefix/workdir-name + subdir correction against disk)
 *   - filename repair for read of an existing file (case/extension/punctuation)
 */
import { existsSync, readdirSync, statSync } from 'fs';
import { isAbsolute, basename, dirname, join } from 'path';

export function squash(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Levenshtein distance (iterative, O(n*m)). */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let cur = new Array(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}

/** Two path components are "the same intent" if they squash-match or are close. */
export function fuzzyEq(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (squash(a) === squash(b)) return true;
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  const ratio = 1 - levenshtein(la, lb) / Math.max(la.length, lb.length);
  return ratio >= 0.78;
}

/** Walk `suffix` under `workdir`, fuzzy-correcting each intermediate DIRECTORY
 *  component to an existing on-disk sibling when the exact name is absent but a
 *  single close match exists. The final component (file being created) is left. */
export function fsCorrectSuffix(workdir: string, suffix: string): string {
  if (!suffix) return suffix;
  const parts = suffix.split('/').filter(Boolean);
  let cur = workdir;
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const comp = parts[i];
    const nxt = join(cur, comp);
    if (i === parts.length - 1 || existsSync(nxt)) {
      out.push(comp);
      cur = nxt;
      continue;
    }
    let cands: string[] = [];
    try {
      cands = readdirSync(cur).filter(
        (e) => statSync(join(cur, e)).isDirectory() && fuzzyEq(e, comp)
      );
    } catch {
      cands = [];
    }
    const chosen = cands.length === 1 ? cands[0] : comp;
    out.push(chosen);
    cur = join(cur, chosen);
  }
  return out.join('/');
}

export interface ContainResult {
  path: string;
  changed: boolean;
  reason?: string;
}

/** Snap a garbled in-workdir path back onto `workdir` (known project root). */
export function containToWorkdir(path: string, workdir: string): ContainResult {
  if (!path || !workdir || !path.startsWith('/')) return { path, changed: false };
  const wd = workdir.replace(/\/+$/, '');

  let suffix: string;
  let reason: string;
  if (path === wd || path.startsWith(wd + '/')) {
    suffix = path.slice(wd.length).replace(/^\/+/, '');
    reason = 'corrected garbled subdir(s) under the workdir';
  } else if (existsSync(path)) {
    return { path, changed: false }; // a real path elsewhere — don't touch
  } else {
    const wdName = wd.split('/').filter(Boolean).slice(-1)[0] ?? '';
    const parts = path.split('/').filter(Boolean);
    let anchor: number | null = null;
    for (let i = parts.length - 1; i >= 0; i--) {
      if (fuzzyEq(parts[i], wdName)) {
        anchor = i;
        break;
      }
    }
    if (anchor === null) return { path, changed: false };
    suffix = parts.slice(anchor + 1).join('/');
    reason = `contained garbled out-of-workdir path to '${wdName}'`;
  }
  const corrected = fsCorrectSuffix(wd, suffix);
  const next = wd + (corrected ? '/' + corrected : '');
  return next !== path ? { path: next, changed: true, reason } : { path, changed: false };
}

/** Repair only the filename of an existing-dir path by snapping to a real
 *  sibling (case/extension/punctuation). For read/edit of a file that exists. */
export function repairFilename(abs: string): ContainResult {
  if (!isAbsolute(abs)) return { path: abs, changed: false };
  if (existsSync(abs)) return { path: abs, changed: false };
  const parent = dirname(abs);
  const base = basename(abs);
  if (!base || !existsSync(parent) || !statSync(parent).isDirectory()) {
    return { path: abs, changed: false };
  }
  let entries: string[];
  try {
    entries = readdirSync(parent).filter((e) => statSync(join(parent, e)).isFile());
  } catch {
    return { path: abs, changed: false };
  }
  let matches = entries.filter((e) => e.toLowerCase() === base.toLowerCase());
  let reason = 'case-normalized to the real filename in the same directory';
  if (matches.length === 0) {
    const sb = squash(base);
    matches = entries.filter((e) => squash(e) === sb);
    reason = 'extension/punctuation-normalized to the real filename in the same directory';
  }
  if (matches.length !== 1) return { path: abs, changed: false };
  const target = join(parent, matches[0]);
  return target !== abs ? { path: target, changed: true, reason } : { path: abs, changed: false };
}

/**
 * Normalize a tool-call path against the known project root.
 *   - absolute → contain to root (prefix/workdir-name + subdir correction)
 *   - relative → fuzzy-correct garbled existing subdirs under root
 *   - read of an existing file → also repair the filename to a real sibling
 * Returns the corrected path (absolute or relative as given) + a note if changed.
 */
/**
 * Strip a leading run of segments that repeats the project root's own trailing
 * segments, or null when the path is not a root echo.
 *
 * Narrow by construction, because the cost of a wrong rewrite is a write to the
 * wrong file:
 *   - the echoed prefix must be the root's OWN trailing segments, longest first
 *     (so `.../src/rust-pg-ext` matches `src/rust-pg-ext/...` before `rust-pg-ext/...`);
 *   - the stripped path must already EXIST — never invent a destination;
 *   - the doubled path must NOT exist. A genuinely nested `packages/foo/packages/foo`
 *     is then left alone, because if the deeper file is real it is what was meant.
 *
 * That last clause makes this a first-write guard, which is the whole job: the
 * phantom is what creates the ambiguity, so preventing it is enough.
 */
export function stripRootEcho(projectRoot: string, rel: string, forWrite: boolean): string | null {
  const rootSegs = projectRoot.split('/').filter(Boolean);
  const relSegs = rel.split('/').filter(Boolean);
  // Belt-and-braces: `maxEcho` below already excludes a single-segment path
  // (its ceiling becomes 0, so the loop never runs). Removing this line is an
  // EQUIVALENT MUTANT and no test kills it; it stays as a cheap early-out that
  // says the intent out loud.
  if (relSegs.length < 2) return null;
  if (existsSync(join(projectRoot, rel))) return null; // the deep path is real
  // `- 1` keeps at least one segment for the file itself. Widening it to
  // consume the whole path is an EQUIVALENT MUTANT: the strip would yield an
  // empty string, which the `!stripped` guard below already skips.
  const maxEcho = Math.min(rootSegs.length, relSegs.length - 1);
  for (let k = maxEcho; k >= 1; k--) {
    const tail = rootSegs.slice(rootSegs.length - k);
    if (!tail.every((seg, i) => relSegs[i] === seg)) continue;
    const stripped = relSegs.slice(k).join('/');
    if (!stripped) continue;
    if (existsSync(join(projectRoot, stripped))) return stripped;
    // Creating a new file is legitimate as long as its directory is real.
    if (forWrite && existsSync(join(projectRoot, dirname(stripped)))) return stripped;
  }
  return null;
}

export function normalizeToolPath(
  projectRoot: string,
  proposed: string,
  opts: { forWrite?: boolean } = {}
): ContainResult {
  const trimmed = (proposed ?? '').trim();
  if (!trimmed) return { path: proposed, changed: false };

  if (isAbsolute(trimmed)) {
    const contained = containToWorkdir(trimmed, projectRoot);
    if (!opts.forWrite) {
      const repaired = repairFilename(contained.path);
      if (repaired.changed) return { path: repaired.path, changed: true, reason: repaired.reason };
    }
    return contained.changed ? contained : { path: trimmed, changed: trimmed !== proposed, reason: 'trimmed' };
  }

  // A path that re-enters the project root BY NAME. A model handed a
  // repo-root-relative path (`src/rust-pg-ext/src/lib.rs`) while the run's root
  // already IS `.../src/rust-pg-ext` writes one level too deep, and the result
  // is a phantom tree that looks plausible to every later reader — including a
  // self-authored gate, which then reports progress on files the project does
  // not have. Measured live 2026-08-12: 20 minutes of work landed in
  // `src/rust-pg-ext/src/rust-pg-ext/src/lib.rs` while the real crate file was
  // never touched.
  const echoed = stripRootEcho(projectRoot, trimmed, opts.forWrite === true);
  if (echoed) return { path: echoed, changed: true, reason: 'path repeated the project root' };

  // Relative: fuzzy-correct garbled existing subdirs under the root.
  const corrected = fsCorrectSuffix(projectRoot, trimmed);
  if (!opts.forWrite) {
    const repaired = repairFilename(join(projectRoot, corrected));
    if (repaired.changed) {
      // Return relative to keep the caller's shape.
      return { path: repaired.path.slice(projectRoot.length).replace(/^\/+/, ''), changed: true, reason: repaired.reason };
    }
  }
  return corrected !== trimmed ? { path: corrected, changed: true, reason: 'corrected garbled subdir(s)' } : { path: proposed, changed: false };
}
