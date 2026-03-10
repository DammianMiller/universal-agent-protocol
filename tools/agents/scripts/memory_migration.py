#!/usr/bin/env python3
"""
Memory Migration Tool

Provides automated migration between different memory system implementations:
- SQLite short-term <-> JSON export
- Qdrant long-term <-> JSON export
- Qdrant -> Mem0 format
- Qdrant -> A-MEM format
- Full backup/restore capabilities

Usage:
    # Export all memories to JSON
    python memory_migration.py export all output.json

    # Export Qdrant to Mem0 format
    python memory_migration.py export qdrant --format mem0 output.json

    # Backup everything
    python memory_migration.py backup

    # Restore from backup
    python memory_migration.py restore <backup_id>

    # Migrate to enhanced schema
    python memory_migration.py upgrade
"""

import argparse
import hashlib
import json
import os
import shutil
import sqlite3
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

try:
    from sentence_transformers import SentenceTransformer
    from qdrant_client import QdrantClient
    from qdrant_client.models import PointStruct
    QDRANT_AVAILABLE = True
except ImportError:
    QDRANT_AVAILABLE = False


def get_project_root() -> Path:
    return Path(__file__).parent.parent.parent.parent


def get_data_dir() -> Path:
    return get_project_root() / "tools/agents/data/memory"


def get_backup_dir() -> Path:
    backup_dir = get_data_dir() / "backups"
    backup_dir.mkdir(parents=True, exist_ok=True)
    return backup_dir


class MemoryMigration:
    def __init__(self):
        self.data_dir = get_data_dir()
        self.backup_dir = get_backup_dir()
        self.short_term_db = self.data_dir / "short_term.db"
        self.long_term_json = self.data_dir / "long_term.json"

        self.qdrant = None
        self.model = None
        if QDRANT_AVAILABLE:
            try:
                self.qdrant = QdrantClient(host="localhost", port=6333)
                self.model = SentenceTransformer("all-MiniLM-L6-v2")
            except Exception:
                pass

    def export_sqlite(self) -> list[dict]:
        """Export all SQLite memories to list of dicts."""
        if not self.short_term_db.exists():
            return []

        conn = sqlite3.connect(self.short_term_db)
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()

        memories = []

        # Export main memories table
        cursor.execute("SELECT * FROM memories ORDER BY id")
        for row in cursor.fetchall():
            memories.append({
                "source": "sqlite_memories",
                "id": row["id"],
                "timestamp": row["timestamp"],
                "type": row["type"],
                "content": row["content"]
            })

        # Export session_memories if exists
        try:
            cursor.execute("SELECT * FROM session_memories ORDER BY id")
            for row in cursor.fetchall():
                memories.append({
                    "source": "sqlite_session_memories",
                    "id": row["id"],
                    "session_id": row["session_id"],
                    "timestamp": row["timestamp"],
                    "type": row["type"],
                    "content": row["content"],
                    "context": row["context"],
                    "importance": row["importance"]
                })
        except sqlite3.OperationalError:
            pass  # Table doesn't exist

        # Export entities if exists
        try:
            cursor.execute("SELECT * FROM entities ORDER BY id")
            for row in cursor.fetchall():
                memories.append({
                    "source": "sqlite_entities",
                    "id": row["id"],
                    "type": row["type"],
                    "name": row["name"],
                    "context": row["context"],
                    "first_seen": row["first_seen"],
                    "last_seen": row["last_seen"],
                    "mention_count": row["mention_count"]
                })
        except sqlite3.OperationalError:
            pass

        # Export relationships if exists
        try:
            cursor.execute("SELECT * FROM relationships ORDER BY id")
            for row in cursor.fetchall():
                memories.append({
                    "source": "sqlite_relationships",
                    "id": row["id"],
                    "source_id": row["source_id"],
                    "target_id": row["target_id"],
                    "relation": row["relation"],
                    "weight": row["weight"],
                    "timestamp": row["timestamp"]
                })
        except sqlite3.OperationalError:
            pass

        conn.close()
        return memories

    def export_qdrant(self, format: str = "native") -> list[dict]:
        """Export Qdrant memories.

        Formats:
        - native: Raw Qdrant format
        - mem0: Mem0-compatible format
        - amem: A-MEM compatible format
        """
        if not self.qdrant:
            return []

        try:
            # Get all points (scroll through collection)
            points = []
            offset = None

            while True:
                result = self.qdrant.scroll(
                    collection_name="claude_memory",
                    limit=100,
                    offset=offset,
                    with_vectors=True,
                    with_payload=True
                )

                if not result[0]:
                    break

                points.extend(result[0])
                offset = result[1]

                if offset is None:
                    break

            memories = []
            for point in points:
                if format == "native":
                    memories.append({
                        "source": "qdrant",
                        "id": str(point.id),
                        "vector": point.vector,
                        "payload": point.payload
                    })
                elif format == "mem0":
                    # Mem0 format
                    memories.append({
                        "id": str(point.id),
                        "memory": point.payload.get("content", ""),
                        "hash": hashlib.md5(point.payload.get("content", "").encode()).hexdigest(),
                        "metadata": {
                            "type": point.payload.get("type"),
                            "tags": point.payload.get("tags", []),
                            "importance": point.payload.get("importance", 5),
                            "created_at": point.payload.get("timestamp"),
                            "updated_at": point.payload.get("timestamp")
                        },
                        "user_id": "claude_agent"
                    })
                elif format == "amem":
                    # A-MEM format (Zettelkasten-style)
                    memories.append({
                        "id": str(point.id),
                        "title": point.payload.get("content", "")[:50] + "...",
                        "content": point.payload.get("content", ""),
                        "keywords": point.payload.get("tags", []),
                        "tags": point.payload.get("tags", []),
                        "links": [],  # Would need to be computed from similarity
                        "created": point.payload.get("timestamp"),
                        "modified": point.payload.get("timestamp"),
                        "importance": point.payload.get("importance", 5)
                    })

            return memories

        except Exception as e:
            print(f"Error exporting Qdrant: {e}")
            return []

    def export_all(self, output_path: str, format: str = "native"):
        """Export all memories to a JSON file."""
        export = {
            "metadata": {
                "exported_at": datetime.utcnow().isoformat() + "Z",
                "format": format,
                "version": "2.0"
            },
            "sqlite": self.export_sqlite(),
            "qdrant": self.export_qdrant(format)
        }

        with open(output_path, "w") as f:
            json.dump(export, f, indent=2, default=str)

        print(f"Exported {len(export['sqlite'])} SQLite entries")
        print(f"Exported {len(export['qdrant'])} Qdrant entries")
        print(f"Saved to: {output_path}")

    def backup(self) -> str:
        """Create a full backup of all memory stores."""
        backup_id = datetime.utcnow().strftime("%Y%m%d_%H%M%S")
        backup_path = self.backup_dir / backup_id
        backup_path.mkdir(parents=True, exist_ok=True)

        # Backup SQLite
        if self.short_term_db.exists():
            shutil.copy2(self.short_term_db, backup_path / "short_term.db")
            print(f"Backed up SQLite: {self.short_term_db}")

        # Backup long_term.json
        if self.long_term_json.exists():
            shutil.copy2(self.long_term_json, backup_path / "long_term.json")
            print(f"Backed up JSON: {self.long_term_json}")

        # Export Qdrant to JSON
        qdrant_export = self.export_qdrant("native")
        with open(backup_path / "qdrant_export.json", "w") as f:
            json.dump(qdrant_export, f, indent=2, default=str)
        print(f"Backed up Qdrant: {len(qdrant_export)} entries")

        # Create manifest
        manifest = {
            "backup_id": backup_id,
            "created_at": datetime.utcnow().isoformat() + "Z",
            "files": os.listdir(backup_path),
            "sqlite_entries": len(self.export_sqlite()),
            "qdrant_entries": len(qdrant_export)
        }
        with open(backup_path / "manifest.json", "w") as f:
            json.dump(manifest, f, indent=2)

        print(f"\nBackup complete: {backup_path}")
        print(f"Backup ID: {backup_id}")
        return backup_id

    def restore(self, backup_id: str):
        """Restore from a backup."""
        backup_path = self.backup_dir / backup_id

        if not backup_path.exists():
            print(f"Backup not found: {backup_id}")
            print(f"Available backups: {os.listdir(self.backup_dir)}")
            return False

        # Confirm
        manifest_path = backup_path / "manifest.json"
        if manifest_path.exists():
            with open(manifest_path) as f:
                manifest = json.load(f)
            print(f"Backup from: {manifest['created_at']}")
            print(f"SQLite entries: {manifest['sqlite_entries']}")
            print(f"Qdrant entries: {manifest['qdrant_entries']}")

        # Restore SQLite
        sqlite_backup = backup_path / "short_term.db"
        if sqlite_backup.exists():
            # Backup current before overwriting
            if self.short_term_db.exists():
                shutil.copy2(self.short_term_db, self.short_term_db.with_suffix(".db.pre_restore"))
            shutil.copy2(sqlite_backup, self.short_term_db)
            print(f"Restored SQLite: {self.short_term_db}")

        # Restore long_term.json
        json_backup = backup_path / "long_term.json"
        if json_backup.exists():
            if self.long_term_json.exists():
                shutil.copy2(self.long_term_json, self.long_term_json.with_suffix(".json.pre_restore"))
            shutil.copy2(json_backup, self.long_term_json)
            print(f"Restored JSON: {self.long_term_json}")

        # Restore Qdrant
        qdrant_backup = backup_path / "qdrant_export.json"
        if qdrant_backup.exists() and self.qdrant and self.model:
            with open(qdrant_backup) as f:
                qdrant_data = json.load(f)

            if qdrant_data:
                # Recreate collection
                try:
                    self.qdrant.delete_collection("claude_memory")
                except Exception:
                    pass

                from qdrant_client.models import VectorParams, Distance
                self.qdrant.create_collection(
                    collection_name="claude_memory",
                    vectors_config=VectorParams(size=384, distance=Distance.COSINE)
                )

                # Restore points
                points = []
                for entry in qdrant_data:
                    points.append(PointStruct(
                        id=entry["id"],
                        vector=entry["vector"],
                        payload=entry["payload"]
                    ))

                if points:
                    self.qdrant.upsert(collection_name="claude_memory", points=points)
                print(f"Restored Qdrant: {len(points)} entries")

        print("\nRestore complete!")
        return True

    def upgrade_schema(self):
        """Upgrade SQLite schema to enhanced v2.0 with session memory and graph tables."""
        if not self.short_term_db.exists():
            print("No SQLite database to upgrade")
            return

        conn = sqlite3.connect(self.short_term_db)
        cursor = conn.cursor()

        # Check current schema
        cursor.execute("SELECT name FROM sqlite_master WHERE type='table'")
        existing_tables = {row[0] for row in cursor.fetchall()}

        # Add session_memories table if not exists
        if "session_memories" not in existing_tables:
            print("Creating session_memories table...")
            cursor.execute("""
                CREATE TABLE session_memories (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id TEXT NOT NULL,
                    timestamp TEXT NOT NULL,
                    type TEXT NOT NULL CHECK(type IN ('summary', 'decision', 'entity', 'error')),
                    content TEXT NOT NULL,
                    context TEXT,
                    importance INTEGER DEFAULT 5
                )
            """)
            cursor.execute("CREATE INDEX idx_session_memories_session ON session_memories(session_id)")
            cursor.execute("CREATE INDEX idx_session_memories_type ON session_memories(type)")

        # Add entities table if not exists
        if "entities" not in existing_tables:
            print("Creating entities table...")
            cursor.execute("""
                CREATE TABLE entities (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    type TEXT NOT NULL CHECK(type IN ('file', 'function', 'concept', 'error', 'config', 'service')),
                    name TEXT NOT NULL,
                    context TEXT,
                    first_seen TEXT NOT NULL,
                    last_seen TEXT NOT NULL,
                    mention_count INTEGER DEFAULT 1,
                    UNIQUE(type, name)
                )
            """)
            cursor.execute("CREATE INDEX idx_entities_type ON entities(type)")
            cursor.execute("CREATE INDEX idx_entities_name ON entities(name)")

        # Add relationships table if not exists
        if "relationships" not in existing_tables:
            print("Creating relationships table...")
            cursor.execute("""
                CREATE TABLE relationships (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    source_id INTEGER NOT NULL,
                    target_id INTEGER NOT NULL,
                    relation TEXT NOT NULL CHECK(relation IN ('depends_on', 'fixes', 'causes', 'related_to', 'contains', 'implements')),
                    weight REAL DEFAULT 1.0,
                    timestamp TEXT NOT NULL,
                    FOREIGN KEY (source_id) REFERENCES entities(id),
                    FOREIGN KEY (target_id) REFERENCES entities(id)
                )
            """)
            cursor.execute("CREATE INDEX idx_relationships_source ON relationships(source_id)")
            cursor.execute("CREATE INDEX idx_relationships_target ON relationships(target_id)")
            cursor.execute("CREATE INDEX idx_relationships_relation ON relationships(relation)")

        conn.commit()
        conn.close()

        print("Schema upgrade complete!")
        print("\nNew tables added:")
        print("  - session_memories: For session-scoped context")
        print("  - entities: For knowledge graph nodes")
        print("  - relationships: For knowledge graph edges")

    def list_backups(self):
        """List all available backups."""
        backups = []
        for backup_id in sorted(os.listdir(self.backup_dir)):
            backup_path = self.backup_dir / backup_id
            manifest_path = backup_path / "manifest.json"

            if manifest_path.exists():
                with open(manifest_path) as f:
                    manifest = json.load(f)
                backups.append({
                    "id": backup_id,
                    "created_at": manifest.get("created_at"),
                    "sqlite_entries": manifest.get("sqlite_entries", 0),
                    "qdrant_entries": manifest.get("qdrant_entries", 0)
                })

        if not backups:
            print("No backups found")
            return

        print("\nAvailable Backups:")
        print("-" * 60)
        for b in backups:
            print(f"  {b['id']}  |  {b['created_at']}  |  SQLite: {b['sqlite_entries']}  Qdrant: {b['qdrant_entries']}")


def main():
    parser = argparse.ArgumentParser(description="Memory Migration Tool")
    subparsers = parser.add_subparsers(dest="command", help="Command")

    # Export command
    export_parser = subparsers.add_parser("export", help="Export memories")
    export_parser.add_argument("source", choices=["all", "sqlite", "qdrant"])
    export_parser.add_argument("output", help="Output file path")
    export_parser.add_argument("--format", choices=["native", "mem0", "amem"], default="native")

    # Backup command
    subparsers.add_parser("backup", help="Create full backup")

    # Restore command
    restore_parser = subparsers.add_parser("restore", help="Restore from backup")
    restore_parser.add_argument("backup_id", help="Backup ID to restore")

    # List command
    subparsers.add_parser("list", help="List available backups")

    # Upgrade command
    subparsers.add_parser("upgrade", help="Upgrade schema to v2.0")

    args = parser.parse_args()
    migration = MemoryMigration()

    if args.command == "export":
        if args.source == "all":
            migration.export_all(args.output, args.format)
        elif args.source == "sqlite":
            data = migration.export_sqlite()
            with open(args.output, "w") as f:
                json.dump(data, f, indent=2)
            print(f"Exported {len(data)} SQLite entries to {args.output}")
        elif args.source == "qdrant":
            data = migration.export_qdrant(args.format)
            with open(args.output, "w") as f:
                json.dump(data, f, indent=2, default=str)
            print(f"Exported {len(data)} Qdrant entries to {args.output}")

    elif args.command == "backup":
        migration.backup()

    elif args.command == "restore":
        migration.restore(args.backup_id)

    elif args.command == "list":
        migration.list_backups()

    elif args.command == "upgrade":
        migration.upgrade_schema()

    else:
        parser.print_help()


if __name__ == "__main__":
    main()
