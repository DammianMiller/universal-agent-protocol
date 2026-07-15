/**
 * Phased Mission — the sequential phase runner extracted from deliver.ts
 * behind seams (the last runner-sized closure after the orchestrated-,
 * epic-, and watch-ci extractions).
 *
 * Why it exists at all: this is the ONLY runner that honors the resume
 * cursor (`startIndex` + a checkpoint consumed by the first loop), so every
 * `--resume` lands here, and it is the fallback when orchestration is
 * explicitly disabled. Each phase runs its own convergence loop against the
 * same gates; later phases see one-line summaries of what earlier phases
 * built. A failed phase stops the mission with the cursor persisted for the
 * next resume.
 */

import type { DeliveryResult } from './convergence-loop.js';
import type { DeliveryPhase } from './decompose.js';
import { phaseInstruction } from './decompose.js';
import { foldDeliveryResult } from './delivery-result.js';
import type { DeliveryTaskHandle } from './task-sync.js';

export interface PhasedMissionDeps {
  /** The overall mission text (each phase prompt embeds it as context). */
  instruction: string;
  /** The full phase plan (execution starts at `startIndex`). */
  phases: DeliveryPhase[];
  /** Resume cursor: first phase to run (0 for a fresh mission). */
  startIndex: number;
  /** Summaries of phases completed BEFORE this run (resume state). */
  initialSummaries: string[];
  /** True when a loop checkpoint exists: the FIRST loop resumes from it and
   * its already-counted turns are subtracted from the aggregate. */
  hasResumeCheckpoint: boolean;
  /** Turns already recorded inside the resume checkpoint (subtracted once). */
  resumedTurns: number;
  /** Run one phase's convergence loop. `resume` is true only for the first
   * loop of a resumed mission — the caller binds the checkpoint (and the
   * re-escalated executor) to exactly that loop. */
  runPhaseLoop: (args: { prompt: string; index: number; resume: boolean }) => Promise<DeliveryResult>;
  /** Point the judge at THIS phase's goal and reset breaker evidence —
   * judging phase 1 against the full mission would fail by construction. */
  setPhaseSpec: (spec: string) => void;
  /** Delivery-task records (fail-soft; both optional). */
  openTask?: (title: string) => Promise<DeliveryTaskHandle | null>;
  completeTask?: (record: DeliveryTaskHandle | null, result: DeliveryResult) => void;
  /** Persist the cursor BEFORE a phase runs (what --resume restarts at). */
  persistCursor: (index: number) => void;
  /** Persist the completed-phase summaries AND clear the consumed checkpoint
   * after a phase lands (the checkpoint belongs to the finished phase). */
  persistCompleted: (summaries: string[]) => void;
  /** Progress lines (the caller decorates with chalk). */
  note?: (line: string) => void;
}

/** Run the phases sequentially from the cursor; returns the mission result. */
export async function runPhasedMission(deps: PhasedMissionDeps): Promise<DeliveryResult> {
  const note = deps.note ?? ((): void => undefined);
  const all: DeliveryResult = {
    success: true, alreadyDelivered: false, turns: 0, bestScore: 0, bestTurn: 0,
    history: [], finalFeedback: '', finalOutput: '', totalDurationMs: 0,
  };
  const summaries = [...deps.initialSummaries];

  for (let index = deps.startIndex; index < deps.phases.length; index++) {
    deps.persistCursor(index);
    const phase = deps.phases[index];
    note(`▶ phase ${index + 1}/${deps.phases.length}: ${phase.title}`);
    const phaseTask = (await deps.openTask?.(`${phase.title} — ${phase.goal.slice(0, 120)}`)) ?? null;
    const resume = deps.hasResumeCheckpoint && index === deps.startIndex;
    const phaseText = phaseInstruction(deps.instruction, deps.phases, index, summaries);
    // The acceptance judge grades THIS phase's goal, not the whole mission.
    deps.setPhaseSpec(phaseText);
    const phaseResult = await deps.runPhaseLoop({ prompt: phaseText, index, resume });
    foldDeliveryResult(all, phaseResult);
    if (resume) {
      // The checkpoint's turns were spent by the interrupted run — count
      // only this session's new turns toward the aggregate.
      all.turns -= deps.resumedTurns;
    }
    deps.completeTask?.(phaseTask, phaseResult);
    if (!phaseResult.success) {
      all.success = false;
      break;
    }
    summaries.push(`${phase.title}: ${phase.goal.slice(0, 140)} (delivered in ${phaseResult.turns} turn(s))`);
    deps.persistCompleted([...summaries]);
  }
  return all;
}
