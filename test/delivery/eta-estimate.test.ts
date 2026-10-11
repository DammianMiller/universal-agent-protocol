/**
 * S1b · the EWMA ETA estimator (bridge P5) — fold order, the thin-data gate,
 * the honesty fields (spread, failure accounting), and the fail-soft store
 * wrapper. The pure core is deterministic: no store, no clock, no fs.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  ewmaEstimate,
  estimatePace,
  listPaceKeys,
  remainingWallMs,
  formatDurationMs,
  MIN_ETA_SAMPLES,
  type EtaSample,
} from '../../src/delivery/eta-estimate.js';
import { ModelAnalytics } from '../../src/models/analytics.js';

const dirs: string[] = [];
function tmp(): string {
  const d = join(tmpdir(), `uap-eta-est-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(d, { recursive: true });
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const s = (durationMs: number, success = true, turns = 3): EtaSample => ({
  durationMs,
  success,
  turns,
  timestamp: '2026-10-11T00:00:00.000Z',
});

describe('ewmaEstimate — the thin-data gate', () => {
  it('refuses to estimate below the minimum sample count (thin data is not an estimate)', () => {
    expect(ewmaEstimate([s(1000), s(2000)])).toBeNull();
    expect(ewmaEstimate([])).toBeNull();
    expect(ewmaEstimate([s(1000), s(2000), s(3000, false)])).toBeNull(); // only 2 successes
    expect(MIN_ETA_SAMPLES).toBe(3);
  });

  it('tiers confidence: thin at 3-5 successes, solid at 6+', () => {
    expect(ewmaEstimate([s(1), s(2), s(3)])!.confidence).toBe('thin');
    expect(ewmaEstimate([s(1), s(2), s(3), s(4), s(5)])!.confidence).toBe('thin');
    expect(ewmaEstimate([s(1), s(2), s(3), s(4), s(5), s(6)])!.confidence).toBe('solid');
  });
});

describe('ewmaEstimate — the fold', () => {
  it('folds OLDEST→NEWEST: the newest samples weigh most', () => {
    // A stream of 10s tasks followed by 100s tasks must land NEAR 100s when
    // memory is short: the newest samples dominate the fold.
    const oldSlow = Array.from({ length: 10 }, () => s(10_000));
    const newFast = Array.from({ length: 10 }, () => s(100));
    const storeOrder = [...newFast, ...oldSlow]; // store order: newest first
    const est = ewmaEstimate(storeOrder, { halfLifeSamples: 2 })!;
    expect(est.etaMs).toBeLessThan(1000); // pulled strongly toward the recent 100s
    expect(est.etaMs).toBeGreaterThan(100); // but history still visible
    // The fold is CHRONOLOGICAL, not order-blind: presenting the same
    // multiset with the opposite chronology (10s tasks as the RECENT ones)
    // yields a very different estimate — recency is the whole point.
    const estFlipped = ewmaEstimate([...storeOrder].reverse(), { halfLifeSamples: 2 })!;
    expect(estFlipped.etaMs).toBeGreaterThan(9000);
  });

  it('a short half-life forgets faster than a long one', () => {
    // Newest-first store order: the 60s spike is the RECENT sample, the 1s
    // tasks are history. A short half-life reacts to it; a long one has
    // already mostly forgotten it.
    const samples = [s(60_000), s(1000), s(1000), s(1000), s(1000), s(1000)];
    const forgetful = ewmaEstimate(samples, { halfLifeSamples: 2 })!;
    const patient = ewmaEstimate(samples, { halfLifeSamples: 50 })!;
    expect(forgetful.etaMs).toBeGreaterThan(patient.etaMs); // the 60s spike weighs more when memory is short
  });

  it('carries the honest spread: min/max of the folded successes', () => {
    const est = ewmaEstimate([s(1000), s(5000), s(3000), s(9000)])!;
    expect(est.minMs).toBe(1000);
    expect(est.maxMs).toBe(9000);
  });
});

describe('ewmaEstimate — failure accounting', () => {
  it('folds SUCCESS durations but reports attempts-per-success for wall time', () => {
    // 5 attempts, 3 succeeded (1000, 3000, 5000) — the EWMA is over
    // successes, but expected wall time must scale by observed/successes,
    // not pretend failures away.
    const est = ewmaEstimate([s(1000), s(3000), s(5000), s(7000, false), s(9000, false)])!;
    expect(est.samples).toBe(3);
    expect(est.observed).toBe(5);
    expect(est.successRate).toBeCloseTo(3 / 5);
    expect(est.attemptsPerSuccess).toBeCloseTo(5 / 3);
    // Wall time for 6 items: 6 * (5/3)x * ewma(success durations)
    expect(remainingWallMs(est, 6)).toBeCloseTo(6 * (5 / 3) * est.etaMs, 5);
  });

  it('remainingWallMs is null without an estimate or with no items', () => {
    expect(remainingWallMs(null, 5)).toBeNull();
    const est = ewmaEstimate([s(1), s(2), s(3)])!;
    expect(remainingWallMs(est, 0)).toBeNull();
    expect(remainingWallMs(est, -1)).toBeNull();
  });
});

describe('formatDurationMs', () => {
  it('renders human-scale strings', () => {
    expect(formatDurationMs(500)).toBe('1s'); // 0.5s rounds up
    expect(formatDurationMs(42_000)).toBe('42s');
    expect(formatDurationMs(90_000)).toBe('1.5 min');
    expect(formatDurationMs(3 * 3600_000 + 60_000)).toBe('3.0h');
    expect(formatDurationMs(Number.NaN)).toBe('—');
    expect(formatDurationMs(-5)).toBe('—');
  });
});

describe('estimatePace — the store wrapper', () => {
  it('reads the S1a sample stream and folds it (end-to-end against a real store)', () => {
    const db = join(tmp(), 'analytics.db');
    const rec = new ModelAnalytics(db);
    for (const ms of [60_000, 62_000, 58_000, 61_000, 59_000, 60_500, 30_000]) {
      rec.recordOutcome({
        modelId: 'qwen35-a3b',
        taskType: 'orchestrated',
        complexity: 'medium',
        success: true,
        durationMs: ms,
        turns: 4,
        tokensUsed: { input: 0, output: 0 },
        cost: 0,
      });
    }
    rec.recordOutcome({
      modelId: 'qwen35-a3b',
      taskType: 'orchestrated',
      complexity: 'medium',
      success: false,
      durationMs: 120_000,
      turns: 9,
      tokensUsed: { input: 0, output: 0 },
      cost: 0,
    });
    rec.close();

    const est = estimatePace({ modelId: 'qwen35-a3b', dbPath: db })!;
    expect(est).not.toBeNull();
    expect(est.samples).toBe(7);
    expect(est.observed).toBe(8);
    expect(est.etaMs).toBeGreaterThan(30_000); // recent samples weigh more than the 30s outlier
    expect(est.etaMs).toBeLessThan(65_000);
    expect(est.attemptsPerSuccess).toBeCloseTo(8 / 7, 3);
    expect(est.confidence).toBe('solid');
  });

  it('keys are isolated: a different (model|type|complexity) sees nothing', () => {
    const db = join(tmp(), 'analytics.db');
    const rec = new ModelAnalytics(db);
    for (let i = 0; i < 5; i++) {
      rec.recordOutcome({
        modelId: 'm1', taskType: 'orchestrated', complexity: 'medium',
        success: true, durationMs: 1000, turns: 1, tokensUsed: { input: 0, output: 0 }, cost: 0,
      });
    }
    rec.close();
    expect(estimatePace({ modelId: 'm1', dbPath: db })).not.toBeNull();
    expect(estimatePace({ modelId: 'm2', dbPath: db })).toBeNull();
    expect(estimatePace({ modelId: 'm1', taskType: 'other', dbPath: db })).toBeNull();
    expect(estimatePace({ modelId: 'm1', complexity: 'high', dbPath: db })).toBeNull();
  });

  it('is fail-soft: a broken store yields null, never a throw', () => {
    // A DB path whose PARENT is a file: SQLite cannot even create the store,
    // so this exercises the throw→catch path, not the empty-store path.
    const dir = tmp();
    writeFileSync(join(dir, 'blocker'), '');
    expect(estimatePace({ modelId: 'm1', dbPath: join(dir, 'blocker', 'nested.db') })).toBeNull();
  });

  it('requireExisting: a missing store yields null WITHOUT being materialized', () => {
    // The reactor calls this per prompt — a read must not create the store.
    const dir = tmp();
    const dbPath = join(dir, 'agents', 'data', 'memory', 'model_analytics.db');
    expect(estimatePace({ modelId: 'm1', dbPath, requireExisting: true })).toBeNull();
    expect(existsSync(dbPath)).toBe(false); // nothing was created
  });

  it('a hostile turns value poisons only itself, never etaTurns (NaN guard)', () => {
    const samples: EtaSample[] = [
      { durationMs: 1000, success: true, turns: Number.NaN, timestamp: '2026-10-11T00:00:00.000Z' },
      { durationMs: 1000, success: true, turns: 3, timestamp: '2026-10-11T00:00:01.000Z' },
      { durationMs: 1000, success: true, turns: 4, timestamp: '2026-10-11T00:00:02.000Z' },
      { durationMs: 1000, success: true, turns: 5, timestamp: '2026-10-11T00:00:03.000Z' },
    ];
    const est = ewmaEstimate(samples)!;
    expect(Number.isFinite(est.etaTurns)).toBe(true);
    expect(est.etaMs).toBe(1000);
  });

  it('listPaceKeys: every key with history, honest truncation, fail-soft', () => {
    const db = join(tmp(), 'analytics.db');
    const rec = new ModelAnalytics(db);
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 4; j++) {
        rec.recordOutcome({
          modelId: `m${i}`,
          taskType: 'orchestrated',
          complexity: 'medium',
          success: j < 3,
          durationMs: 1000,
          turns: 2,
          tokensUsed: { input: 1, output: 1 },
          cost: 0,
        });
      }
    }
    rec.close();
    const { keys, estimates, truncated } = listPaceKeys({ dbPath: db, maxKeys: 2 });
    expect(keys).toHaveLength(2); // capped
    expect(truncated).toBe(true); // and says so
    expect(estimates.every((e) => e.key.modelId.startsWith('m'))).toBe(true);
    const all = listPaceKeys({ dbPath: db });
    expect(all.keys).toHaveLength(3);
    expect(all.truncated).toBe(false);
    // Fail-soft on a broken store: empty, never a throw.
    const dir = tmp();
    writeFileSync(join(dir, 'blocker'), '');
    const broken = listPaceKeys({ dbPath: join(dir, 'blocker', 'x.db') });
    expect(broken).toEqual({ keys: [], estimates: [], truncated: false });
  });
});
