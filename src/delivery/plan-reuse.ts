/**
 * Reuse the phase plan a previous run already produced for the SAME instruction.
 *
 * WHY THIS EXISTS
 * Planning is a model call, so relaunching the same mission re-plans it — and
 * the plan that comes back is different every time. Measured over four hours in
 * `cognition-engine` on 2026-08-11, where the agent relaunched near-identical
 * instructions after killing each run:
 *
 *   "Add pgrx bindings for join_by_i_sql … to lib.rs"      (68 chars)  ->  5 phases
 *   "Add pgrx bindings for join_by_i_sql … to lib.rs - …"  (121 chars) ->  0 phases
 *   "Create …setup_optimizations.sql with 4 functions"     (74 chars)  ->  0 phases
 *   "Create …setup_optimizations.sql with 4 functions …"   (130 chars) ->  8 phases
 *
 * The codebase already treats replanning as something to avoid where identity
 * matters: resume deliberately skips it, because "replanning would mint new
 * epic ids (resetting the completion ledger's done marks) and draw new
 * boundaries over already-built work". A relaunch of the same instruction has
 * the same problem and did not get the same protection.
 *
 * HOW MUCH OF THAT IS LEFT (read this before trusting the numbers above)
 * Every instruction in that table is under 200 characters, and since
 * `shouldPlanEpicPhases` those do not get planned at all — they run as one
 * epic, so there is no plan to draw twice. This module now covers only what
 * that one does not: an instruction long enough to be worth planning, launched
 * again within the window.
 *
 * Replayed against the 47-run corpus it was built from, this fires ZERO times:
 * every repeated instruction there was short. It is insurance against a
 * relaunch storm on a LONG mission, which is the expensive version of the same
 * failure (a 10-phase plan costs more to redraw than a 2-phase one) and has not
 * yet been observed. Kept deliberately, with that stated, rather than presented
 * as a measured win.
 *
 * WHAT IT DOES NOT DO
 * It does not make the planner deterministic — a model call is not — and it
 * does not decide epic-vs-single, which is already a pure function of flags and
 * config. It makes the OUTCOME deterministic for the case that actually
 * repeats: the same instruction, in the same project, launched again.
 */

import { createHash } from 'crypto';
import { listRuns, MAX_INSTRUCTION_CHARS, type DeliverRunState } from './run-state.js';
import type { DeliveryPhase } from './decompose.js';

/** Off-switch, for an operator who wants a fresh plan every time. */
export const PLAN_REUSE_OFF_ENV = 'UAP_DELIVER_NO_PLAN_REUSE';

/**
 * How old a plan may be and still be reused.
 *
 * Six hours is long enough to cover the relaunch storms this exists for (the
 * observed ones were minutes apart), and shorter than every other TTL in this
 * codebase (24h for run manifests and snapshots, 7d for mined traces) because
 * it is guarding something they are not.
 *
 * Age is a WEAK proxy and worth saying so: a plan describes a tree, and the
 * killed run being relaunched is often the thing that changed the tree. Sixty
 * seconds of writing can invalidate a plan that six idle hours could not. The
 * window is short for that reason, not because six hours makes a plan safe.
 * Keying on tree identity would be the real answer and is not what this does.
 */
export const PLAN_REUSE_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/** Identity of a mission for reuse purposes: exact instruction text. */
export function instructionKey(instruction: string): string {
  // Trimmed, because trailing whitespace is not a different mission. NOT
  // normalised further: a caller that rewords is asking a different question
  // and must get a fresh plan, which is the whole point of keying on the text.
  //
  // Truncated to the SAME cap run-state applies when it reads a run back
  // (saveRunState writes the instruction verbatim, readState slices it). Hash
  // the raw text on one side and the truncated text on the other and every
  // instruction over 8000 characters silently never matches — which would have
  // made this dead for the longest missions, exactly the ones it exists for.
  return createHash('sha256')
    .update(instruction.trim().slice(0, MAX_INSTRUCTION_CHARS))
    .digest('hex')
    .slice(0, 32);
}

/** True when plan reuse is switched off for this session. */
export function planReuseDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return ['1', 'true', 'on', 'yes'].includes(
    String(env[PLAN_REUSE_OFF_ENV] ?? '').toLowerCase()
  );
}

/**
 * Below this, a persisted "plan" is not a plan worth carrying.
 *
 * A run whose planner produced nothing does not persist an empty array — the
 * epic runner reshapes a degenerate plan into the single `mission` epic BEFORE
 * persisting it (epic-mission.ts), so a planner failure reaches disk as one
 * phase, not zero. Reusing that would cache the failure for the whole window
 * and never retry the planner, while printing "1 phase carried over" as though
 * a plan had been carried. A real decomposition has at least two phases; the
 * one-phase case costs nothing to redo, because a mission that decomposes to
 * one epic is the same run either way.
 */
const MIN_REUSABLE_PHASES = 2;

/**
 * The phases a previous run planned for this exact instruction, or null.
 *
 * Deliberately narrow about which runs qualify, because a wrong reuse is
 * silent: the epic controller executes whatever it is handed.
 */
export function reusablePlan(
  projectRoot: string,
  instruction: string,
  now: number = Date.now(),
  runs: DeliverRunState[] = listRuns(projectRoot)
): { phases: DeliveryPhase[]; fromRunId: string } | null {
  const key = instructionKey(instruction);
  let best: { phases: DeliveryPhase[]; fromRunId: string; at: number } | null = null;

  for (const run of runs) {
    if (!run.phases || run.phases.length < MIN_REUSABLE_PHASES) continue;
    if (!run.instruction || instructionKey(run.instruction) !== key) continue;
    // `phases` does not mean the same thing for every runner: the orchestrated
    // path appends DISCOVERED tasks to it as the run grows (deliver.ts,
    // onPlanChange), so its persisted array is a grown task DAG, not a plan.
    // Handing that to the epic controller would run each discovered sub-task as
    // a top-level epic with its own attempt budget and gates.
    if (run.runnerKind !== 'epic') continue;
    // A failed run's plan may be WHY it failed. Everything else qualifies: the
    // relaunch storms this exists for leave runs 'running' or 'interrupted'.
    if (run.status === 'failed') continue;
    // createdAt, not updatedAt: updatedAt is rewritten on every checkpoint, so
    // a long-lived run makes a day-old plan read as one minute old and the age
    // window stops bounding anything.
    const at = Date.parse(run.createdAt ?? '');
    if (!Number.isFinite(at)) continue;
    const age = now - at;
    // A future timestamp is a planted or skewed clock, not a fresh plan.
    if (age < 0 || age > PLAN_REUSE_MAX_AGE_MS) continue;
    if (!best || at > best.at) best = { phases: run.phases, fromRunId: run.runId, at };
  }

  return best ? { phases: best.phases, fromRunId: best.fromRunId } : null;
}

/**
 * Reuse a recent plan for this instruction, or fall through to `plan()`.
 *
 * The composition itself, so it is testable: a version that plans FIRST and
 * then discards the result has to fail a test rather than merely look wrong in
 * a diff. The CLI passes this as `resolveEpicPlan`'s planner, which means a
 * short mission short-circuits to one epic before any lookup happens — reuse
 * walks every persisted run, which is wasted work for a mission that was never
 * going to be planned.
 */
export async function planWithReuse(
  projectRoot: string,
  instruction: string,
  plan: () => Promise<DeliveryPhase[]>,
  onReuse?: (notice: string) => void,
  env: NodeJS.ProcessEnv = process.env
): Promise<DeliveryPhase[]> {
  if (!planReuseDisabled(env)) {
    const reused = reusablePlan(projectRoot, instruction);
    if (reused) {
      onReuse?.(planReuseNotice(reused.fromRunId, reused.phases.length));
      return reused.phases;
    }
  }
  return plan();
}

/** The line printed when a plan is reused, so the choice is never silent. */
export function planReuseNotice(fromRunId: string, phaseCount: number): string {
  return (
    `♻ plan reuse: ${phaseCount} phase${phaseCount === 1 ? '' : 's'} carried over from ` +
    `${fromRunId} — same instruction, so this launch skips planning and starts working. ` +
    `(fresh plan: ${PLAN_REUSE_OFF_ENV}=1)`
  );
}
