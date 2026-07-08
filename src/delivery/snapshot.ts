/**
 * Project tree snapshot/restore for `uap deliver --no-regress`.
 *
 * Captures the project state before the convergence loop runs so deliver can
 * roll back if it ends up worse (by the real gates' measure) than it started.
 * Excludes heavy/derived DIRECTORIES (.git, node_modules, target, .venv, …):
 * they aren't part of the task's source and would make snapshots slow. The
 * contract is symmetric — an excluded directory is neither snapshotted nor
 * touched by restore, at any depth. Files sharing an excluded name (e.g. a
 * script called `build`) are snapshotted normally.
 *
 * Hardening (2026-07-08, after the project-i incident where a 424 GB Rust
 * `target/` tree was copied into a 61 GB RAM tmpfs):
 *  - snapshots land on real disk (~/.cache/uap/snapshots, UAP_SNAPSHOT_DIR
 *    overrides — absolute paths only), never os.tmpdir(), which is RAM-backed
 *    on many Linux setups;
 *  - the source tree is size-guarded before copying (UAP_SNAPSHOT_MAX_MB,
 *    default 4096) — over the cap, snapshotTree returns null and the caller
 *    degrades to "no rollback this run" instead of exhausting the machine;
 *  - snapshotTree never throws: any failure cleans up its partial copy and
 *    returns null;
 *  - restoreTree validates the snapshot before touching the project, restores
 *    copy-first (prune extras, then merge back) so an interrupted restore
 *    never leaves a gutted tree, and marks the snapshot preserve-on-failure
 *    so the reaper won't collect the only good copy;
 *  - each snapshot carries a pid marker; stale snapshots from dead processes
 *    (crashes, SIGKILL, ENOSPC mid-copy) are reaped before a new one is taken.
 */

import {
  cpSync,
  rmSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  lstatSync,
  statSync,
} from 'fs';
import { join, basename, isAbsolute, resolve } from 'path';
import { tmpdir, homedir } from 'os';

const EXCLUDE = new Set([
  // VCS / UAP-internal
  '.git',
  '.worktrees',
  '.uap-deliver',
  '.uap-backups',
  // JS
  'node_modules',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.cache',
  '.parcel-cache',
  // Rust / JVM / Go
  'target',
  '.gradle',
  'vendor',
  // Python
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.tox',
]);

/** Marker written inside each snapshot so the reaper can tell live from stale. */
const META_FILE = '.uap-snap.json';

const SNAP_PREFIX = 'uap-snap-';

/** Age past which a marker-less (legacy/partial) snapshot is considered stale. */
const LEGACY_STALE_MS = 24 * 60 * 60 * 1000;

/** Backstop against pid reuse pinning a dead snapshot forever. */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const DEFAULT_MAX_MB = 4096;

interface SnapMeta {
  pid?: number;
  created?: string;
  /** Set after a failed restore: this snapshot is the only good copy — never reap. */
  preserve?: boolean;
}

/** True for a directory whose name marks it as derived/heavy (dir-only contract). */
function isExcludedDir(path: string, name: string): boolean {
  if (!EXCLUDE.has(name)) return false;
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Disk-backed base directory for snapshots (never os.tmpdir — often RAM tmpfs). */
export function snapshotBaseDir(): string {
  const raw = process.env.UAP_SNAPSHOT_DIR?.trim();
  // Relative/garbage overrides silently landing inside the project tree would
  // snapshot into the thing being snapshotted — absolute paths only.
  const base = raw && isAbsolute(raw) ? resolve(raw) : join(homedir(), '.cache', 'uap', 'snapshots');
  mkdirSync(base, { recursive: true });
  return base;
}

function maxSnapshotBytes(): number {
  const mb = Number(process.env.UAP_SNAPSHOT_MAX_MB);
  return (Number.isFinite(mb) && mb > 0 ? mb : DEFAULT_MAX_MB) * 1024 * 1024;
}

/**
 * Sum file sizes under root (skipping excluded dirs and symlinks), bailing out
 * as soon as the running total exceeds `limit` so huge trees cost one early
 * partial walk, not a full traversal.
 */
function treeSizeExceeds(root: string, limit: number): boolean {
  let total = 0;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue; // unreadable dir — the copy will surface real problems
    }
    for (const name of entries) {
      const path = join(dir, name);
      let st;
      try {
        st = lstatSync(path);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        if (!EXCLUDE.has(name)) stack.push(path);
      } else {
        total += st.size;
        if (total > limit) return true;
      }
    }
  }
  return false;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but isn't ours.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function isStaleSnapshot(path: string): boolean {
  try {
    const metaPath = join(path, META_FILE);
    // The tmpdir sweep reads world-writable locations: a planted FIFO or
    // symlink-to-/dev/zero marker must not hang or balloon the read.
    const st = lstatSync(metaPath);
    if (!st.isFile() || st.size > 4096) throw new Error('untrusted marker');
    const meta = JSON.parse(readFileSync(metaPath, 'utf-8')) as SnapMeta;
    if (meta.preserve === true) return false;
    if (!Number.isInteger(meta.pid) || (meta.pid as number) <= 1) return true;
    const created = Date.parse(meta.created ?? '');
    if (Number.isFinite(created) && Date.now() - created > MAX_AGE_MS) return true;
    return !pidAlive(meta.pid as number);
  } catch {
    // No/unreadable/untrusted marker: a partial copy or a pre-hardening
    // snapshot. Only reap once it is old enough that no live run can
    // plausibly own it.
    try {
      return Date.now() - statSync(path).mtimeMs > LEGACY_STALE_MS;
    } catch {
      return false;
    }
  }
}

/**
 * Remove snapshots left behind by dead processes (crash, SIGKILL, ENOSPC
 * mid-copy). Sweeps the snapshot base dir, plus os.tmpdir() for snapshots
 * created by pre-hardening versions (UAP_SNAPSHOT_SKIP_TMP_SWEEP=1 disables
 * the legacy sweep). Fail-soft: reaping must never block a delivery run.
 */
export function reapStaleSnapshots(): void {
  const bases = new Set([snapshotBaseDir()]);
  if (process.env.UAP_SNAPSHOT_SKIP_TMP_SWEEP !== '1') bases.add(tmpdir());
  for (const base of bases) {
    let entries: string[];
    try {
      entries = readdirSync(base);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (!name.startsWith(SNAP_PREFIX)) continue;
      const path = join(base, name);
      try {
        if (isStaleSnapshot(path)) rmSync(path, { recursive: true, force: true });
      } catch {
        /* fail-soft */
      }
    }
  }
}

/**
 * Copy the project tree (minus excluded dirs) to a disk-backed snapshot dir.
 * Returns the snapshot path, or null when the snapshot is skipped (tree over
 * the size cap) or fails for any reason — callers must treat null as "no
 * rollback available for this run", not as an error. Never throws.
 */
export function snapshotTree(root: string): string | null {
  let snap: string;
  try {
    reapStaleSnapshots();
    const limit = maxSnapshotBytes();
    if (treeSizeExceeds(root, limit)) {
      console.warn(
        `  no-regress: snapshot skipped — project tree exceeds ${Math.round(limit / (1024 * 1024))} MB ` +
          '(raise UAP_SNAPSHOT_MAX_MB to override)'
      );
      return null;
    }
    snap = mkdtempSync(join(snapshotBaseDir(), SNAP_PREFIX));
  } catch (err) {
    console.warn(`  no-regress: snapshot unavailable (${(err as Error).message}) — rollback disabled for this run`);
    return null;
  }
  try {
    cpSync(root, snap, {
      recursive: true,
      // Never filter the root itself — a project dir named `build`/`dist`/…
      // must still snapshot its contents, not produce an empty snapshot.
      filter: (src) => src === root || !isExcludedDir(src, basename(src)),
    });
    writeFileSync(join(snap, META_FILE), JSON.stringify({ pid: process.pid, created: new Date().toISOString() }));
    return snap;
  } catch (err) {
    // Never leak a partial snapshot (the original failure mode: ENOSPC
    // mid-copy left tens of GB behind).
    rmSync(snap, { recursive: true, force: true });
    console.warn(`  no-regress: snapshot failed (${(err as Error).message}) — rollback disabled for this run`);
    return null;
  }
}

/**
 * Delete entries under rootDir that the snapshot doesn't contain (or whose
 * file/dir type flipped), recursing with the same excluded-dir contract as
 * the snapshot filter so nested excluded trees (a workspace's node_modules,
 * a nested target/) survive rollback untouched.
 */
function pruneToSnapshot(rootDir: string, snapDir: string): void {
  for (const entry of readdirSync(rootDir)) {
    const rootPath = join(rootDir, entry);
    let rootStat;
    try {
      rootStat = lstatSync(rootPath);
    } catch {
      continue;
    }
    if (rootStat.isDirectory() && EXCLUDE.has(entry)) continue;
    let snapStat = null;
    try {
      snapStat = lstatSync(join(snapDir, entry));
    } catch {
      /* not in snapshot */
    }
    if (!snapStat) {
      rmSync(rootPath, { recursive: true, force: true });
    } else if (rootStat.isDirectory() && snapStat.isDirectory()) {
      pruneToSnapshot(rootPath, join(snapDir, entry));
    } else if (rootStat.isDirectory() !== snapStat.isDirectory()) {
      // Type flip (file↔dir): remove so the merge copy can recreate it.
      rmSync(rootPath, { recursive: true, force: true });
    }
  }
}

/**
 * Restore the project tree from a snapshot. Validates the snapshot BEFORE
 * touching the project, then prunes extras and merge-copies the snapshot
 * back — copy-first ordering so an interruption leaves a recoverable union
 * of both trees, never a gutted project. On failure the snapshot is marked
 * preserve (reaper-immune) and the error is rethrown.
 */
export function restoreTree(root: string, snap: string): void {
  const entries = readdirSync(snap); // throws if the snapshot is gone — root untouched
  if (!entries.includes(META_FILE)) {
    throw new Error(`refusing to restore from ${snap}: missing ${META_FILE} marker`);
  }
  try {
    pruneToSnapshot(root, snap);
    for (const entry of entries) {
      if (entry === META_FILE) continue;
      cpSync(join(snap, entry), join(root, entry), { recursive: true });
    }
  } catch (err) {
    try {
      writeFileSync(
        join(snap, META_FILE),
        JSON.stringify({ pid: process.pid, created: new Date().toISOString(), preserve: true })
      );
    } catch {
      /* marker rewrite is best-effort */
    }
    console.warn(`  no-regress: restore FAILED — snapshot preserved at ${snap}`);
    throw err;
  }
}

/** Remove a snapshot directory. */
export function disposeSnapshot(snap: string): void {
  rmSync(snap, { recursive: true, force: true });
}
