/**
 * finalRunStatus: the durable-status mapping for a finished delivery.
 *
 * The regression this pins: a cooperatively-stopped run must land
 * 'interrupted', with the stop threaded through from observation time. The
 * project-level STOP file is consumed the moment the stop latch observes it,
 * so a filesystem re-check at bookkeeping time returns false for exactly the
 * stopped runs — they landed 'failed' and followers relaunched checkpointed
 * work from scratch (2026-08-15, four stop/relaunch cycles in 30 minutes).
 */

import { describe, it, expect } from 'vitest';
import { finalRunStatus } from '../../src/delivery/run-state.js';

describe('finalRunStatus', () => {
  it('success is delivered regardless of stop signals', () => {
    expect(finalRunStatus(true, false, false)).toBe('delivered');
    expect(finalRunStatus(true, true, false)).toBe('delivered');
    expect(finalRunStatus(true, false, true)).toBe('delivered');
    expect(finalRunStatus(true, true, true)).toBe('delivered');
  });

  it('a stop observed during the run maps to interrupted even after the STOP file is gone', () => {
    // stopFilePresent=false is the consumed-file case that used to land 'failed'.
    expect(finalRunStatus(false, true, false)).toBe('interrupted');
  });

  it('a per-run STOP file still present at bookkeeping maps to interrupted', () => {
    expect(finalRunStatus(false, false, true)).toBe('interrupted');
  });

  it('no success and no stop is a plain failure', () => {
    expect(finalRunStatus(false, false, false)).toBe('failed');
  });
});
