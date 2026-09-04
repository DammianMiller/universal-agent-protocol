import { describe, it, expect } from 'vitest';
import {
  deliverCellTimeoutMs,
  DEFAULT_DELIVER_TIMEOUT_MULT,
} from '../../src/benchmarks/paired/adapter.js';

/**
 * The deliver adapter's cell budget was `agentTimeoutSec * 3`, calibrated on
 * fast hosted models. On a slow LOCAL model (27B, one GPU, minutes per model
 * call) a full convergence mission exceeds it and the harness kills the
 * mission mid-flight: paired-qwen38-e4 (2026-09-02) lost 21/25 treatment
 * cells to the cap, 15 of them with verify-passing workdirs — a manufactured
 * -8pp "regression" that was pure budget starvation.
 *
 * These tests pin the accommodation: a higher default multiplier, an env
 * override for unusually slow/fast stacks, and a fallback that can never
 * disable the cap (an unbounded cell is a wedged overnight run).
 */
describe('deliverCellTimeoutMs', () => {
  it('defaults to 6x the task agent timeout', () => {
    expect(deliverCellTimeoutMs(420, {})).toBe(420 * 1000 * 6);
    expect(DEFAULT_DELIVER_TIMEOUT_MULT).toBe(6);
  });

  it('honors UAP_BENCH_DELIVER_TIMEOUT_MULT for slower or faster stacks', () => {
    expect(
      deliverCellTimeoutMs(420, { UAP_BENCH_DELIVER_TIMEOUT_MULT: '12' }),
    ).toBe(420 * 1000 * 12);
    expect(
      deliverCellTimeoutMs(420, { UAP_BENCH_DELIVER_TIMEOUT_MULT: '1.5' }),
    ).toBe(420 * 1000 * 1.5);
  });

  it('falls back to the default on missing/invalid values — never unbounded', () => {
    for (const env of [
      {},
      { UAP_BENCH_DELIVER_TIMEOUT_MULT: '' },
      { UAP_BENCH_DELIVER_TIMEOUT_MULT: 'abc' },
      { UAP_BENCH_DELIVER_TIMEOUT_MULT: '0' },
      { UAP_BENCH_DELIVER_TIMEOUT_MULT: '-2' },
      { UAP_BENCH_DELIVER_TIMEOUT_MULT: 'Infinity' },
    ]) {
      expect(deliverCellTimeoutMs(420, env)).toBe(420 * 1000 * DEFAULT_DELIVER_TIMEOUT_MULT);
    }
  });
});
