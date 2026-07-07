/**
 * Performance monitoring utilities for measuring and analyzing operation metrics
 */

export interface PerformanceMetrics {
  avg: number;
  p50: number;
  p95: number;
  p99: number;
  min: number;
  max: number;
  count: number;
}

/**
 * Compute latency percentiles from a set of duration samples. Shared by the
 * in-memory PerformanceMonitor and the persisted telemetry store so both
 * surface identical statistics regardless of which process produced the data.
 * Returns null for an empty sample set.
 */
export function computePercentiles(samples: number[]): PerformanceMetrics | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const count = sorted.length;
  return {
    avg: sorted.reduce((a, b) => a + b, 0) / count,
    p50: sorted[Math.floor(count * 0.5)] ?? 0,
    p95: sorted[Math.floor(count * 0.95)] ?? 0,
    p99: sorted[Math.floor(count * 0.99)] ?? 0,
    min: sorted[0] ?? 0,
    max: sorted[count - 1] ?? 0,
    count,
  };
}

/**
 * Monitor performance of operations with percentile tracking
 */
export class PerformanceMonitor {
  private metrics: Map<string, number[]> = new Map();
  private readonly maxSamples: number;

  constructor(options?: { maxSamples?: number }) {
    this.maxSamples = options?.maxSamples ?? 1000;
  }

  /**
   * Measure and record duration of an async operation
   */
  async measure<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const start = performance.now();
    try {
      return await fn();
    } finally {
      const duration = performance.now() - start;
      this.record(name, duration);
    }
  }

  /**
   * Record a metric directly
   */
  record(metric: string, duration: number): void {
    const entries = this.metrics.get(metric) || [];

    entries.push(duration);

    // Keep last N samples
    if (entries.length > this.maxSamples) {
      entries.shift();
    }

    this.metrics.set(metric, entries);
  }

  /**
   * Get statistics for a metric
   */
  getStats(metric: string): PerformanceMetrics | null {
    return computePercentiles(this.metrics.get(metric) ?? []);
  }

  /**
   * Get all metric names
   */
  getMetrics(): string[] {
    return [...this.metrics.keys()];
  }

  /**
   * Clear all metrics
   */
  clear(): void {
    this.metrics.clear();
  }

  /**
   * Export metrics as JSON
   */
  exportMetrics(): Record<string, PerformanceMetrics> {
    const result: Record<string, PerformanceMetrics> = {};

    for (const metric of this.metrics.keys()) {
      const stats = this.getStats(metric);
      if (stats) {
        result[metric] = stats;
      }
    }

    return result;
  }
}

/**
 * Global performance monitor instance
 */
let globalMonitor: PerformanceMonitor | null = null;

export function getPerformanceMonitor(): PerformanceMonitor {
  if (!globalMonitor) {
    globalMonitor = new PerformanceMonitor();
  }
  return globalMonitor;
}

/**
 * Helper to wrap any function with performance monitoring
 */
export function monitorFunction<T extends (...args: unknown[]) => Promise<unknown>>(
  fn: T,
  name?: string
): T {
  const monitor = getPerformanceMonitor();
  const metricName = (name ?? fn.name) || 'anonymous';

  return (async (...args: Parameters<T>): Promise<ReturnType<T>> => {
    return monitor.measure(metricName, async () => await fn(...args)) as ReturnType<T>;
  }) as T;
}
