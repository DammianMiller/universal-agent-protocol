import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';

export function ensureShortTermSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('action', 'observation', 'thought', 'goal', 'lesson', 'decision')),
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
    const cols = db.prepare('PRAGMA table_info(memories)').all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'importance')) {
      db.exec(`ALTER TABLE memories ADD COLUMN importance INTEGER NOT NULL DEFAULT 5`);
    }
  } catch {
    // Ignore migration errors - column may already exist
  }

  // Migration: widen CHECK constraint on memories.type to include 'lesson' and 'decision'
  // SQLite doesn't support ALTER TABLE to change CHECK constraints, so we must rebuild the table.
  try {
    const ALLOWED_TYPES = ['action', 'observation', 'thought', 'goal', 'lesson', 'decision'];
    // Probe: try inserting a 'lesson' row — if it fails, the old CHECK is blocking it
    let needsRebuild = false;
    try {
      db.prepare(
        "INSERT INTO memories (timestamp, type, content) VALUES ('__check_probe__', 'lesson', '__check_probe__')"
      ).run();
      db.exec("DELETE FROM memories WHERE timestamp = '__check_probe__' AND content = '__check_probe__'");
    } catch {
      needsRebuild = true;
    }

    if (needsRebuild) {
      const checkExpr = ALLOWED_TYPES.map((t) => `'${t}'`).join(', ');

      // Drop FTS triggers first so they don't fire during the migration
      db.exec(`
        DROP TRIGGER IF EXISTS memories_ai;
        DROP TRIGGER IF EXISTS memories_ad;
        DROP TRIGGER IF EXISTS memories_au;
      `);

      // Drop the FTS table — it will be recreated below
      db.exec(`DROP TABLE IF EXISTS memories_fts`);

      // Rebuild: create new table, copy data, swap
      db.exec(`
        CREATE TABLE memories_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp TEXT NOT NULL,
          type TEXT NOT NULL CHECK(type IN (${checkExpr})),
          content TEXT NOT NULL,
          project_id TEXT NOT NULL DEFAULT 'default',
          importance INTEGER NOT NULL DEFAULT 5
        );
        INSERT INTO memories_new (id, timestamp, type, content, project_id, importance)
          SELECT id, timestamp, type, content,
                 COALESCE(project_id, 'default'),
                 COALESCE(importance, 5)
          FROM memories;
        DROP TABLE memories;
        ALTER TABLE memories_new RENAME TO memories;
      `);

      // Recreate indexes on the new table
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_memories_project_id ON memories(project_id);
        CREATE INDEX IF NOT EXISTS idx_memories_timestamp ON memories(timestamp);
        CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
        CREATE INDEX IF NOT EXISTS idx_memories_project_type ON memories(project_id, type);
        CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance DESC);
      `);
    }
  } catch {
    // Ignore — constraint migration is best-effort
  }

  // Create importance index after migration ensures column exists
  db.exec(`CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance DESC)`);

  // Enable WAL mode for concurrent reads and better write performance
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('mmap_size = 268435456');
  db.pragma('cache_size = -64000');

  // Create FTS5 virtual table for full-text search (external content table synced via triggers)
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      content,
      type,
      content='memories',
      content_rowid='id',
      tokenize='porter unicode61'
    );

    -- Triggers to keep FTS5 index in sync with memories table
    CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, content, type)
      VALUES (new.id, new.content, new.type);
    END;

    CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content, type)
      VALUES ('delete', old.id, old.content, old.type);
    END;

    CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content, type)
      VALUES ('delete', old.id, old.content, old.type);
      INSERT INTO memories_fts(rowid, content, type)
      VALUES (new.id, new.content, new.type);
    END;
  `);

  // Populate FTS if empty but memories exist (initial backfill)
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

  // Create FTS5 for session memories (external content table synced via triggers)
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS session_memories_fts USING fts5(
      content,
      type,
      content='session_memories',
      content_rowid='id',
      tokenize='porter unicode61'
    );

    -- Triggers to keep FTS5 index in sync with session_memories table
    CREATE TRIGGER IF NOT EXISTS session_memories_ai AFTER INSERT ON session_memories BEGIN
      INSERT INTO session_memories_fts(rowid, content, type)
      VALUES (new.id, new.content, new.type);
    END;

    CREATE TRIGGER IF NOT EXISTS session_memories_ad AFTER DELETE ON session_memories BEGIN
      INSERT INTO session_memories_fts(session_memories_fts, rowid, content, type)
      VALUES ('delete', old.id, old.content, old.type);
    END;

    CREATE TRIGGER IF NOT EXISTS session_memories_au AFTER UPDATE ON session_memories BEGIN
      INSERT INTO session_memories_fts(session_memories_fts, rowid, content, type)
      VALUES ('delete', old.id, old.content, old.type);
      INSERT INTO session_memories_fts(rowid, content, type)
      VALUES (new.id, new.content, new.type);
    END;
  `);
}

export function ensureKnowledgeSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS entities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
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
      strength REAL NOT NULL DEFAULT 1.0,
      timestamp TEXT NOT NULL,
      UNIQUE(source_id, target_id, relation),
      FOREIGN KEY (source_id) REFERENCES entities(id),
      FOREIGN KEY (target_id) REFERENCES entities(id)
    );
    CREATE INDEX IF NOT EXISTS idx_relationships_source ON relationships(source_id);
    CREATE INDEX IF NOT EXISTS idx_relationships_target ON relationships(target_id);
  `);

  // Migration: add description column to entities if missing (for existing databases)
  try {
    const entityCols = db.prepare('PRAGMA table_info(entities)').all() as Array<{ name: string }>;
    if (!entityCols.some((c) => c.name === 'description')) {
      db.exec(`ALTER TABLE entities ADD COLUMN description TEXT`);
    }
  } catch {
    // Ignore migration errors
  }

  // Migration: add strength column to relationships if missing (for existing databases)
  try {
    const relCols = db.prepare('PRAGMA table_info(relationships)').all() as Array<{ name: string }>;
    if (!relCols.some((c) => c.name === 'strength')) {
      db.exec(`ALTER TABLE relationships ADD COLUMN strength REAL NOT NULL DEFAULT 1.0`);
    }
  } catch {
    // Ignore migration errors
  }
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
