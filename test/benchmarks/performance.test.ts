/**
 * Performance Benchmark Suite for Universal Agent Memory
 *
 * Measures latency (p50, p95, p99) and throughput for core operations:
 * - SQLite short-term memory store/query
 * - FTS5 full-text search
 * - Coordination service (register, claim, message)
 * - Task CRUD operations
 * - Write gate evaluation
 * - Agent-scoped memory store/query
 * - Daily log write/read
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { existsSync, unlinkSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { CoordinationService } from '../../src/coordination/service.js';
import { CoordinationDatabase } from '../../src/coordination/database.js';
import { TaskService } from '../../src/tasks/service.js';
import { TaskDatabase } from '../../src/tasks/database.js';
import { evaluateWriteGate } from '../../src/memory/write-gate.js';
import { SQLiteShortTermMemory } from '../../src/memory/short-term/sqlite.js';
// AgentScopedMemory removed in sweep 4 — benchmark section disabled
// import { AgentScopedMemory } from '../../src/memory/agent-scoped-memory.js';
import { DailyLog } from '../../src/memory/daily-log.js';

// --- Helpers ---

const BENCH_DIR = join(process.cwd(), '.uap-bench');

function benchPath(name: string): string {
  return join(BENCH_DIR, `${name}.db`);
}

function cleanDb(path: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    if (existsSync(path + suffix)) unlinkSync(path + suffix);
  }
}

interface LatencyStats {
  count: number;
  totalMs: number;
  avgMs: number;
  minMs: number;
  maxMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  opsPerSec: number;
}

function computeStats(durationsMs: number[]): LatencyStats {
  const sorted = [...durationsMs].sort((a, b) => a - b);
  const count = sorted.length;
  const totalMs = sorted.reduce((s, v) => s + v, 0);
  return {
    count,
    totalMs: round(totalMs),
    avgMs: round(totalMs / count),
    minMs: round(sorted[0]),
    maxMs: round(sorted[count - 1]),
    p50Ms: round(sorted[Math.floor(count * 0.5)]),
    p95Ms: round(sorted[Math.floor(count * 0.95)]),
    p99Ms: round(sorted[Math.floor(count * 0.99)]),
    opsPerSec: round((count / totalMs) * 1000),
  };
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** High-resolution timer returning milliseconds */
function hrtimeMs(): number {
  const [s, ns] = process.hrtime();
  return s * 1000 + ns / 1e6;
}

function bench(fn: () => void, iterations: number): LatencyStats {
  const durations: number[] = [];
  // Warm-up: 5% of iterations or at least 3
  const warmup = Math.max(3, Math.floor(iterations * 0.05));
  for (let i = 0; i < warmup; i++) fn();

  for (let i = 0; i < iterations; i++) {
    const start = hrtimeMs();
    fn();
    durations.push(hrtimeMs() - start);
  }
  return computeStats(durations);
}

async function benchAsync(fn: () => Promise<void>, iterations: number): Promise<LatencyStats> {
  const durations: number[] = [];
  const warmup = Math.max(3, Math.floor(iterations * 0.05));
  for (let i = 0; i < warmup; i++) await fn();

  for (let i = 0; i < iterations; i++) {
    const start = hrtimeMs();
    await fn();
    durations.push(hrtimeMs() - start);
  }
  return computeStats(durations);
}

function formatStats(label: string, stats: LatencyStats): string {
  return [
    `  ${label}:`,
    `    ops: ${stats.count} | total: ${stats.totalMs}ms | ops/sec: ${stats.opsPerSec}`,
    `    avg: ${stats.avgMs}ms | min: ${stats.minMs}ms | max: ${stats.maxMs}ms`,
    `    p50: ${stats.p50Ms}ms | p95: ${stats.p95Ms}ms | p99: ${stats.p99Ms}ms`,
  ].join('\n');
}

// --- Benchmark Suite ---

const ITERATIONS = 500;
const SEARCH_ITERATIONS = 200;
const allResults: string[] = [];

describe('Performance Benchmarks', () => {
  beforeAll(() => {
    if (!existsSync(BENCH_DIR)) mkdirSync(BENCH_DIR, { recursive: true });
    allResults.length = 0;
  });

  afterAll(() => {
    // Print consolidated report
    console.log('\n' + '='.repeat(70));
    console.log('  PERFORMANCE BENCHMARK REPORT');
    console.log('  Universal Agent Memory v8.0.0');
    console.log('  Date: ' + new Date().toISOString());
    console.log('='.repeat(70));
    for (const r of allResults) console.log(r);
    console.log('='.repeat(70) + '\n');

    // Cleanup
    if (existsSync(BENCH_DIR)) {
      rmSync(BENCH_DIR, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------
  // 1. Write Gate (pure function, no DB)
  // -------------------------------------------------------
  describe('Write Gate', () => {
    const samples = [
      'The user prefers TypeScript over JavaScript for all new projects',
      'Remember to always use ESLint with the strict config',
      'We decided to use PostgreSQL instead of MySQL because of JSON support',
      'Deploy to staging every Friday at 3pm',
      'The API rate limit is 100 requests per minute per user',
      'hello world',
      'ok',
      'This is a trivial message that should not pass the gate',
    ];

    it('evaluateWriteGate throughput', () => {
      let idx = 0;
      const stats = bench(() => {
        evaluateWriteGate(samples[idx % samples.length]);
        idx++;
      }, ITERATIONS * 2);

      allResults.push('\n[1] WRITE GATE (pure function)');
      allResults.push(formatStats('evaluateWriteGate', stats));
      expect(stats.p95Ms).toBeLessThan(5); // should be sub-millisecond
    });
  });

  // -------------------------------------------------------
  // 2. Short-Term Memory (SQLite + FTS5)
  // -------------------------------------------------------
  describe('Short-Term Memory', () => {
    const dbPath = benchPath('short-term');
    let mem: SQLiteShortTermMemory;

    beforeEach(() => {
      cleanDb(dbPath);
      mem = new SQLiteShortTermMemory({ dbPath, projectId: 'bench' });
    });

    afterEach(async () => {
      await mem.close();
      cleanDb(dbPath);
    });

    it('store latency', async () => {
      let idx = 0;
      const types = ['action', 'observation', 'thought', 'goal'] as const;
      const stats = await benchAsync(async () => {
        await mem.store(
          types[idx % 4],
          `Benchmark memory entry #${idx}: The agent discovered that caching improves performance by ${idx}%`,
          5 + (idx % 6)
        );
        idx++;
      }, ITERATIONS);

      allResults.push('\n[2] SHORT-TERM MEMORY (SQLite + FTS5)');
      allResults.push(formatStats('store', stats));
      expect(stats.p95Ms).toBeLessThan(50);
    });

    it('query (FTS5 search) latency', async () => {
      // Seed 200 entries first
      for (let i = 0; i < 200; i++) {
        await mem.store(
          'observation',
          `Entry ${i}: performance optimization for database queries with index tuning`
        );
      }

      const queries = ['performance', 'database', 'optimization', 'index', 'queries'];
      let idx = 0;
      const stats = await benchAsync(async () => {
        await mem.query(queries[idx % queries.length], 10);
        idx++;
      }, SEARCH_ITERATIONS);

      allResults.push(formatStats('query (FTS5)', stats));
      expect(stats.p95Ms).toBeLessThan(50);
    });

    it('getRecent latency', async () => {
      // Seed 200 entries
      for (let i = 0; i < 200; i++) {
        await mem.store('thought', `Recent entry ${i}: thinking about architecture decisions`);
      }

      const stats = await benchAsync(async () => {
        await mem.getRecent(20);
      }, SEARCH_ITERATIONS);

      allResults.push(formatStats('getRecent(20)', stats));
      expect(stats.p95Ms).toBeLessThan(20);
    });
  });

  // -------------------------------------------------------
  // 3. Coordination Service
  // -------------------------------------------------------
  describe('Coordination Service', () => {
    const dbPath = benchPath('coordination');
    let service: CoordinationService;

    beforeEach(() => {
      CoordinationDatabase.resetInstance();
      cleanDb(dbPath);
      service = new CoordinationService({
        dbPath,
        heartbeatIntervalMs: 60000,
        claimExpiryMs: 300000,
      });
    });

    afterEach(() => {
      CoordinationDatabase.resetInstance();
      cleanDb(dbPath);
    });

    it('register/deregister latency', () => {
      const stats = bench(() => {
        const id = service.register('bench-agent', ['coding']);
        service.deregister(id);
      }, ITERATIONS);

      allResults.push('\n[3] COORDINATION SERVICE');
      allResults.push(formatStats('register + deregister', stats));
      expect(stats.p95Ms).toBeLessThan(20);
    });

    it('claimResource/releaseResource latency', () => {
      const agentId = service.register('bench-agent', ['coding']);
      let idx = 0;

      const stats = bench(() => {
        const resource = `file-${idx++}.ts`;
        service.claimResource(agentId, resource, 'exclusive');
        service.releaseResource(agentId, resource);
      }, ITERATIONS);

      allResults.push(formatStats('claim + release (exclusive)', stats));
      service.deregister(agentId);
      expect(stats.p95Ms).toBeLessThan(20);
    });

    it('send/receive message latency', () => {
      const agent1 = service.register('sender', ['coding']);
      const agent2 = service.register('receiver', ['review']);

      const stats = bench(() => {
        service.send(agent1, agent2, { action: 'notify', data: 'benchmark message' });
      }, ITERATIONS);

      const receiveStats = bench(() => {
        service.receive(agent2, undefined, true);
      }, SEARCH_ITERATIONS);

      allResults.push(formatStats('send message', stats));
      allResults.push(formatStats('receive messages', receiveStats));

      service.deregister(agent1);
      service.deregister(agent2);
      expect(stats.p95Ms).toBeLessThan(20);
    });

    it('announceWork latency', () => {
      const agent1 = service.register('agent-1', ['coding']);
      const agent2 = service.register('agent-2', ['coding']);
      let idx = 0;

      const stats = bench(() => {
        service.announceWork(agent1, `src/module-${idx++}.ts`, 'editing');
      }, ITERATIONS);

      allResults.push(formatStats('announceWork', stats));
      service.deregister(agent1);
      service.deregister(agent2);
      expect(stats.p95Ms).toBeLessThan(20);
    });
  });

  // -------------------------------------------------------
  // 4. Task Service
  // -------------------------------------------------------
  describe('Task Service', () => {
    const dbPath = benchPath('tasks');
    let service: TaskService;

    beforeEach(() => {
      TaskDatabase.resetInstance();
      cleanDb(dbPath);
      service = new TaskService({ dbPath, agentId: 'bench-agent' });
    });

    afterEach(() => {
      TaskDatabase.resetInstance();
      cleanDb(dbPath);
    });

    it('create task latency', () => {
      // Note: TaskService.generateId() uses only 4 hex chars (65k space),
      // so we limit iterations to avoid birthday-paradox collisions.
      let idx = 0;
      const stats = bench(() => {
        service.create({
          title: `Benchmark task #${idx}`,
          description: `Performance test task for measuring create latency iteration ${idx}`,
          type: 'task',
          priority: 2,
        });
        idx++;
      }, 200);

      allResults.push('\n[4] TASK SERVICE');
      allResults.push(formatStats('create', stats));
      expect(stats.p95Ms).toBeLessThan(20);
    });

    it('get task latency', () => {
      // Create tasks to query (limited to avoid ID collisions)
      const ids: string[] = [];
      for (let i = 0; i < 100; i++) {
        const task = service.create({ title: `Task ${i}`, type: 'task', priority: 2 });
        ids.push(task.id);
      }

      let idx = 0;
      const stats = bench(() => {
        service.get(ids[idx % ids.length]);
        idx++;
      }, ITERATIONS);

      allResults.push(formatStats('get (by ID)', stats));
      expect(stats.p95Ms).toBeLessThan(10);
    });

    it('list tasks latency', () => {
      // Create 100 tasks with mixed statuses (limited to avoid ID collisions)
      for (let i = 0; i < 100; i++) {
        const task = service.create({
          title: `Task ${i}`,
          type: 'task',
          priority: i % 3 === 0 ? 0 : 2,
        });
        if (i % 4 === 0) service.update(task.id, { status: 'in_progress' });
        if (i % 5 === 0) service.close(task.id, 'completed');
      }

      const stats = bench(() => {
        service.list({ status: 'open' });
      }, SEARCH_ITERATIONS);

      allResults.push(formatStats('list (filtered)', stats));
      expect(stats.p95Ms).toBeLessThan(30);
    });

    it('update task latency', () => {
      const task = service.create({ title: 'Update target', type: 'task', priority: 2 });
      let idx = 0;

      const stats = bench(() => {
        service.update(task.id, { description: `Updated description #${idx++}` });
      }, ITERATIONS);

      allResults.push(formatStats('update', stats));
      expect(stats.p95Ms).toBeLessThan(20);
    });

    it('getStats latency', () => {
      // Seed tasks (limited to avoid ID collisions)
      for (let i = 0; i < 50; i++) {
        service.create({ title: `Task ${i}`, type: 'task', priority: 2 });
      }

      const stats = bench(() => {
        service.getStats();
      }, SEARCH_ITERATIONS);

      allResults.push(formatStats('getStats', stats));
      expect(stats.p95Ms).toBeLessThan(50); // aggregate query, relaxed threshold
    });
  });

  // Agent-Scoped Memory benchmarks removed — module deleted in sweep 4

  // -------------------------------------------------------
  // 6. Daily Log
  // -------------------------------------------------------
  describe('Daily Log', () => {
    const dbPath = benchPath('daily-log');
    let log: DailyLog;

    beforeEach(() => {
      cleanDb(dbPath);
      log = new DailyLog(dbPath);
    });

    afterEach(() => {
      log.close();
      cleanDb(dbPath);
    });

    it('write latency', () => {
      let idx = 0;
      const types = ['decision', 'discovery', 'progress', 'blocker'] as const;
      const stats = bench(() => {
        log.write(
          `Daily log entry ${idx}: completed performance benchmarking for module ${idx % 10}`,
          types[idx % 4] as string,
          0.5 + (idx % 5) * 0.1
        );
        idx++;
      }, ITERATIONS);

      allResults.push('\n[6] DAILY LOG');
      allResults.push(formatStats('write', stats));
      expect(stats.p95Ms).toBeLessThan(20);
    });

    it('getByDate latency', () => {
      // Seed entries
      for (let i = 0; i < 200; i++) {
        log.write(`Entry ${i}: daily log content`, 'progress', 0.7);
      }

      const stats = bench(() => {
        log.getByDate();
      }, SEARCH_ITERATIONS);

      allResults.push(formatStats('getByDate (today)', stats));
      expect(stats.p95Ms).toBeLessThan(20);
    });

    it('getPromotionCandidates latency', () => {
      for (let i = 0; i < 200; i++) {
        log.write(`Entry ${i}: important discovery about system behavior`, 'discovery', 0.8);
      }

      const stats = bench(() => {
        log.getPromotionCandidates(0.5);
      }, SEARCH_ITERATIONS);

      allResults.push(formatStats('getPromotionCandidates', stats));
      expect(stats.p95Ms).toBeLessThan(20);
    });
  });
});
