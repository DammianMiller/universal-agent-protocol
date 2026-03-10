#!/usr/bin/env python3
"""
Query agent memory systems (both short-term SQLite and long-term Qdrant).

Usage:
    # Query short-term memory (recent actions)
    agents/.venv/bin/python agents/scripts/query_memory.py short

    # Semantic search in long-term memory
    agents/.venv/bin/python agents/scripts/query_memory.py long "Redis caching"

    # Add to short-term memory
    agents/.venv/bin/python agents/scripts/query_memory.py add action "Deployed new feature X"

    # Add to long-term memory (with embedding)
    agents/.venv/bin/python agents/scripts/query_memory.py store lesson "Always check network policies" --tags networking,kubernetes --importance 8
"""

import argparse
import json
import sqlite3
import uuid
from datetime import datetime
from pathlib import Path

try:
    from sentence_transformers import SentenceTransformer
    from qdrant_client import QdrantClient
    from qdrant_client.models import PointStruct
    QDRANT_AVAILABLE = True
except ImportError:
    QDRANT_AVAILABLE = False


def get_project_root():
    return Path(__file__).parent.parent.parent


def query_short_term(limit=50):
    """Query short-term SQLite memory."""
    db_path = get_project_root() / "agents/data/memory/short_term.db"

    if not db_path.exists():
        print("Short-term memory not initialized.")
        return

    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()

    cursor.execute("""
        SELECT id, timestamp, type, content
        FROM memories
        ORDER BY id DESC
        LIMIT ?
    """, (limit,))

    rows = cursor.fetchall()
    conn.close()

    print(f"=== Short-term Memory (last {len(rows)} entries) ===\n")
    for row in rows:
        id_, timestamp, type_, content = row
        print(f"[{id_:3d}] {timestamp} [{type_:11s}]")
        print(f"      {content[:100]}{'...' if len(content) > 100 else ''}")
        print()


def add_short_term(type_: str, content: str):
    """Add entry to short-term memory."""
    db_path = get_project_root() / "agents/data/memory/short_term.db"

    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()

    timestamp = datetime.utcnow().isoformat() + "Z"
    cursor.execute(
        "INSERT INTO memories (timestamp, type, content) VALUES (?, ?, ?)",
        (timestamp, type_, content)
    )

    conn.commit()
    print(f"Added to short-term memory: [{type_}] {content[:50]}...")
    conn.close()


def query_long_term(query: str, limit=5):
    """Semantic search in long-term Qdrant memory."""
    if not QDRANT_AVAILABLE:
        print("Qdrant client not available. Install with:")
        print("  agents/.venv/bin/pip install sentence-transformers qdrant-client")
        return

    client = QdrantClient(host="localhost", port=6333)
    model = SentenceTransformer("all-MiniLM-L6-v2")

    query_embedding = model.encode(query).tolist()

    results = client.query_points(
        collection_name="claude_memory",
        query=query_embedding,
        limit=limit
    )

    print(f"=== Long-term Memory Search: '{query}' ===\n")
    for i, point in enumerate(results.points, 1):
        payload = point.payload
        print(f"{i}. [{payload['type']:10s}] Score: {point.score:.3f}")
        print(f"   Tags: {', '.join(payload.get('tags', []))}")
        print(f"   {payload['content'][:100]}...")
        print()


def store_long_term(type_: str, content: str, tags: list, importance: int):
    """Store new entry in long-term Qdrant memory."""
    if not QDRANT_AVAILABLE:
        print("Qdrant client not available. Install with:")
        print("  agents/.venv/bin/pip install sentence-transformers qdrant-client")
        return

    client = QdrantClient(host="localhost", port=6333)
    model = SentenceTransformer("all-MiniLM-L6-v2")

    embedding = model.encode(content).tolist()

    point = PointStruct(
        id=str(uuid.uuid4()),
        vector=embedding,
        payload={
            "original_id": f"{type_}-{uuid.uuid4().hex[:8]}",
            "type": type_,
            "tags": tags,
            "importance": importance,
            "content": content,
            "timestamp": datetime.utcnow().isoformat() + "Z"
        }
    )

    client.upsert(
        collection_name="claude_memory",
        points=[point]
    )

    print(f"Stored in long-term memory: [{type_}] importance={importance}")
    print(f"  Tags: {', '.join(tags)}")
    print(f"  {content[:80]}...")


def main():
    parser = argparse.ArgumentParser(description="Query agent memory systems")
    subparsers = parser.add_subparsers(dest="command", help="Command")

    # Short-term query
    short_parser = subparsers.add_parser("short", help="Query short-term memory")
    short_parser.add_argument("-n", "--limit", type=int, default=50, help="Number of entries")

    # Long-term query
    long_parser = subparsers.add_parser("long", help="Semantic search in long-term memory")
    long_parser.add_argument("query", help="Search query")
    long_parser.add_argument("-n", "--limit", type=int, default=5, help="Number of results")

    # Add to short-term
    add_parser = subparsers.add_parser("add", help="Add to short-term memory")
    add_parser.add_argument("type", choices=["action", "observation", "thought", "goal"])
    add_parser.add_argument("content", help="Memory content")

    # Store in long-term
    store_parser = subparsers.add_parser("store", help="Store in long-term memory")
    store_parser.add_argument("type", choices=["fact", "skill", "preference", "lesson", "discovery"])
    store_parser.add_argument("content", help="Memory content")
    store_parser.add_argument("--tags", default="", help="Comma-separated tags")
    store_parser.add_argument("--importance", type=int, default=5, help="Importance 1-10")

    args = parser.parse_args()

    if args.command == "short":
        query_short_term(args.limit)
    elif args.command == "long":
        query_long_term(args.query, args.limit)
    elif args.command == "add":
        add_short_term(args.type, args.content)
    elif args.command == "store":
        tags = [t.strip() for t in args.tags.split(",") if t.strip()]
        store_long_term(args.type, args.content, tags, args.importance)
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
