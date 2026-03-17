/**
 * Correction Propagation Protocol
 *
 * When a memory is corrected, updates propagate across all tiers:
 * daily log, working memory, and session memory. Old claims are marked
 * [superseded] with date and reason, preserving the audit trail.
 *
 * Inspired by Total Recall's correction gate.
 */

import Database from 'better-sqlite3';
import { existsSync } from 'fs';
import { ensureDailyLogSchema } from './daily-log.js';

export interface CorrectionResult {
  originalFound: boolean;
  originalId?: number;
  originalContent?: string;
  tiersUpdated: string[];
  supersededCount: number;
  correctedEntryId?: number;
}

export interface SupersededEntry {
  id: number;
  tier: string;
  originalContent: string;
  supersededDate: string;
  supersededBy: string;
  reason: string;
}

/**
 * Ensure the superseded tracking table exists.
 */
export function ensureSupersededSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS superseded_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tier TEXT NOT NULL,
      original_entry_id INTEGER,
      original_content TEXT NOT NULL,
      corrected_content TEXT NOT NULL,
      superseded_date TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT 'correction'
    );
    CREATE INDEX IF NOT EXISTS idx_superseded_date ON superseded_entries(superseded_date);
  `);
}

/**
 * Propagate a correction across all memory tiers.
 *
 * @param dbPath Path to the SQLite database
 * @param searchContent Content to find and correct (fuzzy match)
 * @param correctedContent The corrected version
 * @param reason Why the correction was made
 */
export function propagateCorrection(
  dbPath: string,
  searchContent: string,
  correctedContent: string,
  reason: string = 'user correction'
): CorrectionResult {
  if (!existsSync(dbPath)) {
    return { originalFound: false, tiersUpdated: [], supersededCount: 0 };
  }

  const db = new Database(dbPath);
  ensureSupersededSchema(db);
  ensureDailyLogSchema(db);

  const result: CorrectionResult = {
    originalFound: false,
    tiersUpdated: [],
    supersededCount: 0,
  };

  const now = new Date().toISOString();
  const today = now.split('T')[0];
  const searchLower = searchContent.toLowerCase();

  try {
    // 1. Search in memories (working memory / L1)
    const memRows = db.prepare(`
      SELECT id, content FROM memories
      WHERE LOWER(content) LIKE ?
      ORDER BY id DESC
      LIMIT 5
    `).all(`%${searchLower}%`) as Array<{ id: number; content: string }>;

    for (const row of memRows) {
      result.originalFound = true;
      result.originalId = result.originalId || row.id;
      result.originalContent = result.originalContent || row.content;

      // Record superseded entry
      db.prepare(`
        INSERT INTO superseded_entries (tier, original_entry_id, original_content, corrected_content, superseded_date, reason)
        VALUES ('memories', ?, ?, ?, ?, ?)
      `).run(row.id, row.content, correctedContent, now, reason);

      // Update the memory in-place (prepend [corrected] marker)
      db.prepare(`
        UPDATE memories SET content = ? WHERE id = ?
      `).run(`[corrected ${today}] ${correctedContent}`, row.id);

      result.supersededCount++;
    }
    if (memRows.length > 0) {
      result.tiersUpdated.push('memories');
    }

    // 2. Search in session_memories (L2)
    const sessRows = db.prepare(`
      SELECT id, content FROM session_memories
      WHERE LOWER(content) LIKE ?
      ORDER BY id DESC
      LIMIT 5
    `).all(`%${searchLower}%`) as Array<{ id: number; content: string }>;

    for (const row of sessRows) {
      result.originalFound = true;

      db.prepare(`
        INSERT INTO superseded_entries (tier, original_entry_id, original_content, corrected_content, superseded_date, reason)
        VALUES ('session_memories', ?, ?, ?, ?, ?)
      `).run(row.id, row.content, correctedContent, now, reason);

      db.prepare(`
        UPDATE session_memories SET content = ? WHERE id = ?
      `).run(`[corrected ${today}] ${correctedContent}`, row.id);

      result.supersededCount++;
    }
    if (sessRows.length > 0) {
      result.tiersUpdated.push('session_memories');
    }

    // 3. Always write the correction to the daily log
    db.prepare(`
      INSERT INTO daily_log (date, timestamp, content, type, gate_score)
      VALUES (?, ?, ?, 'correction', 1.0)
    `).run(today, now, `[CORRECTION] ${reason}: ${correctedContent}`);
    result.tiersUpdated.push('daily_log');

    // 4. Write corrected version as new working memory entry
    const insertResult = db.prepare(`
      INSERT INTO memories (timestamp, type, content, project_id, importance)
      VALUES (?, 'observation', ?, 'default', 8)
    `).run(now, correctedContent);
    result.correctedEntryId = Number(insertResult.lastInsertRowid);

    // Update FTS if available
    try {
      db.prepare(`
        INSERT INTO memories_fts(rowid, content, type)
        VALUES (?, ?, 'observation')
      `).run(result.correctedEntryId, correctedContent);
    } catch {
      // FTS not available
    }
  } finally {
    db.close();
  }

  return result;
}

/**
 * Get the superseded history for audit trail.
 */
export function getSupersededHistory(
  dbPath: string,
  limit: number = 20
): SupersededEntry[] {
  if (!existsSync(dbPath)) return [];

  const db = new Database(dbPath);
  ensureSupersededSchema(db);

  try {
    const rows = db.prepare(`
      SELECT id, tier, original_entry_id, original_content, superseded_date, reason
      FROM superseded_entries
      ORDER BY id DESC
      LIMIT ?
    `).all(limit) as Array<{
      id: number;
      tier: string;
      original_entry_id: number;
      original_content: string;
      superseded_date: string;
      reason: string;
    }>;

    return rows.map(r => ({
      id: r.id,
      tier: r.tier,
      originalContent: r.original_content,
      supersededDate: r.superseded_date,
      supersededBy: '', // Would need to join with corrected content
      reason: r.reason,
    }));
  } finally {
    db.close();
  }
}
