import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { propagateCorrection, getSupersededHistory } from '../src/memory/correction-propagator.js';
import Database from 'better-sqlite3';
import { existsSync, unlinkSync, mkdirSync } from 'fs';
import { join } from 'path';
import { ensureShortTermSchema, ensureSessionSchema } from '../src/memory/short-term/schema.js';
import { ensureDailyLogSchema } from '../src/memory/daily-log.js';

const TEST_DB = join(process.cwd(), 'test/fixtures/test-correction.db');

describe('CorrectionPropagator', () => {
  beforeEach(() => {
    const dir = join(process.cwd(), 'test/fixtures');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);

    // Setup test DB with some entries
    const db = new Database(TEST_DB);
    ensureShortTermSchema(db);
    ensureSessionSchema(db);
    ensureDailyLogSchema(db);

    db.prepare(`
      INSERT INTO memories (timestamp, type, content, project_id, importance)
      VALUES (?, 'observation', ?, 'default', 5)
    `).run(new Date().toISOString(), 'The deadline is April 1');

    db.prepare(`
      INSERT INTO session_memories (session_id, timestamp, type, content, importance)
      VALUES ('test', ?, 'observation', ?, 5)
    `).run(new Date().toISOString(), 'Project deadline is April 1');

    db.close();
  });

  afterEach(() => {
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
  });

  it('finds and corrects matching entries across tiers', () => {
    const result = propagateCorrection(
      TEST_DB,
      'deadline is April 1',
      'The deadline is March 15',
      'Date was moved up'
    );

    expect(result.originalFound).toBe(true);
    expect(result.tiersUpdated).toContain('memories');
    expect(result.tiersUpdated).toContain('session_memories');
    expect(result.tiersUpdated).toContain('daily_log');
    expect(result.supersededCount).toBeGreaterThanOrEqual(2);
  });

  it('always writes correction to daily log', () => {
    const result = propagateCorrection(
      TEST_DB,
      'nonexistent content',
      'Some correction',
      'test'
    );

    expect(result.tiersUpdated).toContain('daily_log');
  });

  it('creates a new corrected entry in working memory', () => {
    const result = propagateCorrection(
      TEST_DB,
      'deadline is April 1',
      'The deadline is March 15'
    );

    expect(result.correctedEntryId).toBeDefined();
    expect(result.correctedEntryId).toBeGreaterThan(0);
  });

  it('preserves superseded history', () => {
    propagateCorrection(
      TEST_DB,
      'deadline is April 1',
      'The deadline is March 15',
      'Date moved up'
    );

    const history = getSupersededHistory(TEST_DB);
    expect(history.length).toBeGreaterThan(0);
    expect(history[0].tier).toBeDefined();
    expect(history[0].reason).toBe('Date moved up');
  });

  it('handles missing database gracefully', () => {
    const result = propagateCorrection(
      '/nonexistent/path.db',
      'anything',
      'corrected'
    );
    expect(result.originalFound).toBe(false);
    expect(result.tiersUpdated).toEqual([]);
  });
});
