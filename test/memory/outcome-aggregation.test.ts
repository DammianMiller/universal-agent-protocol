import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import {
  parseDeliverLesson,
  collectDeliverOutcomes,
  aggregateDeliverOutcomes,
  type DeliverOutcomeRow,
} from '../../src/memory/outcome-aggregation.js';
import { ensureDailyLogSchema } from '../../src/memory/daily-log.js';

/**
 * The lesson format is the deliver loop's own emission contract:
 *   [deliver] <outcome> [after|in] N turn(s)[, best X% of gates] — model M — task: T
 * including the STOPPED variant whose parenthetical itself contains an em dash.
 */
describe('parseDeliverLesson — the emission contract', () => {
  it('parses a not-delivered lesson with gates', () => {
    const r = parseDeliverLesson(
      '(lesson, i7) [deliver] NOT delivered after 17 turn(s), best 83% of gates — model qwen35-a3b — task: Fix security gap in src/delivery/user-validation.ts: X'
    );
    expect(r).toEqual({
      outcome: 'not-delivered',
      turns: 17,
      gatesPct: 83,
      model: 'qwen35-a3b',
      task: 'Fix security gap in src/delivery/user-validation.ts: X',
    });
  });

  it('parses a STOPPED lesson whose parenthetical contains an em dash', () => {
    const r = parseDeliverLesson(
      '(lesson, i7) [deliver] STOPPED (interrupted, resumable — not a gate failure) after 5 turn(s), best 83% of gates — model qwen35-a3b — task: Harden the UAP'
    );
    expect(r).toMatchObject({ outcome: 'stopped', turns: 5, gatesPct: 83, model: 'qwen35-a3b' });
  });

  it('parses a delivered lesson that omits the gates share', () => {
    const r = parseDeliverLesson(
      '(decision, i6) [deliver] delivered in 1 turn(s) — model qwen35-a3b — task: [mission:#1:131c4b30] Create the file'
    );
    expect(r).toMatchObject({ outcome: 'delivered', turns: 1, gatesPct: null, model: 'qwen35-a3b' });
  });

  it('returns null (uncounted, never miscounted) when essential fields are absent', () => {
    expect(parseDeliverLesson('[deliver] something else entirely')).toBeNull();
    expect(parseDeliverLesson('no marker at all')).toBeNull();
  });
});

describe('aggregateDeliverOutcomes — model table', () => {
  function row(over: Partial<DeliverOutcomeRow>): DeliverOutcomeRow {
    return {
      outcome: 'not-delivered',
      turns: 10,
      gatesPct: 50,
      model: 'm',
      task: 't',
      source: 'daily-log',
      ...over,
    };
  }

  it('aggregates per model with means, bests, and outcome counts', () => {
    const aggs = aggregateDeliverOutcomes([
      row({ model: 'a', gatesPct: 83, outcome: 'not-delivered', turns: 17 }),
      row({ model: 'a', gatesPct: 33, outcome: 'not-delivered', turns: 13 }),
      row({ model: 'a', gatesPct: null, outcome: 'delivered', turns: 1 }),
      row({ model: 'b', gatesPct: 0, outcome: 'not-delivered', turns: 5 }),
    ]);
    expect(aggs.length).toBe(2);
    const a = aggs[0]; // most runs first
    expect(a.model).toBe('a');
    expect(a.runs).toBe(3);
    expect(a.delivered).toBe(1);
    expect(a.notDelivered).toBe(2);
    expect(a.bestGatesMean).toBeCloseTo((83 + 33) / 2, 10);
    expect(a.bestGatesBest).toBe(83);
    expect(a.turnsMean).toBeCloseTo((17 + 13 + 1) / 3, 10);
    const b = aggs[1];
    expect(b.bestGatesMean).toBe(0); // 0% is a real measurement, not a null
    expect(b.bestGatesBest).toBe(0);
  });

  it('reports null gates aggregates only when no run reported gates', () => {
    const aggs = aggregateDeliverOutcomes([row({ model: 'x', gatesPct: null })]);
    expect(aggs[0].bestGatesMean).toBeNull();
    expect(aggs[0].bestGatesBest).toBeNull();
  });
});

describe('collectDeliverOutcomes — substrates and coverage', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'uap-outcomes-'));
    mkdirSync(join(cwd, 'agents', 'data', 'memory'), { recursive: true });
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it('reads the daily-log substrate and labels it in coverage', () => {
    const db = new Database(join(cwd, 'agents', 'data', 'memory', 'short_term.db'));
    ensureDailyLogSchema(db);
    db.prepare(
      'INSERT INTO daily_log (date, timestamp, content, type, gate_score) VALUES (?, ?, ?, ?, 0)'
    ).run(
      '2026-11-21',
      '2026-11-21T10:00:00Z',
      '[deliver] NOT delivered after 9 turn(s), best 42% of gates — model m1 — task: t',
      'lesson'
    );
    db.close();

    const ds = collectDeliverOutcomes(cwd, undefined);
    expect(ds.rows.length).toBe(1);
    expect(ds.rows[0].source).toBe('daily-log');
    expect(ds.coverage.find((c) => c.source === 'daily-log')?.rows).toBe(1);
  });

  it('reads the bridge-mirror substrate, deduping lessons present in both', () => {
    const db = new Database(join(cwd, 'agents', 'data', 'memory', 'short_term.db'));
    ensureDailyLogSchema(db);
    db.prepare(
      'INSERT INTO daily_log (date, timestamp, content, type, gate_score) VALUES (?, ?, ?, ?, 0)'
    ).run(
      '2026-11-21',
      '2026-11-21T10:00:00Z',
      '[deliver] NOT delivered after 9 turn(s), best 42% of gates — model m1 — task: same lesson lands twice',
      'lesson'
    );
    db.close();
    writeFileSync(
      join(cwd, 'CLAUDE.md'),
      [
        '<!-- UAP-MEMORY-BRIDGE:START -->',
        'Recent UAP memories:',
        '  - (lesson, i7) [deliver] NOT delivered after 9 turn(s), best 42% of gates — model m1 — task: same lesson lands twice',
        '  - (lesson, i7) [deliver] NOT delivered after 4 turn(s), best 25% of gates — model m2 — task: bridge-only lesson',
        '<!-- UAP-MEMORY-BRIDGE:END -->',
        '',
      ].join('\n')
    );

    const ds = collectDeliverOutcomes(cwd, undefined);
    // The duplicated lesson counts once; the bridge-only one adds a row.
    expect(ds.rows.length).toBe(2);
    expect(ds.rows.filter((r) => r.source === 'bridge-mirror').length).toBe(1);
    expect(ds.coverage.find((c) => c.source === 'bridge-mirror')?.rows).toBe(1);
    expect(ds.aggregates.map((a) => a.model).sort()).toEqual(['m1', 'm2']);
  });

  it('returns empty coverage honestly when no substrate holds lessons', () => {
    const ds = collectDeliverOutcomes(cwd, undefined);
    expect(ds.rows).toEqual([]);
    expect(ds.aggregates).toEqual([]);
    expect(ds.coverage.length).toBe(2);
  });
});
