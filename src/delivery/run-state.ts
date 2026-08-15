/**
 * Durable Delivery Runs — persist convergence-loop state across process
 * boundaries so very long missions survive interruption (crash, timeout,
 * operator stop) and resume exactly where they left off.
 *
 * One directory per run under `<projectRoot>/.uap/deliver-runs/<runId>/` with
 * a single `state.json`: run metadata + the loop's last LoopCheckpoint (and,
 * for decomposed runs, the phase plan + cursor). Writes are atomic
 * (tmp + rename) and fail-soft — persistence must never break a run.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { randomBytes } from 'crypto';
import type { LoopCheckpoint } from './convergence-loop.js';
import type { DeliveryPhase } from './decompose.js';

export type DeliverRunStatus = 'running' | 'delivered' | 'failed' | 'interrupted';

export interface DeliverRunState {
  runId: string;
  instruction: string;
  presetId: string;
  projectRoot: string;
  status: DeliverRunStatus;
  createdAt: string;
  updatedAt: string;
  /** Loop state after the last completed turn (absent before turn 1). */
  checkpoint?: LoopCheckpoint;
  /** Decomposed missions: the phase plan and the index of the phase in flight. */
  phases?: DeliveryPhase[];
  phaseIndex?: number;
  /** Which runner executed the fresh run. Epic-kind resumes re-enter the
   * epic path; everything else takes the phased (cursor-honoring) path, and
   * a mismatch triggers a loud downgrade warning instead of a silent
   * execution-model switch. */
  runnerKind?: 'single' | 'phased' | 'orchestrated' | 'epic';
  /** One-line summaries of completed phases — or, for epic-kind runs,
   * completed EPICS (harness-owned, injected into later phases/epics). */
  phaseSummaries?: string[];
  /** Epic-kind runs: ids of epics ACCEPTED so far. Resume marks these done in
   * the controller so completed work is skipped, never redone. */
  completedEpicIds?: string[];
  /** Orchestrated-kind runs: accepted task outcomes (id + the summary/contract
   * dependents read). Resume seeds the scheduler's done set + blackboard. */
  taskOutcomes?: Array<{ id: string; summary: string; contract?: string }>;
  /** Task-DB id opened for this mission, so --resume reuses it instead of duplicating. */
  taskId?: string;
  /** OS pid of the deliver process that owns this run (operator cancel target). */
  pid?: number;
  /** pid of whoever SPAWNED the deliver process — names the killer when a parent tears it down. */
  ppid?: number;
  /** How the process ended (signal/code). Absent while genuinely alive; see run-exit.ts. */
  exit?: {
    at: string;
    signal?: string;
    code?: number;
    ppid?: number;
    reason: string;
  };
}

export function deliverRunsDir(projectRoot: string): string {
  return join(projectRoot, '.uap', 'deliver-runs');
}

export function newRunId(): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
  return `run-${stamp}-${randomBytes(3).toString('hex')}`;
}

/** Run ids are path components; refuse anything that is not a plain slug. */
export function isValidRunId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(id) && !id.includes('..');
}

/** Persist run state atomically. Fail-soft: returns false on any error. */
export function saveRunState(state: DeliverRunState): boolean {
  try {
    const dir = join(deliverRunsDir(state.projectRoot), state.runId);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'state.json');
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2), 'utf-8');
    renameSync(tmp, path);
    return true;
  } catch {
    return false;
  }
}

const VALID_STATUSES = new Set<DeliverRunStatus>(['running', 'delivered', 'failed', 'interrupted']);
/**
 * Instructions are truncated to this on READ, while `saveRunState` writes them
 * verbatim. Exported because anything comparing a live instruction against a
 * persisted one has to apply the same cap or it will never match above it.
 */
export const MAX_INSTRUCTION_CHARS = 8000;
// Must match the planner's hard ceiling (decompose.ts): the old cap of 5
// silently TRUNCATED bigger persisted plans, so a legally-sized 8-phase
// mission resumed at phaseIndex 6 skipped the loop entirely and reported
// success having done nothing.
const MAX_PHASES = 20;
/** Producer-side view of the phases cap: persist no more than this many. */
export const MAX_PERSISTED_PHASES = MAX_PHASES;
const MAX_SUMMARY_CHARS = 300;
const MAX_CRITERIA = 6;
const MAX_CRITERION_CHARS = 200;
const VALID_RUNNER_KINDS = new Set(['single', 'phased', 'orchestrated', 'epic']);
const PHASE_ID_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;

/**
 * Read + SANITIZE a persisted run state. The state file lives inside the
 * target project tree, i.e. on the untrusted side of the boundary (a generator
 * model or repo content could seed one), so nothing loaded here is trusted:
 * the runId is forced back to the validated directory name (a planted
 * traversal runId would otherwise steer every later save), text fields are
 * length-clamped, phases re-validated against the planner's own limits, and
 * unknown statuses rejected.
 */
function readState(projectRoot: string, runId: string): DeliverRunState | null {
  try {
    const path = join(deliverRunsDir(projectRoot), runId, 'state.json');
    if (!existsSync(path)) return null;
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as DeliverRunState;
    if (!parsed || typeof parsed.instruction !== 'string' || !parsed.instruction.trim()) {
      return null;
    }
    if (!VALID_STATUSES.has(parsed.status)) return null;
    // The directory name is the validated identity; never trust the embedded id.
    parsed.runId = runId;
    parsed.projectRoot = projectRoot;
    parsed.instruction = parsed.instruction.slice(0, MAX_INSTRUCTION_CHARS);
    if (typeof parsed.updatedAt !== 'string' || Number.isNaN(Date.parse(parsed.updatedAt))) {
      parsed.updatedAt = new Date(0).toISOString(); // sorts last for 'latest'
    }
    if (parsed.phases !== undefined) {
      if (!Array.isArray(parsed.phases)) return null;
      const phases: DeliveryPhase[] = [];
      for (const ph of parsed.phases.slice(0, MAX_PHASES)) {
        if (typeof ph !== 'object' || ph === null) return null;
        const { id, title, goal, deps, contracts, scaffold, criteria } = ph as {
          id?: unknown;
          title?: unknown;
          goal?: unknown;
          deps?: unknown;
          contracts?: unknown;
          scaffold?: unknown;
          criteria?: unknown;
        };
        if (typeof id !== 'string' || typeof title !== 'string' || typeof goal !== 'string') return null;
        if (!PHASE_ID_RE.test(id)) return null;
        // Round-trip the planner's structural fields (they used to be silently
        // stripped, making resume lossy for deps/flags/criteria) — each
        // re-validated against the same caps the planner parse applies.
        const cleanDeps = Array.isArray(deps)
          ? deps.filter((d): d is string => typeof d === 'string' && PHASE_ID_RE.test(d)).slice(0, MAX_PHASES)
          : undefined;
        const cleanCriteria = Array.isArray(criteria)
          ? criteria
              .filter((c): c is string => typeof c === 'string' && c.trim().length > 0)
              .map((c) => c.trim().slice(0, MAX_CRITERION_CHARS))
              .slice(0, MAX_CRITERIA)
          : undefined;
        phases.push({
          id,
          title: title.slice(0, 120),
          goal: goal.slice(0, 600),
          ...(cleanDeps && cleanDeps.length > 0 ? { deps: cleanDeps } : {}),
          ...(contracts === true ? { contracts: true } : {}),
          ...(scaffold === true ? { scaffold: true } : {}),
          ...(cleanCriteria && cleanCriteria.length > 0 ? { criteria: cleanCriteria } : {}),
        });
      }
      parsed.phases = phases;
    }
    if (
      parsed.runnerKind !== undefined &&
      (typeof parsed.runnerKind !== 'string' || !VALID_RUNNER_KINDS.has(parsed.runnerKind))
    ) {
      delete parsed.runnerKind;
    }
    // The resume CURSOR itself is untrusted: an out-of-range phaseIndex makes
    // the phase loop never run (vacuous success — the same hazard the
    // MAX_PHASES note above documents), and a negative or fractional one
    // crashes on phases[index]. Valid iff an integer in [0, phases.length)
    // (0 only when no phase plan is persisted); anything else is dropped so
    // the resume restarts from the first phase instead of lying.
    if (parsed.phaseIndex !== undefined) {
      const upper = Math.max(parsed.phases?.length ?? 0, 1);
      if (
        typeof parsed.phaseIndex !== 'number' ||
        !Number.isInteger(parsed.phaseIndex) ||
        parsed.phaseIndex < 0 ||
        parsed.phaseIndex >= upper
      ) {
        delete parsed.phaseIndex;
      }
    }
    if (parsed.phaseSummaries !== undefined) {
      if (!Array.isArray(parsed.phaseSummaries)) return null;
      parsed.phaseSummaries = parsed.phaseSummaries
        .slice(0, MAX_PHASES * 2)
        .filter((x): x is string => typeof x === 'string')
        .map((x) => x.slice(0, MAX_SUMMARY_CHARS));
    }
    if (parsed.completedEpicIds !== undefined) {
      if (!Array.isArray(parsed.completedEpicIds)) return null;
      // Same id shape the planner emits, plus dots for namespaced split ids
      // (defensive — split sub-epics are never persisted at top level).
      parsed.completedEpicIds = parsed.completedEpicIds
        .slice(0, MAX_PHASES * 2)
        .filter((x): x is string => typeof x === 'string' && /^[a-z0-9][a-z0-9.-]{0,63}$/.test(x));
    }
    if (parsed.taskOutcomes !== undefined) {
      if (!Array.isArray(parsed.taskOutcomes)) return null;
      // Task ids: planner shape + dots/tildes for namespaced repair-chain
      // links; summaries/contracts are prompt-bound text — length-clamped.
      parsed.taskOutcomes = parsed.taskOutcomes
        .filter(
          (x): x is { id: string; summary: string; contract?: string } =>
            typeof x === 'object' &&
            x !== null &&
            typeof (x as { id?: unknown }).id === 'string' &&
            /^[a-z0-9][a-z0-9.~-]{0,63}$/.test((x as { id: string }).id) &&
            typeof (x as { summary?: unknown }).summary === 'string'
        )
        .slice(0, MAX_PHASES * 2)
        .map((x) => ({
          id: x.id,
          summary: x.summary.slice(0, 400),
          ...(typeof x.contract === 'string' ? { contract: x.contract.slice(0, 2000) } : {}),
        }));
    }
    if (parsed.taskId !== undefined && (typeof parsed.taskId !== 'string' || !/^uap-[0-9a-f]{8}$/.test(parsed.taskId))) {
      delete parsed.taskId;
    }
    if (parsed.checkpoint) {
      const cp = parsed.checkpoint;
      // Seeds are re-injected verbatim into every candidate prompt on resume —
      // enforce the same bounds the ideation generator does at creation time.
      if (cp.seeds !== undefined) {
        if (!Array.isArray(cp.seeds)) {
          delete cp.seeds;
        } else {
          const seeds = [];
          for (const seed of cp.seeds.slice(0, 8)) {
            if (typeof seed !== 'object' || seed === null) continue;
            const { id, hint } = seed as { id?: unknown; hint?: unknown };
            if (typeof id !== 'string' || typeof hint !== 'string') continue;
            if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(id)) continue;
            seeds.push({ id, hint: hint.slice(0, 400) });
          }
          cp.seeds = seeds.length >= 2 ? seeds : undefined;
        }
      }
      if (cp.candidates !== undefined) {
        cp.candidates =
          typeof cp.candidates === 'number' && Number.isFinite(cp.candidates)
            ? Math.min(8, Math.max(2, Math.round(cp.candidates)))
            : undefined;
      }
      cp.criticEnabled = cp.criticEnabled === undefined ? undefined : Boolean(cp.criticEnabled);
      cp.modelEscalated = cp.modelEscalated === undefined ? undefined : Boolean(cp.modelEscalated);
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Load a run for resumption. `'latest'` resolves to the most recently updated
 * non-delivered run (an interrupted process leaves status 'running' behind —
 * that IS the resumable state). Returns null when nothing resumable exists.
 */
export function loadRunState(projectRoot: string, runId: string): DeliverRunState | null {
  if (runId !== 'latest') {
    if (!isValidRunId(runId)) return null;
    return readState(projectRoot, runId);
  }
  const dir = deliverRunsDir(projectRoot);
  if (!existsSync(dir)) return null;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  let best: DeliverRunState | null = null;
  for (const id of entries) {
    if (!isValidRunId(id)) continue;
    const state = readState(projectRoot, id);
    if (!state || state.status === 'delivered') continue;
    if (!best || state.updatedAt > best.updatedAt) best = state;
  }
  return best;
}

/**
 * Is this launch resuming an EPIC run — i.e. does the persisted state describe
 * work that belongs to this same mission-in-progress?
 *
 * The one question behind everything a resume inherits: the plan, the done set,
 * the phase summaries, and the completion ledger's marks. Named because those
 * four had to agree and were four separate copies of the same expression; a
 * fresh run that inherits any of them is claiming work it has not done.
 */
export function isEpicResume(state: Pick<DeliverRunState, 'runnerKind'> | null | undefined): boolean {
  return state?.runnerKind === 'epic';
}

/** List all persisted runs for a project, most-recently-updated first. */
export function listRuns(projectRoot: string): DeliverRunState[] {
  const dir = deliverRunsDir(projectRoot);
  if (!existsSync(dir)) return [];
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return []; }
  const runs: DeliverRunState[] = [];
  for (const id of entries) {
    if (!isValidRunId(id)) continue;
    const state = readState(projectRoot, id);
    if (state) runs.push(state);
  }
  runs.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  return runs;
}

/** Path to the cooperative stop-file for a run (an operator/dashboard cancel). */
export function stopFilePath(projectRoot: string, runId: string): string {
  return join(deliverRunsDir(projectRoot), runId, 'STOP');
}

/**
 * A stop-file that does not need a runId: `.uap/deliver-runs/STOP`.
 *
 * The per-run STOP is the right thing for a dashboard Cancel, which knows which
 * run it is cancelling. An AGENT does not: the detach banner hands it a pid
 * ~90 seconds before the run registers a runId, so for the whole window in
 * which it decides to intervene, the only handle it has is that pid — and it
 * uses it. Measured on 2026-08-10: eleven runs in two and a half hours, eight
 * of them SIGTERMed, most before completing a single turn, one launched roughly
 * every four minutes.
 *
 * A kill is the worst of the options. SIGKILL runs no handler, so nothing is
 * checkpointed, no exit is recorded, and the lock is left behind — the next
 * launch starts from zero, which is what makes it a loop rather than a
 * decision. This gives that same impatient caller a handle it can actually use
 * at the moment it wants one.
 */
export function projectStopFilePath(projectRoot: string): string {
  return join(deliverRunsDir(projectRoot), 'STOP');
}

/**
 * True when a stop has been requested for this run. Checked by the loop per turn.
 *
 * The project-level file is CONSUMED when it is observed. A stop-file that
 * outlived its run would silently stop every future one, which is a worse
 * failure than the one this fixes — and unlike the per-run file, nothing
 * scopes this one to a mission that has ended.
 */
export function isStopRequested(projectRoot: string, runId: string): boolean {
  try {
    if (isValidRunId(runId) && existsSync(stopFilePath(projectRoot, runId))) return true;
    const shared = projectStopFilePath(projectRoot);
    if (existsSync(shared)) {
      try { unlinkSync(shared); } catch { /* consumed by a racing reader */ }
      return true;
    }
    return false;
  } catch { return false; }
}

/** Wall-clock budget for one delivery, in minutes. 0 (or negative) disables it. */
export const DEFAULT_RUN_BUDGET_MINUTES = 120;

/**
 * The run's wall-clock budget: `UAP_DELIVER_MAX_MINUTES`, else
 * `delivery.maxRunMinutes` in `.uap.json`, else the default.
 *
 * Calibrated, not chosen. Across 61 local runs, every one that DELIVERED
 * finished within 119.9 minutes, so 120 would have ended 18 futile runs and no
 * successful one; 60 would have cut a run that succeeded. The environment wins
 * over the file so an operator can rescue a genuinely long mission without
 * editing config mid-flight.
 */
export function runBudgetMinutes(projectRoot: string): number {
  const env = process.env.UAP_DELIVER_MAX_MINUTES;
  if (env !== undefined) {
    const n = Number(env);
    if (Number.isFinite(n)) return n;
  }
  try {
    const cfg = JSON.parse(readFileSync(join(projectRoot, '.uap.json'), 'utf-8')) as {
      delivery?: { maxRunMinutes?: unknown };
    };
    const n = Number(cfg.delivery?.maxRunMinutes);
    if (Number.isFinite(n)) return n;
  } catch {
    /* absent or unreadable config — the default stands */
  }
  return DEFAULT_RUN_BUDGET_MINUTES;
}

/**
 * Has this run outlived its budget? PURE.
 *
 * A non-positive budget means OFF, not "expire immediately" — a config typo
 * must not stop every run on its first turn.
 *
 * A start time in the FUTURE (clock skew, a restored checkpoint) cannot expire
 * either, and needs no guard of its own: the budget is already known positive
 * here, so a negative elapsed can never exceed it. An explicit `elapsed > 0`
 * check was written first and removed — no test could distinguish it, because
 * nothing it guards against is reachable.
 */
export function isRunBudgetExpired(startedAtMs: number, budgetMinutes: number): boolean {
  if (!(budgetMinutes > 0)) return false;
  // `>` vs `>=` differ only when elapsed equals the budget to the exact
  // millisecond: an EQUIVALENT MUTANT no test kills, and not worth freezing a
  // clock to pin.
  return Date.now() - startedAtMs > budgetMinutes * 60_000;
}

/**
 * Map a finished delivery to its durable status. PURE.
 *
 * `stopObserved` is the stop as WITNESSED during the run (the latch fired, or
 * the result carries `stopped`). It must be threaded through rather than
 * re-derived: the project-level STOP file is consumed at observation time, so
 * an `isStopRequested` re-check at bookkeeping time returns false for exactly
 * the runs that were stopped that way — they landed 'failed', and followers
 * relaunched work that was checkpointed and resumable (2026-08-15, four
 * stop/relaunch cycles in 30 minutes). `stopFilePresent` still matters for the
 * per-run STOP file (which persists until cleared) and for a project-level
 * STOP arriving after the final turn began — either way a late stop rightly
 * lands 'interrupted'.
 */
export function finalRunStatus(
  success: boolean,
  stopObserved: boolean,
  stopFilePresent: boolean
): DeliverRunStatus {
  if (success) return 'delivered';
  if (stopObserved || stopFilePresent) return 'interrupted';
  return 'failed';
}

/**
 * Wrap a one-shot stop signal so it stays true once it has fired.
 *
 * `isStopRequested` CONSUMES the project-level stop file when it observes it —
 * deliberately, because a file that outlived its run would silently stop every
 * future one. Wired straight into `shouldStop`, though, that makes the signal
 * answer true exactly ONCE: the convergence loop sees it and ends that epic,
 * the epic controller asks again before the next epic, the file is gone, and
 * the run carries on (measured 2026-08-12 — stop consumed, fresh epic started
 * with its turn counter back at 1).
 *
 * Latching keeps both properties: still consumed on first observation, and now
 * applying to everything after it. Per run, so one mission stopping cannot
 * stop another.
 */
export function makeStopLatch(read: () => boolean): () => boolean {
  let latched = false;
  return () => {
    if (latched) return true;
    latched = read();
    return latched;
  };
}

/** Request a cooperative stop: write the run's STOP file (creating the dir if needed). */
export function requestStop(projectRoot: string, runId: string): boolean {
  try {
    const dir = join(deliverRunsDir(projectRoot), runId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'STOP'), new Date().toISOString(), 'utf-8');
    return true;
  } catch { return false; }
}

/** Clear a stale stop-file so a fresh/resumed run is not instantly interrupted. */
export function clearStop(projectRoot: string, runId: string): void {
  try { const p = stopFilePath(projectRoot, runId); if (existsSync(p)) unlinkSync(p); } catch { /* ignore */ }
}
