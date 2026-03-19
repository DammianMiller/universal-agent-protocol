/**
 * Adaptive Pattern Engine for UAP
 *
 * Tracks pattern outcomes per task category and returns patterns sorted
 * by historical success rate. Enables the system to learn which patterns
 * work best for different types of tasks over time.
 *
 * Now with SQLite persistence — outcomes survive across process restarts.
 */

import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';

export interface PatternOutcome {
  uses: number;
  successes: number;
}

export interface AdaptedPattern {
  id: string;
  content: string;
  successRate: number;
}

export interface PatternStats {
  uses: number;
  successes: number;
  rate: number;
}

/**
 * Ensure the pattern_outcomes table exists in the given database.
 */
function ensurePatternOutcomesSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pattern_outcomes (
      pattern_id TEXT NOT NULL,
      task_category TEXT NOT NULL,
      uses INTEGER NOT NULL DEFAULT 0,
      successes INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (pattern_id, task_category)
    );
    CREATE INDEX IF NOT EXISTS idx_pattern_outcomes_category
      ON pattern_outcomes(task_category);
  `);
}

/**
 * AdaptivePatternEngine learns which patterns work best for different
 * task categories by tracking success/failure outcomes.
 *
 * Supports optional SQLite persistence via `attachDb()`.
 */
export class AdaptivePatternEngine {
  /**
   * Map<patternId, Map<taskCategory, PatternOutcome>>
   * Tracks per-pattern, per-category success rates.
   */
  private outcomes: Map<string, Map<string, PatternOutcome>> = new Map();

  /**
   * Optional content store: Map<patternId, content>
   * Populated when outcomes are recorded so getAdaptedPatterns can return content.
   */
  private patternContent: Map<string, string> = new Map();

  /**
   * Optional SQLite database for persistence.
   */
  private db: Database.Database | null = null;
  private flushStmt: Database.Statement | null = null;

  /**
   * Attach a SQLite database for persistent outcome storage.
   * Loads existing outcomes from the database into memory.
   */
  attachDb(dbPath: string): void {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('busy_timeout = 5000');
    ensurePatternOutcomesSchema(this.db);

    // Prepare the upsert statement for flushing
    this.flushStmt = this.db.prepare(`
      INSERT INTO pattern_outcomes (pattern_id, task_category, uses, successes, updated_at)
      VALUES (?, ?, ?, ?, datetime('now'))
      ON CONFLICT(pattern_id, task_category) DO UPDATE SET
        uses = excluded.uses,
        successes = excluded.successes,
        updated_at = excluded.updated_at
    `);

    // Load existing outcomes from DB into memory
    this.loadFromDb();
  }

  /**
   * Load all persisted outcomes into the in-memory maps.
   */
  private loadFromDb(): void {
    if (!this.db) return;

    const rows = this.db
      .prepare('SELECT pattern_id, task_category, uses, successes FROM pattern_outcomes')
      .all() as Array<{ pattern_id: string; task_category: string; uses: number; successes: number }>;

    for (const row of rows) {
      if (!this.outcomes.has(row.pattern_id)) {
        this.outcomes.set(row.pattern_id, new Map());
      }
      this.outcomes.get(row.pattern_id)!.set(row.task_category, {
        uses: row.uses,
        successes: row.successes,
      });

      // Set default content if not already present
      if (!this.patternContent.has(row.pattern_id)) {
        this.patternContent.set(row.pattern_id, row.pattern_id);
      }
    }
  }

  /**
   * Flush a single outcome to the database.
   */
  private flushOutcome(patternId: string, taskCategory: string, outcome: PatternOutcome): void {
    if (!this.db || !this.flushStmt) return;
    try {
      this.flushStmt.run(patternId, taskCategory, outcome.uses, outcome.successes);
    } catch {
      // Non-fatal: DB write failure doesn't break in-memory operation
    }
  }

  /**
   * Record the outcome of applying a pattern to a task.
   *
   * @param patternId - Identifier of the pattern (e.g. "P12")
   * @param success - Whether the task completed successfully
   * @param taskCategory - Category of the task (e.g. "security", "refactor")
   */
  recordPatternOutcome(patternId: string, success: boolean, taskCategory: string): void {
    if (!this.outcomes.has(patternId)) {
      this.outcomes.set(patternId, new Map());
    }

    const categoryMap = this.outcomes.get(patternId)!;
    if (!categoryMap.has(taskCategory)) {
      categoryMap.set(taskCategory, { uses: 0, successes: 0 });
    }

    const outcome = categoryMap.get(taskCategory)!;
    outcome.uses += 1;
    if (success) {
      outcome.successes += 1;
    }

    // Store a default content string if not already present
    if (!this.patternContent.has(patternId)) {
      this.patternContent.set(patternId, patternId);
    }

    // Persist to SQLite immediately
    this.flushOutcome(patternId, taskCategory, outcome);
  }

  /**
   * Set content for a pattern (optional, for richer results).
   */
  setPatternContent(patternId: string, content: string): void {
    this.patternContent.set(patternId, content);
  }

  /**
   * Get patterns sorted by success rate for a given task category.
   *
   * @param taskCategory - Category to filter by
   * @param limit - Maximum number of patterns to return (default: 10)
   * @returns Patterns sorted by success rate descending
   */
  getAdaptedPatterns(taskCategory: string, limit: number = 10): AdaptedPattern[] {
    const results: AdaptedPattern[] = [];

    for (const [patternId, categoryMap] of this.outcomes) {
      const outcome = categoryMap.get(taskCategory);
      if (!outcome) continue;

      const successRate = outcome.uses > 0 ? outcome.successes / outcome.uses : 0;
      results.push({
        id: patternId,
        content: this.patternContent.get(patternId) || patternId,
        successRate,
      });
    }

    results.sort((a, b) => b.successRate - a.successRate);
    return results.slice(0, limit);
  }

  /**
   * Get aggregated stats for all tracked patterns across all categories.
   *
   * @returns Map of patternId to aggregate stats
   */
  getPatternStats(): Record<string, PatternStats> {
    const stats: Record<string, PatternStats> = {};

    for (const [patternId, categoryMap] of this.outcomes) {
      let totalUses = 0;
      let totalSuccesses = 0;

      for (const outcome of categoryMap.values()) {
        totalUses += outcome.uses;
        totalSuccesses += outcome.successes;
      }

      stats[patternId] = {
        uses: totalUses,
        successes: totalSuccesses,
        rate: totalUses > 0 ? totalSuccesses / totalUses : 0,
      };
    }

    return stats;
  }

  /**
   * Close the database connection if attached.
   */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
      this.flushStmt = null;
    }
  }
}

// Singleton
let instance: AdaptivePatternEngine | null = null;

export function getAdaptivePatternEngine(dbPath?: string): AdaptivePatternEngine {
  if (!instance) {
    instance = new AdaptivePatternEngine();
    if (dbPath) {
      instance.attachDb(dbPath);
    }
  }
  return instance;
}

/**
 * Reset the singleton (for testing).
 */
export function resetAdaptivePatternEngine(): void {
  if (instance) {
    instance.close();
    instance = null;
  }
}
