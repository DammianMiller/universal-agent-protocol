#!/usr/bin/env python3
"""
Qdrant Vector Database Initialization Script

This script initializes the Qdrant collection for semantic memory.

Usage:
    tools/agents/scripts/init_qdrant.py
"""

import sys
from pathlib import Path

try:
    from sentence_transformers import SentenceTransformer
    from qdrant_client import QdrantClient
    from qdrant_client.models import (
        Distance,
        VectorParams,
        PointStruct,
    )
except ImportError:
    print("❌ Required packages not installed")
    print("\nInstall with:")
    print("  tools/agents/.venv/bin/pip install sentence-transformers qdrant-client")
    sys.exit(1)


def get_project_root():
    """Get project root directory."""
    return Path(__file__).parent.parent.parent


def init_collection():
    """Initialize Qdrant collection for UAP memory."""
    print("=== Initializing Qdrant Vector Database ===\n")

    # Connect to Qdrant
    client = QdrantClient(host="localhost", port=6333)

    # Check if collection exists
    collections = client.get_collections().collections
    collection_name = "agent_memory"

    if any(c.name == collection_name for c in collections):
        print(f"⚠️  Collection '{collection_name}' already exists")
        response = input("Delete and recreate? (y/N): ").strip().lower()
        if response != "y":
            print("Skipping initialization")
            return 0

    # Load embedding model
    print("📦 Loading embedding model (this may take a minute)...")
    model = SentenceTransformer("all-MiniLM-L6-v2", device="cpu")
    vector_size = len(model.encode("test"))
    print(f"   ✅ Model loaded, vector size: {vector_size}")

    # Create collection
    print(f"\n📦 Creating collection '{collection_name}'...")
    client.create_collection(
        collection_name=collection_name,
        vectors=VectorParams(size=vector_size, distance=Distance.COSINE),
    )
    print("   ✅ Collection created")

    # Create payload index for metadata filtering
    print("\n📦 Creating payload indexes...")
    client.create_payload_index(
        collection_name=collection_name,
        field_name="type",
        field_schema="keyword",
    )
    client.create_payload_index(
        collection_name=collection_name,
        field_name="tags",
        field_schema="keyword",
    )
    client.create_payload_index(
        collection_name=collection_name,
        field_name="importance",
        field_schema="integer",
    )
    print("   ✅ Payload indexes created")

    # Migrate existing JSON memories
    json_memory_path = get_project_root() / "agents/data/memory/long_term.json"
    if json_memory_path.exists():
        print(f"\n📦 Migrating memories from {json_memory_path}...")

        import json

        with open(json_memory_path, "r") as f:
            data = json.load(f)

        memories = data.get("memories", [])
        points = []

        for mem in memories:
            embedding = model.encode(mem["content"]).tolist()

            point = PointStruct(
                id=mem.get("id", hash(mem["content"]) % 1000000),
                vector=embedding,
                payload={
                    "original_id": mem.get("id"),
                    "type": mem.get("type"),
                    "tags": mem.get("tags", []),
                    "importance": mem.get("importance", 5),
                    "content": mem.get("content"),
                    "timestamp": mem.get("timestamp"),
                },
            )
            points.append(point)

        if points:
            client.upsert(collection_name=collection_name, points=points)
            print(f"   ✅ Migrated {len(points)} memories")
        else:
            print("   ⚠️  No memories to migrate")
    else:
        print("\n⚠️  No long_term.json found (skipping migration)")

    # Test query
    print("\n📦 Testing collection...")
    test_query = "architecture"
    test_embedding = model.encode(test_query).tolist()

    results = client.search(
        collection_name=collection_name,
        query_vector=test_embedding,
        limit=3,
    )

    print(f"   ✅ Query successful: {len(results)} results found")

    print("\n" + "=" * 50)
    print("✅ Qdrant initialization completed!")
    print("=" * 50)
    print("\nCollection details:")
    print(f"  Name: {collection_name}")
    print(f"  Vector size: {vector_size}")
    print(f"  Distance: COSINE")
    print(f"  REST API: http://localhost:6333")
    print(f"\nTo query:")
    print('  tools/agents/scripts/query_memory.py long "<query>"')

    return 0


if __name__ == "__main__":
    sys.exit(init_collection())
