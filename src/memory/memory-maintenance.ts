/**
 * Automated Memory Maintenance
 *
 * Periodic maintenance tasks: verify stale claims, prune decayed entries,
 * consolidate daily logs, and surface maintenance recommendations.
 *
 * Inspired by Total Recall's maintenance cadences and Clawe's heartbeat system.
 */

import Database from 'better-sqlite3';
import { existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { ensureDailyLogSchema } from './daily-log.js';

export interface MaintenanceResult {
  staleEntriesPruned: number;
  decayedEntriesUpdated: number;
  dailyLogsArchived: number;
  duplicatesRemoved: number;
  staleWorktrees: string[];
  recommendations: string[];
}

export interface MaintenanceConfig {
  staleDaysThreshold: number;
  decayRate: number;
  minImportanceAfterDecay: number;
  archiveDaysOld: number;
  duplicateSimilarityThreshold: number;
}

const DEFAULT_CONFIG: MaintenanceConfig = {
  staleDaysThreshold: 14,
  decayRate: 0.95,
  minImportanceAfterDecay: 1,
  archiveDaysOld: 30,
  duplicateSimilarityThreshold: 0.92,
};

/**
 * Run full maintenance cycle on the memory database.
 */
export function runMaintenance(
  dbPath: string,
  config: Partial<MaintenanceConfig> = {}
): MaintenanceResult {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const result: MaintenanceResult = {
    staleEntriesPruned: 0,
    decayedEntriesUpdated: 0,
    dailyLogsArchived: 0,
    duplicatesRemoved: 0,
    staleWorktrees: [],
    recommendations: [],
  };

  if (!existsSync(dbPath)) {
    result.recommendations.push('Database not found. Run `uam init` first.');
    return result;
  }

  const db = new Database(dbPath);

  try {
    // 1. Apply importance decay to old memories
    result.decayedEntriesUpdated = applyDecay(db, cfg);

    // 2. Prune entries that decayed below minimum importance
    result.staleEntriesPruned = pruneStale(db, cfg);

    // 3. Archive old daily log entries
    result.dailyLogsArchived = archiveDailyLogs(db, cfg);

    // 4. Remove duplicates
    result.duplicatesRemoved = removeDuplicates(db);

    // 5. Detect stale worktrees
    result.staleWorktrees = detectStaleWorktrees(dbPath, cfg);

    // 6. Generate recommendations
    result.recommendations = generateRecommendations(db, cfg, result.staleWorktrees);

  } finally {
    db.close();
  }

  return result;
}

function applyDecay(db: Database.Database, cfg: MaintenanceConfig): number {
  const now = Date.now();
  let updated = 0;

  try {
    const rows = db.prepare(`
      SELECT id, importance, timestamp
      FROM memories
      WHERE importance > ?
    `).all(cfg.minImportanceAfterDecay) as Array<{ id: number; importance: number; timestamp: string }>;

    const updateStmt = db.prepare('UPDATE memories SET importance = ? WHERE id = ?');

    for (const row of rows) {
      const daysSince = (now - new Date(row.timestamp).getTime()) / (1000 * 60 * 60 * 24);
      if (daysSince < 1) continue; // Skip recent entries

      const decayed = Math.round(row.importance * Math.pow(cfg.decayRate, daysSince));
      if (decayed !== row.importance && decayed >= cfg.minImportanceAfterDecay) {
        updateStmt.run(decayed, row.id);
        updated++;
      }
    }
  } catch {
    // Table might not exist
  }

  try {
    const rows = db.prepare(`
      SELECT id, importance, timestamp
      FROM session_memories
      WHERE importance > ?
    `).all(cfg.minImportanceAfterDecay) as Array<{ id: number; importance: number; timestamp: string }>;

    const updateStmt = db.prepare('UPDATE session_memories SET importance = ? WHERE id = ?');

    for (const row of rows) {
      const daysSince = (now - new Date(row.timestamp).getTime()) / (1000 * 60 * 60 * 24);
      if (daysSince < 1) continue;

      const decayed = Math.round(row.importance * Math.pow(cfg.decayRate, daysSince));
      if (decayed !== row.importance && decayed >= cfg.minImportanceAfterDecay) {
        updateStmt.run(decayed, row.id);
        updated++;
      }
    }
  } catch {
    // Table might not exist
  }

  return updated;
}

function pruneStale(db: Database.Database, cfg: MaintenanceConfig): number {
  let pruned = 0;
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - cfg.staleDaysThreshold);
  const cutoff = cutoffDate.toISOString();

  try {
    const result = db.prepare(`
      DELETE FROM memories
      WHERE importance <= ? AND timestamp < ?
    `).run(cfg.minImportanceAfterDecay, cutoff);
    pruned += result.changes;
  } catch {
    // Table might not exist
  }

  try {
    const result = db.prepare(`
      DELETE FROM session_memories
      WHERE importance <= ? AND timestamp < ?
    `).run(cfg.minImportanceAfterDecay, cutoff);
    pruned += result.changes;
  } catch {
    // Table might not exist
  }

  return pruned;
}

function archiveDailyLogs(db: Database.Database, cfg: MaintenanceConfig): number {
  try {
    ensureDailyLogSchema(db);

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - cfg.archiveDaysOld);
    const cutoffDate = cutoff.toISOString().split('T')[0];

    // Delete promoted entries older than threshold
    const result = db.prepare(`
      DELETE FROM daily_log WHERE date < ? AND promoted = 1
    `).run(cutoffDate);
    return result.changes;
  } catch {
    return 0;
  }
}

function removeDuplicates(db: Database.Database): number {
  let removed = 0;

  try {
    // Remove exact duplicates in memories (keep lowest id)
    const result = db.prepare(`
      DELETE FROM memories
      WHERE id NOT IN (
        SELECT MIN(id) FROM memories GROUP BY content, project_id
      )
    `).run();
    removed += result.changes;
  } catch {
    // Table might not exist
  }

  try {
    // Remove exact duplicates in session_memories
    const result = db.prepare(`
      DELETE FROM session_memories
      WHERE id NOT IN (
        SELECT MIN(id) FROM session_memories GROUP BY content, session_id
      )
    `).run();
    removed += result.changes;
  } catch {
    // Table might not exist
  }

  return removed;
}

function detectStaleWorktrees(dbPath: string, cfg: MaintenanceConfig): string[] {
  // Look for .worktrees directory relative to the DB path
  // DB is typically at agents/data/memory/short_term.db, project root is 3 levels up
  const projectRoot = join(dbPath, '..', '..', '..', '..');
  const worktreesDir = join(projectRoot, '.worktrees');

  if (!existsSync(worktreesDir)) return [];

  const stale: string[] = [];
  const staleDays = cfg.archiveDaysOld; // reuse same threshold
  const cutoff = Date.now() - staleDays * 24 * 60 * 60 * 1000;

  try {
    const entries = readdirSync(worktreesDir);
    for (const entry of entries) {
      const entryPath = join(worktreesDir, entry);
      try {
        const stats = statSync(entryPath);
        if (stats.isDirectory() && stats.mtimeMs < cutoff) {
          stale.push(entry);
        }
      } catch {
        // Skip entries we can't stat
      }
    }
  } catch {
    // Can't read directory
  }

  return stale;
}

function generateRecommendations(db: Database.Database, cfg: MaintenanceConfig, staleWorktrees: string[] = []): string[] {
  const recs: string[] = [];

  try {
    // Check total memory count
    const memCount = (db.prepare('SELECT COUNT(*) as c FROM memories').get() as { c: number }).c;
    if (memCount > 45) {
      recs.push(`Working memory near capacity (${memCount}/50). Consider promoting important entries and pruning old ones.`);
    }

    // Check for stale entries
    const staleDate = new Date();
    staleDate.setDate(staleDate.getDate() - cfg.staleDaysThreshold);
    const staleCount = (db.prepare(`
      SELECT COUNT(*) as c FROM memories WHERE timestamp < ? AND importance <= 3
    `).get(staleDate.toISOString()) as { c: number }).c;

    if (staleCount > 0) {
      recs.push(`${staleCount} stale entries with low importance found. Run maintenance again or review manually.`);
    }
  } catch {
    // Table might not exist
  }

  try {
    // Check unpromoted daily log entries
    ensureDailyLogSchema(db);
    const unpromoted = (db.prepare(`
      SELECT COUNT(*) as c FROM daily_log WHERE promoted = 0
    `).get() as { c: number }).c;

    if (unpromoted > 10) {
      recs.push(`${unpromoted} unpromoted daily log entries. Run \`uam memory promote\` to review.`);
    }
  } catch {
    // Table might not exist
  }

  try {
    // Check for entries with very low importance
    const lowImp = (db.prepare(`
      SELECT COUNT(*) as c FROM session_memories WHERE importance <= 2
    `).get() as { c: number }).c;

    if (lowImp > 20) {
      recs.push(`${lowImp} session memories with very low importance. These may be pruned on next maintenance.`);
    }
  } catch {
    // Table might not exist
  }

  if (staleWorktrees.length > 0) {
    recs.push(`${staleWorktrees.length} stale worktrees found (>${cfg.archiveDaysOld} days old): ${staleWorktrees.slice(0, 5).join(', ')}${staleWorktrees.length > 5 ? '...' : ''}. Run \`uam worktree cleanup <id>\` to remove.`);
  }

  if (recs.length === 0) {
    recs.push('Memory system is healthy. No action needed.');
  }

  return recs;
}

/**
 * Get a quick health summary without running full maintenance.
 */
export function getHealthSummary(dbPath: string): {
  memoriesCount: number;
  sessionCount: number;
  dailyLogCount: number;
  staleCount: number;
  unpromotedCount: number;
  healthy: boolean;
} {
  const summary = {
    memoriesCount: 0,
    sessionCount: 0,
    dailyLogCount: 0,
    staleCount: 0,
    unpromotedCount: 0,
    healthy: true,
  };

  if (!existsSync(dbPath)) return summary;

  const db = new Database(dbPath, { readonly: true });
  try {
    try {
      summary.memoriesCount = (db.prepare('SELECT COUNT(*) as c FROM memories').get() as { c: number }).c;
    } catch { /* table doesn't exist */ }

    try {
      summary.sessionCount = (db.prepare('SELECT COUNT(*) as c FROM session_memories').get() as { c: number }).c;
    } catch { /* table doesn't exist */ }

    try {
      summary.dailyLogCount = (db.prepare('SELECT COUNT(*) as c FROM daily_log').get() as { c: number }).c;
      summary.unpromotedCount = (db.prepare('SELECT COUNT(*) as c FROM daily_log WHERE promoted = 0').get() as { c: number }).c;
    } catch { /* table doesn't exist */ }

    const staleDate = new Date();
    staleDate.setDate(staleDate.getDate() - 14);
    try {
      summary.staleCount = (db.prepare(`
        SELECT COUNT(*) as c FROM memories WHERE timestamp < ? AND importance <= 3
      `).get(staleDate.toISOString()) as { c: number }).c;
    } catch { /* table doesn't exist */ }

    summary.healthy = summary.memoriesCount <= 45 && summary.staleCount < 10 && summary.unpromotedCount < 20;
  } finally {
    db.close();
  }

  return summary;
}
