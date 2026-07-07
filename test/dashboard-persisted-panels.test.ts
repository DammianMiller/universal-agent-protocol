/**
 * The Compression and Performance dashboard panels used to read in-process
 * singletons (globalSessionStats, getPerformanceMonitor) that are only populated
 * in the MCP-router/executor/memory processes — never in the separate
 * `uap dash serve` process, so both panels rendered structurally 0/empty.
 *
 * These tests cover the persisted-store fix: producers write samples to
 * telemetry.db, and the dashboard reads them back even when the in-process
 * singleton is empty (the real cross-process scenario).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import {
  persistCompressionSample,
  readCompressionStats,
  persistPerfSample,
  readPerfMetrics,
  closeTelemetryStores,
} from '../src/utils/telemetry-store.js';
import { getMemoryData, getPerformanceData } from '../src/dashboard/data-service.js';
import { globalSessionStats } from '../src/mcp-router/session-stats.js';
import { getPerformanceMonitor, PerformanceMonitor } from '../src/utils/performance-monitor.js';

describe('telemetry-store — persisted compression', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uap-tel-comp-'));
  });
  afterEach(() => {
    closeTelemetryStores(dir);
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns honest zeros when nothing has been persisted', () => {
    expect(readCompressionStats(dir)).toEqual({
      rawBytes: 0,
      contextBytes: 0,
      savingsPercent: '0%',
      totalCalls: 0,
    });
  });

  it('aggregates samples across tools into running totals + savings%', () => {
    persistCompressionSample(dir, 'toolA', 1000, 400);
    persistCompressionSample(dir, 'toolA', 1000, 600);
    persistCompressionSample(dir, 'toolB', 2000, 1000);
    const s = readCompressionStats(dir);
    expect(s.totalCalls).toBe(3);
    expect(s.rawBytes).toBe(4000);
    expect(s.contextBytes).toBe(2000);
    // 1 - 2000/4000 = 50%
    expect(s.savingsPercent).toBe('50%');
  });
});

describe('telemetry-store — persisted performance', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uap-tel-perf-'));
  });
  afterEach(() => {
    closeTelemetryStores(dir);
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns an empty map when nothing has been persisted', () => {
    expect(readPerfMetrics(dir)).toEqual({});
  });

  it('computes per-metric count/min/max/avg from samples', () => {
    for (const ms of [10, 20, 30, 40]) persistPerfSample(dir, 'op.x', ms);
    persistPerfSample(dir, 'op.y', 100);
    const m = readPerfMetrics(dir);
    expect(m['op.x'].count).toBe(4);
    expect(m['op.x'].min).toBe(10);
    expect(m['op.x'].max).toBe(40);
    expect(m['op.x'].avg).toBe(25);
    expect(m['op.y'].count).toBe(1);
    expect(m['op.y'].avg).toBe(100);
  });

  it('ignores non-finite / negative durations', () => {
    persistPerfSample(dir, 'op.z', -5);
    persistPerfSample(dir, 'op.z', Number.NaN);
    expect(readPerfMetrics(dir)['op.z']).toBeUndefined();
  });

  it('produces stats identical to the in-memory PerformanceMonitor for the same samples', () => {
    // The store and the singleton share computePercentiles — the dashboard must
    // render the same numbers regardless of which process produced the data.
    const samples = [3, 8, 8, 12, 15, 21, 34, 55, 89, 90, 91, 100];
    const monitor = new PerformanceMonitor();
    for (const ms of samples) {
      monitor.record('op.shared', ms);
      persistPerfSample(dir, 'op.shared', ms);
    }
    expect(readPerfMetrics(dir)['op.shared']).toEqual(monitor.exportMetrics()['op.shared']);
  });
});

describe('dashboard panels read the persisted store, not the empty singleton', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uap-panel-'));
    // Simulate the `dash serve` process: singletons are empty here.
    globalSessionStats.reset();
    getPerformanceMonitor().clear();
  });
  afterEach(() => {
    closeTelemetryStores(dir);
    rmSync(dir, { recursive: true, force: true });
  });

  it('compression panel reflects persisted samples while the in-process singleton is empty', () => {
    persistCompressionSample(dir, 'execute_tool', 5000, 1000);
    const mem = getMemoryData(dir);
    expect(mem.compression.totalCalls).toBe(1);
    expect(mem.compression.rawBytes).toBe(5000);
    expect(mem.compression.contextBytes).toBe(1000);
    // 1 - 1000/5000 = 80%
    expect(mem.compression.savingsPercent).toBe('80%');
  });

  it('performance panel reflects persisted samples while the in-process singleton is empty', () => {
    for (const ms of [5, 15, 25]) persistPerfSample(dir, 'executor.qwen', ms);
    const perf = getPerformanceData(dir);
    expect(perf.metrics['executor.qwen'].count).toBe(3);
    expect(perf.hotPaths[0].name).toBe('executor.qwen');
    expect(perf.hotPaths[0].count).toBe(3);
  });
});

describe('compression model_analytics fallback populates call count (was fixed 0)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uap-fallback-'));
    globalSessionStats.reset();
  });
  afterEach(() => {
    closeTelemetryStores(dir);
    rmSync(dir, { recursive: true, force: true });
  });

  it('derives totalCalls from task_outcomes when no session/store data exists', () => {
    const mdir = join(dir, 'agents', 'data', 'memory');
    mkdirSync(mdir, { recursive: true });
    const db = new Database(join(mdir, 'model_analytics.db'));
    db.exec(
      'CREATE TABLE task_outcomes (id INTEGER PRIMARY KEY AUTOINCREMENT, tokensIn INTEGER, tokensOut INTEGER)'
    );
    const ins = db.prepare('INSERT INTO task_outcomes (tokensIn, tokensOut) VALUES (?, ?)');
    ins.run(100, 20);
    ins.run(200, 40);
    db.close();

    const mem = getMemoryData(dir);
    expect(mem.compression.totalCalls).toBe(2); // previously always 0
    expect(mem.compression.rawBytes).toBe(360); // 100+20+200+40
  });
});
