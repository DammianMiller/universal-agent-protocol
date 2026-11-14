/**
 * Did-you-mean hints for missing paths (harness plan O-C.2).
 *
 * Measured motivation (tool-calls corpus, 2026-10-11 → 2026-11-14): 502
 * `path-not-found` failures, and the guessed paths are near-misses of real
 * files (`apps/api/src/repositories/installments_repository.ts`-shaped).
 * A bare "does not exist" answers the question the model did not ask — it
 * already knows the file is missing, that is why it is trying to create or
 * read it — and the retry is another guess. Telling it what IS there converts
 * the next round from a guess into a lookup.
 *
 * The hint is deliberately an ERROR APPENDAGE, never a standalone result, so
 * the telemetry classifier still files the call under `path-not-found` (the
 * leading text carries the trigger phrase; nothing in the hint text does).
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Bounds: a hint must stay cheap even on hostile inputs (gigantic dirs). */
const MAX_UP_LEVELS = 4;
const MAX_ENTRIES_PER_DIR = 60;
const MAX_SUGGESTIONS = 3;
const MAX_LISTED_ENTRIES = 12;
/** Candidate depth below the anchor dir. 2 catches `src/types/audit.ts`
 * when the anchor is `src/` and the guess named `src/types/audits.ts`. */
const MAX_CANDIDATE_DEPTH = 2;

export interface PathHintOptions {
  maxSuggestions?: number;
}

/** Cheap case-insensitive similarity in [0, 1]; 1 = identical. */
function similarity(a: string, b: string): number {
  const x = a.toLowerCase().replace(/[^a-z0-9]/g, '');
  const y = b.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (x === y) return 1;
  if (x.length === 0 || y.length === 0) return 0;
  // Bounded Levenshtein: these strings are path fragments, not genomes.
  const prev = new Array<number>(y.length + 1);
  const cur = new Array<number>(y.length + 1);
  for (let j = 0; j <= y.length; j++) prev[j] = j;
  for (let i = 1; i <= x.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= y.length; j++) {
      const cost = x[i - 1] === y[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= y.length; j++) prev[j] = cur[j];
  }
  return 1 - prev[y.length] / Math.max(x.length, y.length);
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The deepest existing ancestor directory of `rel` (POSIX-project-relative),
 * plus how many segments of `rel` live below it. `[null, 0]` when none of the
 * ancestors exist within the walk-up bound (a fully bogus root).
 */
function nearestExistingAncestor(
  projectRoot: string,
  rel: string,
): { dir: string; dirRel: string; missing: string[] } | null {
  const parts = rel.split('/').filter((p) => p.length > 0 && p !== '.');
  if (parts.length === 0) return null;
  // Peel TRAILING components until a directory exists — including peeling
  // ALL of them, in which case the project root itself is the anchor. The
  // case-insensitive miss ('BIG.js' vs 'big.js') has no existing prefix at
  // all, and its did-you-mean lives in the root listing.
  const maxPeel = Math.min(MAX_UP_LEVELS, parts.length);
  for (let peel = 0; peel <= maxPeel; peel++) {
    const keep = parts.length - peel;
    const dir = join(projectRoot, ...parts.slice(0, keep));
    if (isDirectory(dir)) {
      return {
        dir,
        dirRel: parts.slice(0, keep).join('/') || '.',
        missing: parts.slice(keep),
      };
    }
  }
  return null;
}

interface Candidate {
  rel: string;
  score: number;
}

/**
 * Collect paths under `dir` (bounded breadth/depth) whose names resemble the
 * missing tail of the request. Resemblance is scored against the FULL
 * requested path so a same-named file in a different directory ranks below a
 * same-named file in the right one.
 */
function collectCandidates(
  dir: string,
  dirRel: string,
  wanted: string,
): Candidate[] {
  const out: Candidate[] = [];
  const walk = (abs: string, rel: string, depth: number): void => {
    let names: string[];
    try {
      names = readdirSync(abs).slice(0, MAX_ENTRIES_PER_DIR);
    } catch {
      return;
    }
    for (const name of names) {
      if (name.startsWith('.') && !wanted.startsWith('.')) continue;
      const relHere = rel === '' ? name : `${rel}/${name}`;
      let isDir: boolean;
      try {
        isDir = statSync(join(abs, name)).isDirectory();
      } catch {
        continue;
      }
      if (isDir) {
        if (depth < MAX_CANDIDATE_DEPTH) walk(join(abs, name), relHere, depth + 1);
        continue;
      }
      const score = similarity(relHere, wanted);
      if (score >= 0.55) out.push({ rel: relHere, score });
    }
  };
  walk(dir, dirRel, 0);
  return out.sort((a, b) => b.score - a.score);
}

/**
 * A did-you-mean suffix for a path-not-found error, or null when nothing
 * useful can be said cheaply. NEVER throws — a hint failure must not turn a
 * clean `path-not-found` into an `other-error`.
 */
export function nearestPathHint(
  projectRoot: string,
  rel: string,
  options: PathHintOptions = {},
): string | null {
  try {
    const wanted = String(rel ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (wanted === '' || wanted === '.') return null;
    // The request may itself be a directory the caller mis-filed; the caller's
    // error text distinguishes that, the hint just needs to not lie.
    const ancestor = nearestExistingAncestor(projectRoot, wanted);
    if (!ancestor) return null;
    const dirRel = ancestor.dirRel;
    const candidates = collectCandidates(ancestor.dir, dirRel, wanted);
    const seen = new Set<string>();
    const suggestions: string[] = [];
    for (const c of candidates) {
      if (seen.has(c.rel)) continue;
      seen.add(c.rel);
      suggestions.push(c.rel);
      if (suggestions.length >= (options.maxSuggestions ?? MAX_SUGGESTIONS)) break;
    }
    if (suggestions.length > 0) {
      return ` — did you mean: ${suggestions.join(', ')}?`;
    }
    // Nothing close: the second-best hint is what the nearest existing
    // directory actually holds, so the model's next path is a fact not a guess.
    let names: string[] = [];
    try {
      names = readdirSync(ancestor.dir).slice(0, MAX_LISTED_ENTRIES);
    } catch {
      return null;
    }
    const entries = names.map((name) => {
      try {
        return statSync(join(ancestor.dir as string, name)).isDirectory() ? `${name}/` : name;
      } catch {
        return name;
      }
    });
    if (entries.length === 0) return null;
    const suffix = ancestor.missing.length > 0 ? ` (nothing under ${ancestor.missing.join('/')})` : '';
    return ` — nearest existing directory ${dirRel}/ contains: ${entries.join(', ')}${suffix}`;
  } catch {
    return null;
  }
}
