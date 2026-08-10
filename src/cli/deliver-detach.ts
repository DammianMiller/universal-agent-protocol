/**
 * A mission must outlive the tool call that started it.
 *
 * Coding agents run shell commands in a bounded tool call: opencode puts each
 * `bash -c …` in its own session and kills that process group when the call ends
 * or times out. A model that invokes `uap deliver` from its bash tool therefore
 * spawns a long mission INSIDE a short-lived container — and when the tool call
 * ends, the whole mission dies wherever it happened to be. Observed lifetimes on
 * the live sandbox were 531s, 258s, 34s, 0s, 291s: not timeouts, just "whenever
 * the tool call happened to end". Nothing landed, ever.
 *
 * (The autoroute hook already spawns with start_new_session=True and is immune.
 * This closes the same hole for a model that calls deliver directly.)
 *
 * So deliver re-launches itself into its OWN session, which a process-group kill
 * cannot reach, and the foreground wrapper mirrors the mission's output. If the
 * client tears the tool call down, the wrapper dies and the MISSION KEEPS GOING —
 * to completion, with its result recorded and resumable.
 *
 * Two details that matter:
 *  - The child's stdio goes to a FILE, never to a pipe held by the wrapper. A
 *    pipe whose reader is killed would hand the child EPIPE and take it down
 *    too — defeating the entire point.
 *  - An interactive run (stdout is a TTY) is left alone: a human wants live
 *    output and a working Ctrl-C. Only a captured, non-TTY invocation — which is
 *    exactly what an agent tool call looks like — is detached.
 */

import { spawn } from 'child_process';
import { createWriteStream, existsSync, mkdirSync, openSync, statSync, createReadStream } from 'fs';
import { join } from 'path';
import { OWNER_PID_ENV, resolveOwnerPid } from '../delivery/orphan-guard.js';

/** Set on the detached child so it never re-detaches (infinite recursion). */
export const DETACH_ENV = 'UAP_DELIVER_DETACHED';
/** Escape hatch: force the old attached behaviour. */
export const NO_DETACH_ENV = 'UAP_DELIVER_NO_DETACH';

export interface DetachDecision {
  detach: boolean;
  reason: string;
}

/**
 * Should this invocation re-launch itself detached? Exported for tests — the
 * decision is the whole safety argument, so it must be checkable in isolation.
 */
export function shouldDetach(opts: {
  alreadyDetached: boolean;
  noDetach: boolean;
  isTTY: boolean;
  dryRun: boolean;
}): DetachDecision {
  if (opts.alreadyDetached) return { detach: false, reason: 'already the detached child' };
  if (opts.noDetach) return { detach: false, reason: `${NO_DETACH_ENV} is set` };
  if (opts.dryRun) return { detach: false, reason: 'a dry-run only plans; nothing to outlive' };
  // A TTY means a human is watching: keep the foreground semantics they expect.
  if (opts.isTTY) return { detach: false, reason: 'interactive (stdout is a TTY)' };
  return {
    detach: true,
    reason: 'captured stdout (an agent tool call) — the mission must outlive it',
  };
}

/** Where the detached child streams its output (the wrapper tails this). */
export function detachLogPath(projectRoot: string, stamp: string): string {
  return join(projectRoot, '.uap', 'deliver-logs', `deliver-${stamp}.log`);
}

/**
 * Re-launch this same command in a new session and mirror its output.
 *
 * Returns the child's exit code once it finishes. If the WRAPPER is killed
 * first (the tool-call teardown), the child simply carries on: it is in its own
 * session, and its stdio is a file, so nothing about the wrapper's death can
 * reach it.
 */
/**
 * Returned when the mirror budget expired while the mission was still running.
 * Distinct from any real exit code so a caller cannot mistake it for failure.
 */
export const STILL_RUNNING = -1;

export async function relaunchDetached(
  projectRoot: string,
  stamp: string,
  opts: { mirrorBudgetMs?: number } = {}
): Promise<number> {
  const logPath = detachLogPath(projectRoot, stamp);
  mkdirSync(join(projectRoot, '.uap', 'deliver-logs'), { recursive: true });
  // Touch it so the tail below always has something to open.
  createWriteStream(logPath, { flags: 'a' }).end();

  const ownerPid = resolveOwnerPid();
  const fd = openSync(logPath, 'a');
  const child = spawn(process.argv[0], process.argv.slice(1), {
    detached: true, // setsid: new session AND new process group — out of reach of a pgroup kill
    stdio: ['ignore', fd, fd], // a FILE, never a pipe the wrapper could break
    // Resolve the OWNING session here, in the parent, while the ancestor chain
    // is still intact — after the detach this process exits and the child is
    // re-parented, losing any way to find who ordered the work. The child uses
    // it to stop when that session goes; undefined simply means no guard.
    env: {
      ...process.env,
      [DETACH_ENV]: '1',
      ...(ownerPid ? { [OWNER_PID_ENV]: String(ownerPid) } : {}),
    },
    cwd: process.cwd(),
  });
  child.unref();

  console.log(
    `⇢ mission detached (pid ${child.pid}) so it outlives this tool call — streaming ${logPath}`
  );
  // This line is the only place the pid is handed over, and for ~90 seconds it
  // is the ONLY handle the caller has — the runId does not exist yet. So the
  // clean alternative has to be offered here, next to the pid, or the pid is
  // what gets used. It is: eight of eleven runs on 2026-08-10 died by signal,
  // most before their first checkpoint.
  console.log(
    `  to stop it: touch ${join(projectRoot, '.uap', 'deliver-runs', 'STOP')}\n` +
      '  (it stops at the next turn boundary with its work checkpointed and the lock\n' +
      '   released. Killing the pid does none of that — the run loses everything it\n' +
      '   had finished, leaves the lock behind, and the next launch starts from zero.)'
  );

  // Mirror the log to our stdout for as long as we are alive — but not past a
  // caller that has already given up.
  //
  // The mission is DETACHED by this point; mirroring is a convenience. For a
  // terminal or CI caller that convenience is the whole point and it should run
  // to completion. For an AGENT it inverts: its tool budget expires mid-mirror,
  // the call is killed, and a launch that SUCCEEDED is reported to the model as
  // a timeout. Seen on 2026-08-10 — "shell tool terminated command after
  // exceeding timeout 300000 ms", followed by "The deliver tool keeps timing
  // out", followed by `xargs kill -9` on the very run that was still working.
  //
  // So a bounded mirror returns STILL_RUNNING instead of being killed, and the
  // caller is told the mission continues. Unbounded when no budget is given,
  // which is what a terminal keeps.
  return await new Promise<number>((resolve) => {
    let offset = 0;
    let done = false;
    const pump = (): void => {
      let size = 0;
      try {
        size = statSync(logPath).size;
      } catch {
        return;
      }
      if (size <= offset) return;
      const stream = createReadStream(logPath, { start: offset, end: size - 1, encoding: 'utf-8' });
      offset = size;
      stream.on('data', (chunk) => process.stdout.write(String(chunk)));
      // The stat above and this read are two separate moments, and the file can
      // go between them — rotated, cleaned up, or on a temp filesystem being
      // torn down. An unhandled 'error' on a read stream is a hard crash, so a
      // vanished LOG would take down a launch whose MISSION is fine, which is
      // precisely backwards: mirroring is a convenience and its failure must
      // never be louder than the thing it is reporting on.
      //
      // Found by CI, not locally: the race needs the log to disappear inside a
      // 400ms window, which a slower machine hits and mine did not.
      stream.on('error', () => {
        /* the mission is unaffected; stop echoing this chunk and try again */
      });
    };
    const timer = setInterval(pump, 400);
    let budget: NodeJS.Timeout | undefined;
    if (opts.mirrorBudgetMs && opts.mirrorBudgetMs > 0) {
      budget = setTimeout(() => finish(STILL_RUNNING), opts.mirrorBudgetMs);
      budget.unref?.();
    }
    const finish = (code: number): void => {
      if (done) return;
      done = true;
      clearInterval(timer);
      if (budget) clearTimeout(budget);
      setTimeout(() => {
        pump(); // one last flush so the tail of the mission is not lost
        resolve(code);
      }, 500);
    };
    child.on('exit', (code, signal) => finish(signal ? 143 : (code ?? 0)));
    child.on('error', () => finish(1));
  });
}

/** Is this process the detached child? */
export function isDetachedChild(): boolean {
  return process.env[DETACH_ENV] === '1';
}

/** True when the project dir looks writable enough to host the detach log. */
export function canHostDetachLog(projectRoot: string): boolean {
  try {
    return existsSync(projectRoot);
  } catch {
    return false;
  }
}
