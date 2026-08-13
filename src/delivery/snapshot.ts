/**
 * Project tree snapshot/restore for `uap deliver --no-regress`.
 *
 * Captures the project state before the convergence loop runs so deliver can
 * roll back if it ends up worse (by the real gates' measure) than it started.
 * Two classes of entry are excluded, with a SYMMETRIC contract (neither
 * snapshotted nor touched by restore, at any depth):
 *  - heavy/derived DIRECTORIES (.git, node_modules, target, .venv, …) — not
 *    part of the task's source, and copying them is what melted a machine;
 *  - secret-bearing FILES (.env*, keys, certs) — they must not persist in
 *    snapshot storage under ~/.cache, so they are never copied and rollback
 *    leaves them exactly as they are.
 * Files merely sharing an excluded directory name (a script called `build`)
 * are snapshotted normally.
 *
 * Hardening (2026-07-08, after the project-i incident where a 424 GB Rust
 * `target/` tree was copied into a 61 GB RAM tmpfs):
 *  - snapshots land on real disk (~/.cache/uap/snapshots, UAP_SNAPSHOT_DIR
 *    overrides — absolute paths only), never os.tmpdir(), which is RAM-backed
 *    on many Linux setups;
 *  - the source tree is size-guarded before copying (UAP_SNAPSHOT_MAX_MB,
 *    default 4096) — over the cap the snapshot is skipped and the caller
 *    degrades to "no rollback this run" instead of exhausting the machine;
 *  - snapshotTree never throws: it returns a discriminated SnapshotResult and
 *    any failure cleans up its partial copy (presentation belongs to callers);
 *  - restoreTree validates the snapshot before touching the project, restores
 *    copy-first (prune extras, then merge back) so an interrupted restore
 *    never leaves a gutted tree, and marks the snapshot preserve-on-failure
 *    so the reaper won't collect the only good copy;
 *  - each snapshot carries a pid+host marker; stale snapshots from dead
 *    processes are reaped before a new one is taken, and markers from other
 *    hosts / pid namespaces (shared $HOME, containers) are never judged by
 *    local pid liveness — only by the 7-day age backstop.
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
import { tmpdir, homedir, hostname } from 'os';

const EXCLUDE = new Set([
  // A DIRECTORY named .env is almost always a python venv, never source.
  '.env',
  // VCS / UAP-internal
  '.git',
  '.worktrees',
  // The run's OWN state: logs, run-state checkpoints, heartbeat, lock. It sat
  // inside the snapshot, so a no-regress revert took all of it with the
  // mission changes (measured on a clean fixture 2026-08-13): the log that
  // explains the revert lives here, so the revert deleted its own explanation
  // and looked like silent data loss, and the checkpoint was rewound from
  // turn 9 to turn 1, which makes a later --resume redo work already done.
  // Its siblings were already excluded; this one was simply missed.
  '.uap',
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

/**
 * Secret-bearing file names that must never be copied into snapshot storage.
 * Kept symmetric with restore: these files are also never pruned or
 * overwritten by a rollback. Committed env TEMPLATES (.env.example etc.) are
 * carved out — they contain no secrets and should roll back like source.
 */
function isSecretName(name: string): boolean {
  if (/^\.env(\..+)?$/i.test(name)) return !/^\.env\.(example|sample|template|dist)$/i.test(name);
  return /^\.npmrc$|^\.netrc$|\.(pem|key|p12|pfx)$|^id_(rsa|dsa|ecdsa(_sk)?|ed25519(_sk)?)$/i.test(name);
}

/** Marker written inside each snapshot so the reaper can tell live from stale. */
const META_FILE = '.uap-snap.json';

const SNAP_PREFIX = 'uap-snap-';

/** Age past which a marker-less (legacy/partial) snapshot is considered stale. */
const LEGACY_STALE_MS = 24 * 60 * 60 * 1000;

/** Backstop against pid reuse (and the only signal for foreign-host markers). */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const DEFAULT_MAX_MB = 4096;

export type SnapshotResult =
  | { ok: true; path: string }
  | { ok: false; reason: 'size-cap' | 'error'; detail: string };

interface SnapMeta {
  pid?: number;
  host?: string;
  created?: string;
  /** Set after a failed restore: this snapshot is the only good copy — never reap. */
  preserve?: boolean;
}

/** True when the entry must be skipped by snapshot, prune, and size walk alike. */
function isExcludedEntry(path: string, name: string): boolean {
  const secretName = isSecretName(name);
  const dirName = EXCLUDE.has(name);
  if (!secretName && !dirName) return false;
  try {
    const isDir = lstatSync(path).isDirectory();
    return isDir ? dirName : secretName;
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
 * Sum file sizes under root (skipping excluded entries and symlinks), bailing
 * out as soon as the running total exceeds `limit` so huge trees cost one
 * early partial walk, not a full traversal.
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
        if (isSecretName(name)) continue;
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
    const created = Date.parse(meta.created ?? '');
    const expired = Number.isFinite(created) && Date.now() - created > MAX_AGE_MS;
    // A marker from another host or pid namespace (shared $HOME, container):
    // local pid liveness says nothing about it — age is the only safe signal.
    // Without a parseable created field, fall back to dir mtime so a garbled
    // foreign marker can't pin its snapshot forever.
    if (typeof meta.host === 'string' && meta.host !== hostname()) {
      if (Number.isFinite(created)) return expired;
      return Date.now() - statSync(path).mtimeMs > MAX_AGE_MS;
    }
    if (!Number.isInteger(meta.pid) || (meta.pid as number) <= 1) return true;
    if (expired) return true;
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
 * Copy the project tree (minus excluded entries) to a disk-backed snapshot
 * dir. Never throws and never logs — callers decide presentation from the
 * discriminated result. `ok: false` means "no rollback available for this
 * run", not a fatal error.
 */
export function snapshotTree(root: string): SnapshotResult {
  let snap: string;
  try {
    reapStaleSnapshots();
    const limit = maxSnapshotBytes();
    if (treeSizeExceeds(root, limit)) {
      return {
        ok: false,
        reason: 'size-cap',
        detail: `project tree exceeds ${Math.round(limit / (1024 * 1024))} MB (raise UAP_SNAPSHOT_MAX_MB to override)`,
      };
    }
    snap = mkdtempSync(join(snapshotBaseDir(), SNAP_PREFIX));
  } catch (err) {
    return { ok: false, reason: 'error', detail: (err as Error).message };
  }
  try {
    cpSync(root, snap, {
      recursive: true,
      // Never filter the root itself — a project dir named `build`/`dist`/…
      // must still snapshot its contents, not produce an empty snapshot.
      filter: (src) => src === root || !isExcludedEntry(src, basename(src)),
    });
    writeFileSync(
      join(snap, META_FILE),
      JSON.stringify({ pid: process.pid, host: hostname(), created: new Date().toISOString() })
    );
    return { ok: true, path: snap };
  } catch (err) {
    // Never leak a partial snapshot (the original failure mode: ENOSPC
    // mid-copy left tens of GB behind).
    rmSync(snap, { recursive: true, force: true });
    return { ok: false, reason: 'error', detail: (err as Error).message };
  }
}

/**
 * rm -rf that leaves secret files in place (and keeps any directory that
 * still holds one). Excluded dirs (node_modules, target, …) encountered
 * inside the doomed tree are derived/reinstallable — removed wholesale
 * rather than walked. Returns true when the path was fully removed.
 */
function rmPreservingSecrets(path: string): boolean {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    return true;
  }
  if (!st.isDirectory()) {
    if (isSecretName(basename(path))) return false;
    rmSync(path, { force: true });
    return true;
  }
  if (EXCLUDE.has(basename(path))) {
    rmSync(path, { recursive: true, force: true });
    return true;
  }
  let removedAll = true;
  for (const entry of readdirSync(path)) {
    if (!rmPreservingSecrets(join(path, entry))) removedAll = false;
  }
  if (removedAll) rmSync(path, { recursive: true, force: true });
  return removedAll;
}

/**
 * Delete entries under rootDir that the snapshot doesn't contain (or whose
 * file/dir type flipped), recursing with the same excluded-entry contract as
 * the snapshot filter so nested excluded trees (a workspace's node_modules)
 * and secret files survive rollback untouched — even secrets created after
 * the snapshot inside directories the snapshot never held.
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
    if (rootStat.isDirectory() ? EXCLUDE.has(entry) : isSecretName(entry)) continue;
    let snapStat = null;
    try {
      snapStat = lstatSync(join(snapDir, entry));
    } catch {
      /* not in snapshot */
    }
    if (!snapStat) {
      rmPreservingSecrets(rootPath);
    } else if (rootStat.isDirectory() && snapStat.isDirectory()) {
      pruneToSnapshot(rootPath, join(snapDir, entry));
    } else if (rootStat.isDirectory() !== snapStat.isDirectory()) {
      // Type flip (file↔dir): remove so the merge copy can recreate it. If a
      // secret survives inside (dir→file flip), leave the dir — the copy will
      // fail and the preserve path keeps the snapshot for manual recovery.
      rmPreservingSecrets(rootPath);
    }
  }
}

/**
 * Restore the project tree from a snapshot. Validates the snapshot BEFORE
 * touching the project, then prunes extras and merge-copies the snapshot
 * back — copy-first ordering so an interruption leaves a recoverable union
 * of both trees, never a gutted project. On failure the snapshot is marked
 * preserve (reaper-immune) and the error is rethrown; callers own logging.
 */
export function restoreTree(root: string, snap: string): void {
  const entries = readdirSync(snap); // throws if the snapshot is gone — root untouched
  if (!entries.includes(META_FILE)) {
    throw new Error(`refusing to restore from ${snap}: missing ${META_FILE} marker`);
  }
  try {
    pruneToSnapshot(root, snap);
    for (const entry of entries) {
      // Skip the marker and (defense-in-depth) any secrets present in a
      // pre-hardening snapshot — never overwrite a live rotated secret.
      if (entry === META_FILE || isSecretName(entry)) continue;
      cpSync(join(snap, entry), join(root, entry), {
        recursive: true,
        filter: (src) => !isExcludedEntry(src, basename(src)) || src === join(snap, entry),
      });
    }
  } catch (err) {
    try {
      writeFileSync(
        join(snap, META_FILE),
        JSON.stringify({ pid: process.pid, host: hostname(), created: new Date().toISOString(), preserve: true })
      );
    } catch {
      /* marker rewrite is best-effort */
    }
    throw err;
  }
}

/** Remove a snapshot directory. */
export function disposeSnapshot(snap: string): void {
  rmSync(snap, { recursive: true, force: true });
}
