/**
 * Changed-file discovery for the watch-ci commit boundary.
 *
 * Extracted from deliver.ts so the porcelain parsing is testable: the old
 * inline version sliced 3 chars off EVERY NUL token, but a rename/copy entry
 * is `XY new\0old\0` — the old-path token has NO status prefix, so slicing it
 * produced a corrupted pathspec, and one bad pathspec fails the whole
 * `git add -- <files>` (a real wedge on missions that move files).
 */

import { spawnSync } from 'child_process';

/**
 * Parse `git status --porcelain -z` output into the CURRENT paths of every
 * changed entry. Rename/copy entries contribute their NEW path only; the
 * trailing old-path token is consumed, never mangled.
 */
export function parsePorcelainZ(out: string): string[] {
  const tokens = out.split('\0');
  const files: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (!tok) continue;
    const status = tok.slice(0, 2);
    const path = tok.slice(3);
    if (path) files.push(path);
    // Renames/copies carry the OLD path as the NEXT token, bare.
    if (status[0] === 'R' || status[0] === 'C' || status[1] === 'R' || status[1] === 'C') i++;
  }
  return files;
}

/**
 * Changed files in the working tree, minus harness-owned state — run
 * checkpoints, traces, and mined weaknesses must never ride into a delivery
 * commit on repos that don't ignore `.uap/`. Fail-soft to [] (the watch-ci
 * runner treats an empty set as nothing-to-commit and skips the watch).
 */
export function changedFiles(projectRoot: string): string[] {
  try {
    const r = spawnSync('git', ['status', '--porcelain', '-z'], {
      cwd: projectRoot,
      encoding: 'utf-8',
    });
    if (r.status !== 0 || !r.stdout) return [];
    return parsePorcelainZ(r.stdout).filter((f) => !f.startsWith('.uap/') && !f.startsWith('.uap\\'));
  } catch {
    return [];
  }
}
