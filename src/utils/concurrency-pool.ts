/**
 * Concurrency Pool
 *
 * Shared utility for bounded-concurrency parallel execution.
 * Replaces duplicated Promise.all batching patterns across the codebase.
 *
 * Uses getMaxParallel() for auto-detection with UAP_MAX_PARALLEL env override.
 */

import { getMaxParallel } from './system-resources.js';

/**
 * Map over items with bounded concurrency.
 *
 * Unlike Promise.all(items.map(fn)), this limits the number of
 * in-flight promises to prevent overwhelming local inference
 * endpoints or exhausting file descriptors.
 *
 * @param items - Array of items to process
 * @param fn - Async function to apply to each item
 * @param options - Concurrency options
 * @returns Results in the same order as input items
 *
 * @example
 * ```ts
 * // Auto-detect concurrency from vCPUs
 * const results = await concurrentMap(urls, url => fetch(url));
 *
 * // Explicit limit
 * const results = await concurrentMap(tasks, runTask, { maxConcurrent: 4 });
 *
 * // CPU-bound mode (reserves cores for OS)
 * const results = await concurrentMap(files, compress, { mode: 'cpu' });
 * ```
 */
export async function concurrentMap<T, R>(
  items: T[],
  fn: (item: T, index: number) => Promise<R>,
  options?: {
    /** Maximum concurrent operations. Overrides auto-detection. */
    maxConcurrent?: number;
    /** 'cpu' reserves cores for OS/inference, 'io' allows higher concurrency */
    mode?: 'cpu' | 'io';
  }
): Promise<R[]> {
  if (items.length === 0) return [];

  const max = options?.maxConcurrent ?? getMaxParallel(options?.mode ?? 'io');
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  const worker = async (): Promise<void> => {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      results[i] = await fn(items[i], i);
    }
  };

  const workerCount = Math.min(max, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return results;
}

/**
 * Map over items with bounded concurrency, settling all promises.
 *
 * Like concurrentMap but uses Promise.allSettled semantics --
 * failures don't abort other in-flight operations.
 *
 * @returns Array of PromiseSettledResult in input order
 */
export async function concurrentMapSettled<T, R>(
  items: T[],
  fn: (item: T, index: number) => Promise<R>,
  options?: {
    maxConcurrent?: number;
    mode?: 'cpu' | 'io';
  }
): Promise<PromiseSettledResult<R>[]> {
  if (items.length === 0) return [];

  const max = options?.maxConcurrent ?? getMaxParallel(options?.mode ?? 'io');
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let nextIndex = 0;

  const worker = async (): Promise<void> => {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      try {
        const value = await fn(items[i], i);
        results[i] = { status: 'fulfilled', value };
      } catch (reason) {
        results[i] = { status: 'rejected', reason };
      }
    }
  };

  const workerCount = Math.min(max, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return results;
}
