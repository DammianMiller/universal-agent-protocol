/**
 * Semantic supervisor for `uap deliver` missions — shared types.
 *
 * The supervisor WATCHES a run; it does not drive it. Observations are bounded
 * (log tails capped, diffs capped, git calls time-boxed), assessments are pure
 * functions over those observations, and the policy is deterministic with
 * reviewed thresholds (config/supervise-policy.json). Models may only ASSESS
 * (via the injectable classifier); they never decide.
 */

export type SupervisorAction = 'CONTINUE' | 'STOP' | 'RETRY' | 'VERIFY' | 'FINISH' | 'ESCALATE';

export type SupervisedRunStatus = 'running' | 'delivered' | 'failed' | 'interrupted';

/**
 * One bounded snapshot of a deliver run. Everything here is cheap to collect
 * and safe to hand to a classifier: no unbounded file contents, no secrets.
 *
 * Beyond the minimal contract (runId/status/elapsed/turns/failures/tail/git)
 * this carries three derived fields the PURE dimension functions need so
 * observation stays the only impure step: `instruction` (off-track keyword
 * matching), `minutesSinceUpdate` (stall detection), and `hasCheckpoint`
 * (verification-pending).
 */
export interface Observation {
  runId: string;
  status: SupervisedRunStatus;
  /** Mission instruction (already length-clamped by run-state on load). */
  instruction: string;
  /** Wall-clock minutes since the run was created. */
  elapsedMinutes: number;
  /** Minutes since the run state was last persisted (stall signal). */
  minutesSinceUpdate: number;
  /** Last completed loop turn (0 before the first checkpoint). */
  turnsCompleted: number;
  /** Turns recorded as not-passed in the checkpoint history. */
  failures: number;
  /** A loop checkpoint exists (the run has completed at least one turn). */
  hasCheckpoint: boolean;
  /** Tail of the newest matching deliver log, capped at 8KB. '' when absent. */
  recentLogTail: string;
  /** `git status --porcelain` line count; undefined when git is unavailable. */
  gitDirtyFiles?: number;
  /** `git diff --stat`, capped; undefined when git is unavailable. */
  diffStat?: string;
}

export interface DimensionAssessment {
  name: string;
  /** boolean for flag dimensions, 1-5 for score dimensions. */
  value: boolean | number;
  /** Estimated probability the assessment is correct (0-1). */
  probability: number;
  /** Confidence in THIS answer (0-1); low confidence defers to the heuristic. */
  confidence: number;
  /** True when the assessor abstains (insufficient evidence). */
  defer: boolean;
  source: 'heuristic' | 'classifier';
}

export interface Decision {
  action: SupervisorAction;
  reason: string;
  /** The dimension values and counters that fired, for the event ledger. */
  evidence: Record<string, unknown>;
}

/**
 * Reviewed policy thresholds (config/supervise-policy.json). Validated loudly
 * at load — a missing or out-of-range policy REFUSES to run rather than
 * silently supervising with invented numbers.
 */
export interface SupervisorConfig {
  version: 1;
  /** running + no state update for this long ⇒ progress-stalled. */
  stallMinutes: number;
  /** elapsed beyond this ⇒ STOP (mirrors the calibrated 120m deliver budget). */
  maxMinutes: number;
  /** turns beyond this ⇒ STOP. */
  maxTurns: number;
  /** RETRY budget before off-track/stuck escalates. */
  maxRetries: number;
  /** checkpoint failures at/above this ⇒ stuck-loop. */
  maxFailures: number;
  /** minimum gap between assessments (change-triggered). */
  debounceMs: number;
  /** maximum gap between assessments (periodic heartbeat). */
  intervalMs: number;
  /** classifier answers below this confidence are ignored (fail closed). */
  classifierConfidenceMin: number;
  /** escalation-risk answers below this probability are ignored. */
  classifierTau: number;
  /** VERIFY actions issued without test evidence before stuck-path takeover. */
  maxVerify: number;
}

/** State persisted per supervised run at .uap/supervise/<runId>/state.json. */
export interface SupervisorState {
  version: 1;
  runId: string;
  startedAt: string;
  updatedAt: string;
  /** Assessment cycles completed. */
  assessments: number;
  /** RETRY actions issued so far (drives the retry→escalate boundary). */
  retries: number;
  /** VERIFY actions issued since test evidence was last seen. */
  verifyCount: number;
  /** Consecutive suppressed ESCALATE repeats (bounded by the loop). */
  suppressedEscalations: number;
  /** Last action taken — the oscillation guard's memory. */
  lastAction: SupervisorAction | null;
  lastActionAt: string | null;
  lastDecision?: Decision;
}
