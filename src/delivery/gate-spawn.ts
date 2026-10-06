/**
 * Grouped gate-process execution
 *
 * Gate scripts spawn real toolchains (cargo, npm, pytest…), and those tools
 * spawn children of their own. `spawnSync` with a timeout kills only the
 * DIRECT child — on timeout the grandchildren survive, orphaned and
 * re-parented to init, still burning CPU. Observed live (deliver run
 * 20261005T060243, `uap deliver` against a Rust crate): a cold `cargo build`
 * exceeded the gate's 120s budget, spawnSync timed out and killed only the
 * bash parent, and the orphaned cargo/rustc tree kept a full core busy for
 * over an hour until it was found and killed by hand.
 *
 * The fix is a process GROUP: spawn the gate detached so it becomes its own
 * process-group leader, and on timeout kill the whole group by its negative
 * pid. spawnSync has no `detached` support, so this is async `spawn` with a
 * manual wait — the callers (self-gate authoring, the verifier ladder) are
 * turn-boundary steps that can await.
 */

import { spawn, spawnSync } from 'child_process';

/**
 * Synchronous grouped run for the ladder's per-rung execution, whose call
 * chain (baseline demotion, integrity re-check, tier loop) is synchronous and
 * not worth an async refactor to save an orphaned process tree.
 *
 * `setsid` execs the command in place (it only forks when IT is already a
 * group leader, which a direct node child never is), so the child keeps the
 * spawned pid AND becomes a session/group leader: on timeout, spawnSync
 * SIGTERMs the direct child and the follow-up kill(-pid) SIGKILLs the whole
 * tool tree beneath it. Falls back to plain spawnSync where setsid is
 * unavailable (non-Linux): direct-child kill only — the pre-uplift behavior,
 * no worse than before.
 */
export interface GateSpawnSyncResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
  pid?: number;
  stdout: string;
  stderr: string;
}

export function runGateProcessSync(
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs?: number; env?: NodeJS.ProcessEnv; maxBuffer?: number; input?: string }
): GateSpawnSyncResult {
  const common = {
    cwd: options.cwd,
    encoding: 'utf-8' as const,
    timeout: options.timeoutMs,
    maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
    env: options.env,
    input: options.input,
  };
  let res = spawnSync('setsid', [command, ...args], common);
  if ((res.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
    // No setsid (non-Linux): run ungrouped. The direct child still dies on
    // timeout; grandchildren are not reachable — same as before this fix.
    res = spawnSync(command, args, common);
  } else if (res.status === 127 && /setsid: failed to execute/.test(String(res.stderr))) {
    // setsid EXEC'd the gate binary itself, so a missing gate command is an
    // exit code + stderr line rather than spawnSync's res.error. Restore the
    // ENOENT shape the ladder classifies as 'spawn-error' — otherwise an
    // unrunnable gate reads as "ran and failed" and the model burns its turn
    // budget against an unexplained command.
    res = {
      ...res,
      status: null,
      error: Object.assign(new Error(`spawn ${command} ENOENT`), { code: 'ENOENT' }),
    };
  }
  if (res.error && res.pid) {
    // Timeout or early spawn error: reap whatever of the group is left.
    // ESRCH just means it already exited.
    try {
      process.kill(-res.pid, 'SIGKILL');
    } catch {
      /* group already gone */
    }
  }
  return res;
}

export interface GateSpawnResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  /** Set when the process could not be spawned at all. */
  spawnError?: string;
  stdout: string;
  stderr: string;
  /** True when the timeout fired and the group was killed. */
  timedOut: boolean;
}

export interface GateSpawnOptions {
  cwd: string;
  /** Timeout in ms. On expiry the whole process group is SIGKILLed. */
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /** Output cap per stream (default 16 MiB, matching the ladder runner). */
  maxBuffer?: number;
}

/**
 * Run a gate command in its own process group, killing the ENTIRE group on
 * timeout. Async: `spawn` (unlike `spawnSync`) supports `detached`, which is
 * what makes the tool tree addressable as one unit when the budget expires.
 */
/**
 * Live gate process groups (review security F6): `detached: true` without a
 * reaper means an abrupt teardown of THIS process (operator SIGKILL, OOM)
 * leaves the gate's whole tool tree running with no one to enforce its
 * budget — the orphan problem relocated to parent death. The exit hook
 * SIGKILLs every still-live group so teardown takes the gates with it.
 * (An outright SIGKILL of this process cannot be intercepted from within —
 * that residue is inherent and documented.)
 */
const liveGroups = new Set<number>();
let reaperInstalled = false;
function installGroupReaper(): void {
  if (reaperInstalled) return;
  reaperInstalled = true;
  process.on('exit', () => {
    for (const pgid of liveGroups) {
      try {
        process.kill(-pgid, 'SIGKILL');
      } catch {
        /* group already gone */
      }
    }
  });
}

export function runGateProcess(
  command: string,
  args: string[],
  options: GateSpawnOptions
): Promise<GateSpawnResult> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env,
        // Own process-group leader: kill(-pid) then reaps bash -> cargo ->
        // rustc -> ld, the whole tree, in one shot.
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      if (child.pid) {
        installGroupReaper();
        liveGroups.add(child.pid);
      }
    } catch (err) {
      resolve({
        status: null,
        signal: null,
        spawnError: err instanceof Error ? err.message : String(err),
        stdout: '',
        stderr: '',
        timedOut: false,
      });
      return;
    }
    const maxBuffer = options.maxBuffer ?? 16 * 1024 * 1024;
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const finish = (status: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child.pid) liveGroups.delete(child.pid);
      resolve({
        status,
        signal,
        stdout: stdout.slice(0, maxBuffer),
        stderr: stderr.slice(0, maxBuffer),
        timedOut,
      });
    };

    const timer = options.timeoutMs
      ? setTimeout(() => {
          // SIGKILL the whole group so no grandchild outlives the gate.
          // ESRCH means the group ALREADY exited (the race where the gate
          // finished in the instant between the timer firing and the kill):
          // do NOT mark the run timed-out — the 'close' event resolves it
          // with its real exit status, so an exit-0 pass survives (review
          // quality F6: the pass used to be discarded here).
          try {
            process.kill(-child.pid!, 'SIGKILL');
            timedOut = true;
          } catch {
            /* group already gone — let 'close' speak */
          }
        }, options.timeoutMs)
      : undefined;

    child.stdout?.on('data', (d: Buffer) => {
      if (stdout.length < maxBuffer) stdout += d.toString('utf-8');
    });
    child.stderr?.on('data', (d: Buffer) => {
      if (stderr.length < maxBuffer) stderr += d.toString('utf-8');
    });
    child.on('error', (err) => {
      // Spawn failure (missing binary, bad cwd). timedOut stays false; any
      // partial group cleanup is still attempted for safety. Settled-guarded
      // so a late 'close' after an 'error' cannot overwrite this result.
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child.pid) liveGroups.delete(child.pid);
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* not started or already gone */
      }
      resolve({
        status: null,
        signal: null,
        spawnError: err.message,
        stdout: stdout.slice(0, maxBuffer),
        stderr: (stderr + `\n${err.message}`).slice(0, maxBuffer),
        timedOut: false,
      });
    });
    child.on('close', (code, signal) => finish(code, signal));
  });
}
