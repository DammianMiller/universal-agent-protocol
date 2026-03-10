import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';

export class CoordinationDatabase {
  private db: Database.Database;
  private static instance: CoordinationDatabase | null = null;

  private constructor(dbPath: string) {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath);
    this.initSchema();
  }

  static getInstance(dbPath: string): CoordinationDatabase {
    if (!CoordinationDatabase.instance) {
      CoordinationDatabase.instance = new CoordinationDatabase(dbPath);
    }
    return CoordinationDatabase.instance;
  }

  static resetInstance(): void {
    if (CoordinationDatabase.instance) {
      CoordinationDatabase.instance.close();
      CoordinationDatabase.instance = null;
    }
  }

  getDatabase(): Database.Database {
    return this.db;
  }

  private initSchema(): void {
    this.db.exec(`
      -- Agent registry for tracking active agents
      CREATE TABLE IF NOT EXISTS agent_registry (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        session_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('active', 'idle', 'completed', 'failed')),
        current_task TEXT,
        worktree_branch TEXT,
        started_at TEXT NOT NULL,
        last_heartbeat TEXT NOT NULL,
        capabilities TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_agent_registry_session ON agent_registry(session_id);
      CREATE INDEX IF NOT EXISTS idx_agent_registry_status ON agent_registry(status);

      -- Message bus for inter-agent communication
      CREATE TABLE IF NOT EXISTS agent_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel TEXT NOT NULL,
        from_agent TEXT,
        to_agent TEXT,
        type TEXT NOT NULL CHECK(type IN ('request', 'response', 'notification', 'claim', 'release')),
        payload TEXT NOT NULL,
        priority INTEGER DEFAULT 5,
        created_at TEXT NOT NULL,
        read_at TEXT,
        expires_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_messages_channel ON agent_messages(channel);
      CREATE INDEX IF NOT EXISTS idx_messages_to_agent ON agent_messages(to_agent);
      CREATE INDEX IF NOT EXISTS idx_messages_created ON agent_messages(created_at);

      -- Work announcements (informational - for coordination, NOT locking)
      -- Agents announce what they're working on so others can optimize velocity
      CREATE TABLE IF NOT EXISTS work_announcements (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL,
        agent_name TEXT,
        worktree_branch TEXT,
        intent_type TEXT NOT NULL CHECK(intent_type IN ('editing', 'reviewing', 'refactoring', 'testing', 'documenting')),
        resource TEXT NOT NULL,
        description TEXT,
        files_affected TEXT,
        estimated_completion TEXT,
        announced_at TEXT NOT NULL,
        completed_at TEXT,
        FOREIGN KEY (agent_id) REFERENCES agent_registry(id)
      );
      CREATE INDEX IF NOT EXISTS idx_announcements_agent ON work_announcements(agent_id);
      CREATE INDEX IF NOT EXISTS idx_announcements_resource ON work_announcements(resource);
      CREATE INDEX IF NOT EXISTS idx_announcements_active ON work_announcements(completed_at) WHERE completed_at IS NULL;

      -- Legacy work_claims table (for backward compatibility, maps to announcements)
      CREATE TABLE IF NOT EXISTS work_claims (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        resource TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        claim_type TEXT NOT NULL CHECK(claim_type IN ('exclusive', 'shared')),
        claimed_at TEXT NOT NULL,
        expires_at TEXT,
        FOREIGN KEY (agent_id) REFERENCES agent_registry(id)
      );
      CREATE INDEX IF NOT EXISTS idx_claims_agent ON work_claims(agent_id);

      -- Deployment batching queue
      CREATE TABLE IF NOT EXISTS deploy_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL,
        action_type TEXT NOT NULL CHECK(action_type IN ('commit', 'push', 'merge', 'deploy', 'workflow')),
        target TEXT NOT NULL,
        payload TEXT,
        status TEXT NOT NULL CHECK(status IN ('pending', 'batched', 'executing', 'completed', 'failed')),
        batch_id TEXT,
        queued_at TEXT NOT NULL,
        execute_after TEXT,
        priority INTEGER DEFAULT 5,
        dependencies TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_deploy_status ON deploy_queue(status);
      CREATE INDEX IF NOT EXISTS idx_deploy_batch ON deploy_queue(batch_id);
      CREATE INDEX IF NOT EXISTS idx_deploy_target ON deploy_queue(target);

      -- Batch tracking
      CREATE TABLE IF NOT EXISTS deploy_batches (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        executed_at TEXT,
        status TEXT NOT NULL CHECK(status IN ('pending', 'executing', 'completed', 'failed')),
        result TEXT
      );
    `);
  }

  close(): void {
    this.db.close();
  }
}

export function getDefaultCoordinationDbPath(): string {
  return './agents/data/coordination/coordination.db';
}
