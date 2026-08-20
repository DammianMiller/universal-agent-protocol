/**
 * A repeated follow used to return the full kill-loop briefing every time.
 *
 * That text is load-bearing the FIRST time — it is what stops a caller killing a
 * healthy run — and pure cost every time after, because the caller has already
 * read it and cannot act on it twice.
 *
 * Measured live (2026-08-20, opencode + qwen3.8-27b): 19 follows on one mission
 * returned ~23KB of near-identical prose, which drove 20 context compactions in
 * 80 minutes. The client then degenerated into empty completions and stopped
 * polling entirely, while the mission it had been watching carried on fine and
 * reached 4 of 7 epics unobserved. The briefing meant to keep a caller alive is
 * what killed it.
 */
import { describe, it, expect } from 'vitest';
import { progressDelta, RECOMMENDED_BACKOFF_SEC, FOLLOW_CLIENT_POLL_SEC } from '../../src/delivery/await-run.js';
import type { FollowProgress } from '../../src/delivery/await-run.js';

function progress(over: Partial<FollowProgress> = {}): FollowProgress {
  return { heartbeatAgeSec: 3, wedgeAfterSec: 600, health: 'active', ...over };
}

describe('progressDelta — what a repeat poll is actually asking', () => {
  it('reports a turn boundary crossed since the last poll', () => {
    expect(progressDelta({ turn: 2 }, progress({ turn: 3 }))).toBe('turn 2 → 3');
  });

  it('reports a phase boundary crossed since the last poll', () => {
    expect(progressDelta({ phase: '2/7' }, progress({ phase: '4/7' }))).toBe('phase 2/7 → 4/7');
  });

  it('reports both when both moved', () => {
    const d = progressDelta({ turn: 1, phase: '1/7' }, progress({ turn: 3, phase: '2/7' }));
    expect(d).toBe('turn 1 → 3, phase 1/7 → 2/7');
  });

  it('reports planning finishing — the stage that caused nine kills', () => {
    // "no turns, no phases" reads as "not started"; naming the phases the
    // planner produced is the fact that distinguishes slow from stuck.
    expect(progressDelta({}, progress({ phasesPlanned: 7 }))).toBe('planned 7 phases');
  });

  it('reports the first turn appearing after a turnless poll', () => {
    expect(progressDelta({}, progress({ turn: 1 }))).toBe('reached turn 1');
  });

  it('returns null when nothing a caller could act on moved', () => {
    // null is itself the answer to "is it stuck?" and the caller is told so
    // explicitly rather than being handed a repeat of the same sentence.
    expect(progressDelta({ turn: 3, phase: '2/7' }, progress({ turn: 3, phase: '2/7' }))).toBeNull();
  });

  it('never reports a turn counter going BACKWARDS as progress', () => {
    // A reclaimed/handed-over run can re-report a lower turn. That is not news.
    expect(progressDelta({ turn: 5 }, progress({ turn: 2 }))).toBeNull();
  });

  it('never reports a phase going BACKWARDS as progress', () => {
    // Same exposure as the turn counter above: a reclaimed or handed-over run
    // can re-report a lower phase, and that is a different mission answering,
    // not movement.
    expect(progressDelta({ phase: '4/7' }, progress({ phase: '2/7' }))).toBeNull();
  });

  it('reports a plan that GREW after an epic split', () => {
    // `!prev.phasesPlanned` alone reported only the first appearance and then
    // went quiet forever, so 3 → 7 was invisible.
    expect(progressDelta({ phasesPlanned: 3 }, progress({ phasesPlanned: 7 }))).toBe('planned 7 phases');
  });

  it('does NOT re-report an unchanged plan at an epic boundary', () => {
    // phasesPlanned is published only while no turn exists, and deliver clears
    // the checkpoint after every accepted epic — so the field oscillates
    // 7 → undefined → 7 and a naive check re-fired on a plan that never moved.
    // A previous poll that HAD a turn is what marks this as a boundary rather
    // than the planner finishing.
    expect(progressDelta({ turn: 4 }, progress({ phasesPlanned: 7 }))).toBeNull();
  });

  it('has no delta to report on a first poll', () => {
    expect(progressDelta(undefined, progress({ turn: 3 }))).toBeNull();
  });
});

describe('the poll cadence the caller is told to use', () => {
  it('asks for a gap longer than a single call may block', () => {
    // Otherwise the advice is "poll continuously", which is what already
    // happened: 19 follows in 36 minutes against 220-600s turns.
    expect(RECOMMENDED_BACKOFF_SEC).toBeGreaterThan(FOLLOW_CLIENT_POLL_SEC);
  });

  it('is at least as long as the fastest turn observed, so a poll can have news', () => {
    // Turn floor measured on the local model was ~220s.
    expect(RECOMMENDED_BACKOFF_SEC).toBeGreaterThanOrEqual(220);
  });
});
