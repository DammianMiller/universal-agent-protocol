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
  /** Max fresh-session attempts per epic before it is declared failed. Default 2. */
  maxAttemptsPerEpic?: number;
  /** Progress hook. */
  onEpic?: (epic: Epic, outcome: EpicOutcome) => void;
}

export interface EpicControllerResult {
  success: boolean;
  completed: string[];
  failed: string[];
  turns: number;
  outcomes: EpicOutcome[];
}

const DEFAULT_MAX_ATTEMPTS = 2;

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
  const priorSummaries: string[] = [];
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
