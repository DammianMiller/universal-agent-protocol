/**
 * Epic Controller (P7) — the outer loop above the blackboard orchestrator.
 *
 * A single `deliver` run drives one task DAG (2–8 phases) to green. But a
 * genuinely massive mission — "design and build this system through to
 * operational readiness" — is more than one DAG: it is a sequence of EPICS,
 * each of which is itself a full orchestrated mission (its own fresh phases,
 * its own convergence). This controller sits above the orchestrator and loops
 * epics until the whole mission is complete:
 *
 *   for each epic (dependency-ordered):
 *     run it as a FRESH orchestrated mission (fresh context, only prior epics'
 *       compact summaries injected — not their source, not the full spec)
 *     check acceptance (gate/judge)
 *     if not accepted, RETRY with a fresh session (bounded) feeding back the
 *       last failure — the "loop against with fresh sessions until complete"
 *
 * Like the task-orchestrator, this module is executor-agnostic: it takes a
 * `runEpic` callback (production wires a fresh orchestrated deliver mission;
 * tests inject a deterministic stub) and an optional `checkAcceptance`
 * callback, so the loop logic is unit-testable without a model.
 */

import type { DeliveryPhase } from './decompose.js';
import { topoOrder } from './decompose.js';
import { CONTEXT_BUDGET_MARKER } from './context-budget.js';

/** A top-level epic — the same shape as a phase, one lifecycle level up. */
export interface Epic extends DeliveryPhase {
  /** Epic-specific acceptance criteria (optional; used by the judge). */
  criteria?: string[];
}

/** What one epic execution attempt returns. */
export interface EpicRunResult {
  success: boolean;
  /** Harness-composed one-liner: what this epic produced (later epics read it). */
  summary: string;
  /** Turns spent this attempt, for reporting. */
  turns: number;
}

export interface EpicOutcome {
  epicId: string;
  accepted: boolean;
  attempts: number;
  turns: number;
  summary: string;
}

export interface EpicControllerConfig {
  /** The overall mission — a short orienting line for each epic, never dumped whole. */
  mission: string;
  epics: Epic[];
  /**
   * Run one epic as a fresh orchestrated mission. `attempt` starts at 1;
   * `priorSummaries` are the compact summaries of already-completed epics (the
   * only cross-epic state a fresh session sees). `lastFailure` is the previous
   * attempt's summary when retrying, so the fresh session knows what to fix.
   */
  runEpic: (
    epic: Epic,
    ctx: { attempt: number; priorSummaries: string[]; lastFailure?: string }
  ) => Promise<EpicRunResult>;
  /**
   * Confirm an epic actually meets its acceptance criteria (gate/judge). When
   * omitted, a successful run is taken as accepted. Fail-soft: a throw is
   * treated as "not accepted" so the controller retries rather than wedging.
   */
  checkAcceptance?: (epic: Epic, result: EpicRunResult) => boolean | Promise<boolean>;
  /** Max fresh-session attempts per epic before it is declared failed. Default 3. */
  maxAttemptsPerEpic?: number;
  /**
   * (#4c) Max recursive split levels when an epic can't be delivered whole.
   * Default 1 (one level: an over-budget epic splits into sub-epics, which
   * never re-split). deliver raises this for LARGE missions so a genuinely huge
   * epic recursively shrinks — a sub-epic that still can't land is split again,
   * one level shallower — until each piece fits a rail, instead of failing the
   * whole mission at the first split. Bounded: the depth counter decrements to
   * 0, and each `splitEpic` planner can decline (return null) to stop early.
   */
  splitDepth?: number;
  /**
   * (#5) When true, split a failed epic on ANY exhausted-attempts failure, not
   * only on context-budget exhaustion — turning "epic failed, mission
   * incomplete" into "re-plan it into smaller pieces and try those." Default
   * false (budget exhaustion only, preserving the conservative path). deliver
   * enables it for large missions so give-up becomes auto-escalation. Still
   * bounded by `splitDepth` and by the planner's option to decline the split.
   */
  splitOnAnyFailure?: boolean;
  /** Progress hook. */
  onEpic?: (epic: Epic, outcome: EpicOutcome) => void;
  /**
   * Rail sizing (context auto-size): when an epic exhausts its attempts AND
   * its last failure indicates the session outgrew its context budget (the
   * executor's CONTEXT_BUDGET_MARKER), this is asked to re-plan the epic as
   * smaller sub-epics. Returning ≥2 sub-epics runs them immediately, in
   * order, through the same controller (one level deep — sub-epics never
   * split again); the epic counts as accepted iff ALL sub-epics are. Return
   * null/[] to decline. Fail-soft: a throw declines the split.
   */
  splitEpic?: (epic: Epic, lastFailure?: string) => Promise<Epic[] | null>;
  /**
   * Seed summaries of epics completed BEFORE this controller ran — used by
   * the split recursion so sub-epics still see what earlier epics built.
   */
  initialPriorSummaries?: string[];
}

export interface EpicControllerResult {
  success: boolean;
  completed: string[];
  failed: string[];
  turns: number;
  outcomes: EpicOutcome[];
}

const DEFAULT_MAX_ATTEMPTS = 3;

/**
 * Run the epic sequence. Epics execute in dependency order; an epic whose
 * dependency failed is skipped (never build an epic on an unfinished one). Each
 * epic gets up to `maxAttemptsPerEpic` fresh-session attempts and must both run
 * successfully AND pass acceptance to count as complete.
 */
export async function runEpics(config: EpicControllerConfig): Promise<EpicControllerResult> {
  const maxAttempts = Math.max(1, config.maxAttemptsPerEpic ?? DEFAULT_MAX_ATTEMPTS);
  const ordered = topoOrder(config.epics as DeliveryPhase[]) as Epic[];

  const done = new Set<string>();
  const failed = new Set<string>();
  const priorSummaries: string[] = [...(config.initialPriorSummaries ?? [])];
  const outcomes: EpicOutcome[] = [];
  let totalTurns = 0;

  for (const epic of ordered) {
    const deps = epic.deps ?? [];
    const blockedBy = deps.filter((d) => failed.has(d) || !done.has(d));
    if (blockedBy.length > 0) {
      const outcome: EpicOutcome = {
        epicId: epic.id,
        accepted: false,
        attempts: 0,
        turns: 0,
        summary: `skipped — unmet epic dependency: ${blockedBy.join(', ')}`,
      };
      failed.add(epic.id);
      outcomes.push(outcome);
      config.onEpic?.(epic, outcome);
      continue;
    }

    let accepted = false;
    let attempts = 0;
    let epicTurns = 0;
    let lastSummary = '';
    let lastFailure: string | undefined;

    while (attempts < maxAttempts && !accepted) {
      attempts++;
      const result = await config.runEpic(epic, {
        attempt: attempts,
        priorSummaries: [...priorSummaries],
        lastFailure,
      });
      epicTurns += result.turns;
      lastSummary = result.summary;

      if (result.success) {
        let ok = true;
        if (config.checkAcceptance) {
          try {
            ok = await config.checkAcceptance(epic, result);
          } catch {
            ok = false; // fail-soft: unverifiable ⇒ not accepted ⇒ retry
          }
        }
        accepted = ok;
      }

      if (!accepted) {
        lastFailure = result.success
          ? `attempt ${attempts} delivered but did not pass acceptance: ${result.summary}`
          : `attempt ${attempts} failed to deliver: ${result.summary}`;
      }
    }

    // Rail sizing + auto-escalation: an epic that exhausted its attempts is
    // re-planned as smaller sub-epics and run in place, rather than failing the
    // whole mission. Fires on context-budget exhaustion always, and on ANY
    // failure when splitOnAnyFailure is set (#5). Recurses up to `splitDepth`
    // levels (#4c): sub-epics inherit the prior summaries and may split again
    // one level shallower until each piece fits a rail. Default depth 1 keeps
    // the conservative one-level behavior.
    const depthRemaining = config.splitDepth ?? 1;
    const budgetExhausted = (lastFailure ?? '').includes(CONTEXT_BUDGET_MARKER);
    const splitFn = config.splitEpic;
    const shouldSplit =
      !accepted &&
      !!splitFn &&
      depthRemaining > 0 &&
      (budgetExhausted || config.splitOnAnyFailure === true);
    if (shouldSplit && splitFn) {
      let subs: Epic[] | null = null;
      try {
        subs = await splitFn(epic, lastFailure);
      } catch {
        subs = null; // fail-soft: an unplannable split just keeps the failure
      }
      if (subs && subs.length >= 2) {
        // Sub-epics run in planner order (the for-loop is sequential and
        // topoOrder is stable) but are deliberately NOT dep-chained: a
        // budget-split piece often fails gates only because the WHOLE isn't
        // assembled yet, and later pieces — each a fresh session over the
        // accumulated repo state — can still complete it. Chaining would skip
        // every remaining piece on the first partial failure. Ids are
        // namespaced so they can't collide with sibling epics.
        const chained: Epic[] = subs.map((s) => ({
          ...s,
          id: `${epic.id}.${s.id}`.slice(0, 64),
          deps: [],
        }));
        const subResult = await runEpics({
          ...config,
          epics: chained,
          splitDepth: depthRemaining - 1, // recurse one level shallower (#4c); 0 ⇒ no re-split
          initialPriorSummaries: [...priorSummaries],
        });
        epicTurns += subResult.turns; // flows into totalTurns below
        outcomes.push(...subResult.outcomes);
        // Delivered when every piece passed OR when the FINAL piece passed:
        // earlier pieces often "fail" only because the whole wasn't assembled
        // yet — a green final piece means the accumulated state passes the
        // project gates, i.e. the epic's goal is delivered.
        const finalPieceGreen =
          subResult.outcomes.length > 0 && subResult.outcomes[subResult.outcomes.length - 1].accepted;
        accepted = subResult.success || finalPieceGreen;
        const splitReason = budgetExhausted ? 'context auto-size' : 'auto-escalation';
        lastSummary = accepted
          ? `split into ${chained.length} sub-epics (${splitReason}): ${subResult.outcomes.map((o) => o.summary).join('; ')}`
          : `split into ${chained.length} sub-epics (${splitReason}); failed: ${subResult.failed.join(', ')}`;
      }
    }

    totalTurns += epicTurns;
    const outcome: EpicOutcome = {
      epicId: epic.id,
      accepted,
      attempts,
      turns: epicTurns,
      summary: lastSummary,
    };
    outcomes.push(outcome);
    if (accepted) {
      done.add(epic.id);
      priorSummaries.push(`${epic.title}: ${lastSummary}`.slice(0, 200));
    } else {
      failed.add(epic.id);
    }
    config.onEpic?.(epic, outcome);
  }

  return {
    success: failed.size === 0,
    completed: [...done],
    failed: [...failed],
    turns: totalTurns,
    outcomes,
  };
}
