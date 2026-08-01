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
import { heartbeatAgeS, wedgeTimeoutS } from './heartbeat.js';

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
  /**
   * Evidence that the run is MOVING, set whenever the wait gave up on a live
   * run. See FollowProgress — this is the field that makes a repeated poll
   * informative rather than identical.
   */
  progress?: FollowProgress;
  /** Human/model-facing explanation. Always set. */
  reason: string;
  /** What the caller should do next. Always set. */
  nextStep: string;
}

/**
 * What a caller needs to tell "slow but working" from "stuck".
 *
 * THE GAP THIS CLOSES
 * A follow that times out used to answer with elapsed-wait only — the same
 * sentence every time, and an UNCONDITIONAL claim that "the run is healthy"
 * which nothing had checked. Three identical answers look exactly like a hung
 * process, so a caller with no way to see movement concludes the run is wedged.
 *
 * Observed live (2026-07-31, octopus_invaders_v3, qwen on opencode): the model
 * followed three times, got three identical "STILL RUNNING after 45s" replies,
 * and then killed the run — six times in one hour, each kill discarding work the
 * run had already finished. Closing the kill ROUTES is a separate change; this
 * closes the REASON it reached for them. A gate that refuses without answering
 * the question just moves the loop somewhere else.
 *
 * Every field here is a fact the caller can DIFF across consecutive polls:
 * `heartbeatAgeSec` falling, `phase` advancing, `run.updatedAt` moving. The
 * health verdict is derived from the heartbeat rather than asserted, so a run
 * that really has stopped is reported as stopped.
 */
export interface FollowProgress {
  /** Seconds since the run's own start (not since this wait began). */
  runElapsedSec?: number;
  /**
   * Seconds since the mission last stamped `.uap/deliver.heartbeat`, or null
   * when it has not stamped one yet (starting up). THE liveness signal.
   */
  heartbeatAgeSec: number | null;
  /** The wedge threshold this verdict was measured against. */
  wedgeAfterSec: number;
  /** 1-based phase position, when the mission is decomposed. */
  phase?: string;
  /**
   * 'starting' — alive, no heartbeat yet.
   * 'active'   — heartbeat within the wedge window.
   * 'wedged'   — alive but silent past the wedge window.
   *
   * Deliberately 'active', NOT 'advancing'. The heartbeat is stamped on every
   * executor TOOL CALL, not only on completed turns, so a run spinning in a
   * tool-call loop — an attractor loop, an error loop, a read-forever recon
   * loop, all of which this project has hit — stamps a fresh heartbeat forever
   * while achieving nothing. This field can honestly say the process is doing
   * something; it cannot say the mission is getting closer, and a label that
   * claimed otherwise would be the same unmeasured assertion this projection
   * exists to remove. Cross-check `phase` and `run.updatedAt`, which only move
   * when a turn or phase actually completes.
   */
  health: 'starting' | 'active' | 'wedged';
}

function describeProgress(projectRoot: string, run?: DeliverRunState): FollowProgress {
  const ageS = heartbeatAgeS(projectRoot);
  const wedgeAfterSec = wedgeTimeoutS();
  const startedMs = run?.createdAt ? Date.parse(run.createdAt) : NaN;
  const phase =
    run?.phaseIndex !== undefined && run?.phases?.length
      ? `${run.phaseIndex + 1}/${run.phases.length}`
      : undefined;
  // OMITTED rather than clamped when the delta is negative (a future or planted
  // createdAt). Clamping would pin the field at exactly 0 on every poll, and a
  // field frozen at 0 reads as "not moving" — the very inference that produced
  // the six kills. An absent field says "unknown"; a present one that lies is
  // worse than none.
  const elapsedMs = Date.now() - startedMs;
  const runElapsedSec =
    Number.isFinite(startedMs) && elapsedMs >= 0 ? Math.round(elapsedMs / 1000) : undefined;

  // A missing heartbeat means 'starting' only while the run is YOUNG. Treating
  // it as 'starting' unconditionally would report an hour-old run as still
  // starting up — the same unmeasured adjective as the "the run is healthy" this
  // projection replaced, just in a new coat. It would also CONTRADICT the lock
  // path, which calls the identical state (no heartbeat, old) abandoned and
  // reclaimable; two readers of one file disagreeing is what heartbeat.ts exists
  // to prevent. Falling back to the run's own age keeps them consistent.
  const silentForSec = ageS ?? runElapsedSec;
  const health: FollowProgress['health'] =
    silentForSec === undefined
      ? 'starting'
      : silentForSec > wedgeAfterSec
        ? 'wedged'
        : ageS === null
          ? 'starting'
          : 'active';

  return {
    ...(runElapsedSec !== undefined ? { runElapsedSec } : {}),
    heartbeatAgeSec: ageS,
    wedgeAfterSec,
    ...(phase ? { phase } : {}),
    // `updatedAt` is NOT repeated here: RunSummary already ships it on the same
    // result object, and a projection whose purpose is diffable facts must not
    // publish one fact twice — a caller comparing run.updatedAt on one poll and
    // progress.updatedAt on the next is comparing nothing.
    health,
  };
}

/** One line of evidence, so the prose carries the same facts as the struct. */
function progressSentence(p: FollowProgress): string {
  const bits: string[] = [];
  if (p.runElapsedSec !== undefined) bits.push(`running for ${p.runElapsedSec}s`);
  bits.push(
    p.heartbeatAgeSec === null
      ? 'no heartbeat yet'
      : `last activity ${p.heartbeatAgeSec}s ago`
  );
  if (p.phase) bits.push(`phase ${p.phase}`);
  return bits.join(', ');
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
        // This branch also gives up on a LIVE run and also tells the caller to
        // poll again, so it needs the same evidence — without it, repeated
        // reclaims produce byte-identical replies on the one path that is
        // actually describing instability.
        progress: describeProgress(projectRoot),
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
      const progress = describeProgress(projectRoot, attributed ? (run ?? undefined) : undefined);
      // The old message asserted "the run is healthy" unconditionally, which
      // nothing had checked — so it was a claim, not an answer, and it was
      // wrong precisely when it mattered. Derive it from the heartbeat instead,
      // and hand back the numbers so a caller can watch them move.
      const evidence = progressSentence(progress);
      return {
        followed: false,
        delivered: false,
        timedOut: true,
        holderPid: holder.pid,
        runId: attributed ? run?.runId : undefined,
        // Gated like runId and run: publishing a GUESSED run's status while
        // withholding its id hands the caller a fact about someone else's
        // mission with nothing to notice the mismatch by.
        status: attributed ? run?.status : undefined,
        run: run && attributed ? summarize(run) : undefined,
        attributed,
        progress,
        reason:
          `The deliver run (pid ${holder.pid}) is STILL RUNNING after ${Math.round(opts.timeoutMs / 1000)}s ` +
          `of waiting — ${evidence}. It has not failed: this wait gave up, the mission did not.` +
          (progress.health === 'wedged'
            ? ` WARNING: it has been silent for longer than the ${progress.wedgeAfterSec}s wedge` +
              ' timeout, so it may be stuck rather than slow.'
            : ''),
        nextStep:
          progress.health === 'wedged'
            ? // "Relaunch and it will be reclaimed" is true ONLY of a lock
              // holder: acquireDeliverLock reclaims a wedged holder, but it
              // only looks at all when a lock FILE exists. A resumed run never
              // takes the lock, so the same advice there hands the relaunch a
              // free lock and puts a SECOND mission on the same tree —
              // precisely the fan-out this module exists to prevent. The
              // remedy has to follow the holder, not the health.
              holder.source === 'lock'
              ? 'Do NOT kill it — a wedged LOCK holder is reclaimed automatically: start the ' +
                'mission again and the new run takes the lock from it. Killing it by hand ' +
                'discards the work it already finished and leaves the lock behind.'
              : 'Do NOT kill it, and do NOT relaunch: this holder is a RESUMED run, which holds ' +
                'no lock, so a new run would not reclaim it — it would execute concurrently on ' +
                'the same tree. Keep following, and if it never recovers, raise it with the ' +
                'operator rather than starting or killing anything.'
            : 'This is the NORMAL answer for a mission that takes longer than one poll. Call deliver ' +
              'again with follow:true to keep waiting, and compare heartbeatAgeSec against this reply ' +
              'to watch it move (also phase and the run\'s updatedAt when present — they advance only ' +
              'when a turn or phase actually completes). From the MCP tool these are under ' +
              'result.progress and result.run; from `uap deliver --json` they are top-level. Do NOT ' +
              'kill the deliver process, do NOT change any gate or enforcement setting, and do NOT ' +
              'start another run.',
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
