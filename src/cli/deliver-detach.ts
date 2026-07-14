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
export async function relaunchDetached(projectRoot: string, stamp: string): Promise<number> {
  const logPath = detachLogPath(projectRoot, stamp);
  mkdirSync(join(projectRoot, '.uap', 'deliver-logs'), { recursive: true });
  // Touch it so the tail below always has something to open.
  createWriteStream(logPath, { flags: 'a' }).end();

  const fd = openSync(logPath, 'a');
  const child = spawn(process.argv[0], process.argv.slice(1), {
    detached: true, // setsid: new session AND new process group — out of reach of a pgroup kill
    stdio: ['ignore', fd, fd], // a FILE, never a pipe the wrapper could break
    env: { ...process.env, [DETACH_ENV]: '1' },
    cwd: process.cwd(),
  });
  child.unref();

  console.log(
    `⇢ mission detached (pid ${child.pid}) so it outlives this tool call — streaming ${logPath}`
  );

  // Mirror the log to our stdout for as long as we are alive.
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
    };
    const timer = setInterval(pump, 400);
    const finish = (code: number): void => {
      if (done) return;
      done = true;
      clearInterval(timer);
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
