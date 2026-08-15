/**
 * Stop a detached deliver run once the session that ordered it is gone.
 *
 * `uap deliver` detaches on purpose (see deliver-detach.ts): a mission must
 * outlive the agent's bash tool call, which is a short-lived, process-group-
 * killed container. That is correct and this must not undo it.
 *
 * What it must not outlive is the SESSION. Observed live: an agent client
 * exited, and two detached deliver runs kept driving the model for over an hour
 * — holding both slots, generating tokens for a conversation nobody would ever
 * read — while the operator reasonably reported "I have nothing running". Only
 * killing them by pid stopped it.
 *
 * WHY NOT THE OBVIOUS CHECKS
 *  - `ppid === 1`: wrong on any modern Linux desktop. Both orphans observed here
 *    had ppid 11681 — the systemd --user manager, which registers as a child
 *    subreaper, so orphans are re-parented to IT and never to init.
 *  - "re-parented since start": fires immediately on every detached run, because
 *    being re-parented is exactly what detaching does. It would kill the feature.
 *
 * So the guard watches a specific OWNER pid — the nearest ancestor that is an
 * agent client — resolved once at detach time and inherited by the child.
 */

import { readFileSync } from 'node:fs';
import { noteExitReason } from './run-exit.js';

/** Env var carrying the resolved owner pid across the detach boundary. */
export const OWNER_PID_ENV = 'UAP_DELIVER_OWNER_PID';

/** Poll interval. Slow on purpose — a janitor, not a latency path. */
const DEFAULT_INTERVAL_MS = 20_000;

/**
 * Process names that own a deliver run. A deliver started by one of these is
 * work on behalf of a live session; when that session goes, so does the reason
 * for the run. Anything else (a plain shell, CI, systemd) is deliberately NOT
 * matched — the guard then stays off rather than guessing.
 */
const CLIENT_COMMS = ['opencode', 'claude', 'cursor', 'codex', 'windsurf'];

/** `comm` and `ppid` for a pid, or null if it is gone / unreadable. */
export function readProcInfo(pid: number, procRoot = '/proc'): { comm: string; ppid: number } | null {
  try {
    // /proc/<pid>/stat: "pid (comm) state ppid ..." — comm can contain spaces and
    // parens, so split on the LAST ')' rather than tokenising the whole line.
    const stat = readFileSync(`${procRoot}/${pid}/stat`, 'utf8');
    const close = stat.lastIndexOf(')');
    const open = stat.indexOf('(');
    if (open < 0 || close < 0 || close < open) return null;
    const comm = stat.slice(open + 1, close);
    const rest = stat.slice(close + 2).trim().split(/\s+/);
    const ppid = Number(rest[1]);
    return Number.isFinite(ppid) ? { comm, ppid } : null;
  } catch {
    return null; // gone or unreadable — treat as absent
  }
}

/**
 * Nearest ancestor that is an agent client, or undefined.
 *
 * Undefined is a first-class answer: a deliver run from a plain shell or from CI
 * has no session to outlive, so it gets no guard at all.
 */
export function resolveOwnerPid(
  startPid: number = process.ppid,
  opts: { procRoot?: string; maxDepth?: number } = {}
): number | undefined {
  const procRoot = opts.procRoot ?? '/proc';
  let pid = startPid;
  for (let depth = 0; depth < (opts.maxDepth ?? 12); depth++) {
    if (pid <= 1) return undefined;
    const info = readProcInfo(pid, procRoot);
    if (!info) return undefined;
    const comm = info.comm.toLowerCase();
    if (CLIENT_COMMS.some((c) => comm === c || comm.startsWith(c))) return pid;
    pid = info.ppid;
  }
  return undefined;
}

/** Is that pid still around? */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0: existence check, delivers nothing
    return true;
  } catch (err) {
    // EPERM means it exists but belongs to someone else — alive for our purpose.
    return (err as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

export interface OwnerGuardOptions {
  intervalMs?: number;
  /** Called instead of exiting (tests). */
  onOwnerGone?: (ownerPid: number) => void;
  /** Liveness probe override (tests). */
  isAlive?: (pid: number) => boolean;
}

/**
 * Watch the owning session and CONTINUE when it exits. No-op when there is no
 * owner. The mission's value is the delivered artifact on disk, not the log
 * stream the launcher was watching — stopping on owner-exit threw away three
 * healthy mid-mission runs in one day (2026-08-15) and each loss triggered a
 * from-scratch relaunch. The run already has two bounded ends of its own (the
 * wall-clock budget and the wedge watchdog), so an orphan cannot run forever.
 *
 * The old stop-on-orphan behavior remains available via UAP_STOP_ON_ORPHAN=1
 * for environments where an unwatched run must never hold a model slot.
 * UAP_ALLOW_ORPHAN=1 (the old opt-out) still disables the watcher entirely.
 *
 * Returns a stop function. The timer is unref'd: a watchdog that by itself kept
 * the process alive would be its own bug.
 */
export function guardAgainstOwnerExit(opts: OwnerGuardOptions = {}): () => void {
  const optOut = (process.env.UAP_ALLOW_ORPHAN ?? '').toLowerCase();
  if (['1', 'true', 'on', 'yes'].includes(optOut)) return () => {};

  const stopOnOrphan = ['1', 'true', 'on', 'yes'].includes(
    (process.env.UAP_STOP_ON_ORPHAN ?? '').toLowerCase()
  );

  const ownerPid = Number(process.env[OWNER_PID_ENV]);
  if (!Number.isFinite(ownerPid) || ownerPid <= 1) return () => {};

  const isAlive = opts.isAlive ?? pidAlive;
  // Fallback lifetime for a CONTINUED orphan. The run budget and wedge
  // watchdog usually bound it, but the budget can be configured OFF and the
  // wedge only bounds silence — an actively-looping orphan with no budget
  // would otherwise run forever. 0 disables the cap (explicitly unbounded).
  const orphanCapMs =
    Math.max(0, Number(process.env.UAP_ORPHAN_MAX_MINUTES ?? 120)) * 60_000;
  let orphanedAtMs: number | null = null;
  let announced = false;
  const timer = setInterval(() => {
    if (isAlive(ownerPid)) {
      orphanedAtMs = null;
      return;
    }
    if (!stopOnOrphan) {
      if (orphanedAtMs === null) orphanedAtMs = Date.now();
      if (!announced) {
        announced = true;
        // Continue detached. Announce it so the log explains why the process
        // outlived its launcher; budget/wedge rails plus this cap bound it.
        console.error(
          `\nuap: the session that started this run (pid ${ownerPid}) has exited — ` +
            `continuing detached to completion (work lands on disk; follow with ` +
            `\`uap deliver --await-run\`). Set UAP_STOP_ON_ORPHAN=1 to restore stop-on-orphan.`
        );
      }
      if (orphanCapMs === 0 || Date.now() - orphanedAtMs < orphanCapMs) return;
      // Cap exceeded: fall through to the stop path below so an unwatched,
      // unbudgeted run cannot hold a model slot indefinitely.
    }
    clearInterval(timer);
    // Say why into the RUN's record, not just onto the console. The console
    // line lands in a deliver log the follower has no reason to open; the exit
    // record is what `--await-run` reads back, so this is the only channel that
    // reaches the agent that is actually waiting on this mission.
    noteExitReason(
      stopOnOrphan
        ? `stopped by the orphan guard: the session that started this run (pid ${ownerPid}) exited`
        : `stopped by the orphan guard: continued ${Math.round(orphanCapMs / 60_000)} minutes past ` +
          `its owner's exit (pid ${ownerPid}) and hit the orphan lifetime cap (UAP_ORPHAN_MAX_MINUTES)`
    );
    if (opts.onOwnerGone) {
      opts.onOwnerGone(ownerPid);
      return;
    }
    // Say why on the way out: a run that vanishes silently is the same
    // debugging problem as one that never stops.
    console.error(
      `\nuap: the session that started this run (pid ${ownerPid}) has exited — ` +
        `stopping rather than holding a model slot for output nobody will read. ` +
        `Set ${'UAP_ALLOW_ORPHAN'}=1 to keep detached runs alive.`
    );
    process.exit(130); // 128 + SIGINT: ended by circumstance, not by failing
  }, opts.intervalMs ?? DEFAULT_INTERVAL_MS);

  timer.unref?.();
  return () => clearInterval(timer);
}
