/**
 * Mission ledger types — the durable goal layer above deliver runs.
 *
 * A mission is a user-level goal with FROZEN acceptance criteria (the
 * statement-immutability analog): the hash is taken at creation and every
 * later change is an explicit, recorded replan. Missions link to durable
 * deliver runs and survive reboots, crashes, and session boundaries — the
 * orchestrator daemon polls this ledger to keep incomplete missions moving
 * until their acceptance criteria are verified met.
 */

export type MissionStatus = 'active' | 'paused' | 'delivered' | 'failed';

/** What one launch/execution attempt of (part of) a mission ended as. */
export type MissionAttemptOutcome = 'launched' | 'delivered' | 'failed' | 'interrupted';

export type SalvageStatus = 'proposed' | 'approved' | 'rejected';

export interface Mission {
  id: number;
  goal: string;
  /** Acceptance criteria text, frozen at creation (see acceptanceHash). */
  acceptance: string;
  /** sha256 of the trimmed acceptance text at freeze time. */
  acceptanceHash: string;
  status: MissionStatus;
  /** Model preset the mission's runs should use (optional). */
  presetId?: string;
  /** Durable deliver run most recently attached to this mission. */
  latestRunId?: string;
  /** Total launches (fresh + resume). Drives the relaunch backoff. */
  launchCount: number;
  /** Resume launches after an interruption. Drives the relaunch backoff. */
  relaunchCount: number;
  /** ISO time of the last launch — the backoff's anchor. */
  lastLaunchAt?: string;
  /** pid of the launch we spawned — the provenance anchor for run linkage. */
  launchPid?: number;
  createdAt: string;
  updatedAt: string;
}

export interface MissionAttempt {
  id: number;
  missionId: number;
  /** Deliver run id this attempt executed (absent for a whole-mission note). */
  runId?: string;
  /** Epic/phase/task ref the attempt targeted (absent = the whole run). */
  taskRef?: string;
  outcome: MissionAttemptOutcome;
  /** One-line harness-owned summary (what happened / what remains). */
  summary?: string;
  /**
   * What this observation saw (run.updatedAt / exit.at). Dedupes identical
   * RE-observations while letting genuinely new failures of the same run
   * accumulate into the struggle metric.
   */
  observedAt?: string;
  createdAt: string;
}

/**
 * Choir-style salvage: a failed attempt's residue — what it learned, what
 * partial work exists — seeded as a follow-up. Proposals are APPROVAL-GATED:
 * nothing is scheduled until a human or the overseer approves.
 */
export interface SalvageProposal {
  id: number;
  missionId: number;
  fromAttemptId?: number;
  taskRef?: string;
  proposal: string;
  status: SalvageStatus;
  createdAt: string;
  decidedAt?: string;
}

/** An explicit supersede of a mission's frozen acceptance criteria. */
export interface AcceptanceRevision {
  id: number;
  missionId: number;
  priorAcceptance: string;
  priorHash: string;
  reason: string;
  createdAt: string;
}
