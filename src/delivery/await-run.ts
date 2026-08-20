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

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from 'fs';
import { join, resolve } from 'path';
import { isValidRunId, listRuns, type DeliverRunState } from './run-state.js';
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

/**
 * How long a caller should WAIT between follows, once the first has answered.
 *
 * Distinct from FOLLOW_CLIENT_POLL_SEC, which bounds how long one call may
 * block. Nothing bounded the gap BETWEEN calls, so an LLM caller polled as fast
 * as it could think — measured live 2026-08-20: 19 follows in 36 minutes, one
 * roughly every 115s, against a mission whose turns take 220-600s. Most polls
 * therefore could not have had news, and each cost a model turn.
 *
 * Sized against the observed turn floor (~220s): a poll interval below one turn
 * is guaranteed to return "no change", and on a single-slot backend it also
 * steals the slot that would have produced the change.
 */
export const RECOMMENDED_BACKOFF_SEC = 240;

export interface AwaitOptions {
  /** Give up after this long and say so. */
  timeoutMs: number;
  pollMs?: number;
  /**
   * Called on each poll, for a heartbeat/progress line.
   *
   * Carries the same projection the final reply carries. The ticker used to
   * show elapsed seconds and nothing else — `…following deliver (pid N) — 30s`
   * — which is a clock, not progress: it ticks at exactly the same rate whether
   * the mission is completing turns or spinning. A caller watching that for the
   * length of a poll learns only that time passed, and the runs killed on
   * 2026-08-11 were killed by a caller who had been watching precisely this.
   */
  onTick?: (elapsedMs: number, holderPid: number, progress?: FollowProgress) => void;
  /** Injected for tests. Defaults to a real liveness probe. */
  isAlive?: (pid: number) => boolean;
  /** Injected for tests. Defaults to a real sleep. */
  sleep?: (ms: number) => Promise<void>;
}

export interface AwaitResult {
  /**
   * Live runs found in project roots BELOW the one asked about.
   *
   * Present only when this root had nothing in flight of its own — the case
   * where the honest answer used to be a confidently wrong one about a
   * different (often older) mission. See liveRunsInNestedRoots.
   */
  nestedLiveRuns?: NestedLiveRun[];
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
   * exists to remove. Cross-check `turn`, `phase` and `run.updatedAt`, which
   * only move when a turn or phase actually completes.
   */
  health: 'starting' | 'active' | 'wedged';
  /**
   * Turns COMPLETED so far — the advancement signal, as opposed to liveness.
   *
   * `phase` is absent for an undecomposed mission, which left those runs with
   * no advancement signal at all in this projection. That is the shape the
   * kills happened on.
   */
  turn?: number;
  /**
   * What the run is DOING, when it has not completed a turn yet.
   *
   * 'planning' — decomposing the mission into phases. This is a model call and
   * it produces no turns and no phases until it finishes, so every advancement
   * field is legitimately empty while it runs. A caller reading those empties
   * as "hung" is the failure this exists to prevent.
   *
   * Traced on 2026-08-11: nine runs killed with `kill -9`, median 59 SECONDS
   * after launch, every one of them still planning. The agent's stated reason
   * was "the deliver tool keeps getting stuck in multi-phase plans" — it was
   * not stuck, it had simply not reached turn 1, and nothing in this reply
   * distinguished those.
   *
   * Absent once a turn exists: `turn` is the better signal from then on.
   */
  stage?: 'planning';
  /** Phases decomposed so far — 0 while the planner is still thinking. */
  phasesPlanned?: number;
}

/**
 * The advancement half of a follow tick, appended to the elapsed clock.
 *
 * `previousTurn` is what the LAST tick showed, so a completed turn can be
 * called out as it happens. That transition is the only thing in a follow line
 * that distinguishes a mission from a stalled process, and it is exactly what
 * the old ticker — elapsed seconds alone — could never show.
 */
export function followTickDetail(progress?: FollowProgress, previousTurn?: number): string {
  if (!progress) return '';
  const bits: string[] = [];
  if (progress.stage === 'planning') {
    bits.push('planning');
  } else if (progress.turn !== undefined) {
    bits.push(
      previousTurn !== undefined && progress.turn > previousTurn
        ? `turn ${previousTurn} → ${progress.turn} ✓`
        : `${progress.turn} turn${progress.turn === 1 ? '' : 's'}`
    );
  }
  if (progress.phase) bits.push(`phase ${progress.phase}`);
  if (progress.heartbeatAgeSec !== null) bits.push(`active ${progress.heartbeatAgeSec}s ago`);
  return bits.length ? ` · ${bits.join(', ')}` : '';
}

/**
 * What a previous follow already told this caller, persisted across the
 * SEPARATE PROCESSES a poll loop is made of.
 *
 * WHY THIS EXISTS
 * Every timed-out follow used to return the full ~1.2KB kill-loop briefing —
 * the planning explanation, the do-NOT-kill list, the where-to-find-the-fields
 * paragraph. That text is load-bearing the FIRST time (it is what stops a
 * caller killing a healthy run) and pure cost every time after: the caller has
 * already read it and cannot act on it twice.
 *
 * Measured live (2026-08-20, opencode + qwen3.8-27b): 19 follows on one mission
 * returned ~23KB of near-identical prose, which drove 20 context compactions in
 * 80 minutes; the client then degenerated to empty completions and stopped
 * polling entirely while the mission it had been watching carried on fine. The
 * briefing meant to keep a caller alive is what killed it.
 *
 * So: say it once, then say only what CHANGED. A diff is both smaller and more
 * informative than a repeated essay — it answers "is it moving?", which is the
 * only question a repeat poll is actually asking.
 */
interface PollJournal {
  /** How many times a follow has timed out on this run. */
  count: number;
  /** The progress projection reported by the previous timed-out follow. */
  last?: { turn?: number; phase?: string; runElapsedSec?: number; phasesPlanned?: number };
}

/**
 * `null` for any runId that must not become a path component.
 *
 * The runId reaching here is the `runId` FIELD of a state.json, not a directory
 * name — repo-resident content the project already treats as untrusted
 * elsewhere ("the run-state file is untrusted (repo content can plant values)").
 * A planted `../../../…` would otherwise steer both the read and the write.
 * Same guard `isStopRequested` applies to the same value for the same reason.
 */
function pollJournalPath(projectRoot: string, runId: string): string | null {
  if (!isValidRunId(runId)) return null;
  return join(projectRoot, '.uap', 'follow-polls', `${runId}.json`);
}

/** Prune only once the directory is worth walking. */
const MAX_POLL_JOURNALS = 32;

/** The ONLY shape a phase label may have to be echoed back: "3/7". */
const PHASE_LABEL_RE = /^\d{1,4}\/\d{1,4}$/;

/** A finite, in-range number, or undefined. Never NaN, never Infinity. */
function safeCount(v: unknown, max: number): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.min(Math.floor(n), max) : undefined;
}

/**
 * Sanitize the previous projection read back off disk.
 *
 * `last.phase` is INTERPOLATED into `reason`, which the MCP tool returns
 * verbatim to the calling model — so this file is an input to a supervising
 * agent's prompt, and it lives in the tree the supervised generator can write.
 * Left raw it carried both a prompt-injection channel and an unbounded one:
 * measured on this branch before the fix, a planted phase produced a 50,217-char
 * reply containing "IGNORE ALL PREVIOUS INSTRUCTIONS" — from the one function
 * whose entire purpose is to make the reply SMALLER.
 *
 * Same stance the sibling `count` already took, extended to every field.
 */
function sanitizeLast(raw: unknown): PollJournal['last'] {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  // SHAPE, not just length. A phase label is "3/7" and nothing else, so match
  // that and drop anything else outright — a 32-character budget still leaves
  // 32 attacker-chosen characters in a supervising agent's prompt, and
  // "IGNORE ALL PREVIOUS INSTRUCTIONS" is exactly 32 characters long.
  const phase =
    typeof r.phase === 'string' && PHASE_LABEL_RE.test(r.phase) ? r.phase : undefined;
  return {
    turn: safeCount(r.turn, 1_000_000),
    phase,
    runElapsedSec: safeCount(r.runElapsedSec, 100_000_000),
    phasesPlanned: safeCount(r.phasesPlanned, 10_000),
  };
}

/** Fail-soft by contract: a journal that cannot be read is a first poll. */
function readPollJournal(projectRoot: string, runId: string, runCreatedAt?: string): PollJournal {
  try {
    const path = pollJournalPath(projectRoot, runId);
    if (!path) return { count: 0 };
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
    // Bind the journal to the RUN. `count > 0` is what suppresses the
    // do-not-kill briefing, and that text is load-bearing — it is what stops a
    // caller killing a healthy run. A journal that does not belong to this run
    // (planted, or left over from a recycled runId) must not be able to skip it.
    if (runCreatedAt !== undefined && raw?.createdAt !== runCreatedAt) return { count: 0 };
    return { count: safeCount(raw?.count, 10_000) ?? 0, last: sanitizeLast(raw?.last) };
  } catch {
    return { count: 0 };
  }
}

/**
 * Fail-soft: a journal we cannot write costs verbosity, never correctness.
 *
 * Writes via tmp + rename, which REPLACES a symlink at the destination rather
 * than following it — the pattern `saveRunState` already uses, and this was the
 * only writer in the area that did not. Verified before the fix: a symlink
 * planted at the journal path let this overwrite an arbitrary file outside the
 * project root with attacker-shaped JSON, destroying its contents.
 */
function writePollJournal(
  projectRoot: string,
  runId: string,
  j: PollJournal,
  runCreatedAt?: string
): void {
  try {
    const path = pollJournalPath(projectRoot, runId);
    if (!path) return;
    mkdirSync(join(projectRoot, '.uap', 'follow-polls'), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify({ ...j, createdAt: runCreatedAt }), 'utf-8');
    renameSync(tmp, path);
    prunePollJournals(projectRoot);
  } catch {
    /* read-only tree, races — the reply is still correct, just longer */
  }
}

/**
 * Drop journals whose run is gone. Fail-soft, bounded, and cheap.
 *
 * One tiny file per followed run, written forever, with nothing anywhere
 * removing them — the sibling `deliver-runs/` directory in the measured project
 * had already reached 26 entries. A journal outlives its usefulness the moment
 * its run is no longer listed, so `listRuns` IS the retention rule and no
 * separate policy is needed.
 */
function prunePollJournals(projectRoot: string): void {
  try {
    const dir = join(projectRoot, '.uap', 'follow-polls');
    const files = readdirSync(dir);
    if (files.length <= MAX_POLL_JOURNALS) return;
    const live = new Set(listRuns(projectRoot).map((r) => r.runId));
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      if (live.has(f.slice(0, -'.json'.length))) continue;
      try {
        unlinkSync(join(dir, f));
      } catch {
        /* raced with another follow */
      }
    }
  } catch {
    /* housekeeping — never let it affect the reply */
  }
}

/**
 * The changed facts between two polls, as a sentence — or null when nothing a
 * caller could act on moved.
 *
 * `null` is itself the answer to "is it stuck?", and is reported as such rather
 * than hidden: a poll that shows no movement AND a healthy heartbeat is the
 * signature of a slow turn, which is the case the caller most often misreads.
 */
/**
 * Is `next` further along than `prev`? Both look like "3/7".
 *
 * Unparseable either side answers TRUE — an unrecognised label is not evidence
 * of going backwards, and suppressing a real advance is the worse error.
 */
function phaseAdvanced(prev: string, next: string): boolean {
  const p = Number(prev.split('/')[0]);
  const n = Number(next.split('/')[0]);
  if (!Number.isFinite(p) || !Number.isFinite(n)) return true;
  return n > p;
}

export function progressDelta(prev: PollJournal['last'], now: FollowProgress): string | null {
  if (!prev) return null;
  const bits: string[] = [];
  if (now.turn !== undefined && prev.turn !== undefined && now.turn > prev.turn) {
    bits.push(`turn ${prev.turn} → ${now.turn}`);
  } else if (now.turn !== undefined && prev.turn === undefined) {
    bits.push(`reached turn ${now.turn}`);
  }
  // Forward only, same guard the turn counter gets above and for the same
  // reason: a reclaimed or handed-over run can re-report a LOWER phase, and
  // "phase 4/7 → 2/7" is not movement, it is a different mission answering.
  if (now.phase && prev.phase && now.phase !== prev.phase && phaseAdvanced(prev.phase, now.phase)) {
    bits.push(`phase ${prev.phase} → ${now.phase}`);
  }
  // A plan that GROWS (3 → 7 after an epic split) is news too; `!prev` alone
  // reported only the first appearance and then went quiet forever.
  if (now.phasesPlanned && now.phasesPlanned > (prev.phasesPlanned ?? 0)) {
    bits.push(`planned ${now.phasesPlanned} phases`);
  }
  return bits.length ? bits.join(', ') : null;
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
    ...(typeof run?.checkpoint?.turn === 'number' ? { turn: run.checkpoint.turn } : {}),
    // Only while there is no turn: after that, `turn` says more and this would
    // just be a second name for the same moment.
    ...(run !== undefined && typeof run.checkpoint?.turn !== 'number'
      ? { stage: 'planning' as const, phasesPlanned: run.phases?.length ?? 0 }
      : {}),
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
  // Last, and stated as a COUNT: it is the one number a caller can compare
  // against the previous reply to tell "slow" from "stuck".
  if (p.turn !== undefined) bits.push(`${p.turn} turn${p.turn === 1 ? '' : 's'} completed`);
  // No turn yet is a STAGE, not an absence. Saying "0 turns" would read as
  // failure to start; saying "still planning" says the same fact as progress.
  if (p.stage === 'planning') {
    bits.push(
      p.phasesPlanned
        ? `still PLANNING (${p.phasesPlanned} phases decomposed, no turn yet)`
        : 'still PLANNING (decomposing; no phases or turns yet)'
    );
  }
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
  /**
   * Turns the mission has COMPLETED — the count that actually advances.
   *
   * A follower could previously see only phase position, and an undecomposed
   * run reports phase 0 of 0 forever; `heartbeatAgeSec` moves on every tool
   * call, so it says "alive", never "getting somewhere". A run on 2026-08-09
   * went turn 1 → 4 over an hour with none of that visible, and the agent
   * following it killed the run and relaunched — twice, escalating to
   * `kill -9` and an attempted enforcement bypass. Reporting the number that
   * moved is the difference between "no evidence of progress" and "slow".
   */
  turn?: number;
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
    ...(typeof run.checkpoint?.turn === 'number' ? { turn: run.checkpoint.turn } : {}),
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

/** How deep below the given root to look for another project's runs. */
export const NESTED_ROOT_MAX_DEPTH = 4;
/** Never descend into these while looking — they are not project roots. */
const NESTED_SKIP = new Set(['node_modules', '.git', 'target', 'dist', 'build', '.worktrees', 'vendor']);

export interface NestedLiveRun {
  runId: string;
  projectRoot: string;
  pid: number;
  turn?: number;
}

/**
 * Live deliver runs in project roots BELOW this one.
 *
 * A project root is wherever `.uap/` sits, and this repo nests them: one tree
 * held runs in `src/sql/.uap` and `src/rust-pg-ext/.uap` at the same time.
 * `currentHolder` only ever looks at the root it is given, so asking from the
 * PARENT answered from the parent's own — and on 2026-08-11 that meant reporting
 * confidently on YESTERDAY's run, and offering to resume it, while two of
 * today's were live one directory down.
 *
 * The harm is specific and already documented in this codebase: a caller told
 * "nothing is in flight, start the mission normally" starts a SECOND run
 * against the same tree, and two of them overwrite each other's edits.
 *
 * Liveness is verified against the process, not the record: `status` stays
 * 'running' on a run whose process died (deliberately — that IS the resumable
 * state), so trusting it would report long-dead runs as live.
 */
export function liveRunsInNestedRoots(
  root: string,
  isAlive: (pid: number) => boolean = livePid,
  maxDepth: number = NESTED_ROOT_MAX_DEPTH
): NestedLiveRun[] {
  const found: NestedLiveRun[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return; // unreadable directory is not an error here
    }
    for (const name of entries) {
      if (NESTED_SKIP.has(name)) continue;
      const child = join(dir, name);
      try {
        if (!statSync(child).isDirectory()) continue;
      } catch {
        continue;
      }
      if (name === '.uap') {
        // `dir` is a project root. Skip the one we were asked about — the
        // caller has already been told about it.
        if (resolve(dir) !== resolve(root)) {
          for (const run of listRuns(dir)) {
            if (run.status !== 'running') continue;
            if (typeof run.pid !== 'number' || !isAlive(run.pid)) continue;
            found.push({
              runId: run.runId,
              projectRoot: dir,
              pid: run.pid,
              ...(typeof run.checkpoint?.turn === 'number' ? { turn: run.checkpoint.turn } : {}),
            });
          }
        }
        continue; // never descend INTO .uap
      }
      walk(child, depth + 1);
    }
  };
  walk(root, 0);
  return found;
}

/** The warning that keeps a caller from starting a second mission on one tree. */
export function nestedRunNotice(runs: readonly NestedLiveRun[]): string {
  if (runs.length === 0) return '';
  const [first] = runs;
  const others = runs.length > 1 ? ` (and ${runs.length - 1} more)` : '';
  const turn = first!.turn !== undefined ? `, ${first!.turn} turn(s) completed` : '';
  return (
    ` A deliver run IS live in a nested project root${others}: ${first!.runId} under ` +
    `${first!.projectRoot} (pid ${first!.pid}${turn}). Do NOT start a mission here — ` +
    `follow that one from its own root instead, or two runs will edit the same tree.`
  );
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
  // The run's own account of how it died. "It was interrupted" alone is a
  // dead end for the follower: it names no cause, so the only move left is to
  // try the same thing again. When the process recorded a cause, quote it —
  // and when the cause is one WE caused and can prevent, say how.
  const cause = run.exit?.reason;
  const orphaned = cause !== undefined && cause.includes('orphan guard');
  const remedy = orphaned
    ? ' It was stopped because the session that started it ended — not because the work failed. ' +
      'Relaunching from a session that also ends will stop the same way: keep that session alive ' +
      'while the mission runs, or start it with UAP_ALLOW_ORPHAN=1 so it survives on its own.'
    : '';
  return {
    followed: true,
    delivered: run.status === 'delivered',
    holderPid,
    runId: run.runId,
    status: run.status,
    run: summarize(run),
    attributed,
    reason: stale
      ? `The deliver run${who} exited without recording a final status — it was interrupted.` +
        (cause ? ` Cause: ${cause}.` : '')
      : `The deliver run${who} ${justEnded ? 'finished' : 'had already finished'} with status '${run.status}'.` +
        (attributed ? '' : ' (Matched by run state rather than by process id — verify the run id below is the one you meant.)'),
    nextStep: stale
      ? `The mission is interrupted, not lost. Continue it with resume:'${run.runId}' — safe now that the holder is gone.` +
        remedy
      : run.status === 'delivered'
        ? 'The mission completed. Inspect the result; no further deliver call is needed.'
        : run.status === 'interrupted'
          ? `The mission was STOPPED before completing — interrupted, not failed. ` +
            `Its accepted work is checkpointed: continue it with resume:'${run.runId}'. Do NOT relaunch ` +
            `from scratch and do NOT treat this as a gate failure.` +
            remedy
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
    // Look BELOW this root before answering. Both answers here — "here is the
    // last run" and "start the mission normally" — are wrong and actively
    // harmful when a live run sits one directory down.
    const nested = liveRunsInNestedRoots(projectRoot, isAlive);
    const recent = mostRecentRun(projectRoot);
    if (recent) {
      const outcome = terminalOutcome(recent, undefined, true, false);
      return nested.length
        ? { ...outcome, nestedLiveRuns: nested, nextStep: outcome.nextStep + nestedRunNotice(nested) }
        : outcome;
    }
    return {
      followed: false,
      delivered: false,
      nothingInFlight: true,
      ...(nested.length ? { nestedLiveRuns: nested } : {}),
      reason: 'No deliver run is in flight for this project, and no previous run was found.',
      nextStep: nested.length
        ? `Nothing to follow HERE.${nestedRunNotice(nested)}`
        : 'Nothing to follow. Start the mission normally — a fresh deliver call will acquire the lock.',
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
      // Repeat-poll accounting. Keyed by runId: an unattributed run has no
      // stable identity to journal against, so it keeps the full briefing —
      // the conservative direction, since that is also the case where the
      // caller is most likely looking at the wrong mission.
      const journalId = attributed ? run?.runId : undefined;
      const journal = journalId ? readPollJournal(projectRoot, journalId, run?.createdAt) : { count: 0 };
      const repeat = journal.count > 0;
      const delta = repeat ? progressDelta(journal.last, progress) : null;
      if (journalId) {
        writePollJournal(
          projectRoot,
          journalId,
          {
            count: journal.count + 1,
            last: {
              turn: progress.turn,
              phase: progress.phase,
              runElapsedSec: progress.runElapsedSec,
              phasesPlanned: progress.phasesPlanned,
            },
          },
          run?.createdAt
        );
      }
      // A repeat poll on a HEALTHY run gets the diff and nothing else. Wedged
      // runs are excluded deliberately: that reply carries a warning and a
      // remedy the caller has not acted on yet, so it is not redundant.
      if (repeat && progress.health !== 'wedged') {
        return {
          followed: false,
          delivered: false,
          timedOut: true,
          holderPid: holder.pid,
          runId: attributed ? run?.runId : undefined,
          status: attributed ? run?.status : undefined,
          run: run && attributed ? summarize(run) : undefined,
          attributed,
          progress,
          reason:
            `Still running (poll ${journal.count + 1}) — ${evidence}.` +
            (delta
              ? ` Moved since your last poll: ${delta}.`
              : ' No phase or turn boundary crossed since your last poll; the heartbeat is current,' +
                ' so a turn is in progress (turns take minutes on a local model).'),
          nextStep:
            // The backoff is the point. Each follow is a full model turn for an
            // LLM caller, and on a single-slot local backend it CONTENDS with
            // the mission for the one inference slot — polling harder makes the
            // thing you are waiting for slower. The standing rules are
            // REFERENCED, not restated: restating them is the cost being cut.
            `Sleep ${RECOMMENDED_BACKOFF_SEC}s before the next follow — polling faster costs a ` +
            'model turn and takes the slot the mission needs. First reply\'s rules still stand.',
        };
      }
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
            : progress.stage === 'planning'
              // The kill window, verbatim: nine runs SIGKILLed at a median of
              // 59s, every one still planning, because no turn and no phase
              // read as no progress. Name the stage and its cost before
              // repeating the generic advice, or the generic advice arrives
              // after the caller has already decided.
              ? 'The run has not reached turn 1 yet because it is still PLANNING — decomposing the ' +
                'mission into phases, which is a model call and produces no turns and no phases ' +
                'until it finishes. Empty advancement fields here mean "not started yet", NOT ' +
                '"stuck": planning routinely takes minutes on a local model. Killing it now throws ' +
                'away the planning and the next launch starts it again from nothing — that loop has ' +
                'happened, repeatedly. Call deliver again with follow:true and watch ' +
                'progress.phasesPlanned appear, then progress.turn; heartbeatAgeSec staying small ' +
                'means the planner is still working. Do NOT kill the deliver process, do NOT ' +
                'change any gate or enforcement setting, and do NOT start another run.'
              : 'This is the NORMAL answer for a mission that takes longer than one poll. Call deliver ' +
              'again with follow:true to keep waiting, and compare heartbeatAgeSec against this reply ' +
              'to watch it move (also phase and the run\'s updatedAt when present — they advance only ' +
              'when a turn or phase actually completes). From the MCP tool these are under ' +
              'result.progress and result.run; from `uap deliver --json` they are top-level. Do NOT ' +
              'kill the deliver process, do NOT change any gate or enforcement setting, and do NOT ' +
              'start another run.',
      };
    }
    // Re-read per tick rather than reusing the projection computed above: the
    // point of the ticker is to show what CHANGED since the last one.
    opts.onTick?.(elapsed, holder.pid, describeProgress(projectRoot, runForHolder(projectRoot, holder.pid, isAlive).run ?? undefined));
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
