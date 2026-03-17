#!/usr/bin/env python3
"""
Index patterns from .factory/patterns/ to Qdrant collection.

Works for both OpenCode and Claude Code (Factory Droid) environments.
Creates 'agent_patterns' collection if not exists, indexes all patterns.

Usage:
    python index_patterns.py                    # Index all patterns
    python index_patterns.py --recreate         # Drop and recreate collection
    python index_patterns.py --status           # Check collection status
"""

import argparse
import json
import sys
from pathlib import Path

try:
    from sentence_transformers import SentenceTransformer
    from qdrant_client import QdrantClient, models
except ImportError:
    print("ERROR: Required packages not installed.")
    print("Run: pip install sentence-transformers qdrant-client")
    sys.exit(1)

# Configuration
QDRANT_HOST = "localhost"
QDRANT_PORT = 6333
COLLECTION_NAME = "agent_patterns"
EMBEDDING_MODEL = "all-MiniLM-L6-v2"
VECTOR_SIZE = 384  # all-MiniLM-L6-v2 dimension

# Cache model globally
_model = None


def get_model():
    """Get or initialize the embedding model."""
    global _model
    if _model is None:
        print(f"Loading embedding model: {EMBEDDING_MODEL}")
        _model = SentenceTransformer(EMBEDDING_MODEL, device="cpu")
    return _model


def get_client():
    """Get Qdrant client."""
    return QdrantClient(host=QDRANT_HOST, port=QDRANT_PORT)


def collection_exists(client: QdrantClient) -> bool:
    """Check if collection exists."""
    collections = client.get_collections()
    return any(c.name == COLLECTION_NAME for c in collections.collections)


def create_collection(client: QdrantClient, recreate: bool = False):
    """Create or recreate the collection."""
    if recreate and collection_exists(client):
        print(f"Dropping existing collection: {COLLECTION_NAME}")
        client.delete_collection(COLLECTION_NAME)

    if not collection_exists(client):
        print(f"Creating collection: {COLLECTION_NAME}")
        client.create_collection(
            collection_name=COLLECTION_NAME,
            vectors_config=models.VectorParams(
                size=VECTOR_SIZE, distance=models.Distance.COSINE
            ),
        )


def load_patterns(patterns_dir: Path) -> list[dict]:
    """Load all patterns from directory."""
    index_file = patterns_dir / "index.json"

    if not index_file.exists():
        print(f"ERROR: index.json not found in {patterns_dir}")
        sys.exit(1)

    with open(index_file) as f:
        index = json.load(f)

    patterns = []
    for meta in index["patterns"]:
        pattern_file = patterns_dir / meta["file"]
        if not pattern_file.exists():
            print(f"WARNING: Pattern file not found: {pattern_file}")
            continue

        with open(pattern_file) as f:
            content = f.read()

        patterns.append(
            {
                "id": meta["id"],
                "file": meta["file"],
                "title": meta["title"],
                "abbreviation": meta.get("abbreviation", ""),
                "category": meta.get("category", "General"),
                "keywords": meta.get("keywords", []),
                "body": content,
            }
        )

    return patterns


def index_patterns(client: QdrantClient, patterns: list[dict]):
    """Index all patterns to Qdrant."""
    model = get_model()

    points = []
    for p in patterns:
        # Create embedding text from title, keywords, and body
        embed_text = f"{p['title']}\n{' '.join(p['keywords'])}\n{p['body']}"
        vector = model.encode(embed_text).tolist()

        # Use pattern ID as point ID (convert string IDs to hash)
        point_id = hash(str(p["id"])) % (2**63) if isinstance(p["id"], str) else p["id"]

        points.append(
            models.PointStruct(
                id=point_id,
                vector=vector,
                payload={
                    "id": p["id"],
                    "title": p["title"],
                    "abbreviation": p["abbreviation"],
                    "category": p["category"],
                    "keywords": p["keywords"],
                    "body": p["body"],
                    "file": p["file"],
                },
            )
        )

    print(f"Indexing {len(points)} patterns...")
    client.upsert(collection_name=COLLECTION_NAME, points=points)
    print("Done!")


def show_status(client: QdrantClient):
    """Show collection status."""
    if not collection_exists(client):
        print(f"Collection '{COLLECTION_NAME}' does not exist.")
        return

    info = client.get_collection(COLLECTION_NAME)
    print(f"Collection: {COLLECTION_NAME}")
    print(f"  Points count: {info.points_count}")
    print(f"  Vector size: {info.config.params.vectors.size}")
    print(f"  Distance: {info.config.params.vectors.distance}")
    print(f"  Status: {info.status}")


def main():
    parser = argparse.ArgumentParser(description="Index patterns to Qdrant")
    parser.add_argument("--recreate", action="store_true", help="Recreate collection")
    parser.add_argument("--status", action="store_true", help="Show collection status")
    parser.add_argument(
        "--patterns-dir",
        type=Path,
        default=Path(__file__).parent.parent.parent / ".factory" / "patterns",
        help="Patterns directory (default: .factory/patterns/)",
    )

    args = parser.parse_args()

    try:
        client = get_client()

        if args.status:
            show_status(client)
            return

        create_collection(client, args.recreate)
        patterns = load_patterns(args.patterns_dir)
        index_patterns(client, patterns)
        show_status(client)

    except Exception as e:
        print(f"ERROR: {e}")
        print("\nMake sure Qdrant is running:")
        print("  docker run -p 6333:6333 qdrant/qdrant")
        sys.exit(1)


if __name__ == "__main__":
    main()
