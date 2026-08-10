/**
 * Warn when a mission is asking deliver to DELETE files, which it cannot do.
 *
 * THE FAILURE THIS CATCHES
 * The executor has no delete tool, and `run_bash` is off unless --allow-bash.
 * So a model told to remove a file has exactly one move available: overwrite it
 * with a stub. That is worse than failing, because it half-works.
 *
 * Observed live on 2026-08-10, in a run whose instruction began "Clean up nested
 * architecture: remove src/rust-pg-ext/src/contracts.rs, cooccurrence.rs,
 * hash.rs, slope.rs, sr_lookup…":
 *
 *   r7  write_file contracts.rs      -> refused (anti-gutting)
 *   r8  edit_file  contracts.rs      -> OK      -> cargo check now FAILING
 *   r10 edit_file  sr_lookup/mod.rs  -> OK      -> cargo check now FAILING
 *   r12 edit_file  sr_lookup.rs      -> refused (anti-gutting)
 *   Turn 1: 20% of gates (435s)
 *
 * The anti-gutting predicate only fires on files of 1500 bytes or more, so the
 * SMALL files were successfully replaced with `// REMOVED` — breaking the build
 * — while the large ones were refused, leaving the job half-done. Neither
 * outcome can reach green, so the run burns its turns and leaves the tree worse
 * than it found it.
 *
 * Deleting a file needs no convergence: there is nothing to author and nothing
 * for a gate to judge. The project's own routing guidance already says so —
 * "deleting or renaming files … are not gated — make them directly" — but
 * nothing said it at the point where it matters, which is when a deletion
 * mission is launched.
 *
 * ADVISORY, and narrow by construction. It fires only when a deletion verb is
 * followed by an actual path, so "remove the unused import from src/a.rs" —
 * an edit, whose object is the import — does not trigger it.
 */

import { existsSync } from 'fs';
import { isAbsolute, join } from 'path';
import { mentionedPaths } from './scope-notice.js';

/** Verbs that mean "make this file cease to exist". */
const DELETE_VERB = /\b(?:delete|remove|drop|rm|get rid of)\b/gi;

/**
 * Words that may sit between the verb and its object without changing it —
 * articles and the noun for a file. Anything else (notably a preposition like
 * "from" or "in") means the path is a LOCATION, not the thing being removed.
 */
const FILLER = new Set(['the', 'a', 'an', 'these', 'this', 'those', 'that',
  'file', 'files', 'module', 'modules', 'now', 'also', 'old', 'unused',
  'duplicate', 'dead', 'stale', 'legacy', 'redundant']);

/**
 * Paths the instruction asks to DELETE, in first-seen order.
 *
 * Only paths that exist under `projectRoot` are returned: a mission naming a
 * file that is already gone needs no warning, and a path that never existed is
 * more likely prose than a target.
 */
export function deletionTargets(
  instruction: string,
  projectRoot: string,
  exists: (p: string) => boolean = existsSync
): string[] {
  const known = new Set(mentionedPaths(instruction));
  if (known.size === 0) return [];

  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of instruction.matchAll(DELETE_VERB)) {
    // Walk forward from the verb: filler may intervene, a path ends the walk,
    // and anything else means this verb governs something that is not a file.
    const after = instruction.slice(m.index + m[0].length);
    const tokens = after.split(/[\s,;]+/).filter(Boolean);
    // No cap on how far to walk: the FILLER list is what discriminates, and
    // any non-filler word ends the walk on the next line. A separate distance
    // limit was indistinguishable by any test and could only cause a real
    // target to be missed after a long run of adjectives.
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i].replace(/^[*_`("']+/, '').replace(/[*_`)."',;:]+$/, '');
      if (!tok) continue;
      if (known.has(tok)) {
        // A comma-separated run after the verb is all one list of targets:
        // "remove a.rs, b.rs, c.rs". Take every path until a non-path word.
        for (let j = i; j < tokens.length; j++) {
          const t = tokens[j].replace(/^[*_`("']+/, '').replace(/[*_`)."',;:]+$/, '');
          if (!known.has(t)) break;
          if (!seen.has(t)) {
            seen.add(t);
            out.push(t);
          }
        }
        break;
      }
      if (!FILLER.has(tok.toLowerCase())) break; // the verb governs something else
    }
  }
  return out.filter((p) => !isAbsolute(p) && exists(join(projectRoot, p)));
}

/**
 * The notice, or null when the mission is not asking for deletions.
 *
 * Says what deliver will DO if it proceeds, not merely that it should not —
 * the stub-and-break outcome is the part a model needs to recognise, because
 * overwriting the file is the move it will otherwise reach for.
 */
export function formatDeletionNotice(targets: readonly string[]): string | null {
  if (targets.length === 0) return null;
  const list = targets.map((t) => `  - ${t}`).join('\n');
  return [
    'DELETION NOTICE — this task asks for files to be REMOVED, which this run cannot do.',
    list,
    '',
    'There is no delete tool here, and the shell is unavailable unless the operator',
    'enabled it. Overwriting a file with a stub is NOT deleting it: for a small file',
    'the write succeeds and the build breaks on the missing module, and for a large',
    'one it is refused as gutting — so the job ends half-done either way.',
    '',
    'Deleting a file needs no convergence and is NOT gated: do it directly with the',
    'shell (`rm <path>`), remove the references that point at it, and verify with the',
    "project's own build. Then use this run only for the parts that need authoring.",
  ].join('\n');
}
