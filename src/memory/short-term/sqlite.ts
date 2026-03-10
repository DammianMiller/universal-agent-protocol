import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { ensureShortTermSchema } from './schema.js';
import { getSpeculativeCache } from '../speculative-cache.js';
import type { ShortTermMemoryBackend } from './factory.js';

interface ShortTermMemory {
  id?: number;
  timestamp: string;
  type: 'action' | 'observation' | 'thought' | 'goal';
  content: string;
  projectId?: string;
  importance?: number;
}

export class SQLiteShortTermMemory implements ShortTermMemoryBackend {
  private db: Database.Database;
  private projectId: string;
  private maxEntries: number;
  private cache = getSpeculativeCache({ maxEntries: 50, ttlMs: 120000, preWarmEnabled: true });

  constructor(config: { dbPath: string; projectId?: string; maxEntries?: number }) {
    // Ensure directory exists
    const dir = dirname(config.dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(config.dbPath);
    this.projectId = config.projectId || 'default';
    this.maxEntries = config.maxEntries || 50;

    // Initialize schema
    this.initSchema();
  }

  private initSchema(): void {
    ensureShortTermSchema(this.db);
  }

  async store(type: ShortTermMemory['type'], content: string, importance: number = 5): Promise<void> {
    const timestamp = new Date().toISOString();
    const stmt = this.db.prepare(`
      INSERT INTO memories (timestamp, type, content, project_id, importance)
      VALUES (?, ?, ?, ?, ?)
    `);
    const result = stmt.run(timestamp, type, content, this.projectId, importance);

    // Update FTS5 index
    try {
      const ftsStmt = this.db.prepare(`
        INSERT INTO memories_fts(rowid, content, type)
        VALUES (?, ?, ?)
      `);
      ftsStmt.run(result.lastInsertRowid, content, type);
    } catch {
      // FTS5 not available, ignore
    }
    
    // Auto-prune if exceeds maxEntries
    await this.prune();
  }

  async storeBatch(
    entries: Array<{ type: ShortTermMemory['type']; content: string; timestamp?: string; importance?: number }>
  ): Promise<void> {
    const stmt = this.db.prepare(`
      INSERT INTO memories (timestamp, type, content, project_id, importance)
      VALUES (?, ?, ?, ?, ?)
    `);

    type EntryType = { type: ShortTermMemory['type']; content: string; timestamp?: string; importance?: number };
    const insertMany = this.db.transaction((items: EntryType[]) => {
      for (const entry of items) {
        stmt.run(
          entry.timestamp || new Date().toISOString(),
          entry.type,
          entry.content,
          this.projectId,
          entry.importance ?? 5
        );
      }
    });

    insertMany(entries);
    await this.prune();
  }

  async getRecent(limit = 50): Promise<ShortTermMemory[]> {
    const stmt = this.db.prepare(`
      SELECT id, timestamp, type, content, project_id as projectId, importance
      FROM memories
      WHERE project_id = ?
      ORDER BY id DESC
      LIMIT ?
    `);
    return stmt.all(this.projectId, limit) as ShortTermMemory[];
  }

  async query(searchTerm: string, limit = 10): Promise<ShortTermMemory[]> {
    // Check speculative cache first
    const cacheKey = `${this.projectId}:${searchTerm}:${limit}`;
    const cached = this.cache.get(cacheKey);
    if (cached) {
      return cached.result as ShortTermMemory[];
    }

    let results: ShortTermMemory[] = [];

    // Sanitize search term for FTS5 - escape special characters and wrap in quotes
    // FTS5 special chars: AND OR NOT * " - ( ) NEAR
    const sanitizedTerm = this.sanitizeFTS5Query(searchTerm);

    // Try FTS5 first for faster full-text search
    try {
      const ftsStmt = this.db.prepare(`
        SELECT m.id, m.timestamp, m.type, m.content, m.project_id as projectId, m.importance
        FROM memories_fts fts
        JOIN memories m ON fts.rowid = m.id
        WHERE memories_fts MATCH ? AND m.project_id = ?
        ORDER BY rank
        LIMIT ?
      `);
      results = ftsStmt.all(sanitizedTerm, this.projectId, limit) as ShortTermMemory[];
    } catch {
      // FTS5 not available or query syntax error, fall through to LIKE
    }

    // Fallback to LIKE search if FTS5 returned nothing
    if (results.length === 0) {
      const stmt = this.db.prepare(`
        SELECT id, timestamp, type, content, project_id as projectId, importance
        FROM memories
        WHERE project_id = ? AND content LIKE ?
        ORDER BY id DESC
        LIMIT ?
      `);
      results = stmt.all(this.projectId, `%${searchTerm}%`, limit) as ShortTermMemory[];
    }

    // Store in cache
    this.cache.set(cacheKey, results);

    // Pre-warm cache for predicted next queries
    this.cache.preWarm(searchTerm, async (q) => {
      const predictedKey = `${this.projectId}:${q}:${limit}`;
      if (!this.cache.get(predictedKey)) {
        return this.queryWithoutCache(q, limit);
      }
      return [];
    }).catch(() => {});

    return results;
  }

  /**
   * Sanitize search term for FTS5 query syntax
   * Wraps each word in double quotes to prevent FTS5 syntax errors from
   * special characters like AND, OR, NOT, *, -, parentheses, etc.
   */
  private sanitizeFTS5Query(searchTerm: string): string {
    const words = searchTerm.trim().split(/\s+/).filter(w => w.length > 0);
    if (words.length === 0) return '""';
    // Quote each word individually and join with spaces (implicit AND)
    return words.map(w => `"${w.replace(/"/g, '""')}"`).join(' ');
  }

  private async queryWithoutCache(searchTerm: string, limit: number): Promise<ShortTermMemory[]> {
    const sanitizedTerm = this.sanitizeFTS5Query(searchTerm);
    try {
      const ftsStmt = this.db.prepare(`
        SELECT m.id, m.timestamp, m.type, m.content, m.project_id as projectId, m.importance
        FROM memories_fts fts
        JOIN memories m ON fts.rowid = m.id
        WHERE memories_fts MATCH ? AND m.project_id = ?
        ORDER BY rank
        LIMIT ?
      `);
      const results = ftsStmt.all(sanitizedTerm, this.projectId, limit) as ShortTermMemory[];
      if (results.length > 0) return results;
    } catch {
      // FTS5 not available
    }

    const stmt = this.db.prepare(`
      SELECT id, timestamp, type, content, project_id as projectId, importance
      FROM memories
      WHERE project_id = ? AND content LIKE ?
      ORDER BY id DESC
      LIMIT ?
    `);
    return stmt.all(this.projectId, `%${searchTerm}%`, limit) as ShortTermMemory[];
  }

  async getByType(type: ShortTermMemory['type'], limit = 50): Promise<ShortTermMemory[]> {
    const stmt = this.db.prepare(`
      SELECT id, timestamp, type, content, project_id as projectId, importance
      FROM memories
      WHERE project_id = ? AND type = ?
      ORDER BY id DESC
      LIMIT ?
    `);
    return stmt.all(this.projectId, type, limit) as ShortTermMemory[];
  }

  async count(): Promise<number> {
    const stmt = this.db.prepare(`
      SELECT COUNT(*) as count
      FROM memories
      WHERE project_id = ?
    `);
    const result = stmt.get(this.projectId) as { count: number };
    return result.count;
  }

  private async prune(): Promise<void> {
    const count = await this.count();
    if (count > this.maxEntries) {
      const toDelete = count - this.maxEntries;
      // Importance-aware pruning: delete lowest importance first, then oldest
      // This retains high-value memories longer regardless of age
      const stmt = this.db.prepare(`
        DELETE FROM memories
        WHERE id IN (
          SELECT id FROM memories
          WHERE project_id = ?
          ORDER BY importance ASC, id ASC
          LIMIT ?
        )
      `);
      stmt.run(this.projectId, toDelete);
    }
  }

  async clear(): Promise<void> {
    const stmt = this.db.prepare(`
      DELETE FROM memories
      WHERE project_id = ?
    `);
    stmt.run(this.projectId);
  }

  async close(): Promise<void> {
    this.db.close();
  }

  // Export all memories as JSON (useful for backup/migration)
  async exportAll(): Promise<ShortTermMemory[]> {
    const stmt = this.db.prepare(`
      SELECT id, timestamp, type, content, project_id as projectId, importance
      FROM memories
      WHERE project_id = ?
      ORDER BY id ASC
    `);
    return stmt.all(this.projectId) as ShortTermMemory[];
  }

  // Import memories from JSON (useful for restore/migration)
  async importAll(
    memories: Array<{ type: ShortTermMemory['type']; content: string; timestamp?: string }>
  ): Promise<number> {
    await this.storeBatch(memories);
    return memories.length;
  }
}
