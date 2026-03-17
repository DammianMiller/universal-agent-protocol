/**
 * Per-Agent Workspace Isolation
 *
 * Each registered agent gets its own working memory partition within the
 * shared SQLite database. Agent-specific context stays isolated; shared
 * memories require explicit cross-agent promotion.
 *
 * Inspired by Clawe's per-agent isolated workspaces.
 */

import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';

export interface AgentMemoryPartition {
  agentId: string;
  agentName: string;
  entryCount: number;
  lastActivity: string;
}

export interface AgentScopedEntry {
  id: number;
  agentId: string;
  timestamp: string;
  type: string;
  content: string;
  importance: number;
  shared: boolean;
}

/**
 * Ensure the agent-scoped memory table exists.
 */
export function ensureAgentScopedSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'observation',
      content TEXT NOT NULL,
      importance INTEGER NOT NULL DEFAULT 5,
      shared INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_agent_mem_agent ON agent_memories(agent_id);
    CREATE INDEX IF NOT EXISTS idx_agent_mem_shared ON agent_memories(shared);
    CREATE INDEX IF NOT EXISTS idx_agent_mem_importance ON agent_memories(agent_id, importance DESC);
  `);
}

export class AgentScopedMemory {
  private db: Database.Database;

  constructor(dbPath: string) {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(dbPath);
    ensureAgentScopedSchema(this.db);
  }

  /**
   * Store a memory scoped to a specific agent.
   */
  store(agentId: string, content: string, type: string = 'observation', importance: number = 5): number {
    const stmt = this.db.prepare(`
      INSERT INTO agent_memories (agent_id, timestamp, type, content, importance)
      VALUES (?, ?, ?, ?, ?)
    `);
    const result = stmt.run(agentId, new Date().toISOString(), type, content, importance);
    return Number(result.lastInsertRowid);
  }

  /**
   * Query memories for a specific agent (includes shared memories).
   */
  query(agentId: string, search: string, limit: number = 10): AgentScopedEntry[] {
    const stmt = this.db.prepare(`
      SELECT id, agent_id as agentId, timestamp, type, content, importance, shared
      FROM agent_memories
      WHERE (agent_id = ? OR shared = 1) AND content LIKE ?
      ORDER BY importance DESC, id DESC
      LIMIT ?
    `);
    return stmt.all(agentId, `%${search}%`, limit) as AgentScopedEntry[];
  }

  /**
   * Get all memories for a specific agent (includes shared).
   */
  getForAgent(agentId: string, limit: number = 50): AgentScopedEntry[] {
    const stmt = this.db.prepare(`
      SELECT id, agent_id as agentId, timestamp, type, content, importance, shared
      FROM agent_memories
      WHERE agent_id = ? OR shared = 1
      ORDER BY id DESC
      LIMIT ?
    `);
    return stmt.all(agentId, limit) as AgentScopedEntry[];
  }

  /**
   * Promote a memory to shared (visible to all agents).
   */
  share(entryId: number): void {
    this.db.prepare('UPDATE agent_memories SET shared = 1 WHERE id = ?').run(entryId);
  }

  /**
   * Unshare a memory (make agent-private again).
   */
  unshare(entryId: number): void {
    this.db.prepare('UPDATE agent_memories SET shared = 0 WHERE id = ?').run(entryId);
  }

  /**
   * Get partition statistics per agent.
   */
  getPartitions(): AgentMemoryPartition[] {
    const rows = this.db.prepare(`
      SELECT agent_id as agentId,
             agent_id as agentName,
             COUNT(*) as entryCount,
             MAX(timestamp) as lastActivity
      FROM agent_memories
      GROUP BY agent_id
      ORDER BY lastActivity DESC
    `).all() as Array<{
      agentId: string;
      agentName: string;
      entryCount: number;
      lastActivity: string;
    }>;
    return rows;
  }

  /**
   * Count memories for a specific agent.
   */
  countForAgent(agentId: string): number {
    const result = this.db.prepare(`
      SELECT COUNT(*) as c FROM agent_memories WHERE agent_id = ?
    `).get(agentId) as { c: number };
    return result.c;
  }

  /**
   * Delete all memories for a specific agent (used on deregister).
   */
  clearAgent(agentId: string): number {
    const result = this.db.prepare('DELETE FROM agent_memories WHERE agent_id = ?').run(agentId);
    return result.changes;
  }

  close(): void {
    this.db.close();
  }
}
