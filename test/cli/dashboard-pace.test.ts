/**
 * Measured Pace on the CLI dashboard (bridge P5: S1b) — the compute/render
 * split (`computeMeasuredPace`) made the shaping contract testable without
 * the cwd-pinned analytics singleton: tests pass their own ModelAnalytics at
 * a tmp path. Pins the estimate gate (only keys with real history get a row),
 * the most-attempts-first ranking, the honest caveats (thin count, beyond-cap
 * count), the failure-rate column, and the control-char scrub on foreign ids.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ModelAnalytics } from '../../src/models/analytics.js';
import { computeMeasuredPace } from '../../src/cli/dashboard.js';

let dir: string;
let db: string;

beforeEach(() => {
  dir = join(tmpdir(), `uap-dash-pace-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  db = join(dir, 'model_analytics.db');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function seed(
  modelId: string,
  n: number,
  failures = 0,
  taskType = 'orchestrated',
  complexity = 'medium',
): void {
  const rec = new ModelAnalytics(db);
  for (let i = 0; i < n; i++) {
    rec.recordOutcome({
      modelId,
      taskType,
      complexity,
      success: i < n - failures,
      durationMs: 30_000 + i * 100,
      turns: 4,
      tokensUsed: { input: 100, output: 200 },
      cost: 0.001,
    });
  }
  rec.close();
}

describe('computeMeasuredPace — the dashboard shaping contract', () => {
  it('gives a solid key a full row: estimate, spread, N, success rate', async () => {
    seed('model-a', 6);
    const pace = await computeMeasuredPace(new ModelAnalytics(db));
    expect(pace.rows.length).toBe(1);
    const r = pace.rows[0];
    expect(r.modelId).toBe('model-a');
    expect(r.key).toBe('orchestrated/medium');
    expect(r.perTask).toMatch(/^~/);
    expect(r.spread).toMatch(/30s/);
    expect(r.n).toBe('6/6');
    expect(r.successPct).toBe('100%');
    expect(pace.thin).toBe(0);
    expect(pace.more).toBe(0);
  });

  it('carries the failure rate: 6 successes of 9 attempts is 67%, N reads 6/9', async () => {
    seed('model-a', 9, 3);
    const pace = await computeMeasuredPace(new ModelAnalytics(db));
    expect(pace.rows[0].n).toBe('6/9');
    expect(pace.rows[0].successPct).toBe('67%');
  });

  it('ranks most-attempts-first and keeps beyond-cap keys as an honest count', async () => {
    seed('model-big', 6);
    seed('model-small', 4);
    for (let i = 0; i < 8; i++) seed(`filler-${i}`, 1); // 10 keys total > cap 8
    const pace = await computeMeasuredPace(new ModelAnalytics(db));
    expect(pace.rows.map((r) => r.modelId)).toEqual(['model-big', 'model-small']);
    expect(pace.more).toBe(2);
  });

  it('counts thin keys (<3 successes) instead of guessing a row for them', async () => {
    seed('model-solid', 6);
    seed('model-thin', 2); // only 2 successes — below the estimate floor
    const pace = await computeMeasuredPace(new ModelAnalytics(db));
    expect(pace.rows.map((r) => r.modelId)).toEqual(['model-solid']);
    expect(pace.thin).toBe(1);
  });

  it('scrubs control characters from foreign model ids at the compute choke point', async () => {
    // eslint-disable-next-line no-control-regex -- asserting their absence IS the point
    seed('evil\u001b[31mmodel', 6);
    const pace = await computeMeasuredPace(new ModelAnalytics(db));
    expect(pace.rows.length).toBe(1);
    // eslint-disable-next-line no-control-regex -- asserting their absence IS the point
    expect(pace.rows[0].modelId).not.toMatch(/[\x00-\x1f\x7f]/);
    expect(pace.rows[0].modelId).toContain('evil');
  });

  it('an empty store computes zero rows, zero thin, zero more (render prints nothing)', async () => {
    const pace = await computeMeasuredPace(new ModelAnalytics(db));
    expect(pace.rows).toEqual([]);
    expect(pace.thin).toBe(0);
    expect(pace.more).toBe(0);
  });
});
