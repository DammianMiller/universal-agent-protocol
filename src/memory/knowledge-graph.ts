import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { ensureKnowledgeSchema } from './short-term/schema.js';

/**
 * L4 Knowledge Graph - Entity and relationship management
 *
 * Provides graph-based knowledge storage using SQLite entities and
 * relationships tables. Designed for <20ms access per the UAP protocol.
 */

export interface Entity {
  id?: number;
  type: string;
  name: string;
  description?: string;
  firstSeen: string;
  lastSeen: string;
  mentionCount: number;
}

export interface Relationship {
  id?: number;
  sourceId: number;
  targetId: number;
  relation: string;
  strength: number;
  timestamp: string;
}

export interface GraphQueryResult {
  entity: Entity;
  relationships: Array<{
    relation: string;
    direction: 'outgoing' | 'incoming';
    relatedEntity: Entity;
    strength: number;
  }>;
}

export class KnowledgeGraph {
  private db: Database.Database;

  constructor(dbPath: string) {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath);
    ensureKnowledgeSchema(this.db);

    // Optimize for read-heavy graph queries
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
  }

  // ============================================================
  // ENTITY OPERATIONS
  // ============================================================

  /**
   * Upsert an entity. If (type, name) already exists, updates last_seen
   * and increments mention_count.
   */
  upsertEntity(type: string, name: string, description?: string): Entity {
    const now = new Date().toISOString();

    const existing = this.db
      .prepare('SELECT * FROM entities WHERE type = ? AND name = ?')
      .get(type, name) as Record<string, unknown> | undefined;

    if (existing) {
      this.db
        .prepare(
          `
        UPDATE entities
        SET last_seen = ?, mention_count = mention_count + 1,
            description = COALESCE(?, description)
        WHERE id = ?
      `
        )
        .run(now, description ?? null, existing.id);

      return {
        id: existing.id as number,
        type: existing.type as string,
        name: existing.name as string,
        description: (description ?? existing.description) as string | undefined,
        firstSeen: existing.first_seen as string,
        lastSeen: now,
        mentionCount: (existing.mention_count as number) + 1,
      };
    }

    const result = this.db
      .prepare(
        `
      INSERT INTO entities (type, name, description, first_seen, last_seen, mention_count)
      VALUES (?, ?, ?, ?, ?, 1)
    `
      )
      .run(type, name, description ?? null, now, now);

    return {
      id: Number(result.lastInsertRowid),
      type,
      name,
      description,
      firstSeen: now,
      lastSeen: now,
      mentionCount: 1,
    };
  }

  /**
   * Get an entity by type and name.
   */
  getEntity(type: string, name: string): Entity | null {
    const row = this.db
      .prepare('SELECT * FROM entities WHERE type = ? AND name = ?')
      .get(type, name) as Record<string, unknown> | undefined;

    if (!row) return null;

    return this.rowToEntity(row);
  }

  /**
   * Get an entity by ID.
   */
  getEntityById(id: number): Entity | null {
    const row = this.db.prepare('SELECT * FROM entities WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;

    if (!row) return null;

    return this.rowToEntity(row);
  }

  /**
   * Search entities by type.
   */
  getEntitiesByType(type: string, limit: number = 50): Entity[] {
    const rows = this.db
      .prepare('SELECT * FROM entities WHERE type = ? ORDER BY mention_count DESC LIMIT ?')
      .all(type, limit) as Array<Record<string, unknown>>;

    return rows.map((r) => this.rowToEntity(r));
  }

  /**
   * Search entities by name pattern (LIKE search).
   */
  searchEntities(query: string, limit: number = 20): Entity[] {
    const rows = this.db
      .prepare('SELECT * FROM entities WHERE name LIKE ? ORDER BY mention_count DESC LIMIT ?')
      .all(`%${query}%`, limit) as Array<Record<string, unknown>>;

    return rows.map((r) => this.rowToEntity(r));
  }

  /**
   * Delete an entity and all its relationships.
   */
  deleteEntity(id: number): boolean {
    const deleteRels = this.db.prepare(
      'DELETE FROM relationships WHERE source_id = ? OR target_id = ?'
    );
    const deleteEntity = this.db.prepare('DELETE FROM entities WHERE id = ?');

    const txn = this.db.transaction(() => {
      deleteRels.run(id, id);
      const result = deleteEntity.run(id);
      return result.changes > 0;
    });

    return txn();
  }

  // ============================================================
  // RELATIONSHIP OPERATIONS
  // ============================================================

  /**
   * Add or strengthen a relationship between two entities.
   * If the relationship already exists, increases strength.
   */
  addRelationship(
    sourceId: number,
    targetId: number,
    relation: string,
    strength: number = 1.0
  ): Relationship {
    const now = new Date().toISOString();

    const existing = this.db
      .prepare('SELECT * FROM relationships WHERE source_id = ? AND target_id = ? AND relation = ?')
      .get(sourceId, targetId, relation) as Record<string, unknown> | undefined;

    if (existing) {
      const newStrength = Math.min((existing.strength as number) + strength, 10.0);
      this.db
        .prepare(
          `
        UPDATE relationships SET strength = ?, timestamp = ? WHERE id = ?
      `
        )
        .run(newStrength, now, existing.id);

      return {
        id: existing.id as number,
        sourceId,
        targetId,
        relation,
        strength: newStrength,
        timestamp: now,
      };
    }

    const result = this.db
      .prepare(
        `
      INSERT INTO relationships (source_id, target_id, relation, strength, timestamp)
      VALUES (?, ?, ?, ?, ?)
    `
      )
      .run(sourceId, targetId, relation, strength, now);

    return {
      id: Number(result.lastInsertRowid),
      sourceId,
      targetId,
      relation,
      strength,
      timestamp: now,
    };
  }

  /**
   * Get all relationships for an entity (both directions).
   */
  getRelationships(entityId: number): Relationship[] {
    const rows = this.db
      .prepare(
        `
      SELECT * FROM relationships
      WHERE source_id = ? OR target_id = ?
      ORDER BY strength DESC
    `
      )
      .all(entityId, entityId) as Array<Record<string, unknown>>;

    return rows.map((r) => this.rowToRelationship(r));
  }

  /**
   * Delete a specific relationship.
   */
  deleteRelationship(id: number): boolean {
    const result = this.db.prepare('DELETE FROM relationships WHERE id = ?').run(id);
    return result.changes > 0;
  }

  // ============================================================
  // GRAPH QUERIES
  // ============================================================

  /**
   * Get an entity with all its relationships and related entities.
   * Uses a single JOIN query instead of N+1 individual queries.
   */
  queryEntityGraph(type: string, name: string): GraphQueryResult | null {
    const entity = this.getEntity(type, name);
    if (!entity || !entity.id) return null;

    // Single JOIN query to get all relationships with their related entities
    const rows = this.db
      .prepare(
        `
      SELECT r.id as relId, r.relation, r.strength, r.source_id as sourceId, r.target_id as targetId,
             e.id as entityId, e.type, e.name, e.description, e.first_seen as firstSeen,
             e.last_seen as lastSeen, e.mention_count as mentionCount
      FROM relationships r
      JOIN entities e ON (
        CASE WHEN r.source_id = ? THEN r.target_id ELSE r.source_id END = e.id
      )
      WHERE r.source_id = ? OR r.target_id = ?
    `
      )
      .all(entity.id, entity.id, entity.id) as Array<{
      relId: number;
      relation: string;
      strength: number;
      sourceId: number;
      targetId: number;
      entityId: number;
      type: string;
      name: string;
      description: string | null;
      firstSeen: string;
      lastSeen: string;
      mentionCount: number;
    }>;

    const relationships: GraphQueryResult['relationships'] = rows.map((row) => ({
      relation: row.relation,
      direction: (row.sourceId === entity.id ? 'outgoing' : 'incoming') as 'outgoing' | 'incoming',
      relatedEntity: {
        id: row.entityId,
        type: row.type,
        name: row.name,
        description: row.description || undefined,
        firstSeen: row.firstSeen,
        lastSeen: row.lastSeen,
        mentionCount: row.mentionCount,
      },
      strength: row.strength,
    }));

    return { entity, relationships };
  }

  /**
   * Find entities connected to a given entity within N hops.
   * Uses a recursive CTE for efficient graph traversal in a single query.
   */
  traverseGraph(entityId: number, maxDepth: number = 2): Entity[] {
    const rows = this.db
      .prepare(
        `
      WITH RECURSIVE reachable(id, depth) AS (
        SELECT ?, 0
        UNION
        SELECT
          CASE WHEN r.source_id = reachable.id THEN r.target_id ELSE r.source_id END,
          reachable.depth + 1
        FROM reachable
        JOIN relationships r ON (r.source_id = reachable.id OR r.target_id = reachable.id)
        WHERE reachable.depth < ?
      )
      SELECT DISTINCT e.id, e.type, e.name, e.description, e.first_seen as firstSeen,
             e.last_seen as lastSeen, e.mention_count as mentionCount
      FROM reachable
      JOIN entities e ON e.id = reachable.id
    `
      )
      .all(entityId, maxDepth) as Array<{
      id: number;
      type: string;
      name: string;
      description: string | null;
      firstSeen: string;
      lastSeen: string;
      mentionCount: number;
    }>;

    return rows.map((row) => ({
      id: row.id,
      type: row.type,
      name: row.name,
      description: row.description || undefined,
      firstSeen: row.firstSeen,
      lastSeen: row.lastSeen,
      mentionCount: row.mentionCount,
    }));
  }

  /**
   * Get graph statistics.
   */
  getStats(): { entityCount: number; relationshipCount: number; entityTypes: string[] } {
    const entityCount = (
      this.db.prepare('SELECT COUNT(*) as c FROM entities').get() as { c: number }
    ).c;
    const relationshipCount = (
      this.db.prepare('SELECT COUNT(*) as c FROM relationships').get() as { c: number }
    ).c;
    const typeRows = this.db
      .prepare('SELECT DISTINCT type FROM entities ORDER BY type')
      .all() as Array<{ type: string }>;

    return {
      entityCount,
      relationshipCount,
      entityTypes: typeRows.map((r) => r.type),
    };
  }

  /**
   * Close the database connection.
   */
  close(): void {
    this.db.close();
  }

  // ============================================================
  // PRIVATE HELPERS
  // ============================================================

  private rowToEntity(row: Record<string, unknown>): Entity {
    return {
      id: (row.id as number) ?? 0,
      type: (row.type as string) ?? 'unknown',
      name: (row.name as string) ?? '',
      description: row.description as string | undefined,
      firstSeen: (row.first_seen as string) ?? new Date().toISOString(),
      lastSeen: (row.last_seen as string) ?? new Date().toISOString(),
      mentionCount: (row.mention_count as number) ?? 0,
    };
  }

  private rowToRelationship(row: Record<string, unknown>): Relationship {
    return {
      id: (row.id as number) ?? 0,
      sourceId: (row.source_id as number) ?? 0,
      targetId: (row.target_id as number) ?? 0,
      relation: (row.relation as string) ?? '',
      strength: (row.strength as number) ?? 0,
      timestamp: (row.timestamp as string) ?? new Date().toISOString(),
    };
  }
}
