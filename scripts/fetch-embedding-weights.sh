#!/usr/bin/env bash
# Provision the embedding model weights for the TEI service (:8081).
#
# TEI (agents/docker-compose.yml service `tei-embeddings`) serves
# nomic-embed-text-v2-moe from safetensors (NOT gguf). This script pre-fetches
# the weights into agents/tei_data so `docker compose up -d tei-embeddings`
# starts instantly and works offline/air-gapped. TEI would otherwise self-
# download from HuggingFace on first start (requires network).
#
# Idempotent: re-running is a no-op if the snapshot already exists.
set -euo pipefail

REPO="nomic-ai/nomic-embed-text-v2-moe"
# Resolve repo root so the script works from any cwd.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CACHE_DIR="${ROOT}/agents/tei_data"

mkdir -p "${CACHE_DIR}"

# TEI's Candle backend needs these; model.safetensors is the large one (~1.8GB).
FILES=(
  model.safetensors
  config.json
  tokenizer.json
  config_sentence_transformers.json
  sentence_bert_config.json
  tokenizer_config.json
  special_tokens_map.json
  modules.json
  sentencepiece.bpe.model
  "1_Pooling/config.json"
)

echo "Fetching ${REPO} weights into ${CACHE_DIR} ..."
# NOTE: use the python hf_hub_download API, not the huggingface-cli — the CLI in
# huggingface_hub 1.10.x raises "type 'Choice' is not subscriptable".
python3 - "$REPO" "$CACHE_DIR" "${FILES[@]}" <<'PY'
import sys
from huggingface_hub import hf_hub_download
repo, cache_dir, *files = sys.argv[1:]
for f in files:
    try:
        p = hf_hub_download(repo, f, cache_dir=cache_dir)
        print(f"  ok  {f}")
    except Exception as e:
        print(f"  skip {f}: {e}")
PY

echo "Done. Weights cached under ${CACHE_DIR} (gitignored)."
echo "Bring up TEI:  docker compose -f agents/docker-compose.yml up -d tei-embeddings"
