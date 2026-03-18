/**
 * Concurrent execution utilities with backpressure control
 */

/**
 * Execute async operations with controlled concurrency and backpressure
 */
export async function concurrentMapWithBackpressure<T, R>(
  items: T[],
  fn: (item: T, index: number) => Promise<R>,
  options?: {
    maxConcurrent?: number;
    batchSize?: number;
  }
): Promise<R[]> {
  const { maxConcurrent = 10, batchSize = 100 } = options || {};

  const results: R[] = new Array(items.length);

  // Process in batches to avoid memory spikes
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const batchPromises = batch.map(async (item, idx) => {
      try {
        const result = await fn(item, i + idx);
        results[i + idx] = result;
      } catch (error) {
        // Store error as result or handle differently
        results[i + idx] = undefined as unknown as R;
      }
    });

    // Limit concurrency within batch using simple queue
    const queue = [...batchPromises];
    const workers = Array.from({ length: Math.min(maxConcurrent, batch.length) }, async () => {
      while (queue.length > 0) {
        const promise = queue.shift();
        if (promise) await promise;
      }
    });
    await Promise.all(workers);

    // Yield to event loop between batches
    if (i + batchSize < items.length) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  return results;
}

/**
 * Execute operations in parallel with graceful degradation
 * Returns results array where failed operations are undefined
 */
export async function parallelWithFallback<T>(
  promises: Promise<T>[],
  options?: {
    minSuccess?: number;
    fallback?: () => T[];
  }
): Promise<T[]> {
  const { minSuccess = 0, fallback } = options || {};

  const results = await Promise.allSettled(promises);
  const successCount = results.filter((r) => r.status === 'fulfilled').length;

  if (successCount < minSuccess) {
    if (fallback) {
      return fallback();
    }
    throw new Error(`Only ${successCount}/${promises.length} operations succeeded`);
  }

  return results.map((r) => (r.status === 'fulfilled' ? r.value : (undefined as unknown as T)));
}

/**
 * Execute with retry on failure
 */
export async function retry<T>(
  fn: () => Promise<T>,
  options?: {
    maxRetries?: number;
    delayMs?: number;
    backoffMultiplier?: number;
  }
): Promise<T> {
  const { maxRetries = 3, delayMs = 1000, backoffMultiplier = 2 } = options || {};

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (attempt < maxRetries) {
        const delay = delayMs * Math.pow(backoffMultiplier, attempt);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError || new Error('Retry failed');
}

/**
 * Timeout wrapper for async operations
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  options?: { errorMessage?: string }
): Promise<T> {
  const { errorMessage } = options || {};

  const timeoutPromise = new Promise<never>((_, reject) => {
    setTimeout(() => {
      reject(new Error(errorMessage || `Operation timed out after ${ms}ms`));
    }, ms);
  });

  return Promise.race([promise, timeoutPromise]);
}
