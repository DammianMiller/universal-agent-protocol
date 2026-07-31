/**
 * Attach to a deliver run that is already in flight, and report its result.
 *
 * THE GAP THIS CLOSES
 * A deliver mission outlives the tool call that started it — that is deliberate,
 * and the detach banner says so. But a caller whose own tool timeout fired
 * mid-mission had no way back to its run:
 *
 *   - launching again hits the single-flight guard and is skipped;
 *   - `--resume` is not "follow", it is "continue". It deliberately does NOT take
 *     the lock, and `latest` resolves the most-recently-updated non-delivered
 *     run — which, while a holder is alive, is the LIVE one. So resuming a
 *     running mission starts a second copy of it on the same runId: precisely
 *     the fan-out the lock exists to prevent.
 *
 * Observed live (opencode, 2026-07-30): with `delivery.enforcement: block` the
 * model could not write directly, deliver blocked past its client's tool
 * timeout, and it spent 63 requests in ten minutes alternating between a refused
 * write, a "timed out" deliver, and `pkill -9 -f 'cli.js deliver'`. Every door
 * was shut: it could not write, could not wait, and could not follow.
 *
 * WHAT THIS IS
 * A read-only wait. It takes no lock, writes no run state, and starts nothing —
 * it watches the holder until it exits, then reports that run's final state.
 *
 * WHAT COUNTS AS "IN FLIGHT" (and why the lock alone is not enough)
 * A resumed run never acquires the lock, so a lock-only probe reports "nothing
 * in flight" for a live resumed mission — and the caller, told to start
 * normally, then launches a SECOND concurrent run against the same tree. Since
 * the guidance this harness hands a timed-out caller used to be "use resume",
 * resumed runs are exactly the population most likely to be in flight when
 * someone follows. Liveness therefore falls back to run state: a run marked
 * running whose recorded pid is alive is in flight, lock or no lock.
 *
 * WHY THE HOLDER'S IDENTITY IS (pid, stamp) AND IS RE-READ
 * A pid alone is not an identity. Missions spawn thousands of subprocesses, so a
 * recycled pid would keep this loop reporting "still running" about a mission
 * that finished; and `acquireDeliverLock` can RECLAIM the lock from a holder
 * that is alive but wedged, after which the pid being watched is no longer the
 * mission in flight. The lock file already carries an ISO stamp after `|`; using
 * it turns "is that pid alive" into "is that same holder still there".
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { listRuns, type DeliverRunState } from './run-state.js';

/** Default poll interval — fast enough to feel immediate, idle enough to ignore. */
const DEFAULT_POLL_MS = 2000;

/**
 * How long a follow should wait when the caller is an MCP CLIENT (seconds).
 *
 * The binding constraint is the client's request timeout, not the server's
 * patience — and only the MCP layer knows its caller has one. Measured on the
 * live client (opencode, 2026-07-30): a tool call is abandoned after 62s, which
 * is the MCP SDK's 60s default request timeout plus start-up. A follow budget
 * above that is killed before it can answer — reproducing the exact
 * kill-vs-failure ambiguity follow exists to remove — and strands a process
 * waiting on a question nobody is listening for (observed: a 1620s follow,
 * orphaned, while the model fell back to `sleep 180 && cat`).
 *
 * This is deliberately NOT the CLI's default. A human at a terminal, or a CI
 * step, has no such limit and should get a long block; capping THEM at 45s was
 * the first attempt at this fix and it punished the caller that was not broken.
 */
export const FOLLOW_CLIENT_POLL_SEC = 45;

export interface AwaitOptions {
  /** Give up after this long and say so. */
  timeoutMs: number;
  pollMs?: number;
  /** Called on each poll, for a heartbeat/progress line. */
  onTick?: (elapsedMs: number, holderPid: number) => void;
  /** Injected for tests. Defaults to a real liveness probe. */
  isAlive?: (pid: number) => boolean;
  /** Injected for tests. Defaults to a real sleep. */
  sleep?: (ms: number) => Promise<void>;
}

export interface AwaitResult {
  /** True when a run was followed to completion within the budget. */
  followed: boolean;
  /**
   * True only when the followed run reached 'delivered'. Separate from
   * `followed` because "I watched it finish" and "it succeeded" are different
   * facts, and collapsing them reports a FAILED mission as a success to the one
   * field the MCP layer reads for ok/not-ok.
   */
  delivered: boolean;
  /** Set when nothing was in flight AND no recent run could be reported. */
  nothingInFlight?: boolean;
  /** Set when the holder outlived the budget; the run is still going. */
  timedOut?: boolean;
  /** Set when the holder changed identity mid-wait (reclaim, handoff, reuse). */
  holderChanged?: boolean;
  holderPid?: number;
  runId?: string;
  status?: DeliverRunState['status'];
  /** Compact projection of the run — never the whole state (see below). */
  run?: RunSummary;
  /** False when the run had to be guessed rather than matched to the holder. */
  attributed?: boolean;
  /** Human/model-facing explanation. Always set. */
  reason: string;
  /** What the caller should do next. Always set. */
  nextStep: string;
}

/**
 * A status answer, not a state dump.
 *
 * `DeliverRunState` carries the instruction (8k chars), the phase plan, phase
 * summaries, checkpoints and task outcomes — on the order of 100 KB. Spreading
 * that into a tool result puts a mission's entire history into the caller's
 * context in answer to "is it done yet".
 */
export interface RunSummary {
  runId: string;
  status: DeliverRunState['status'];
  updatedAt: string;
  phaseIndex?: number;
  phaseCount?: number;
  runnerKind?: DeliverRunState['runnerKind'];
  exit?: DeliverRunState['exit'];
}

function summarize(run: DeliverRunState): RunSummary {
  return {
    runId: run.runId,
    status: run.status,
    updatedAt: run.updatedAt,
    ...(run.phaseIndex !== undefined ? { phaseIndex: run.phaseIndex } : {}),
    ...(run.phases ? { phaseCount: run.phases.length } : {}),
    ...(run.runnerKind ? { runnerKind: run.runnerKind } : {}),
    ...(run.exit ? { exit: run.exit } : {}),
  };
}

function livePid(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means it exists and is not ours — still alive.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Identity of whoever currently owns the project's deliver run. */
export interface Holder {
  pid: number;
  /** Lock timestamp, or '' when liveness came from run state instead. */
  stamp: string;
  source: 'lock' | 'run-state';
  runId?: string;
}

/**
 * The lock holder, or null.
 *
 * The pid is validated rather than trusted: the lock file is writable by any
 * local process and this value reaches a model-facing message.
 */
export function lockHolder(projectRoot: string): Holder | null {
  const lockPath = join(projectRoot, '.uap', 'deliver.lock');
  if (!existsSync(lockPath)) return null;
  try {
    const [rawPid = '', rawStamp = ''] = readFileSync(lockPath, 'utf8').split('|');
    const pid = rawPid.trim();
    if (!/^\d{1,10}$/.test(pid) || Number(pid) <= 0) return null;
    return { pid: Number(pid), stamp: rawStamp.trim().slice(0, 64), source: 'lock' };
  } catch {
    return null;
  }
}

/** Back-compat helper: just the pid. */
export function lockHolderPid(projectRoot: string): number | null {
  return lockHolder(projectRoot)?.pid ?? null;
}

/**
 * Whoever is running a mission here: the lock holder, else a live resumed run.
 *
 * The run-state fallback is what makes follow work for `--resume`, which never
 * takes the lock.
 */
export function currentHolder(
  projectRoot: string,
  isAlive: (pid: number) => boolean = livePid
): Holder | null {
  const locked = lockHolder(projectRoot);
  if (locked && isAlive(locked.pid)) return locked;
  for (const run of listRuns(projectRoot)) {
    if (run.status === 'running' && typeof run.pid === 'number' && isAlive(run.pid)) {
      return { pid: run.pid, stamp: run.updatedAt ?? '', source: 'run-state', runId: run.runId };
    }
  }
  return null;
}

function sameHolder(a: Holder, b: Holder | null): boolean {
  return b !== null && a.pid === b.pid && a.stamp === b.stamp && a.source === b.source;
}

/**
 * The run owned by `pid`, and whether it could actually be attributed.
 *
 * The exact-pid match is the only confident answer. Falling back to "the newest
 * run marked running" is tempting and wrong on its own: interrupted runs keep
 * `status: 'running'` deliberately, so a directory that accumulates (33 entries
 * on the project this was built for) usually holds several — and the lock is
 * taken long before run state carrying a pid is written, so a follow that
 * arrives in that window would confidently name an OLDER mission's runId and
 * tell the caller to resume it. The fallback is therefore restricted to runs
 * that could plausibly be the holder's: no recorded pid, or a dead one.
 */
export function runForHolder(
  projectRoot: string,
  pid: number,
  isAlive: (p: number) => boolean = livePid
): { run: DeliverRunState | null; attributed: boolean } {
  const runs = listRuns(projectRoot);
  const exact = runs.find((r) => r.pid === pid);
  if (exact) return { run: exact, attributed: true };
  const plausible = runs.find(
    (r) => r.status === 'running' && (typeof r.pid !== 'number' || !isAlive(r.pid))
  );
  return { run: plausible ?? null, attributed: false };
}

/** The most recent run, for reporting a mission that ended just before we looked. */
function mostRecentRun(projectRoot: string): DeliverRunState | null {
  return listRuns(projectRoot)[0] ?? null;
}

function terminalOutcome(
  run: DeliverRunState,
  holderPid: number | undefined,
  attributed: boolean,
  justEnded: boolean
): AwaitResult {
  // A process killed mid-run leaves 'running' behind — that IS the resumable
  // state, and it is the one case where naming resume is correct, because the
  // holder is provably gone and continuing cannot fork a live mission.
  const stale = run.status === 'running';
  const who = holderPid !== undefined ? ` (pid ${holderPid})` : '';
  return {
    followed: true,
    delivered: run.status === 'delivered',
    holderPid,
    runId: run.runId,
    status: run.status,
    run: summarize(run),
    attributed,
    reason: stale
      ? `The deliver run${who} exited without recording a final status — it was interrupted.`
      : `The deliver run${who} ${justEnded ? 'finished' : 'had already finished'} with status '${run.status}'.` +
        (attributed ? '' : ' (Matched by run state rather than by process id — verify the run id below is the one you meant.)'),
    nextStep: stale
      ? `The mission is interrupted, not lost. Continue it with resume:'${run.runId}' — safe now that the holder is gone.`
      : run.status === 'delivered'
        ? 'The mission completed. Inspect the result; no further deliver call is needed.'
        : `The mission ended '${run.status}'. Read its output before deciding: continue it with resume:'${run.runId}', or start a new mission if the goal changed.`,
  };
}

/**
 * Wait for the in-flight deliver to finish, then report its outcome.
 *
 * Never throws for the ordinary outcomes — "nothing running", "still running
 * when the budget expired" and "the holder changed" are results, not errors,
 * because the caller is a tool whose next move depends on telling them apart.
 */
export async function awaitInFlightDeliver(
  projectRoot: string,
  opts: AwaitOptions
): Promise<AwaitResult> {
  const isAlive = opts.isAlive ?? livePid;
  const pollMs = Math.max(50, opts.pollMs ?? DEFAULT_POLL_MS);
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const holder = currentHolder(projectRoot, isAlive);
  if (holder === null) {
    // Nothing is running NOW — but a mission that finished moments ago is the
    // common case for this call (the caller's tool timeout fired, it called
    // back). Reporting "nothing ever happened, start the mission normally"
    // there sends it to re-run work that is already done.
    const recent = mostRecentRun(projectRoot);
    if (recent) return terminalOutcome(recent, undefined, true, false);
    return {
      followed: false,
      delivered: false,
      nothingInFlight: true,
      reason: 'No deliver run is in flight for this project, and no previous run was found.',
      nextStep:
        'Nothing to follow. Start the mission normally — a fresh deliver call will acquire the lock.',
    };
  }

  const startedAt = Date.now();
  for (;;) {
    const now = currentHolder(projectRoot, isAlive);
    if (now === null) break; // finished
    if (!sameHolder(holder, now)) {
      // Reclaim, handoff, or a recycled pid. Following the wrong mission and
      // reporting on it confidently is worse than saying the ground moved.
      return {
        followed: false,
        delivered: false,
        holderChanged: true,
        holderPid: holder.pid,
        reason:
          `The deliver run being followed (pid ${holder.pid}) was replaced by another (pid ${now.pid}) — ` +
          'the lock was reclaimed or the run handed over.',
        nextStep:
          'Do NOT start another run. Call deliver again with follow:true to attach to the current one.',
      };
    }
    const elapsed = Date.now() - startedAt;
    if (elapsed >= opts.timeoutMs) {
      const { run, attributed } = runForHolder(projectRoot, holder.pid, isAlive);
      return {
        followed: false,
        delivered: false,
        timedOut: true,
        holderPid: holder.pid,
        runId: attributed ? run?.runId : undefined,
        status: run?.status,
        run: run && attributed ? summarize(run) : undefined,
        attributed,
        reason:
          `The deliver run (pid ${holder.pid}) is STILL RUNNING after ${Math.round(opts.timeoutMs / 1000)}s. ` +
          'It has not failed — this wait gave up, the mission did not.',
        nextStep:
          'This is the NORMAL answer for a mission that takes longer than one poll, and the run is ' +
          'healthy. Call deliver again with follow:true to keep waiting. Do NOT kill the deliver ' +
          'process, do NOT change any gate or enforcement setting, and do NOT start another run.',
      };
    }
    opts.onTick?.(elapsed, holder.pid);
    await sleep(Math.min(pollMs, Math.max(1, opts.timeoutMs - elapsed)));
  }

  const { run, attributed } = runForHolder(projectRoot, holder.pid, isAlive);
  if (!run) {
    return {
      followed: true,
      delivered: false,
      holderPid: holder.pid,
      attributed: false,
      reason: `The deliver run (pid ${holder.pid}) finished, but no run state could be read for it.`,
      nextStep:
        'Inspect the project to see what landed before deciding whether to run deliver again.',
    };
  }
  return terminalOutcome(run, holder.pid, attributed, true);
}
