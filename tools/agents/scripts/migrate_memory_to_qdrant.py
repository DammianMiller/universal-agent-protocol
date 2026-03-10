#!/usr/bin/env python3
"""
Migrate long-term memory from JSON to Qdrant vector database.

This script:
1. Reads memories from agents/data/memory/long_term.json
2. Generates embeddings using sentence-transformers
3. Upserts vectors to Qdrant collection 'claude_memory'

Requirements:
    pip install sentence-transformers qdrant-client

Usage:
    python agents/scripts/migrate_memory_to_qdrant.py
"""

import json
import uuid
from pathlib import Path

try:
    from sentence_transformers import SentenceTransformer
    from qdrant_client import QdrantClient
    from qdrant_client.models import PointStruct
except ImportError as e:
    print(f"Error: Missing required packages: {e}")
    print("\nPlease install dependencies:")
    print("  cd /home/cogtek/dev/miller-tech/pay2u")
    print("  agents/.venv/bin/pip install sentence-transformers qdrant-client")
    print("\nThen run:")
    print("  agents/.venv/bin/python agents/scripts/migrate_memory_to_qdrant.py")
    exit(1)


def main():
    # Configuration
    QDRANT_HOST = "localhost"
    QDRANT_PORT = 6333
    COLLECTION_NAME = "claude_memory"
    MODEL_NAME = "all-MiniLM-L6-v2"  # 384 dimensions, fast and effective

    project_root = Path(__file__).parent.parent.parent
    memory_file = project_root / "agents/data/memory/long_term.json"

    print(f"Loading memories from {memory_file}")
    with open(memory_file) as f:
        data = json.load(f)

    memories = data.get("memories", [])
    print(f"Found {len(memories)} memories to migrate")

    # Initialize embedding model
    print(f"Loading embedding model: {MODEL_NAME}")
    model = SentenceTransformer(MODEL_NAME)

    # Initialize Qdrant client
    print(f"Connecting to Qdrant at {QDRANT_HOST}:{QDRANT_PORT}")
    client = QdrantClient(host=QDRANT_HOST, port=QDRANT_PORT)

    # Prepare points for upsert
    points = []
    for memory in memories:
        # Generate embedding from content
        content = memory["content"]
        embedding = model.encode(content).tolist()

        # Create point with payload
        point = PointStruct(
            id=str(uuid.uuid4()),
            vector=embedding,
            payload={
                "original_id": memory["id"],
                "type": memory["type"],
                "tags": memory.get("tags", []),
                "importance": memory.get("importance", 5),
                "content": content,
                "timestamp": memory.get("timestamp", "")
            }
        )
        points.append(point)
        print(f"  Encoded: [{memory['type']}] {memory['id']}")

    # Upsert to Qdrant
    print(f"\nUpserting {len(points)} points to collection '{COLLECTION_NAME}'")
    client.upsert(
        collection_name=COLLECTION_NAME,
        points=points
    )

    # Verify
    collection_info = client.get_collection(COLLECTION_NAME)
    print(f"\nCollection '{COLLECTION_NAME}' now has {collection_info.points_count} points")

    # Test search
    print("\nTesting semantic search for 'Redis caching'...")
    test_query = "Redis caching performance"
    test_embedding = model.encode(test_query).tolist()
    results = client.query_points(
        collection_name=COLLECTION_NAME,
        query=test_embedding,
        limit=3
    )

    print("Top 3 results:")
    for i, point in enumerate(results.points, 1):
        print(f"  {i}. [{point.payload['type']}] Score: {point.score:.3f}")
        print(f"     {point.payload['content'][:80]}...")

    print("\nMigration complete!")


if __name__ == "__main__":
    main()
