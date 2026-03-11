/**
 * Daily Log - Staging area for memory writes.
 *
 * All memories land here first. Promotion to working/semantic memory
 * is a separate step controlled by the user via `uam memory promote`.
 * Inspired by Total Recall's "daily log first, promote later" pattern.
 */

import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';

export interface DailyLogEntry {
  id: number;
  date: string;
  timestamp: string;
  content: string;
  type: string;
  promoted: boolean;
  promotedTo?: string;
  gateScore: number;
}

export interface PromotionCandidate {
  entry: DailyLogEntry;
  suggestedTier: 'working' | 'semantic';
  reason: string;
}

export function ensureDailyLogSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS daily_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      content TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'observation',
      promoted INTEGER NOT NULL DEFAULT 0,
      promoted_to TEXT,
      gate_score REAL NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_daily_log_date ON daily_log(date);
    CREATE INDEX IF NOT EXISTS idx_daily_log_promoted ON daily_log(promoted);
  `);
}

export class DailyLog {
  private db: Database.Database;

  constructor(dbPath: string) {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(dbPath);
    ensureDailyLogSchema(this.db);
  }

  /**
   * Write an entry to today's daily log.
   */
  write(content: string, type: string = 'observation', gateScore: number = 0): number {
    const now = new Date();
    const date = now.toISOString().split('T')[0];
    const timestamp = now.toISOString();

    const stmt = this.db.prepare(`
      INSERT INTO daily_log (date, timestamp, content, type, gate_score)
      VALUES (?, ?, ?, ?, ?)
    `);
    const result = stmt.run(date, timestamp, content, type, gateScore);
    return Number(result.lastInsertRowid);
  }

  /**
   * Get entries for a specific date (default: today).
   */
  getByDate(date?: string): DailyLogEntry[] {
    const d = date || new Date().toISOString().split('T')[0];
    const stmt = this.db.prepare(`
      SELECT id, date, timestamp, content, type,
             promoted, promoted_to as promotedTo, gate_score as gateScore
      FROM daily_log
      WHERE date = ?
      ORDER BY id DESC
    `);
    return stmt.all(d) as DailyLogEntry[];
  }

  /**
   * Get unpromoted entries across all dates (candidates for promotion).
   */
  getUnpromoted(limit: number = 50): DailyLogEntry[] {
    const stmt = this.db.prepare(`
      SELECT id, date, timestamp, content, type,
             promoted, promoted_to as promotedTo, gate_score as gateScore
      FROM daily_log
      WHERE promoted = 0
      ORDER BY gate_score DESC, id DESC
      LIMIT ?
    `);
    return stmt.all(limit) as DailyLogEntry[];
  }

  /**
   * Get promotion candidates - entries scored high enough to promote.
   */
  getPromotionCandidates(minScore: number = 0.3): PromotionCandidate[] {
    const entries = this.getUnpromoted();
    return entries
      .filter(e => e.gateScore >= minScore)
      .map(e => ({
        entry: e,
        suggestedTier: e.gateScore >= 0.6 ? 'working' as const : 'semantic' as const,
        reason: e.gateScore >= 0.6
          ? 'High gate score - likely behavior-changing or commitment'
          : 'Moderate gate score - durable fact or decision',
      }));
  }

  /**
   * Mark an entry as promoted.
   */
  markPromoted(id: number, tier: string): void {
    const stmt = this.db.prepare(`
      UPDATE daily_log SET promoted = 1, promoted_to = ? WHERE id = ?
    `);
    stmt.run(tier, id);
  }

  /**
   * Archive old entries (>30 days) by marking them.
   */
  archiveOld(daysOld: number = 30): number {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - daysOld);
    const cutoffDate = cutoff.toISOString().split('T')[0];

    const stmt = this.db.prepare(`
      DELETE FROM daily_log WHERE date < ? AND promoted = 1
    `);
    const result = stmt.run(cutoffDate);
    return result.changes;
  }

  /**
   * Get log statistics.
   */
  getStats(): { total: number; unpromoted: number; promoted: number; todayCount: number } {
    const total = (this.db.prepare('SELECT COUNT(*) as c FROM daily_log').get() as { c: number }).c;
    const unpromoted = (this.db.prepare('SELECT COUNT(*) as c FROM daily_log WHERE promoted = 0').get() as { c: number }).c;
    const today = new Date().toISOString().split('T')[0];
    const todayCount = (this.db.prepare('SELECT COUNT(*) as c FROM daily_log WHERE date = ?').get(today) as { c: number }).c;
    return { total, unpromoted, promoted: total - unpromoted, todayCount };
  }

  /**
   * Get recent entries across dates.
   */
  getRecent(limit: number = 20): DailyLogEntry[] {
    const stmt = this.db.prepare(`
      SELECT id, date, timestamp, content, type,
             promoted, promoted_to as promotedTo, gate_score as gateScore
      FROM daily_log
      ORDER BY id DESC
      LIMIT ?
    `);
    return stmt.all(limit) as DailyLogEntry[];
  }

  close(): void {
    this.db.close();
  }
}
