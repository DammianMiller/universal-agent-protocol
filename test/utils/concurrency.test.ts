import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  parallelWithFallback,
  retry,
  withTimeout,
} from '../../src/utils/concurrency.js';

describe('Concurrency Utilities', () => {
  // concurrentMapWithBackpressure tests removed — function was removed in sweep 3

  describe('parallelWithFallback', () => {
    it('should resolve all promises successfully', async () => {
      const promises = [Promise.resolve(1), Promise.resolve(2), Promise.resolve(3)];
      const result = await parallelWithFallback(promises);
      expect(result).toEqual([1, 2, 3]);
    });

    it('should handle mixed success and failure', async () => {
      const promises = [
        Promise.resolve(1),
        Promise.reject(new Error('Failed')),
        Promise.resolve(3),
      ];
      const result = await parallelWithFallback(promises, { minSuccess: 2 });
      expect(result).toHaveLength(3);
      expect(result[0]).toBe(1);
      expect(result[1]).toBeUndefined();
      expect(result[2]).toBe(3);
    });

    it('should throw when not enough successes', async () => {
      const promises = [
        Promise.reject(new Error('Failed 1')),
        Promise.reject(new Error('Failed 2')),
      ];
      await expect(parallelWithFallback(promises, { minSuccess: 1 })).rejects.toThrow(
        'Only 0/2 operations succeeded'
      );
    });

    it('should use fallback when not enough successes', async () => {
      const promises = [Promise.reject(new Error('Failed')), Promise.reject(new Error('Failed'))];
      const result = await parallelWithFallback(promises, {
        minSuccess: 1,
        fallback: () => [0, 0],
      });
      expect(result).toEqual([0, 0]);
    });

    it('should handle empty array', async () => {
      const result = await parallelWithFallback([]);
      expect(result).toEqual([]);
    });

    it('should work with promises that resolve after delays', async () => {
      const promises = [
        new Promise((resolve) => setTimeout(() => resolve('a'), 100)),
        new Promise((resolve) => setTimeout(() => resolve('b'), 50)),
        new Promise((resolve) => setTimeout(() => resolve('c'), 150)),
      ];
      const result = await parallelWithFallback(promises);
      expect(result).toEqual(['a', 'b', 'c']);
    });
  });

  describe('retry', () => {
    it('should succeed on first attempt', async () => {
      let attempts = 0;
      const result = await retry(async () => {
        attempts++;
        return 'success';
      });
      expect(result).toBe('success');
      expect(attempts).toBe(1);
    });

    it('should retry on failure and succeed', async () => {
      let attempts = 0;
      const result = await retry(
        async () => {
          attempts++;
          if (attempts < 3) throw new Error('Not yet');
          return 'success';
        },
        { maxRetries: 5, delayMs: 10 }
      );
      expect(result).toBe('success');
      expect(attempts).toBe(3);
    });

    it('should throw after all retries exhausted', async () => {
      let attempts = 0;
      await expect(
        retry(
          async () => {
            attempts++;
            throw new Error('Always fails');
          },
          { maxRetries: 3, delayMs: 10 }
        )
      ).rejects.toThrow();
      expect(attempts).toBe(4); // Initial + 3 retries
    });

    it('should use exponential backoff', async () => {
      const timestamps: number[] = [];
      await expect(
        retry(
          async () => {
            timestamps.push(Date.now());
            throw new Error('Fail');
          },
          { maxRetries: 3, delayMs: 50, backoffMultiplier: 2 }
        )
      ).rejects.toThrow();

      // Check that delays increased (exponential backoff)
      const delays = [
        timestamps[1] - timestamps[0],
        timestamps[2] - timestamps[1],
        timestamps[3] - timestamps[2],
      ];
      expect(delays[1]).toBeGreaterThan(delays[0]);
      expect(delays[2]).toBeGreaterThan(delays[1]);
    });

    it('should handle custom error messages', async () => {
      await expect(
        retry(
          async () => {
            throw new Error('Custom error');
          },
          { maxRetries: 1, delayMs: 10 }
        )
      ).rejects.toThrow('Custom error');
    });

    it('should succeed without retry when first attempt works', async () => {
      let attempts = 0;
      await expect(
        retry(
          async () => {
            attempts++;
            return 'immediate success';
          },
          { maxRetries: 3, delayMs: 100 }
        )
      ).resolves.toBe('immediate success');
      expect(attempts).toBe(1);
    });
  });

  describe('withTimeout', () => {
    it('should resolve when operation completes within timeout', async () => {
      const result = await withTimeout(
        new Promise((resolve) => setTimeout(() => resolve('done'), 50)),
        100
      );
      expect(result).toBe('done');
    });

    it('should reject when operation exceeds timeout', async () => {
      await expect(
        withTimeout(new Promise((resolve) => setTimeout(() => resolve('late'), 200)), 50)
      ).rejects.toThrow('timed out');
    });

    it('should use custom error message', async () => {
      await expect(
        withTimeout(new Promise((resolve) => setTimeout(() => resolve('late'), 200)), 50, {
          errorMessage: 'Custom timeout error',
        })
      ).rejects.toThrow('Custom timeout error');
    });

    it('should work with immediate promises', async () => {
      const result = await withTimeout(Promise.resolve('immediate'), 100);
      expect(result).toBe('immediate');
    });

    it('should reject immediately if timeout is 0', async () => {
      await expect(withTimeout(new Promise(() => {}), 0)).rejects.toThrow('timed out');
    });

    it('should handle errors from the promise itself', async () => {
      await expect(withTimeout(Promise.reject(new Error('Promise error')), 100)).rejects.toThrow(
        'Promise error'
      );
    });
  });
});
