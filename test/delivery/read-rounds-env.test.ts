import { describe, expect, it, afterEach } from 'vitest';
import { readRoundsEnv } from '../../src/delivery/agentic-executor.js';

const VAR = 'UAP_TEST_ROUNDS_ENV';

afterEach(() => {
  delete process.env[VAR];
});

describe('readRoundsEnv', () => {
  it('falls back when the variable is unset', () => {
    expect(readRoundsEnv(VAR, 3)).toBe(3);
  });

  it('reads a valid positive integer', () => {
    process.env[VAR] = '7';
    expect(readRoundsEnv(VAR, 3)).toBe(7);
  });

  it('tolerates surrounding whitespace', () => {
    process.env[VAR] = '  4  ';
    expect(readRoundsEnv(VAR, 3)).toBe(4);
  });

  // The rail these thresholds gate is what breaks a read-forever loop. A value
  // that coerced to 0 or NaN would make `roundsWithoutWrite >= threshold` true
  // immediately (0) or never (NaN) — disabling the rail or forcing every round.
  // Junk must degrade to the default, not to either of those.
  it.each([
    ['empty', ''],
    ['whitespace only', '   '],
    ['zero', '0'],
    ['negative', '-2'],
    ['fractional', '2.5'],
    ['non-numeric', 'lots'],
    ['NaN literal', 'NaN'],
    ['Infinity', 'Infinity'],
  ])('rejects %s and keeps the default', (_label, value) => {
    process.env[VAR] = value;
    expect(readRoundsEnv(VAR, 3)).toBe(3);
  });

  it('never returns a value below 1, so the rail cannot fire every round', () => {
    for (const v of ['0', '-1', '0.5']) {
      process.env[VAR] = v;
      expect(readRoundsEnv(VAR, 3)).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('shipped write-nudge threshold', () => {
  // Pins the tuning itself. Measured on the Octopus Invaders build: 281 reads
  // to 44 writes at the old threshold of 5, because roundsWithoutWrite resets
  // on every write and the steady state was "~6 reads, one forced write".
  // 4 tightens that while still allowing the "three reads then a write"
  // orientation pattern that the streak-reset test treats as productive — 3
  // would nudge it. If this assertion is ever changed, the ratio it was chosen
  // from should be re-measured rather than the number simply nudged again.
  const SHIPPED_DEFAULT = 4;

  it('is low enough to break a read-forever streak', () => {
    expect(SHIPPED_DEFAULT).toBeLessThan(5);
  });

  it('is high enough not to punish three reads before a write', () => {
    expect(SHIPPED_DEFAULT).toBeGreaterThan(3);
  });

  it('matches what the executor actually uses when unset', () => {
    delete process.env.UAP_DELIVER_WRITE_NUDGE_AFTER;
    expect(readRoundsEnv('UAP_DELIVER_WRITE_NUDGE_AFTER', SHIPPED_DEFAULT)).toBe(SHIPPED_DEFAULT);
  });
});
