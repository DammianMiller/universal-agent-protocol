import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { runMaintenance, getHealthSummary } from '../src/memory/memory-maintenance.js';
import Database from 'better-sqlite3';
import { existsSync, unlinkSync, mkdirSync } from 'fs';
import { join } from 'path';
import { ensureShortTermSchema, ensureSessionSchema } from '../src/memory/short-term/schema.js';
import { ensureDailyLogSchema } from '../src/memory/daily-log.js';

const TEST_DB = join(process.cwd(), 'test/fixtures/test-maintenance.db');

describe('MemoryMaintenance', () => {
  beforeEach(() => {
    const dir = join(process.cwd(), 'test/fixtures');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);

    const db = new Database(TEST_DB);
    ensureShortTermSchema(db);
    ensureSessionSchema(db);
    ensureDailyLogSchema(db);

    // Add some old memories with low importance
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 30);

    for (let i = 0; i < 5; i++) {
      db.prepare(`
        INSERT INTO memories (timestamp, type, content, project_id, importance)
        VALUES (?, 'observation', ?, 'default', 1)
      `).run(oldDate.toISOString(), `Old memory ${i}`);
    }

    // Add some recent memories
    for (let i = 0; i < 3; i++) {
      db.prepare(`
        INSERT INTO memories (timestamp, type, content, project_id, importance)
        VALUES (?, 'action', ?, 'default', 7)
      `).run(new Date().toISOString(), `Recent memory ${i}`);
    }

    // Add duplicate memories
    db.prepare(`
      INSERT INTO memories (timestamp, type, content, project_id, importance)
      VALUES (?, 'observation', 'Duplicate content here', 'default', 5)
    `).run(new Date().toISOString());
    db.prepare(`
      INSERT INTO memories (timestamp, type, content, project_id, importance)
      VALUES (?, 'observation', 'Duplicate content here', 'default', 5)
    `).run(new Date().toISOString());

    db.close();
  });

  afterEach(() => {
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
  });

  it('prunes stale low-importance entries', () => {
    const result = runMaintenance(TEST_DB);
    expect(result.staleEntriesPruned).toBeGreaterThan(0);
  });

  it('removes duplicate entries', () => {
    const result = runMaintenance(TEST_DB);
    expect(result.duplicatesRemoved).toBeGreaterThan(0);
  });

  it('generates recommendations', () => {
    const result = runMaintenance(TEST_DB);
    expect(result.recommendations.length).toBeGreaterThan(0);
  });

  it('returns health summary', () => {
    const summary = getHealthSummary(TEST_DB);
    expect(summary.memoriesCount).toBeGreaterThan(0);
  });

  it('handles missing database gracefully', () => {
    const result = runMaintenance('/nonexistent/path.db');
    expect(result.recommendations).toContain('Database not found. Run `uap init` first.');
  });

  it('health summary handles missing database', () => {
    const summary = getHealthSummary('/nonexistent/path.db');
    expect(summary.memoriesCount).toBe(0);
    expect(summary.healthy).toBe(true);
  });
});
