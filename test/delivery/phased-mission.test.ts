/**
 * Phased-mission runner (extracted from deliver.ts): the cursor-honoring
 * resume path — cursor persistence, checkpoint consumption, turn accounting,
 * summaries flowing into later phase prompts. Every seam faked.
 */

import { describe, it, expect } from 'vitest';
import { runPhasedMission, type PhasedMissionDeps } from '../../src/delivery/phased-mission.js';
import type { DeliveryResult } from '../../src/delivery/convergence-loop.js';
import type { DeliveryPhase } from '../../src/delivery/decompose.js';

const phase = (id: string): DeliveryPhase => ({ id, title: id, goal: `deliver ${id}` });

const ok = (over: Partial<DeliveryResult> = {}): DeliveryResult => ({
  success: true,
  alreadyDelivered: false,
  turns: 1,
  bestScore: 1,
  bestTurn: 1,
  history: [],
  finalFeedback: '',
  finalOutput: '',
  totalDurationMs: 1,
  ...over,
});

function baseDeps(over: Partial<PhasedMissionDeps>): PhasedMissionDeps {
  return {
    instruction: 'build the thing',
    phases: [phase('a'), phase('b')],
    startIndex: 0,
    initialSummaries: [],
    hasResumeCheckpoint: false,
    resumedTurns: 0,
    runPhaseLoop: async () => ok(),
    setPhaseSpec: () => undefined,
    persistCursor: () => undefined,
    persistCompleted: () => undefined,
    ...over,
  };
}

describe('runPhasedMission', () => {
  it('runs every phase in order, threading summaries into later prompts', async () => {
    const prompts: string[] = [];
    const cursors: number[] = [];
    const r = await runPhasedMission(
      baseDeps({
        phases: [phase('a'), phase('b'), phase('c')],
        runPhaseLoop: async ({ prompt }) => {
          prompts.push(prompt);
          return ok();
        },
        persistCursor: (i) => cursors.push(i),
      })
    );
    expect(r.success).toBe(true);
    expect(r.turns).toBe(3);
    expect(cursors).toEqual([0, 1, 2]);
    expect(prompts[0]).toContain('CURRENT PHASE 1/3');
    // phase 2 sees phase 1's completion summary
    expect(prompts[1]).toContain('a: deliver a');
    expect(prompts[2]).toContain('b: deliver b');
  });

  it('a failed phase stops the mission with the cursor persisted AT the failing phase', async () => {
    const cursors: number[] = [];
    let completedCalls = 0;
    const r = await runPhasedMission(
      baseDeps({
        phases: [phase('a'), phase('b'), phase('c')],
        runPhaseLoop: async ({ index }) => ok({ success: index !== 1 }),
        persistCursor: (i) => cursors.push(i),
        persistCompleted: () => completedCalls++,
      })
    );
    expect(r.success).toBe(false);
    expect(cursors).toEqual([0, 1]); // never advanced past the failure
    expect(completedCalls).toBe(1); // only phase a completed
  });

  it('RESUME: only the first loop resumes, and its checkpointed turns are not double-counted', async () => {
    const resumes: boolean[] = [];
    const r = await runPhasedMission(
      baseDeps({
        phases: [phase('a'), phase('b'), phase('c')],
        startIndex: 1,
        initialSummaries: ['a: deliver a (delivered in 2 turn(s))'],
        hasResumeCheckpoint: true,
        resumedTurns: 4,
        runPhaseLoop: async ({ prompt, index, resume }) => {
          resumes.push(resume);
          if (index === 1) expect(prompt).toContain('a: deliver a'); // resume summaries present
          return ok({ turns: index === 1 ? 6 : 1 }); // 6 total incl. 4 checkpointed
        },
      })
    );
    expect(resumes).toEqual([true, false]); // phases b (resumed) and c
    expect(r.turns).toBe(3); // (6 - 4 resumed) + 1
    expect(r.success).toBe(true);
  });

  it('sets the judge spec to each PHASE text, not the mission', async () => {
    const specs: string[] = [];
    await runPhasedMission(
      baseDeps({
        setPhaseSpec: (s) => specs.push(s),
      })
    );
    expect(specs).toHaveLength(2);
    expect(specs[0]).toContain('CURRENT PHASE 1/2');
    expect(specs[1]).toContain('CURRENT PHASE 2/2');
  });

  it('persists completed summaries (and the checkpoint clear) after each green phase', async () => {
    const persisted: string[][] = [];
    await runPhasedMission(
      baseDeps({
        persistCompleted: (s) => persisted.push(s),
      })
    );
    expect(persisted).toHaveLength(2);
    expect(persisted[0]).toHaveLength(1);
    expect(persisted[1]).toHaveLength(2);
  });
});
