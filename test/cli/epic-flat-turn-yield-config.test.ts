/**
 * The yield threshold, its operator override, and the ladder floor.
 *
 * The default (3) is measured, not chosen: replaying the rail's streak logic
 * over 157 deliver logs (51 attempts where it arms) gives
 * fires / turns-cut / in-attempt breakthroughs destroyed of 35/101/5 at K=2,
 * 32/67/3 at K=3, 30/35/2 at K=4. Moving 2 -> 3 gives up 34 turns of saving and
 * spares two attempts that went on to PASS from a flat run
 * (`migration-register-rel-record` [75,75,75,PASS], `contracts` [100,100,100,PASS]).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { epicFlatTurnYield, epicFlatTurnOption, EPIC_FLAT_TURN_YIELD } from '../../src/cli/deliver.js';

const saved = process.env.UAP_EPIC_FLAT_TURN_YIELD;
afterEach(() => {
  if (saved === undefined) delete process.env.UAP_EPIC_FLAT_TURN_YIELD;
  else process.env.UAP_EPIC_FLAT_TURN_YIELD = saved;
});

describe('epicFlatTurnYield', () => {
  it('defaults to three consecutive flat turns', () => {
    delete process.env.UAP_EPIC_FLAT_TURN_YIELD;
    expect(epicFlatTurnYield()).toBe(3);
    expect(EPIC_FLAT_TURN_YIELD).toBe(3);
  });

  it('treats a blank value as UNSET, not as zero', () => {
    // `Number('')` is 0, which would silently switch the rail OFF — the exact
    // inversion of "a typo must not disable it". An exported-but-empty variable
    // is a common accident.
    for (const raw of ['', '   ']) {
      process.env.UAP_EPIC_FLAT_TURN_YIELD = raw;
      expect(epicFlatTurnYield()).toBe(EPIC_FLAT_TURN_YIELD);
    }
  });

  it('cannot fire on turn 1 — the first score is always an improvement', () => {
    // The streak only starts once a high-water exists, so the smallest useful
    // threshold still lets turn 1 establish the baseline. Guards against a
    // future default of 0 quietly meaning "abort immediately".
    expect(epicFlatTurnYield()).toBeGreaterThanOrEqual(1);
  });

  it('honours an operator raising the threshold', () => {
    // Raising to 3 spends one more turn per attempt to catch a turn-4
    // breakthrough — which this sample never showed, but another might.
    process.env.UAP_EPIC_FLAT_TURN_YIELD = '4';
    expect(epicFlatTurnYield()).toBe(4);
  });

  it('treats zero and negatives as OFF, not as abort-immediately', () => {
    for (const raw of ['0', '-1']) {
      process.env.UAP_EPIC_FLAT_TURN_YIELD = raw;
      expect(epicFlatTurnYield()).toBeUndefined();
    }
  });

  it('floors a fractional value rather than passing it through', () => {
    process.env.UAP_EPIC_FLAT_TURN_YIELD = '4.9';
    expect(epicFlatTurnYield()).toBe(4);
  });

  it('falls back to the default when the value is not a number', () => {
    // A typo must not silently disable a rail that is reclaiming budget.
    process.env.UAP_EPIC_FLAT_TURN_YIELD = 'soon';
    expect(epicFlatTurnYield()).toBe(EPIC_FLAT_TURN_YIELD);
  });
});

describe('epicFlatTurnOption — the wiring, not just the threshold', () => {
  it('arms the rail while a retry remains', () => {
    delete process.env.UAP_EPIC_FLAT_TURN_YIELD;
    expect(epicFlatTurnOption(2)).toEqual({ abortOnFlatTurns: 3 });
    expect(epicFlatTurnOption(1)).toEqual({ abortOnFlatTurns: 3 });
  });

  it('never yields before the escalation ladder has played its last tier', () => {
    // The ladder is precisely "what this attempt has left to try". Cutting it is
    // not reclaiming waste, it is skipping the rescue: measured against the real
    // ladder, an attempt that delivers on turn 6 with a stronger model was
    // abandoned on turn 4 and the stronger model was never called.
    delete process.env.UAP_EPIC_FLAT_TURN_YIELD;
    // critic-only ladder (no stronger model) reaches turn 3 — the default already clears it.
    expect(epicFlatTurnOption(2, 3)).toEqual({ abortOnFlatTurns: 3 });
    // critic + model reaches turn 5, so the threshold rises to match.
    expect(epicFlatTurnOption(2, 5)).toEqual({ abortOnFlatTurns: 5 });
  });

  it('self-disables when the ladder needs the whole turn budget', () => {
    // Raising the threshold to the ladder's reach is self-correcting: on a
    // 5-turn attempt a limit of 5 can never be reached, so the rail simply
    // never fires rather than truncating the escalation.
    delete process.env.UAP_EPIC_FLAT_TURN_YIELD;
    const { abortOnFlatTurns } = epicFlatTurnOption(2, 5);
    expect(abortOnFlatTurns).toBeGreaterThanOrEqual(5);
  });

  it('is OFF on the last attempt — nowhere better to spend the turns', () => {
    // The whole safety argument. Ending an attempt early is an improvement only
    // while a fresh attempt is left to inherit the turns.
    delete process.env.UAP_EPIC_FLAT_TURN_YIELD;
    expect(epicFlatTurnOption(0)).toEqual({});
  });

  it('is OFF for a caller that supplies no retry count at all', () => {
    // Any future implementer of the runEpicLoop seam that ignores the optional
    // argument must get today's behaviour, not an armed rail.
    delete process.env.UAP_EPIC_FLAT_TURN_YIELD;
    expect(epicFlatTurnOption(undefined)).toEqual({});
  });

  it('stays off when the operator disabled the rail, even with retries left', () => {
    process.env.UAP_EPIC_FLAT_TURN_YIELD = '0';
    expect(epicFlatTurnOption(2)).toEqual({});
  });

  it('passes an operator-raised threshold through to the loop', () => {
    process.env.UAP_EPIC_FLAT_TURN_YIELD = '6';
    expect(epicFlatTurnOption(2)).toEqual({ abortOnFlatTurns: 6 });
  });

  it('never returns the key at all when off, so a spread is a no-op', () => {
    // `{...epicFlatTurnOption(0)}` must not plant `abortOnFlatTurns: undefined`
    // into the loop config — an explicit undefined reads differently from absent
    // to anything doing `'abortOnFlatTurns' in config`.
    delete process.env.UAP_EPIC_FLAT_TURN_YIELD;
    expect(Object.keys(epicFlatTurnOption(0))).toHaveLength(0);
    expect('abortOnFlatTurns' in epicFlatTurnOption(0)).toBe(false);
  });
});
