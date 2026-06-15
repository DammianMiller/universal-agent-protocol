#!/usr/bin/env python3
"""
UAP Database Schema Migration

This script adds missing tables to the UAP memory database for full protocol compliance.

Usage:
    tools/agents/migrations/apply.py
"""

import sqlite3
from pathlib import Path


def get_project_root():
    """Get project root directory."""
    return Path(__file__).parent.parent.parent


def migrate():
    """Apply all database migrations."""
    db_path = get_project_root() / "agents/data/memory/short_term.db"

    if not db_path.exists():
        print(f"❌ Database not found: {db_path}")
        print("   Initialize memory system first")
        return 1

    print(f"📝 Migrating database: {db_path}\n")

    conn = sqlite3.connect(str(db_path))
    cursor = conn.cursor()

    # ============================================================
    # Migration 1: Session Memories Table
    # ============================================================
    print("📦 Creating session_memories table...")
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS session_memories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            timestamp TEXT NOT NULL,
            type TEXT NOT NULL CHECK(type IN ('action','goal','decision')),
            content TEXT NOT NULL,
            importance INTEGER CHECK(importance >= 1 AND importance <= 10),
            UNIQUE(session_id, id)
        )
    """)
    print("   ✅ session_memories table created")

    # ============================================================
    # Migration 2: Full-Text Search Index (FTS5)
    # ============================================================
    print("📦 Creating memories_fts FTS5 index...")
    try:
        cursor.execute("""
            CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
                content,
                content='memories',
                content_rowid='id'
            )
        """)

        # Copy existing data to FTS index
        cursor.execute("SELECT id, content FROM memories")
        rows = cursor.fetchall()

        for row_id, content in rows:
            cursor.execute(
                "INSERT INTO memories_fts(rowid, content) VALUES (?, ?)",
                (row_id, content),
            )

        print("   ✅ memories_fts index created and populated")
    except sqlite3.OperationalError as e:
        if "already exists" in str(e):
            print("   ⚠️  memories_fts already exists (skipping)")
        else:
            raise

    # ============================================================
    # Migration 3: Triggers for FTS Sync
    # ============================================================
    print("📦 Creating FTS sync triggers...")

    cursor.execute("""
        CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
          INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
        END
    """)
    print("   ✅ memories_ai trigger created")

    cursor.execute("""
        CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
          INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.id, old.content);
        END
    """)
    print("   ✅ memories_ad trigger created")

    cursor.execute("""
        CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
          INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.id, old.content);
          INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
        END
    """)
    print("   ✅ memories_au trigger created")

    # ============================================================
    # Migration 4: Entities Table (Knowledge Graph)
    # ============================================================
    print("📦 Creating entities table...")
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS entities (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            type TEXT NOT NULL CHECK(type IN ('service','database','pattern','lesson','fact','api','tool')),
            description TEXT,
            mention_count INTEGER DEFAULT 0,
            last_seen TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    """)
    print("   ✅ entities table created")

    # ============================================================
    # Migration 5: Relationships Table (Knowledge Graph)
    # ============================================================
    print("📦 Creating relationships table...")
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS relationships (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            source_id INTEGER REFERENCES entities(id),
            target_id INTEGER REFERENCES entities(id),
            relation TEXT NOT NULL,
            strength REAL DEFAULT 1.0 CHECK(strength >= 0 AND strength <= 1),
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(source_id, target_id, relation)
        )
    """)
    print("   ✅ relationships table created")

    # ============================================================
    # Migration 6: Indexes for Performance
    # ============================================================
    print("📦 Creating performance indexes...")

    cursor.execute("""
        CREATE INDEX IF NOT EXISTS idx_session_memories_session ON session_memories(session_id)
    """)
    print("   ✅ idx_session_memories_session index created")

    cursor.execute("""
        CREATE INDEX IF NOT EXISTS idx_session_memories_importance ON session_memories(importance DESC)
    """)
    print("   ✅ idx_session_memories_importance index created")

    cursor.execute("""
        CREATE INDEX IF NOT EXISTS idx_entities_type ON entities(type)
    """)
    print("   ✅ idx_entities_type index created")

    cursor.execute("""
        CREATE INDEX IF NOT EXISTS idx_relationships_source ON relationships(source_id)
    """)
    print("   ✅ idx_relationships_source index created")

    # ============================================================
    # Migration 7: Initialize Coordination Database if needed
    # ============================================================
    coord_db_path = get_project_root() / "agents/data/coordination/coordination.db"
    if not coord_db_path.exists():
        print("📦 Initializing coordination database...")
        coord_conn = sqlite3.connect(str(coord_db_path))
        coord_cursor = coord_conn.cursor()

        coord_cursor.execute("""
            CREATE TABLE IF NOT EXISTS agent_registry (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                agent_id TEXT UNIQUE NOT NULL,
                status TEXT CHECK(status IN ('active','idle','completed','failed')),
                last_heartbeat TEXT,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            )
        """)

        coord_cursor.execute("""
            CREATE TABLE IF NOT EXISTS work_claims (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                agent_id INTEGER REFERENCES agent_registry(id),
                work_type TEXT NOT NULL,
                work_description TEXT,
                started_at TEXT,
                completed_at TEXT,
                UNIQUE(agent_id, work_type)
            )
        """)

        coord_cursor.execute("""
            CREATE TABLE IF NOT EXISTS work_announcements (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                agent_id INTEGER REFERENCES agent_registry(id),
                announcement_type TEXT NOT NULL,
                content TEXT NOT NULL,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                completed_at TEXT
            )
        """)

        coord_cursor.execute("""
            CREATE TABLE IF NOT EXISTS agent_messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                sender_id INTEGER REFERENCES agent_registry(id),
                recipient_id INTEGER REFERENCES agent_registry(id),
                message_type TEXT NOT NULL,
                content TEXT NOT NULL,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP
            )
        """)

        # Create indexes for coordination DB
        coord_cursor.execute("""
            CREATE INDEX IF NOT EXISTS idx_agent_registry_status ON agent_registry(status)
        """)
        coord_cursor.execute("""
            CREATE INDEX IF NOT EXISTS idx_work_claims_agent ON work_claims(agent_id)
        """)
        coord_cursor.execute("""
            CREATE INDEX IF NOT EXISTS idx_agent_messages_created ON agent_messages(created_at)
        """)

        coord_conn.commit()
        coord_conn.close()
        print("   ✅ coordination database initialized")

    # Commit all changes
    conn.commit()
    conn.close()

    print("\n" + "=" * 50)
    print("✅ Database migration completed successfully!")
    print("=" * 50)
    print("\nNew tables created:")
    print("  • session_memories - Store high-importance decisions")
    print("  • memories_fts     - Full-text search index")
    print("  • entities         - Knowledge graph nodes")
    print("  • relationships    - Knowledge graph edges")
    print("  • coordination.db  - Multi-agent coordination DB")
    print("\nRun 'UAP compliance check' to verify compliance")

    return 0


if __name__ == "__main__":
    import sys

    sys.exit(migrate())
