#!/usr/bin/env python3
"""Re-embed the agent_memory Qdrant collection with the active semantic embedder.

Why: the long-term memory collection was historically populated with a deterministic
hash placeholder embedding (384-dim), so semantic recall returned ~random scores.
This re-embeds every stored memory's content with the real embedder
(nomic-embed-text-v2-moe via llama.cpp, 768-dim, "search_document:" prefix) — matching
what src/cli/memory.ts now uses for store + query.

Idempotent: backs up existing points to JSON, recreates the collection at the embedder's
true dimension, and re-upserts the SAME ids + payloads with real vectors.

Env:
  UAP_EMBEDDING_ENDPOINT  llama.cpp embeddings server (default http://192.168.1.165:8081)
  QDRANT_URL              Qdrant URL (default http://localhost:6333)
"""
from __future__ import annotations

import json
import os
import sys
import urllib.request
from pathlib import Path

from qdrant_client import QdrantClient
from qdrant_client.models import Distance, VectorParams, PointStruct

COLLECTION = "agent_memory"
EMBED_ENDPOINT = os.environ.get("UAP_EMBEDDING_ENDPOINT", "http://192.168.1.165:8081")
QDRANT_URL = os.environ.get("QDRANT_URL", "http://localhost:6333")
DOC_PREFIX = "search_document: "
BATCH = 8  # small: the llama.cpp embed server caps total tokens per request
MAX_CHARS = 2000  # truncate long memories to stay under the embed context limit
BACKUP_DIR = Path(__file__).resolve().parents[2] / "agents" / "data" / "memory"


def _post(inputs: list[str]) -> list[list[float]]:
    body = json.dumps({"input": inputs}).encode()
    req = urllib.request.Request(
        f"{EMBED_ENDPOINT}/v1/embeddings",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        payload = json.loads(resp.read().decode())
    data = sorted(payload["data"], key=lambda d: d["index"])
    return [d["embedding"] for d in data]


_DIM = 768  # set from the live probe in main(); used as zero-vector fallback width


def embed(texts: list[str]) -> list[list[float]]:
    """Embed via the llama.cpp endpoint (same prefix/format as embeddings.ts).

    Truncates long content and falls back to per-document requests if a batch
    exceeds the server's per-request token budget. A document the server still
    rejects (e.g. empty or pathological) gets a zero vector so its payload is
    preserved (it just won't surface in semantic search)."""
    inputs = [DOC_PREFIX + (t[:MAX_CHARS] or "(empty)") for t in texts]
    try:
        return _post(inputs)
    except Exception:
        out: list[list[float]] = []
        for one in inputs:
            try:
                out.extend(_post([one]))
            except Exception:
                out.append([0.0] * _DIM)
        return out


def main() -> int:
    client = QdrantClient(url=QDRANT_URL, check_compatibility=False)
    backup = BACKUP_DIR / "agent_memory_backup.json"

    # 1. Read existing points (content + payload). Each item: (id, payload).
    try:
        existing_pts, _ = client.scroll(
            COLLECTION, limit=100000, with_payload=True, with_vectors=False
        )
    except Exception:
        existing_pts = []
    items = [(p.id, p.payload or {}) for p in existing_pts]
    print(f"  Read {len(items)} points from '{COLLECTION}'")

    # 2. Backup to JSON (recovery safety) — or restore from it if the collection is
    #    empty (e.g. a previous run recreated it but failed before re-upserting).
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    if items:
        backup.write_text(json.dumps([{"id": str(i), "payload": p} for i, p in items], default=str))
        print(f"  Backed up to {backup}")
    elif backup.exists():
        restored = json.loads(backup.read_text())
        items = [(e["id"], e.get("payload") or {}) for e in restored]
        print(f"  Collection empty — restoring {len(items)} points from {backup}")

    if not items:
        print("  Nothing to re-embed — exiting.")
        return 0

    # 3. Determine the embedder's true dimension.
    global _DIM
    dim = len(embed(["dimension probe"])[0])
    _DIM = dim
    print(f"  Active embedder dimension: {dim}")

    # 4. Recreate the collection at the embedder dimension.
    client.delete_collection(COLLECTION)
    client.create_collection(
        collection_name=COLLECTION,
        vectors_config=VectorParams(size=dim, distance=Distance.COSINE),
    )
    print(f"  Recreated '{COLLECTION}' at {dim}-dim cosine")

    # 5. Re-embed content and re-upsert with original ids + payloads.
    upserted = 0
    for i in range(0, len(items), BATCH):
        chunk = items[i : i + BATCH]
        contents = [str((payload or {}).get("content", "")) for _id, payload in chunk]
        vectors = embed(contents)
        points = [
            PointStruct(id=pid, vector=vectors[j], payload=payload)
            for j, (pid, payload) in enumerate(chunk)
        ]
        client.upsert(collection_name=COLLECTION, points=points)
        upserted += len(points)
        print(f"  upserted {upserted}/{len(items)}", end="\r")

    print(f"\n  Done: re-embedded {upserted} memories into '{COLLECTION}' at {dim}-dim.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
