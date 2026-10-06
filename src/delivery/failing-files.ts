/**
 * Error-anchored steering: the files a failing gate NAMED
 *
 * A deliver executor can burn its entire turn budget editing a file the gates
 * never complained about. Observed live (run 20261006T042017, rust-pg-ext M1
 * bench): every turn's gate dump named `src/bench.rs:21` and `src/bench.rs:408`,
 * and every one of the executor's 12 rounds edited `src/bin/m1-bench.rs`
 * instead. The gate output had the answer all along; nothing forced the
 * executor's attention onto it.
 *
 * This module pulls machine-readable file locations out of failing gate output
 * so the loop can (a) name those files at the TOP of the next prompt and
 * (b) narrow the turn's writable set to them when the run stagnates.
 *
 * Extraction is deliberately conservative: a candidate only counts when the
 * file EXISTS under the project root (compilers print real paths; the model
 * invents the others), and everything outside the source tree (.uap, node_modules,
 * lockfiles) is dropped.
 */

import { existsSync } from 'fs';
import { relative, resolve } from 'path';
import { containsProtectedSegment } from './applier.js';

export interface GateResultLike {
  passed: boolean;
  skipped: boolean;
  outputTail?: string;
  failureReason?: string;
}

/** Source extensions worth steering to — keeps false positives out. */
const SOURCE_EXT = /\.(rs|ts|tsx|js|mjs|cjs|jsx|py|pyi|go|java|kt|kts|rb|php|cs|swift|c|cc|cpp|cxx|h|hpp|hh|sh|sql|vue|svelte)$/i;

/**
 * Paths a failing gate may name but the executor must not be steered into.
 * Derived from the applier's OWN protected-segment list (single source of
 * truth — review X3/arch F1): the previous local list checked only the FIRST
 * path segment and missed `.husky`, `.github`, `.circleci`…, so model-steered
 * gate output could name a protected path straight into the write allowlist.
 */
const STEERING_EXCLUDED_EXTRA = new Set(['node_modules', 'dist', '.worktrees']);

/**
 * Extract the source files named by failing gate output.
 *
 * Recognized shapes (the formats that actually appear in the gates this
 * harness runs):
 *  - rustc/gcc-style `  --> path/to/file.rs:21:5`
 *  - generic `path/to/file.py:12` / `src/foo.ts:12:3`
 *  - TypeScript `src/foo.ts(12,3): error TS2345`
 *  - Python traceback `File "path/to/file.py", line 12`
 *
 * Returns unique, project-relative, POSIX-style paths that exist, capped at
 * `maxFiles` (most-relevant first: first-seen order — compilers name the root
 * cause before its cascade).
 */
export function extractFailingFiles(
  results: GateResultLike[],
  projectRoot: string,
  maxFiles = 6
): string[] {
  const root = resolve(projectRoot);
  const seen = new Set<string>();
  const out: string[] = [];

  const add = (raw: string): void => {
    const abs = resolve(root, raw);
    const rel = relative(root, abs);
    if (rel.startsWith('..')) return; // outside the project (or absolute elsewhere)
    if (!SOURCE_EXT.test(rel)) return;
    const key = rel.split('\\').join('/');
    // Any protected segment ANYWHERE in the path (plus the extra local
    // exclusions) — a gate naming `.github/workflows/x.sh` must never become
    // a sanctioned write target, however deep the path.
    if (containsProtectedSegment(key) !== null) return;
    if (STEERING_EXCLUDED_EXTRA.has(key.split('/')[0] ?? '')) return;
    if (!existsSync(abs)) return; // a path the model INVENTED never exists
    if (seen.has(key)) return;
    seen.add(key);
    if (out.length < maxFiles) out.push(key);
  };

  for (const r of results) {
    if (r.passed || r.skipped || !r.outputTail) continue;
    const text = r.outputTail;
    // rustc / gcc:  --> src/lib.rs:21:5
    for (const m of text.matchAll(/-->\s*(\S+?):\d+(?::\d+)?/g)) add(m[1]);
    // TypeScript: src/foo.ts(12,3): error TS2345
    for (const m of text.matchAll(/\b(\S+\.(?:ts|tsx))\(\d+,\d+\)/g)) add(m[1]);
    // Python: File "src/foo.py", line 12
    for (const m of text.matchAll(/File "([^"]+)", line \d+/g)) add(m[1]);
    // generic path:line / path:line:col, applied LAST so the specific shapes
    // above win any overlap. Requires a real source extension in the token so
    // numbers, URLs and version strings cannot match.
    for (const m of text.matchAll(/\b([^\s"'`]+?\.[A-Za-z]{1,6}):\d+(?::\d+)?/g)) add(m[1]);
  }
  return out;
}

/**
 * Did the previous turn's edits touch ANY of the files the gates named? When a
 * turn produced writes yet none of them intersect the failing set, the executor
 * is polishing the wrong file — the exact live failure this module exists for.
 * (Empty `filesApplied` is NOT a wrong-file turn: nothing was tried.)
 */
export function editsMissedFailingFiles(filesApplied: string[], failingFiles: string[]): boolean {
  if (filesApplied.length === 0 || failingFiles.length === 0) return false;
  // Normalize before comparing (review quality F7): applied paths can carry
  // `./` prefixes and doubled slashes that failingFiles (compiler-shaped)
  // never do — a raw compare would then flag a turn that DID edit the right
  // file and burn the wrong-file banner on a false positive.
  const norm = (f: string): string =>
    f.split('\\').join('/').replace(/^\.\//, '').replace(/\/\+/g, '/').toLowerCase();
  const applied = new Set(filesApplied.map(norm));
  return !failingFiles.some((f) => applied.has(norm(f)));
}
