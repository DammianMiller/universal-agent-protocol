/**
 * The planner must assign every required file exactly one owner, and order
 * phases by what they import.
 *
 * Two failures the phase-SIZING rules cannot prevent, because they are about
 * the relationships between phases rather than the size of any one:
 *
 *  - A file no phase claims is never written. Observed on a canvas-game epic
 *    run that stalled at 10 of 11 files: the entry module `js/game.js` was
 *    named by the mission and owned by nobody, so every phase passed its own
 *    criteria and the deliverable never ran.
 *  - A file TWO phases claim is written twice, the second overwriting the
 *    first — the same defect from the other side.
 *
 * These rules are deliberately orthogonal to phase sizing. The budget hint
 * argues for MORE and SMALLER phases; ownership holds at any phase count, and
 * this suite pins that the two coexist rather than one having replaced the
 * other (an earlier attempt at this change bundled a contrary
 * "prefer FEWER, LARGER phases" instruction, which would have reversed it).
 */
import { describe, it, expect } from 'vitest';
import { planDeliveryPhases } from '../../src/delivery/decompose.js';

/**
 * Capture the DECOMPOSE prompt.
 *
 * The executor is called more than once — the plan-check validator runs after
 * the planner — so this keeps the FIRST prompt. Taking the last one silently
 * asserts against the validator's prompt instead, which is how the first draft
 * of this suite "failed" against a correct implementation.
 */
async function capturePrompt(opts?: Parameters<typeof planDeliveryPhases>[3]): Promise<string> {
  const prompts: string[] = [];
  await planDeliveryPhases(
    'build a canvas game with an entry module and three sibling render modules',
    async (prompt: string) => {
      prompts.push(prompt);
      return JSON.stringify([
        { id: 'a', title: 'A', goal: 'ga' },
        { id: 'b', title: 'B', goal: 'gb', deps: ['a'] },
      ]);
    },
    undefined,
    opts
  );
  return prompts[0] ?? '';
}

describe('decompose prompt: file ownership', () => {
  it('requires exactly one CREATOR per file', async () => {
    const p = await capturePrompt();
    expect(p).toMatch(/FILE OWNERSHIP/);
    expect(p).toMatch(/EXACTLY ONE phase/);
  });

  it('names both failure directions — unowned and double-owned', async () => {
    const p = await capturePrompt();
    // Two phases creating one file: the overwrite.
    expect(p).toMatch(/never create the same file/i);
    // No phase creating it: the silent omission that stalled the measured run.
    expect(p).toMatch(/never delivered/i);
  });

  it('exempts the scaffold/fill pair, which is one owner across two phases', async () => {
    // Without this the rule contradicts SCAFFOLD THEN FILL, and a planner
    // obeying both would refuse to let the fill phase touch its own file.
    const p = await capturePrompt();
    expect(p).toMatch(/SCAFFOLD phase creating a file and its/);
    expect(p).toMatch(/ONE owner across the pair/);
  });

  it('stops a contracts phase from claiming another module\'s file', async () => {
    const p = await capturePrompt();
    expect(p).toMatch(/contracts\/types phase owns only the shared type file/);
  });
});

describe('decompose prompt: dependency ordering', () => {
  it('requires a phase to declare deps on the files it imports', async () => {
    const p = await capturePrompt();
    expect(p).toMatch(/DEPENDENCY ORDERING/);
    expect(p).toMatch(/MUST name the other/);
  });

  it('calls out the entry point specifically', async () => {
    // The measured failure was an entry module that linked everything and
    // declared no deps, so it ran before its siblings existed.
    const p = await capturePrompt();
    expect(p).toMatch(/entry-point phase therefore depends on every module/);
  });
});

describe('ownership does not disturb phase sizing', () => {
  it('leaves the MORE-and-SMALLER budget guidance intact', async () => {
    // Ownership is orthogonal to phase count. A previous attempt at this change
    // shipped a contrary "prefer FEWER, LARGER phases" line; this pins that the
    // shipped guidance still argues the other way.
    const p = await capturePrompt({ sessionTokenBudget: 100_000 });
    expect(p).toMatch(/prefer MORE, SMALLER phases/);
    expect(p).not.toMatch(/PREFER FEWER, LARGER PHASES/);
  });

  it('still emits ownership when no context budget is configured', async () => {
    // budgetHint is conditional on sessionTokenBudget; ownership must not be.
    const p = await capturePrompt();
    expect(p).not.toMatch(/CONTEXT LIMIT/);
    expect(p).toMatch(/FILE OWNERSHIP/);
  });
});
