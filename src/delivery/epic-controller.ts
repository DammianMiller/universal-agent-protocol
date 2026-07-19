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

/** A top-level epic — the same shape as a phase, one lifecycle level up.
 * (Acceptance `criteria` come from DeliveryPhase — single-source.) */
export type Epic = DeliveryPhase;

/** What one epic execution attempt returns. */
export interface EpicRunResult {
  success: boolean;
  /** Harness-composed one-liner: what this epic produced (later epics read it). */
  summary: string;
  /** Turns spent this attempt, for reporting. */
  turns: number;
  /**
   * The attempt outgrew its per-session context budget — the ONLY signal the
   * rail-sizing split honors. (The old summary-substring match on the budget
   * marker was deprecated in v1.153 and removed as promised: the marker in
   * `summary` is human-facing text, not protocol.)
   */
  budgetStopped?: boolean;
  /** The attempt changed the working tree (even if not accepted) — counts as
   * prior work for the anti-no-op rail on later attempts and sub-epics. */
  changedTree?: boolean;
}

/** Context passed to the split planner about WHY the epic is being split. */
export interface SplitReason {
  /** True when the last attempt outgrew its context budget (rail sizing);
   * false when this is attempts-exhausted auto-escalation. */
  budgetStopped: boolean;
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
    ctx: { attempt: number; priorSummaries: string[]; lastFailure?: string; contract?: string }
  ) => Promise<EpicRunResult>;
  /**
   * Confirm an epic actually meets its acceptance criteria (gate/judge). When
   * omitted, a successful run is taken as accepted. Fail-soft: a throw is
   * treated as "not accepted" so the controller retries rather than wedging.
   */
  checkAcceptance?: (epic: Epic, result: EpicRunResult) => boolean | Promise<boolean>;
  /**
   * P1 contract-first: return the frozen shared contract (module APIs, the
   * CONFIG shape, event names, the verify contract) that ALL epics must conform
   * to — VERBATIM, not a lossy summary. Injected into every epic's ctx.contract
   * so fresh-context epics agree on ONE contract instead of each re-inventing it
   * (the octopus CONFIG/`Audio` divergence). Null until it exists. Fail-soft.
   */
  readContract?: () => string | null;
  /**
   * P1 contract-lint: after an epic delivers AND passes acceptance, verify its
   * output CONFORMS to the shared contract. A NON-EMPTY violations list fails
   * the epic so it re-runs with the violations fed back — catching divergence at
   * the epic boundary. Fail-soft: a throw is treated as no violations.
   */
  contractLint?: (epic: Epic, result: EpicRunResult, contract: string) => string[] | Promise<string[]>;
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
   * Epic ids already ACCEPTED by an interrupted run: marked done WITHOUT
   * running (their summaries ride in via initialPriorSummaries), so their
   * dependents unblock and completed work is never redone on resume.
   */
  initialDone?: string[];
  /**
   * Called with cumulative resume progress (summary list + accepted-epic id
   * set) after each ACCEPTED epic — the caller persists it so an interrupted
   * epic mission can resume at the epic boundary with completed work intact.
   * Deliberately NOT forwarded into split recursion: sub-epic completions
   * surface as their parent's single summary, keeping persisted progress at
   * epic granularity.
   */
  onProgress?: (progress: { summaries: string[]; completed: string[] }) => void;
  /**
   * Rail sizing (context auto-size): when an epic exhausts its attempts AND
   * its run reported the session outgrew its context budget (the structured
   * EpicRunResult.budgetStopped field), this is asked to re-plan the epic as
   * smaller sub-epics. Returning ≥2 sub-epics runs them immediately, in
   * order, through the same controller (one level deep — sub-epics never
   * split again); the epic counts as accepted iff ALL sub-epics are. Return
   * null/[] to decline. Fail-soft: a throw declines the split.
   */
  splitEpic?: (epic: Epic, lastFailure?: string, reason?: SplitReason) => Promise<Epic[] | null>;
  /**
   * Seed summaries of epics completed BEFORE this controller ran — used by
   * the split recursion so sub-epics still see what earlier epics built.
   */
  initialPriorSummaries?: string[];
  /**
   * Epics BEFORE this controller already changed the tree — used by the split
   * recursion so sub-epics inherit the parent run's prior-changes state.
   * Without it the child run recomputes from its own (empty) outcome list and
   * clobbers UAP_EPIC_PRIOR_CHANGES back to '0', re-arming the anti-no-op rail
   * against already-satisfied sub-epics (the re-split churn, one level deeper;
   * octopus_invaders_v3, 2026-07-16).
   */
  initialPriorChanged?: boolean;
  /**
   * Every epic in this controller belongs to a NON-final parent epic — used by
   * the split recursion so the last sub-epic of a non-final parent does NOT
   * run whole-mission gates (child finality = parent-is-final AND
   * child-is-last). Without it the child run computed finality from its own
   * ordering alone, re-creating the unsatisfiable-gate class on the other
   * channel (review follow-up of the initialPriorChanged fix).
   */
  initialNonFinal?: boolean;
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

  const done = new Set<string>(config.initialDone ?? []);
  const failed = new Set<string>();
  const priorSummaries: string[] = [...(config.initialPriorSummaries ?? [])];
  const outcomes: EpicOutcome[] = [];
  let totalTurns = 0;

  for (const epic of ordered) {
    // Resume skip: this epic was accepted by the interrupted run. Its summary
    // already rides in priorSummaries; report it, unblock dependents (via the
    // seeded done set), and never redo the work — a redo would produce zero
    // diff, which the anti-no-op rail correctly refuses to accept.
    if (done.has(epic.id)) {
      const outcome: EpicOutcome = {
        epicId: epic.id,
        accepted: true,
        attempts: 0,
        turns: 0,
        summary: 'accepted by the interrupted run — skipped on resume',
      };
      outcomes.push(outcome);
      config.onEpic?.(epic, outcome);
      continue;
    }
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
    let lastBudgetStopped = false;

    // Whole-mission gates (the user-validation browser journey) can only pass
    // once the FULL deliverable is assembled — gating an EARLY epic on the
    // finished app makes it unsatisfiable and freezes phaseIndex at 0
    // (octopus_invaders_v3, 2026-07-16). Signal non-final epics so those gates
    // report NA (non-blocking) instead of FAIL; the final epic runs them for
    // real. Epics run sequentially, so a process-global flag is safe here;
    // save/restore keeps the sub-epic recursion (runEpics on `chained`) correct.
    const isFinalEpic = config.initialNonFinal === true ? false : epic === ordered[ordered.length - 1];
    const priorNonFinal = process.env.UAP_EPIC_NONFINAL;
    process.env.UAP_EPIC_NONFINAL = isFinalEpic ? '0' : '1';

    // If an earlier epic already delivered (and therefore changed the tree),
    // signal it so the anti-no-op rail doesn't fail a trailing epic whose goal
    // the accumulated state already satisfies (zero diff = already-done, not a
    // no-op — the acceptance judge still gates it). Prevents the re-split churn.
    const priorEpicChanged = config.initialPriorChanged === true || outcomes.some((o) => o.accepted);
    const priorChangesFlag = process.env.UAP_EPIC_PRIOR_CHANGES;
    // A failed attempt's writes live in the NEXT attempt's baseline, so the
    // retry legitimately zero-diffs over real prior work — count it like
    // prior-epic work (the judge still gates; this only stands the
    // deterministic rail down). Re-evaluated per attempt below.
    let anyAttemptChanged = false;
    process.env.UAP_EPIC_PRIOR_CHANGES = priorEpicChanged ? '1' : '0';

    // try/finally: a throwing runEpic/splitEpic must not leak the epic env
    // flags into the long-lived process (review follow-up — the set/restore
    // pair was not exception-safe).
    try {

      while (attempts < maxAttempts && !accepted) {
        attempts++;
        process.env.UAP_EPIC_PRIOR_CHANGES = priorEpicChanged || anyAttemptChanged ? '1' : '0';
        // P1: carry the frozen shared contract VERBATIM into the fresh session so
        // this epic conforms to the same module APIs / CONFIG shape as the others.
        // Fail-soft like every other injected seam.
        let contract: string | undefined;
        try {
          contract = config.readContract?.() ?? undefined;
        } catch {
          contract = undefined;
        }
        const result = await config.runEpic(epic, {
          attempt: attempts,
          priorSummaries: [...priorSummaries],
          lastFailure,
          contract,
        });
        if (result.changedTree) anyAttemptChanged = true;
        epicTurns += result.turns;
        lastSummary = result.summary;
        lastBudgetStopped = result.budgetStopped === true;

        if (result.success) {
          let ok = true;
          if (config.checkAcceptance) {
            try {
              ok = await config.checkAcceptance(epic, result);
            } catch {
              ok = false; // fail-soft: unverifiable ⇒ not accepted ⇒ retry
            }
          }
          // P1 contract-lint: even an accepted epic must CONFORM to the shared
          // contract, or the assembled whole won't integrate. Violations fail
          // the epic so it re-runs against the contract.
          if (ok && contract && config.contractLint) {
            try {
              const violations = await config.contractLint(epic, result, contract);
              if (violations.length > 0) {
                ok = false;
                result.summary += ` [contract violations: ${violations.slice(0, 5).join('; ')}]`;
              }
            } catch {
              /* fail-soft: a broken linter never blocks a real delivery */
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
      // STRUCTURED signal only (the deprecated summary-substring match was
      // removed as promised in v1.153 — runEpic implementations must set
      // EpicRunResult.budgetStopped; the marker in summaries is human-facing
      // text, not protocol).
      const budgetExhausted = lastBudgetStopped;
      const splitFn = config.splitEpic;
      const shouldSplit =
        !accepted &&
        !!splitFn &&
        depthRemaining > 0 &&
        (budgetExhausted || config.splitOnAnyFailure === true);
      if (shouldSplit && splitFn) {
        let subs: Epic[] | null = null;
        try {
          subs = await splitFn(epic, lastFailure, { budgetStopped: budgetExhausted });
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
            // Inherit prior-changes state (this epic's own failed attempts may
            // also have written files — hasAppliedChanges in the child loop still
            // catches those; this flag covers the accumulated-tree case).
            initialPriorChanged: priorEpicChanged || anyAttemptChanged,
            // Child finality = parent-is-final AND child-is-last: sub-epics of
            // a non-final parent must all report non-final or the last one
            // runs whole-mission gates mid-mission.
            initialNonFinal: !isFinalEpic,
            // Persisted resume progress stays at EPIC granularity: sub-epic
            // completions surface as the parent's single summary push above.
            // The parent-level done set must not leak in either — namespaced
            // sub-epic ids could never match it, but semantics stay explicit.
            onProgress: undefined,
            initialDone: undefined,
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
    } finally {
      if (priorNonFinal === undefined) delete process.env.UAP_EPIC_NONFINAL;
      else process.env.UAP_EPIC_NONFINAL = priorNonFinal;
      if (priorChangesFlag === undefined) delete process.env.UAP_EPIC_PRIOR_CHANGES;
      else process.env.UAP_EPIC_PRIOR_CHANGES = priorChangesFlag;
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
      config.onProgress?.({ summaries: [...priorSummaries], completed: [...done] });
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
