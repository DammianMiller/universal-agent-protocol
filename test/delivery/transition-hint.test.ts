import { describe, expect, it } from 'vitest';
import { selectTransitionHint } from '../../src/delivery/user-validation.js';
import type { PathResult } from '../../src/delivery/user-validation.js';

/** A journey that clicks, then fails asserting an element became visible. */
function deadInteraction(id: string): PathResult {
  return {
    id,
    rule: `Verify ${id}`,
    client: 'browser',
    status: 'fail',
    steps: [
      { step: 'goto:/', ok: true, observed: 'HTTP 200' },
      { step: 'click:#startBtn', ok: true, observed: 'clicked #startBtn' },
      { step: 'expect_visible:#hud', ok: false, observed: 'NOT visible' },
    ],
    screenshots: [],
  };
}

/** A journey that fails BEFORE any interaction — e.g. the page never loaded. */
function failsBeforeInteraction(id: string): PathResult {
  return {
    id,
    rule: `Verify ${id}`,
    client: 'browser',
    status: 'fail',
    steps: [
      { step: 'goto:/', ok: true, observed: 'HTTP 200' },
      { step: 'expect_visible:#gameCanvas', ok: false, observed: 'NOT visible' },
    ],
    screenshots: [],
  };
}

/** A journey failing on something other than visibility. */
function failsOnText(id: string): PathResult {
  return {
    id,
    rule: `Verify ${id}`,
    client: 'browser',
    status: 'fail',
    steps: [
      { step: 'goto:/', ok: true, observed: 'HTTP 200' },
      { step: 'click:#startBtn', ok: true, observed: 'clicked #startBtn' },
      { step: 'expect_text:#score', ok: false, observed: 'got "" expected "SCORE"' },
    ],
    screenshots: [],
  };
}

const ENTRYPOINT_HINT = /ONE missing entry point/;
const HANDLER_HINT = /handler .*MUST reveal it/;

describe('selectTransitionHint', () => {
  it('is silent when nothing failed', () => {
    expect(selectTransitionHint([])).toBe('');
  });

  it('is silent when the failure precedes any interaction', () => {
    // Nothing was clicked, so "your handler did not reveal it" would be wrong
    // advice — the page itself is broken.
    expect(selectTransitionHint([failsBeforeInteraction('load')])).toBe('');
  });

  it('is silent when the failure is not about visibility', () => {
    expect(selectTransitionHint([failsOnText('hud')])).toBe('');
  });

  it('blames the handler when only ONE journey is dead', () => {
    // One broken handler is the parsimonious explanation for one failure.
    const out = selectTransitionHint([deadInteraction('load_and_start')]);
    expect(out).toMatch(HANDLER_HINT);
    expect(out).not.toMatch(ENTRYPOINT_HINT);
  });

  it('blames the ENTRY POINT when every interactive journey is dead', () => {
    // The run-C signature: load_and_start, gameplay_hud and pause_resume all
    // failed identically because nothing called Game.init(), so no handler was
    // ever attached. Three broken handlers is the unlikely explanation.
    const out = selectTransitionHint([
      deadInteraction('load_and_start'),
      deadInteraction('gameplay_hud'),
      deadInteraction('pause_resume'),
    ]);
    expect(out).toMatch(ENTRYPOINT_HINT);
    expect(out).toMatch(/init\/start function at top level/);
    expect(out).not.toMatch(HANDLER_HINT);
  });

  it('needs at least two dead journeys before claiming a common cause', () => {
    // Two is the floor: a single failure is not evidence of a shared root, and
    // wrongly sending the model hunting for an entry point that exists wastes a
    // turn as surely as the symptom-only message did.
    const out = selectTransitionHint([deadInteraction('only_one')]);
    expect(out).not.toMatch(ENTRYPOINT_HINT);
  });

  it('does not claim a common cause when some journeys failed for other reasons', () => {
    // A mixed failure set means the interactions are not uniformly dead, so the
    // entry point is not the single explanation.
    const out = selectTransitionHint([
      deadInteraction('load_and_start'),
      deadInteraction('gameplay_hud'),
      failsBeforeInteraction('canvas_missing'),
    ]);
    expect(out).toMatch(HANDLER_HINT);
    expect(out).not.toMatch(ENTRYPOINT_HINT);
  });

  it('does not claim a common cause when one failure is a different KIND', () => {
    // The reviewer's finding: the old condition counted "interactive" failures,
    // not "interactive AND not-visible" ones. Two interactive failures where
    // one is a genuine console error would assert "EVERY journey failed the
    // same way" and steer the model away from a real, reported error.
    const out = selectTransitionHint([
      deadInteraction('load_and_start'),
      failsOnText('gameplay_hud'),
    ]);
    expect(out).not.toMatch(ENTRYPOINT_HINT);
  });

  it('a failing cli path does not suppress the browser diagnosis', () => {
    // A cli/http failure says nothing about browser bootstrap.
    const cli: PathResult = {
      id: 'build', rule: 'builds', client: 'cli', status: 'fail',
      steps: [{ step: 'run:build', ok: false, observed: 'exit 1' }], screenshots: [],
    };
    const out = selectTransitionHint([deadInteraction('a'), deadInteraction('b'), cli]);
    expect(out).toMatch(ENTRYPOINT_HINT);
  });

  it('the entry-point hint tells the model what to check BEFORE rewriting elements', () => {
    // The failure this fixes was four turns of rewriting HUD markup. The
    // ordering instruction is the load-bearing part of the message.
    const out = selectTransitionHint([deadInteraction('a'), deadInteraction('b')]);
    expect(out).toMatch(/BEFORE\s+rewriting the elements/);
  });
});
