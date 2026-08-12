/**
 * A cooperative stop must stop the RUN, not one epic of it.
 *
 * `isStopRequested` CONSUMES the project-level stop file the moment it sees
 * it — deliberately, so a file that outlived its run cannot silently stop
 * every future one. But `shouldStop` was wired straight to it, which makes the
 * signal one-shot: the convergence loop observes the stop and ends that epic,
 * the controller asks again before the NEXT epic, the file is gone, and the
 * run carries on.
 *
 * Measured 2026-08-12: a stop was requested, the log showed it consumed, and
 * the run started a fresh epic with its turn counter back at 1.
 *
 * Latching it keeps both properties: the file is still consumed on first
 * observation, and the stop still applies to everything after it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { makeStopLatch } from '../../src/delivery/run-state.js';

describe('makeStopLatch', () => {
  it('stays true once the underlying signal has fired once', () => {
    let reads = 0;
    // A one-shot source: true the first time, false forever after — exactly
    // what a consume-on-observe stop file does.
    const latch = makeStopLatch(() => ++reads === 1);
    expect(latch()).toBe(true);
    expect(latch(), 'the second epic must still see the stop').toBe(true);
    expect(latch()).toBe(true);
  });

  it('stops reading the source once latched', () => {
    let reads = 0;
    const latch = makeStopLatch(() => {
      reads++;
      return true;
    });
    latch();
    latch();
    latch();
    expect(reads, 'a latched stop needs no further filesystem probes').toBe(1);
  });

  it('keeps returning false while nothing has been requested', () => {
    const latch = makeStopLatch(() => false);
    expect(latch()).toBe(false);
    expect(latch()).toBe(false);
  });

  it('latches on a stop that arrives later, not just the first call', () => {
    let requested = false;
    const latch = makeStopLatch(() => requested);
    expect(latch()).toBe(false);
    requested = true;
    expect(latch()).toBe(true);
    requested = false; // consumed
    expect(latch(), 'and stays latched after the file is gone').toBe(true);
  });

  it('does not share state between runs', () => {
    const a = makeStopLatch(() => true);
    const b = makeStopLatch(() => false);
    expect(a()).toBe(true);
    expect(b(), 'one run stopping must not stop another').toBe(false);
  });
});

describe('both stop consumers share ONE latch', () => {
  /**
   * A source check, and deliberately so. The two wirings live ~300 lines apart
   * inside `runDeliver`, which takes a whole delivery to invoke, so there is no
   * runtime seam to assert against — and the property that matters is not "a
   * latch exists" but "nobody built a SECOND reader", which is a shape of the
   * code rather than a behaviour of it.
   *
   * This is a regression guard against a future refactor, not a boundary
   * against an adversary; a text scan would be the wrong tool for the latter.
   */
  it('deliver.ts never hands shouldStop a fresh isStopRequested closure', () => {
    const src = readFileSync(new URL('../../src/cli/deliver.ts', import.meta.url), 'utf8');
    const freshReader = /shouldStop\s*[:=]\s*(?:async\s*)?\(\s*\)\s*=>\s*isStopRequested/g;
    const offenders = src.match(freshReader) ?? [];
    expect(
      offenders,
      'the stop file is consumed on first read, so a second reader finds nothing and the next epic starts'
    ).toEqual([]);
  });

  it('and wires both consumers to the shared latch', () => {
    const src = readFileSync(new URL('../../src/cli/deliver.ts', import.meta.url), 'utf8');
    expect((src.match(/shouldStop\s*[:=]\s*stopLatch/g) ?? []).length, 'loop + epic controller').toBe(2);
    expect(src).toContain('makeStopLatch(');
  });
});
