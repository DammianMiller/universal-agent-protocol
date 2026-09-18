/**
 * The deterministic supervisor policy. PURE — same inputs, same decision.
 *
 * Priority is safety-first and FIXED (do not reorder without review):
 *   0. terminal status     → FINISH when delivered, else CONTINUE (a run that
 *                            is no longer running is never STOPped/ESCALATEd)
 *   1. iteration bounds    → STOP — outranks even human-need: a run past its
 *      budget stops regardless; a human-needed signal riding along is carried
 *      in evidence.alsoEscalate instead of becoming the action
 *   2. human-needed        → ESCALATE  (a blocked mission burns budget silently)
 *   3. off-track/stuck     → RETRY while retries remain, else ESCALATE
 *   4. completion-signaled → FINISH, ONLY on authoritative state
 *      (status === 'delivered'); the log-tail success regex alone never
 *      detaches supervision — a stuck mission whose model prints "mission
 *      complete" keeps being watched
 *   5. verification-pending → VERIFY, NEVER twice consecutively (oscillation
 *      guard), and bounded by maxVerify: an unanswered verification falls
 *      into the stuck path (RETRY/ESCALATE)
 *   6. otherwise           → CONTINUE
 *
 * Every decision carries its reason and the evidence that fired it — the
 * event ledger must be able to explain every action without re-running.
 */
import { runBudgetMinutes } from '../delivery/run-state.js';
import type { Decision, DimensionAssessment, Observation, SupervisorConfig, SupervisorState } from './types.js';

function dim(dims: DimensionAssessment[], name: string): DimensionAssessment | undefined {
  return dims.find((d) => d.name === name);
}

function fired(dims: DimensionAssessment[], name: string): boolean {
  return dim(dims, name)?.value === true;
}

function scoreOf(dims: DimensionAssessment[], name: string): number | undefined {
  const v = dim(dims, name)?.value;
  return typeof v === 'number' ? v : undefined;
}

/** The policy state it needs: retry/verify budgets + the oscillation guard's memory. */
export type PolicyState = Pick<SupervisorState, 'retries' | 'lastAction' | 'verifyCount'>;

/**
 * The budget the STOP branch enforces: the LARGER of the supervisor policy
 * and the deliver run's own budget (`UAP_DELIVER_MAX_MINUTES` /
 * `.uap.json delivery.maxRunMinutes` / the calibrated default). An
 * operator-raised deliver budget must not be overruled by the supervisor's
 * static policy number; a LOWER operator budget makes the deliver loop stop
 * itself first anyway, so taking the max never extends a mission past what
 * its owner granted. Impure (reads env/config) — callers pass the result in
 * via an adjusted cfg so decide() itself stays pure.
 */
export function effectiveMaxMinutes(cfg: SupervisorConfig, projectRoot: string): number {
  return Math.max(cfg.maxMinutes, runBudgetMinutes(projectRoot));
}

/** RETRY while the budget remains, ESCALATE when it is spent. */
function retryOrEscalate(
  reasonKind: string,
  state: PolicyState,
  cfg: SupervisorConfig,
  evidence: Record<string, unknown>
): Decision {
  const withBudget = { ...evidence, retries: state.retries, maxRetries: cfg.maxRetries };
  if (state.retries < cfg.maxRetries) {
    return { action: 'RETRY', reason: `${reasonKind} — retry budget remains`, evidence: withBudget };
  }
  return { action: 'ESCALATE', reason: `${reasonKind} — retries exhausted`, evidence: withBudget };
}

export function decide(
  obs: Observation,
  dims: DimensionAssessment[],
  state: PolicyState,
  cfg: SupervisorConfig
): Decision {
  // (0) Terminal runs: nothing left to supervise. NEVER STOP/ESCALATE them —
  // a delivered run's log may still contain scary text from earlier turns.
  if (obs.status !== 'running') {
    if (obs.status === 'delivered') {
      return {
        action: 'FINISH',
        reason: 'run delivered',
        evidence: { status: obs.status, turnsCompleted: obs.turnsCompleted },
      };
    }
    return {
      action: 'CONTINUE',
      reason: `run is ${obs.status} — nothing to supervise`,
      evidence: { status: obs.status },
    };
  }

  const humanNeeded = fired(dims, 'human-needed');

  // (1) Iteration bounds. STOP outranks ESCALATE: an over-budget mission that
  // is ALSO waiting on a human still stops — the human-need is recorded as an
  // alsoEscalate note, not acted on as the decision.
  if (obs.turnsCompleted > cfg.maxTurns || obs.elapsedMinutes > cfg.maxMinutes) {
    return {
      action: 'STOP',
      reason: 'iteration bounds exceeded',
      evidence: {
        turnsCompleted: obs.turnsCompleted,
        maxTurns: cfg.maxTurns,
        elapsedMinutes: Math.round(obs.elapsedMinutes * 10) / 10,
        maxMinutes: cfg.maxMinutes,
        ...(humanNeeded ? { alsoEscalate: 'human input required' } : {}),
      },
    };
  }

  // (2) Human need: a blocked mission burns its whole budget silently.
  if (humanNeeded) {
    return {
      action: 'ESCALATE',
      reason: 'human input required',
      evidence: { humanNeeded: true, tail: obs.recentLogTail.slice(-200) },
    };
  }

  // (3) Off-track or stuck: retry while the budget remains, then escalate.
  const offTrack = fired(dims, 'off-track');
  const stuck = fired(dims, 'stuck-loop');
  if (offTrack || stuck) {
    return retryOrEscalate('off-track/stuck', state, cfg, {
      offTrack,
      stuckLoop: stuck,
      progressStalled: fired(dims, 'progress-stalled'),
      failures: obs.failures,
    });
  }

  // (4) Completion: FINISH happens ONLY on authoritative state — branch (0)
  // returns FINISH for status 'delivered'. A completion-signaled dimension
  // firing from the log tail alone (a stuck model printing "mission
  // complete") is deliberately ignored here: supervision stays attached.

  // (5) Verification, oscillation-guarded AND budgeted. VERIFY never fires
  // twice consecutively; once the verify budget is spent without test
  // evidence appearing, the run is treated as stuck.
  if (fired(dims, 'verification-pending')) {
    if (state.lastAction !== 'VERIFY') {
      return {
        action: 'VERIFY',
        reason: 'checkpoint exists without test evidence in the log tail',
        evidence: { hasCheckpoint: obs.hasCheckpoint, lastAction: state.lastAction, verifyCount: state.verifyCount },
      };
    }
    if (state.verifyCount >= cfg.maxVerify) {
      return retryOrEscalate('verification unanswered', state, cfg, {
        verifyCount: state.verifyCount,
        maxVerify: cfg.maxVerify,
      });
    }
    return {
      action: 'CONTINUE',
      reason: 'verify already requested, awaiting result',
      evidence: { verifyCount: state.verifyCount, maxVerify: cfg.maxVerify },
    };
  }

  // (6) Healthy.
  return {
    action: 'CONTINUE',
    reason: 'within bounds',
    evidence: {
      errorDensity: scoreOf(dims, 'error-density'),
      iterationPressure: scoreOf(dims, 'iteration-pressure'),
      risk: scoreOf(dims, 'risk'),
    },
  };
}
