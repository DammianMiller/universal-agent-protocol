import { describe, expect, it } from 'vitest';
import { resolveKeepBest } from '../../src/cli/deliver.js';

/**
 * Never-regress used to be opt-in, and three measured Octopus Invaders runs
 * paid for that default: one reached a fully working, playable game at turn 2,
 * then a later turn fixed an unrelated TypeError and in the same whole-file
 * rewrite deleted the line that started the program. The peak-snapshot
 * machinery (captureBestKeep) existed the whole time but is armed only by this
 * flag, so it never ran and the working artifact was lost.
 */
describe('resolveKeepBest', () => {
  it('is ON when the flag was not passed', () => {
    // `undefined` means "not specified", which is the case that used to lose
    // working artifacts. This is the assertion the whole change exists for.
    expect(resolveKeepBest(undefined, {})).toBe(true);
  });

  it('is ON when explicitly requested', () => {
    expect(resolveKeepBest(true, {})).toBe(true);
  });

  it('is OFF for --no-keep-best', () => {
    // commander sets keepBest=false for --no-keep-best.
    expect(resolveKeepBest(false, {})).toBe(false);
  });

  it('is OFF for UAP_DELIVER_KEEP_BEST=0', () => {
    expect(resolveKeepBest(undefined, { UAP_DELIVER_KEEP_BEST: '0' })).toBe(false);
  });

  it('an explicit flag still loses to the env kill-switch', () => {
    // The env var is the operator's out-of-band switch; a wrapper script that
    // always passes --keep-best must not defeat it.
    expect(resolveKeepBest(true, { UAP_DELIVER_KEEP_BEST: '0' })).toBe(false);
  });

  it('only "0" disables via env — not any truthy-looking value', () => {
    // A half-matched value silently disabling never-regress is the failure mode
    // this change is fixing, so the kill-switch must be exact.
    for (const v of ['1', 'off', 'false', 'no', '', ' ', 'yes']) {
      expect(resolveKeepBest(undefined, { UAP_DELIVER_KEEP_BEST: v })).toBe(true);
    }
  });
});
