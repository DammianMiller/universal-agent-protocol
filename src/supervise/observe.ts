/**
 * Observation collection — the ONLY impure step in the supervisor.
 *
 * Everything read here is bounded and fail-soft:
 *  - run state comes from run-state.ts's sanitizing loader (never trusted raw)
 *  - log tails are read with an fd seek of the last N bytes, never a whole-file
 *    readFileSync (a multi-GB mission log must not be slurped)
 *  - git runs via execFileSync ARG ARRAYS (no shell, no interpolation), piped
 *    stdio, 5s timeout — and any failure degrades to `undefined`, never throws
 */
import { execFileSync } from 'child_process';
import { closeSync, fstatSync, lstatSync, openSync, readSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { deliverRunsDir, isValidRunId, loadRunState } from '../delivery/run-state.js';
import type { Observation } from './types.js';

/** Log tail budget — enough for error signatures, small enough to be safe. */
export const LOG_TAIL_BYTES = 8192;
/** `git diff --stat` cap; a monorepo diff can list thousands of files. */
export const DIFF_STAT_MAX_CHARS = 4000;
export const GIT_TIMEOUT_MS = 5000;
/** Defeat fsmonitor/untracked-cache shims: observation must see the real tree. */
const GIT_ARGS_PREFIX = ['-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false'];

/** True only for a plain regular file — symlinks/FIFOs/devices are skipped. */
function isRegularFile(path: string): boolean {
  try {
    const st = lstatSync(path);
    return !st.isSymbolicLink() && st.isFile();
  } catch {
    return false;
  }
}

/**
 * Read at most the last `maxBytes` of a file. Fail-soft: undefined on any
 * error, and silently for anything that is not a plain regular file (a
 * symlinked log or a FIFO must never be followed into a blocking read).
 */
export function tailFile(path: string, maxBytes: number = LOG_TAIL_BYTES): string | undefined {
  if (!isRegularFile(path)) return undefined;
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    return buf.toString('utf-8');
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* already closed */
      }
    }
  }
}

/**
 * Newest log plausibly belonging to a run. Run ids embed the launch stamp
 * (`run-<YYYYMMDDTHHMMSS>-<hex>`) and the detached wrapper names its log
 * `deliver-<YYYYMMDDTHHMMSS>.log` moments earlier, so the right log is the
 * newest stamped at-or-before the run's stamp; absent any stamped match, the
 * newest log by mtime. Undefined when there are no logs at all.
 */
export function newestLogForRun(projectRoot: string, runId: string): string | undefined {
  const dir = join(projectRoot, '.uap', 'deliver-logs');
  let files: string[];
  try {
    files = readdirSync(dir)
      .filter((f) => f.endsWith('.log'))
      .filter((f) => isRegularFile(join(dir, f)));
  } catch {
    return undefined;
  }
  if (files.length === 0) return undefined;
  const runStamp = /^run-(\d{8}T\d{6})/.exec(runId)?.[1];
  if (runStamp) {
    const eligible = files
      .map((f) => ({ f, stamp: /^deliver-(\d{8}T\d{6})\.log$/.exec(f)?.[1] }))
      .filter((x): x is { f: string; stamp: string } => x.stamp !== undefined && x.stamp <= runStamp)
      .sort((a, b) => b.stamp.localeCompare(a.stamp));
    if (eligible.length > 0) return join(dir, eligible[0].f);
  }
  let best: { f: string; mtime: number } | undefined;
  for (const f of files) {
    try {
      const mtime = statSync(join(dir, f)).mtimeMs;
      if (!best || mtime > best.mtime) best = { f, mtime };
    } catch {
      /* vanished between readdir and stat */
    }
  }
  return best ? join(dir, best.f) : undefined;
}

/** git, fail-soft: undefined on any error (not a repo, timeout, no binary). */
function git(projectRoot: string, args: string[]): string | undefined {
  try {
    const out = execFileSync('git', [...GIT_ARGS_PREFIX, ...args], {
      cwd: projectRoot,
      timeout: GIT_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 1024 * 1024,
    });
    return out.toString('utf-8');
  } catch {
    return undefined;
  }
}

export function gitDirtyFileCount(projectRoot: string): number | undefined {
  const out = git(projectRoot, ['status', '--porcelain']);
  if (out === undefined) return undefined;
  return out.split('\n').filter((l) => l.trim().length > 0).length;
}

export function gitDiffStat(projectRoot: string): string | undefined {
  const out = git(projectRoot, ['diff', '--stat']);
  return out === undefined ? undefined : out.slice(0, DIFF_STAT_MAX_CHARS);
}

/** mtime of the run's state.json — the change signal the debounce watches. */
export function runStateMtimeMs(projectRoot: string, runId: string): number {
  try {
    return statSync(join(deliverRunsDir(projectRoot), runId, 'state.json')).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Collect one bounded observation for a run. `runId` may be 'latest'
 * (resolved by run-state). Returns null for invalid ids and unknown runs —
 * the caller decides how loud to be. `now` is injectable for tests.
 */
export function collectObservation(
  projectRoot: string,
  runId: string,
  now: () => number = Date.now
): Observation | null {
  if (runId !== 'latest' && !isValidRunId(runId)) return null;
  const state = loadRunState(projectRoot, runId);
  if (!state) return null;
  const nowMs = now();
  const created = Date.parse(state.createdAt);
  const updated = Date.parse(state.updatedAt);
  const elapsedMinutes = Number.isFinite(created) ? Math.max(0, (nowMs - created) / 60_000) : 0;
  const minutesSinceUpdate = Number.isFinite(updated) ? Math.max(0, (nowMs - updated) / 60_000) : elapsedMinutes;
  const cp = state.checkpoint;
  const failures = cp?.history?.filter((h) => !h.passed).length ?? 0;
  const logPath = newestLogForRun(projectRoot, state.runId);
  return {
    runId: state.runId,
    status: state.status,
    instruction: state.instruction,
    elapsedMinutes,
    minutesSinceUpdate,
    turnsCompleted: cp?.turn ?? 0,
    failures,
    hasCheckpoint: cp !== undefined,
    recentLogTail: (logPath && tailFile(logPath)) || '',
    gitDirtyFiles: gitDirtyFileCount(projectRoot),
    diffStat: gitDiffStat(projectRoot),
  };
}
