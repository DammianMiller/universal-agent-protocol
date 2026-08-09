/**
 * Warn when a mission's instruction names files it cannot reach.
 *
 * THE FAILURE THIS CATCHES
 * `safePath` refuses any edit that resolves outside the project root, which is
 * correct and stays. But refusing one path does not stop the model wanting that
 * file — and its next move is the damaging one. Observed live on 2026-08-09 in
 * `cognition-engine`:
 *
 *   projectRoot: <repo>/src/rust-pg-ext        (the crate)
 *   instruction: "... **src/sql/setup.sql** lines 22-29: replace SQL md5 hash
 *                 functions with Rust XXH64 versions ..."
 *
 * That file is `<repo>/src/sql/setup.sql` — 62KB, outside the crate. The model
 * tried `../sql/setup.sql`, was refused, and then CREATED a 1.5KB stub at
 * `<crate>/src/sql/setup.sql`, which safePath allows because it is inside the
 * root. The guard deflected the model into writing a plausible file in the
 * wrong place: untracked, unreferenced, and easy to mistake for the real edit.
 *
 * The mission was mis-scoped — it should have run at the repo root — and that
 * was knowable before the first turn, from the instruction and the filesystem
 * alone. Saying so up front turns a silent wrong-place write into a fact the
 * model and the operator both get for free.
 *
 * DELIBERATELY ADVISORY. A path in an instruction can be illustrative, a file
 * yet to be created, or prose that merely looks like a path, so refusing the
 * run on this signal would block legitimate work. It only ever reports paths
 * that are ABSENT under the project root and PRESENT above it — the one
 * combination that cannot be explained by "the model will create it".
 */

import { existsSync } from 'fs';
import { isAbsolute, join, relative, resolve } from 'path';

/**
 * The enclosing repository root ABOVE `projectRoot`, or null.
 *
 * Null when the project root is itself the repo root — there is nothing above
 * to be out of scope of — and null when no repository encloses it at all.
 * `.git` is a directory in a normal clone and a FILE in a worktree, so both
 * count.
 */
export function findRepoRoot(
  projectRoot: string,
  exists: (p: string) => boolean = existsSync
): string | null {
  let dir = resolve(projectRoot);
  for (let hops = 0; hops < 64; hops++) {
    const parent = resolve(dir, '..');
    if (parent === dir) return null; // hit the filesystem root
    dir = parent;
    if (exists(join(dir, '.git'))) return dir;
  }
  return null;
}

/** A path the instruction asks for that this run cannot reach. */
export interface UnreachablePath {
  /** The path as written in the instruction. */
  mentioned: string;
  /** Where it actually is, relative to the search root. */
  foundAt: string;
}

/**
 * File-like tokens: a path with a real extension. Requiring an extension is
 * what keeps prose out — "src/sql" or "the setup" are not candidates, and a
 * bare word never is. Markdown emphasis and surrounding punctuation are
 * stripped by the caller before this matches.
 */
const PATH_TOKEN = /[\w.-]+(?:\/[\w.-]+)*\.[a-z]{1,6}\b/gi;

/**
 * Extensions worth checking. An open-ended match turns ordinary sentences
 * ("v1.2", "e.g.", "node.js") into candidate paths; a fixed list keeps the
 * signal specific to source trees.
 */
const SOURCE_EXT = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'rs', 'py', 'go', 'rb', 'java', 'kt',
  'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'php', 'swift', 'sql', 'sh', 'bash',
  'toml', 'yaml', 'yml', 'json', 'md', 'css', 'scss', 'html', 'jinja',
]);

/** Candidate paths mentioned in free text, de-duplicated, in first-seen order. */
export function mentionedPaths(instruction: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of instruction.match(PATH_TOKEN) ?? []) {
    // Strip markdown emphasis and trailing punctuation the token may have eaten.
    const tok = raw.replace(/^[*_`]+/, '').replace(/[*_`.,;:)\]]+$/, '');
    if (!tok.includes('/')) continue; // a bare filename is too weak a signal
    const ext = tok.split('.').pop()?.toLowerCase() ?? '';
    if (!SOURCE_EXT.has(ext)) continue;
    if (seen.has(tok)) continue;
    seen.add(tok);
    out.push(tok);
  }
  return out;
}

/**
 * Paths the instruction names that are missing under `projectRoot` but present
 * under `searchRoot` (normally the repo root above it).
 *
 * Returns [] when searchRoot is not an ancestor of projectRoot — there is no
 * "above" to look in, so there is nothing this can be confident about.
 */
export function unreachablePaths(
  instruction: string,
  projectRoot: string,
  searchRoot: string,
  exists: (p: string) => boolean = existsSync
): UnreachablePath[] {
  const rel = relative(resolve(searchRoot), resolve(projectRoot));
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return [];

  const found: UnreachablePath[] = [];
  for (const p of mentionedPaths(instruction)) {
    if (isAbsolute(p)) continue; // an absolute path is not a scope mistake
    if (exists(join(projectRoot, p))) continue; // reachable — nothing to say
    if (!exists(join(searchRoot, p))) continue; // absent everywhere: to be created
    found.push({ mentioned: p, foundAt: join(relative(projectRoot, searchRoot), p) });
  }
  return found;
}

/**
 * The prompt/console notice, or null when there is nothing to report.
 *
 * Names the substitute-file failure explicitly. Telling a model only "you
 * cannot reach it" leaves creating a same-named file inside the root as the
 * obvious next move — which is the exact damage observed.
 */
export function formatScopeNotice(
  unreachable: readonly UnreachablePath[],
  projectRoot: string,
  searchRoot: string
): string | null {
  if (unreachable.length === 0) return null;
  const lines = unreachable.map((u) => `  - ${u.mentioned}  (actually at ${u.foundAt})`);
  return [
    'SCOPE NOTICE — this task names files that are OUTSIDE the project root you are running in.',
    `Project root: ${projectRoot}`,
    lines.join('\n'),
    '',
    'You cannot edit them: every path is resolved inside the project root, so `../` is refused.',
    'Do NOT create a same-named file inside the project root as a substitute — it would be a new,',
    'unreferenced file, not the edit that was asked for. Complete the parts that ARE in scope, and',
    `report the rest as out of scope. If they are essential, the run belongs at ${searchRoot}.`,
  ].join('\n');
}
