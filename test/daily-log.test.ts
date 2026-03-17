import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DailyLog } from '../src/memory/daily-log.js';
import { existsSync, unlinkSync, mkdirSync } from 'fs';
import { join } from 'path';

const TEST_DB = join(process.cwd(), 'test/fixtures/test-daily-log.db');

describe('DailyLog', () => {
  let log: DailyLog;

  beforeEach(() => {
    const dir = join(process.cwd(), 'test/fixtures');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
    log = new DailyLog(TEST_DB);
  });

  afterEach(() => {
    log.close();
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
  });

  it('writes entries to today\'s date', () => {
    const id = log.write('Test memory content', 'observation', 0.5);
    expect(id).toBeGreaterThan(0);

    const today = new Date().toISOString().split('T')[0];
    const entries = log.getByDate(today);
    expect(entries.length).toBe(1);
    expect(entries[0].content).toBe('Test memory content');
    expect(entries[0].date).toBe(today);
  });

  it('tracks unpromoted entries', () => {
    log.write('Entry 1', 'action', 0.6);
    log.write('Entry 2', 'thought', 0.8);
    log.write('Entry 3', 'observation', 0.2);

    const unpromoted = log.getUnpromoted();
    expect(unpromoted.length).toBe(3);
  });

  it('marks entries as promoted', () => {
    const id = log.write('Promote me', 'action', 0.7);
    log.markPromoted(id, 'working');

    const unpromoted = log.getUnpromoted();
    expect(unpromoted.length).toBe(0);
  });

  it('returns promotion candidates sorted by gate score', () => {
    log.write('Low score entry', 'observation', 0.1);
    log.write('High score entry', 'action', 0.8);
    log.write('Medium score entry', 'thought', 0.5);

    const candidates = log.getPromotionCandidates(0.3);
    expect(candidates.length).toBe(2); // 0.8 and 0.5, not 0.1
    expect(candidates[0].entry.gateScore).toBeGreaterThanOrEqual(candidates[1].entry.gateScore);
  });

  it('suggests correct tier based on score', () => {
    log.write('High importance', 'goal', 0.9);
    log.write('Moderate importance', 'observation', 0.4);

    const candidates = log.getPromotionCandidates(0.3);
    const high = candidates.find(c => c.entry.content === 'High importance');
    const moderate = candidates.find(c => c.entry.content === 'Moderate importance');

    expect(high?.suggestedTier).toBe('working');
    expect(moderate?.suggestedTier).toBe('semantic');
  });

  it('returns correct stats', () => {
    log.write('A', 'action', 0.5);
    log.write('B', 'action', 0.6);
    const id = log.write('C', 'action', 0.7);
    log.markPromoted(id, 'working');

    const stats = log.getStats();
    expect(stats.total).toBe(3);
    expect(stats.unpromoted).toBe(2);
    expect(stats.promoted).toBe(1);
    expect(stats.todayCount).toBe(3);
  });
});
