/**
 * Heartbeat DURING model generation: the per-tool-call stamp goes silent for
 * the full length of one completion (5–15 min on a local model), and external
 * readers concluded "dead" from that silence — three clients tried to kill or
 * clear a healthy mid-generation run on 2026-08-15/16. The ticker is the
 * "still decoding" signal; these tests pin its interval resolution and
 * lifecycle deterministically (fake timers — no load-dependent margins).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  DEFAULT_GENERATION_HEARTBEAT_MS,
  generationHeartbeatMs,
  startGenerationTicker,
} from '../../src/delivery/heartbeat.js';

const savedEnv = process.env.UAP_GENERATION_HEARTBEAT_MS;

beforeEach(() => {
  delete process.env.UAP_GENERATION_HEARTBEAT_MS;
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env.UAP_GENERATION_HEARTBEAT_MS;
  else process.env.UAP_GENERATION_HEARTBEAT_MS = savedEnv;
  vi.useRealTimers();
});

describe('generationHeartbeatMs', () => {
  it('defaults to 30s and honours the env override', () => {
    expect(generationHeartbeatMs()).toBe(DEFAULT_GENERATION_HEARTBEAT_MS);
    process.env.UAP_GENERATION_HEARTBEAT_MS = '5000';
    expect(generationHeartbeatMs()).toBe(5000);
  });

  it('a non-positive override disables the ticker (returned as-is for the guard)', () => {
    process.env.UAP_GENERATION_HEARTBEAT_MS = '0';
    expect(generationHeartbeatMs()).toBe(0);
    process.env.UAP_GENERATION_HEARTBEAT_MS = '-5';
    expect(generationHeartbeatMs()).toBe(-5);
  });
});

describe('startGenerationTicker', () => {
  it('beats on every interval while running and stops cleanly', () => {
    vi.useFakeTimers();
    let beats = 0;
    const stop = startGenerationTicker(() => { beats++; }, 1000);
    vi.advanceTimersByTime(3500);
    expect(beats).toBe(3);
    stop();
    vi.advanceTimersByTime(5000);
    expect(beats).toBe(3); // no beats after stop
  });

  it('is a no-op for a non-positive interval', () => {
    vi.useFakeTimers();
    let beats = 0;
    const stop = startGenerationTicker(() => { beats++; }, 0);
    vi.advanceTimersByTime(5000);
    stop();
    expect(beats).toBe(0);
  });

  it('a throwing beat never escapes the ticker', () => {
    vi.useFakeTimers();
    let calls = 0;
    const stop = startGenerationTicker(() => {
      calls++;
      throw new Error('beat exploded');
    }, 1000);
    expect(() => vi.advanceTimersByTime(2500)).not.toThrow();
    expect(calls).toBe(2); // kept ticking after the throw
    stop();
  });
});
