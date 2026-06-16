/**
 * Project tree snapshot/restore for `uap deliver --no-regress`.
 *
 * Captures the project state before the convergence loop runs so deliver can
 * roll back if it ends up worse (by the real gates' measure) than it started.
 * Excludes heavy/derived trees (.git, node_modules) — they aren't part of the
 * task's source and would make snapshots slow.
 */

import { cpSync, rmSync, mkdtempSync, readdirSync } from 'fs';
import { join, basename } from 'path';
import { tmpdir } from 'os';

const EXCLUDE = new Set(['.git', 'node_modules', '.uap-deliver']);

/** Copy the project tree (minus excluded dirs) to a temp dir; return its path. */
export function snapshotTree(root: string): string {
  const snap = mkdtempSync(join(tmpdir(), 'uap-snap-'));
  cpSync(root, snap, {
    recursive: true,
    filter: (src) => !EXCLUDE.has(basename(src)),
  });
  return snap;
}

/** Restore the project tree from a snapshot: drop current entries, copy back. */
export function restoreTree(root: string, snap: string): void {
  for (const entry of readdirSync(root)) {
    if (EXCLUDE.has(entry)) continue;
    rmSync(join(root, entry), { recursive: true, force: true });
  }
  for (const entry of readdirSync(snap)) {
    cpSync(join(snap, entry), join(root, entry), { recursive: true });
  }
}

/** Remove a snapshot directory. */
export function disposeSnapshot(snap: string): void {
  rmSync(snap, { recursive: true, force: true });
}
