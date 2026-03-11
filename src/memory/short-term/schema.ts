import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';

export function ensureShortTermSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('action', 'observation', 'thought', 'goal')),
      content TEXT NOT NULL,
      project_id TEXT NOT NULL DEFAULT 'default',
      importance INTEGER NOT NULL DEFAULT 5
    );
    CREATE INDEX IF NOT EXISTS idx_memories_project_id ON memories(project_id);
    CREATE INDEX IF NOT EXISTS idx_memories_timestamp ON memories(timestamp);
    CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
    CREATE INDEX IF NOT EXISTS idx_memories_project_type ON memories(project_id, type);
  `);

  // Migration: add importance column if missing (for existing databases created before importance was added)
  try {
    const cols = db.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>;
    if (!cols.some(c => c.name === 'importance')) {
      db.exec(`ALTER TABLE memories ADD COLUMN importance INTEGER NOT NULL DEFAULT 5`);
    }
  } catch {
    // Ignore migration errors - column may already exist
  }

  // Create importance index after migration ensures column exists
  db.exec(`CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance DESC)`);

  // Enable WAL mode for concurrent reads and better write performance
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('mmap_size = 268435456');
  db.pragma('cache_size = -64000');

  // Create FTS5 virtual table for full-text search
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      content,
      type,
      content_rowid=id,
      tokenize='porter unicode61'
    );
  `);

  // Populate FTS if empty but memories exist
  const ftsCount = (db.prepare('SELECT COUNT(*) as c FROM memories_fts').get() as { c: number }).c;
  const memCount = (db.prepare('SELECT COUNT(*) as c FROM memories').get() as { c: number }).c;
  if (ftsCount === 0 && memCount > 0) {
    db.exec(`
      INSERT INTO memories_fts(rowid, content, type)
      SELECT id, content, type FROM memories;
    `);
  }
}

export function ensureSessionSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      type TEXT NOT NULL,
      content TEXT NOT NULL,
      importance INTEGER DEFAULT 5
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_session_unique ON session_memories(session_id, content);
    CREATE INDEX IF NOT EXISTS idx_session_id ON session_memories(session_id);
    CREATE INDEX IF NOT EXISTS idx_session_timestamp ON session_memories(timestamp);
    CREATE INDEX IF NOT EXISTS idx_session_importance ON session_memories(importance DESC);
    CREATE INDEX IF NOT EXISTS idx_session_id_importance ON session_memories(session_id, importance DESC);
  `);

  // Create FTS5 for session memories
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS session_memories_fts USING fts5(
      content,
      type,
      content_rowid=id,
      tokenize='porter unicode61'
    );
  `);
}

export function ensureKnowledgeSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS entities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      first_seen TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      mention_count INTEGER NOT NULL DEFAULT 1,
      UNIQUE(type, name)
    );
    CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type);

    CREATE TABLE IF NOT EXISTS relationships (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id INTEGER NOT NULL,
      target_id INTEGER NOT NULL,
      relation TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      UNIQUE(source_id, target_id, relation),
      FOREIGN KEY (source_id) REFERENCES entities(id),
      FOREIGN KEY (target_id) REFERENCES entities(id)
    );
    CREATE INDEX IF NOT EXISTS idx_relationships_source ON relationships(source_id);
    CREATE INDEX IF NOT EXISTS idx_relationships_target ON relationships(target_id);
  `);
}

export function initializeMemoryDatabase(dbPath: string): void {
  const dir = dirname(dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const db = new Database(dbPath);
  ensureShortTermSchema(db);
  ensureSessionSchema(db);
  ensureKnowledgeSchema(db);
  db.close();
}
