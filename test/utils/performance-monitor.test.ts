import { describe, it, expect } from 'vitest';
import { PerformanceMonitor } from '../../src/utils/performance-monitor.js';

describe('Performance Monitor', () => {
  it('should record metrics', async () => {
    const monitor = new PerformanceMonitor();

    await monitor.measure('test-operation', async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return 'result';
    });

    const stats = monitor.getStats('test-operation');
    expect(stats).not.toBeNull();
    expect(stats!.count).toBe(1);
  });

  it('should return null for unrecorded metrics', () => {
    const monitor = new PerformanceMonitor();
    expect(monitor.getStats('nonexistent')).toBeNull();
  });

  it('should track multiple operations', async () => {
    const monitor = new PerformanceMonitor();

    await Promise.all([
      monitor.measure('op1', async () => {
        await new Promise((r) => setTimeout(r, 10));
      }),
      monitor.measure('op2', async () => {
        await new Promise((r) => setTimeout(r, 15));
      }),
      monitor.measure('op1', async () => {
        await new Promise((r) => setTimeout(r, 12));
      }),
    ]);

    const stats1 = monitor.getStats('op1');
    const stats2 = monitor.getStats('op2');

    expect(stats1!.count).toBe(2);
    expect(stats2!.count).toBe(1);
  });

  it('should calculate correct average', () => {
    const monitor = new PerformanceMonitor();
    monitor.record('fixed', 10);
    monitor.record('fixed', 20);
    monitor.record('fixed', 30);

    const stats = monitor.getStats('fixed');
    expect(stats!.avg).toBe(20);
  });

  it('should calculate percentiles correctly', () => {
    const monitor = new PerformanceMonitor();

    for (let i = 1; i <= 10; i++) {
      monitor.record('percentiles', i);
    }

    const stats = monitor.getStats('percentiles');
    expect(stats!.p50).toBeGreaterThanOrEqual(5);
    expect(stats!.p95).toBeGreaterThanOrEqual(9);
    expect(stats!.p99).toBe(10);
  });

  it('should track min and max', () => {
    const monitor = new PerformanceMonitor();
    monitor.record('range', 50);
    monitor.record('range', 10);
    monitor.record('range', 100);
    monitor.record('range', 25);

    const stats = monitor.getStats('range');
    expect(stats!.min).toBe(10);
    expect(stats!.max).toBe(100);
  });

  it('should track count', () => {
    const monitor = new PerformanceMonitor();
    for (let i = 0; i < 5; i++) {
      monitor.record('count-test', i);
    }

    const stats = monitor.getStats('count-test');
    expect(stats!.count).toBe(5);
  });

  it('should add to existing metric', () => {
    const monitor = new PerformanceMonitor();
    monitor.record('metric', 10);
    monitor.record('metric', 20);

    const stats = monitor.getStats('metric');
    expect(stats!.count).toBe(2);
  });

  it('should limit stored samples to maxSamples', () => {
    const monitor = new PerformanceMonitor({ maxSamples: 5 });

    for (let i = 0; i < 100; i++) {
      monitor.record('limited', i);
    }

    const stats = monitor.getStats('limited');
    expect(stats!.count).toBe(5);
  });

  it('should return all metric names', () => {
    const monitor = new PerformanceMonitor();
    monitor.record('metric1', 10);
    monitor.record('metric2', 20);
    monitor.record('metric3', 30);

    const metrics = monitor.getMetrics();
    expect(metrics).toContain('metric1');
    expect(metrics).toContain('metric2');
    expect(metrics).toContain('metric3');
    expect(metrics.length).toBe(3);
  });

  it('should return empty array when no metrics', () => {
    const monitor = new PerformanceMonitor();
    expect(monitor.getMetrics()).toEqual([]);
  });

  it('should clear all metrics', () => {
    const monitor = new PerformanceMonitor();
    monitor.record('metric1', 10);
    monitor.record('metric2', 20);
    monitor.clear();

    expect(monitor.getMetrics()).toEqual([]);
    expect(monitor.getStats('metric1')).toBeNull();
  });

  it('should export all metrics as JSON', () => {
    const monitor = new PerformanceMonitor();
    monitor.record('export1', 10);
    monitor.record('export2', 20);

    const exported = monitor.exportMetrics();
    expect(exported).toHaveProperty('export1');
    expect(exported).toHaveProperty('export2');
    expect(exported.export1.count).toBe(1);
    expect(exported.export2.count).toBe(1);
  });

  it('should export empty object when no metrics', () => {
    const monitor = new PerformanceMonitor();
    expect(monitor.exportMetrics()).toEqual({});
  });
});
