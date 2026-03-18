/**
 * Concurrency Pool Tests
 *
 * Unit tests for bounded-concurrency utilities.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { concurrentMap, concurrentMapSettled } from '../../src/utils/concurrency-pool.js';

describe('concurrentMap', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should return empty array for empty input', async () => {
    const result = await concurrentMap([], async (x: number) => x * 2);
    expect(result).toEqual([]);
  });

  it('should process items in order', async () => {
    const result = await concurrentMap([1, 2, 3], async (x) => x * 2);
    expect(result).toEqual([2, 4, 6]);
  });

  it('should respect maxConcurrent limit', async () => {
    let concurrentCount = 0;
    let maxObserved = 0;

    await concurrentMap(
      Array.from({ length: 10 }, (_, i) => i),
      async (x) => {
        concurrentCount++;
        maxObserved = Math.max(maxObserved, concurrentCount);
        await new Promise((resolve) => setTimeout(resolve, 10));
        concurrentCount--;
        return x * 2;
      },
      { maxConcurrent: 3 }
    );

    expect(maxObserved).toBeLessThanOrEqual(3);
  });

  it('should preserve result order regardless of completion order', async () => {
    const delays = [100, 10, 50, 5]; // Non-sorted delays

    const result = await concurrentMap(
      delays.map((d, i) => ({ index: i, delay: d })),
      async (item) => {
        await new Promise((resolve) => setTimeout(resolve, item.delay));
        return item.index;
      },
      { maxConcurrent: 2 }
    );

    // Results should be in input order [0, 1, 2, 3], not completion order
    expect(result).toEqual([0, 1, 2, 3]);
  });

  it('should handle errors without aborting other operations', async () => {
    const mockFn = vi.fn().mockRejectedValue(new Error('Expected error'));

    await expect(concurrentMap([1, 2, 3], mockFn)).rejects.toThrow('Expected error');

    // All items should be attempted
    expect(mockFn).toHaveBeenCalledTimes(3);
  });

  it('should work with async function that returns promises', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 200 });

    await concurrentMap([1, 2, 3], async (x) => {
      return fetchMock(x);
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('should use auto-detected concurrency when no limit specified', async () => {
    const mockFn = vi.fn().mockResolvedValue(42);

    await concurrentMap([1, 2, 3], mockFn);

    expect(mockFn).toHaveBeenCalledTimes(3);
  });
});

describe('concurrentMapSettled', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should return empty array for empty input', async () => {
    const result = await concurrentMapSettled([], async (x: number) => x * 2);
    expect(result).toEqual([]);
  });

  it('should settle all promises even when some fail', async () => {
    const results = await concurrentMapSettled([1, 2, 3, 4], async (x) => {
      if (x === 2 || x === 4) throw new Error(`Error on ${x}`);
      return x * 2;
    });

    expect(results).toHaveLength(4);
    expect(results[0]).toEqual({ status: 'fulfilled', value: 2 });
    expect(results[1].status).toBe('rejected');
    expect(results[2]).toEqual({ status: 'fulfilled', value: 6 });
    expect(results[3].status).toBe('rejected');
  });

  it('should preserve result order for settled promises', async () => {
    const results = await concurrentMapSettled([1, 2, 3], async (x) => {
      await new Promise((resolve) => setTimeout(resolve, x * 10));
      return x;
    });

    expect(results[0]).toEqual({ status: 'fulfilled', value: 1 });
    expect(results[1]).toEqual({ status: 'fulfilled', value: 2 });
    expect(results[2]).toEqual({ status: 'fulfilled', value: 3 });
  });

  it('should respect maxConcurrent limit', async () => {
    let concurrentCount = 0;
    let maxObserved = 0;

    await concurrentMapSettled(
      Array.from({ length: 10 }, (_, i) => i),
      async (x) => {
        concurrentCount++;
        maxObserved = Math.max(maxObserved, concurrentCount);
        await new Promise((resolve) => setTimeout(resolve, 10));
        concurrentCount--;
        return x;
      },
      { maxConcurrent: 2 }
    );

    expect(maxObserved).toBeLessThanOrEqual(2);
  });

  it('should handle mixed success and failure scenarios', async () => {
    const mockFn = vi.fn();

    mockFn
      .mockResolvedValueOnce('success1')
      .mockRejectedValueOnce(new Error('fail1'))
      .mockResolvedValueOnce('success2')
      .mockRejectedValueOnce(new Error('fail2'));

    const results = await concurrentMapSettled([1, 2, 3, 4], mockFn);

    expect(results).toHaveLength(4);
    expect(results[0]).toEqual({ status: 'fulfilled', value: 'success1' });
    expect(results[1].status).toBe('rejected');
    expect(results[2]).toEqual({ status: 'fulfilled', value: 'success2' });
    expect(results[3].status).toBe('rejected');
  });

  it('should capture error reasons correctly', async () => {
    const customError = new Error('Custom error message');

    const results = await concurrentMapSettled([1, 2], async (x) => {
      if (x === 1) throw customError;
      return x;
    });

    expect(results[0].status).toBe('rejected');
    expect((results[0] as any).reason).toBe(customError);
    expect(results[1]).toEqual({ status: 'fulfilled', value: 2 });
  });
});
