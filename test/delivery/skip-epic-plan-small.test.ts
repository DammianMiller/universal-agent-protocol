/**
 * A short mission is not multi-part, so it should not pay for a phase plan.
 *
 * `shouldDecompose` has always said so — "short complex tasks stay single-loop,
 * the decomposition overhead only pays off on genuinely multi-part missions" —
 * but epics are on by default for EVERY mission and the epic runner planned
 * unconditionally, so that rule only applied when epics were switched off.
 *
 * Measured in `cognition-engine` on 2026-08-11: 22 epic runs, 13 of them from
 * instructions under the existing 200-character threshold, each paying two to
 * three minutes of planning before any work. That planning time is what the
 * caller killed — nine times, at a median of 59 seconds.
 *
 * The instability is the tell. The same short instruction drew wildly different
 * plans on successive tries:
 *
 *   "Create …setup_optimizations.sql with 4 functions"  ( 74 chars) -> 0 phases
 *   "Create …setup_optimizations.sql with 4 functions…" (130 chars) -> 8 phases
 *   "Add pgrx bindings … to lib.rs"                     ( 68 chars) -> 5 phases
 *   "Add pgrx bindings … to lib.rs - these functions…"  (121 chars) -> 0 phases
 *
 * A plan that unstable for a one-file edit is not worth a model call.
 */
import { describe, it, expect } from 'vitest';
import {
  shouldPlanEpicPhases,
  shouldDecompose,
  resolveEpicPlan,
  singleEpicFor,
  AUTO_DECOMPOSE_MIN_CHARS,
} from '../../src/delivery/decompose.js';

/** Real instructions from the traced session, with their measured lengths. */
const SHORT = [
  'Add pgrx bindings for join_by_i_sql and join_by_i_time_sql to lib.rs',
  'Fix motivators.rs line 45: set a=0.0 instead of cloning candidate when single point',
  "In lib.rs line 134, add #[pg_extern] before 'fn join_by_i_time_sql'. The file compiles.",
];

describe('shouldPlanEpicPhases', () => {
  it('refuses to plan the short single-file edits that were being over-planned', () => {
    for (const i of SHORT) {
      expect(shouldPlanEpicPhases(i), `${i.length}ch: ${i}`).toBe(false);
    }
  });

  it('still plans a genuinely long, multi-part mission', () => {
    const long =
      'Update the Rust extension end to end: 1) src/lib.rs must restore all original ' +
      'pgrx entry points and register the new ones; 2) src/sql/setup.sql needs the ' +
      'wrapper functions and covering indexes added before the lateral joins are ' +
      'replaced; 3) rebuild and confirm cargo test passes with no new failures.';
    expect(long.length).toBeGreaterThan(AUTO_DECOMPOSE_MIN_CHARS);
    expect(shouldPlanEpicPhases(long)).toBe(true);
  });

  it('uses the SAME threshold as shouldDecompose, not a second one', () => {
    // Two thresholds for one question drift apart, so this compares the two
    // predicates directly rather than just restating the constant.
    for (const n of [1, AUTO_DECOMPOSE_MIN_CHARS - 1, AUTO_DECOMPOSE_MIN_CHARS, 400]) {
      const s = 'x'.repeat(n);
      expect(shouldPlanEpicPhases(s), `${n} chars`).toBe(shouldDecompose(s, 'complex'));
    }
  });

  it('asks about LENGTH only — the epic path has no complexity signal to gate on', () => {
    // Deliberate, and the narrower half of `shouldDecompose`: a long-but-simple
    // mission still gets planned on the epic path. Skipping those too is a
    // separate change with a separate risk, not a silent side effect of this one.
    const long = 'x'.repeat(AUTO_DECOMPOSE_MIN_CHARS);
    expect(shouldPlanEpicPhases(long)).toBe(true);
    expect(shouldDecompose(long, 'simple')).toBe(false);
  });

  it('measures the TRIMMED instruction — padding is not scope', () => {
    const padded = '   ' + 'x'.repeat(AUTO_DECOMPOSE_MIN_CHARS - 10) + '        \n';
    expect(padded.length).toBeGreaterThan(AUTO_DECOMPOSE_MIN_CHARS);
    expect(shouldPlanEpicPhases(padded)).toBe(false);
  });

  it('handles an empty instruction without planning', () => {
    expect(shouldPlanEpicPhases('')).toBe(false);
    expect(shouldPlanEpicPhases('   \n  ')).toBe(false);
  });
});

describe('resolveEpicPlan — the epic runner actually honours the predicate', () => {
  const PLANNED = [
    { id: 'p1', title: 'One', goal: 'a' },
    { id: 'p2', title: 'Two', goal: 'b' },
  ];

  it('does NOT call the planner for a short instruction', async () => {
    let planned = 0;
    const phases = await resolveEpicPlan('Add #[pg_extern] before fn join_by_i_time_sql', async () => {
      planned += 1;
      return PLANNED;
    });
    expect(planned, 'the planning call is the cost being avoided').toBe(0);
    expect(phases).toHaveLength(1);
    expect(phases[0]!.goal).toBe('Add #[pg_extern] before fn join_by_i_time_sql');
  });

  it('carries the instruction into the single epic verbatim — no goal is dropped', async () => {
    const instruction = "Fix motivators.rs line 45: set a=0.0 when there's one point";
    const [only] = await resolveEpicPlan(instruction, async () => PLANNED);
    expect(only!.goal).toBe(instruction);
  });

  it('emits the SAME shape as the runner\'s degenerate-plan fallback', () => {
    // A one-element plan does not satisfy epic-mission's `planned.length >= 2`,
    // so it lands in that fallback. If the two shapes ever diverge, the id the
    // ledger and resume state see silently changes — hence one definition, and
    // this test pins the fields that are load-bearing rather than merely truthy.
    const [only] = singleEpicFor('short mission');
    expect(only).toEqual({ id: 'mission', title: 'Mission', goal: 'short mission' });
  });

  it('announces the skip so the run does not read as silently un-planned', async () => {
    let told = 0;
    await resolveEpicPlan('short one', async () => PLANNED, () => { told += 1; });
    expect(told).toBe(1);
  });

  it('calls the planner — and only the planner — for a long instruction', async () => {
    let planned = 0;
    let told = 0;
    const phases = await resolveEpicPlan(
      'x'.repeat(AUTO_DECOMPOSE_MIN_CHARS),
      async () => { planned += 1; return PLANNED; },
      () => { told += 1; }
    );
    expect(planned).toBe(1);
    expect(told, 'no skip notice when nothing was skipped').toBe(0);
    expect(phases).toEqual(PLANNED);
  });

  it('lets a planner failure surface instead of silently degrading to one epic', async () => {
    // Swallowing this would turn a broken planner into a silent single-epic
    // run — the exact class of "it looked fine" failure being chased here.
    await expect(
      resolveEpicPlan('x'.repeat(AUTO_DECOMPOSE_MIN_CHARS), async () => {
        throw new Error('planner exploded');
      })
    ).rejects.toThrow('planner exploded');
  });
});

