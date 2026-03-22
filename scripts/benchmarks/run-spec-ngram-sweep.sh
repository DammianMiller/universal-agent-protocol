#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LLAMA_BIN="${LLAMA_BIN:-/home/cogtek/llama.cpp/.worktrees/001-llama-spec-rollback-fix/build-cuda/bin/llama-server}"
LLAMA_MODEL="${LLAMA_MODEL:-/home/cogtek/Downloads/Qwen3.5-35B-A3B-UD-IQ4_XS.gguf}"
MODEL_ID="${MODEL_ID:-qwen3.5-a3b-iq4xs}"
RUNS="${RUNS:-4}"
MAX_TOKENS="${MAX_TOKENS:-256}"
PROFILE="${PROFILE:-throughput}"
SPEC_TYPE="${SPEC_TYPE:-ngram-cache}"
LLAMA_THREADS="${LLAMA_THREADS:-32}"
LLAMA_CTX_SIZE="${LLAMA_CTX_SIZE:-262144}"
LLAMA_GPU_LAYERS="${LLAMA_GPU_LAYERS:-99}"
LLAMA_BATCH_SIZE="${LLAMA_BATCH_SIZE:-512}"
LLAMA_UBATCH_SIZE="${LLAMA_UBATCH_SIZE:-512}"

DRAFT_MAXS="${DRAFT_MAXS:-16 18 20 21 22}"
DRAFT_MINS="${DRAFT_MINS:-3 4 5 6}"
DRAFT_P_MINS="${DRAFT_P_MINS:-0.70 0.72 0.75 0.78}"

STAMP="$(date +%Y%m%d_%H%M%S)"
OUT_DIR="${ROOT_DIR}/benchmark-results/spec-ngram-sweep-${STAMP}"
mkdir -p "$OUT_DIR"

function wait_ready() {
  for _ in $(seq 1 120); do
    if curl -sf --max-time 2 http://127.0.0.1:8080/v1/models >/dev/null; then
      return 0
    fi
    sleep 1
  done
  echo "Timed out waiting for llama-server on :8080" >&2
  return 1
}

function start_candidate() {
  local draft_max="$1"
  local draft_min="$2"
  local draft_p_min="$3"

  systemctl --user stop uap-llama-server-bench.service 2>/dev/null || true
  systemd-run --user --unit uap-llama-server-bench --property=Restart=no \
    "$LLAMA_BIN" \
    --model "$LLAMA_MODEL" \
    --host 0.0.0.0 \
    --port 8080 \
    --threads "$LLAMA_THREADS" \
    --ctx-size "$LLAMA_CTX_SIZE" \
    --cache-type-k q4_0 \
    --cache-type-v q4_0 \
    --gpu-layers "$LLAMA_GPU_LAYERS" \
    --flash-attn on \
    --batch-size "$LLAMA_BATCH_SIZE" \
    --ubatch-size "$LLAMA_UBATCH_SIZE" \
    --parallel 1 \
    --no-context-shift \
    --n-predict 32768 \
    --repeat-penalty 1.0 \
    --defrag-thold 0.1 \
    --spec-type "$SPEC_TYPE" \
    --draft-max "$draft_max" \
    --draft-min "$draft_min" \
    --draft-p-min "$draft_p_min" \
    --log-file /home/cogtek/llama.cpp/llama-server.log >/dev/null

  wait_ready
}

echo "Stopping managed llama service during sweep"
systemctl --user stop uap-llama-server.service

cleanup() {
  systemctl --user stop uap-llama-server-bench.service 2>/dev/null || true
  systemctl --user start uap-llama-server.service
}
trap cleanup EXIT

RESULTS_JSONL="$OUT_DIR/results.jsonl"
touch "$RESULTS_JSONL"

echo "{" >"$OUT_DIR/meta.json"
echo "  \"specType\": \"$SPEC_TYPE\"," >>"$OUT_DIR/meta.json"
echo "  \"runs\": $RUNS," >>"$OUT_DIR/meta.json"
echo "  \"maxTokens\": $MAX_TOKENS," >>"$OUT_DIR/meta.json"
echo "  \"profile\": \"$PROFILE\"" >>"$OUT_DIR/meta.json"
echo "}" >>"$OUT_DIR/meta.json"

idx=0
for draft_max in $DRAFT_MAXS; do
  for draft_min in $DRAFT_MINS; do
    if (( draft_min > draft_max )); then
      continue
    fi

    for draft_p_min in $DRAFT_P_MINS; do
      idx=$((idx + 1))
      echo "[$idx] testing draft-max=$draft_max draft-min=$draft_min draft-p-min=$draft_p_min"

      start_candidate "$draft_max" "$draft_min" "$draft_p_min"

      raw_file="$OUT_DIR/run-${idx}.json"
      node "$ROOT_DIR/dist/bin/llama-server-optimize.js" spec-benchmark-live \
        --endpoint http://127.0.0.1:8080/v1 \
        --model "$MODEL_ID" \
        --runs "$RUNS" \
        --max-tokens "$MAX_TOKENS" \
        --profile "$PROFILE" \
        --draft-max "$draft_max" \
        --draft-min "$draft_min" \
        --draft-p-min "$draft_p_min" \
        --json >"$raw_file"

      python3 - "$raw_file" "$draft_max" "$draft_min" "$draft_p_min" >>"$RESULTS_JSONL" <<'PY'
import json
import pathlib
import sys

payload = json.loads(pathlib.Path(sys.argv[1]).read_text())
entry = {
    "draftMax": int(sys.argv[2]),
    "draftMin": int(sys.argv[3]),
    "draftPMin": float(sys.argv[4]),
    "tokensPerSecond": payload["liveSummary"]["tokensPerSecond"],
    "avgLatencyMs": payload["liveSummary"]["avgLatencyMs"],
    "successfulRuns": payload["successfulRuns"],
    "failedRuns": payload["failedRuns"],
}
print(json.dumps(entry))
PY
    done
  done
done

python3 - "$RESULTS_JSONL" "$OUT_DIR" <<'PY'
import json
import pathlib
import statistics
import sys

results_path = pathlib.Path(sys.argv[1])
out_dir = pathlib.Path(sys.argv[2])

rows = [json.loads(line) for line in results_path.read_text().splitlines() if line.strip()]
rows.sort(key=lambda r: (-float(r["tokensPerSecond"]), float(r["avgLatencyMs"])))

best = rows[0]
top5 = rows[:5]

summary = {
    "candidateCount": len(rows),
    "best": best,
    "top5": top5,
    "tpsStats": {
        "mean": round(statistics.mean(float(r["tokensPerSecond"]) for r in rows), 3),
        "stdev": round(statistics.pstdev(float(r["tokensPerSecond"]) for r in rows), 3),
    },
}

(out_dir / "summary.json").write_text(json.dumps(summary, indent=2))

lines = []
lines.append("# Speculative ngram-cache Sweep Report")
lines.append("")
lines.append(f"Candidates tested: {summary['candidateCount']}")
lines.append("")
lines.append("## Best Candidate")
lines.append("")
lines.append(
    f"- --draft-max {best['draftMax']} --draft-min {best['draftMin']} --draft-p-min {best['draftPMin']}"
)
lines.append(f"- tokens/s: {best['tokensPerSecond']}")
lines.append(f"- avg latency: {best['avgLatencyMs']} ms")
lines.append("")
lines.append("## Top 5")
lines.append("")
lines.append("| rank | draft-max | draft-min | draft-p-min | tok/s | avg latency ms |")
lines.append("|---:|---:|---:|---:|---:|---:|")
for i, row in enumerate(top5, 1):
    lines.append(
        f"| {i} | {row['draftMax']} | {row['draftMin']} | {row['draftPMin']} | {row['tokensPerSecond']} | {row['avgLatencyMs']} |"
    )

(out_dir / "summary.md").write_text("\n".join(lines) + "\n")
print(out_dir)
PY

echo "Sweep complete."
echo "  Results dir: $OUT_DIR"
echo "  Best config: $(python3 -c "import json;print('--draft-max',json.load(open('$OUT_DIR/summary.json'))['best']['draftMax'],'--draft-min',json.load(open('$OUT_DIR/summary.json'))['best']['draftMin'],'--draft-p-min',json.load(open('$OUT_DIR/summary.json'))['best']['draftPMin'])")"
echo ""
cat "$OUT_DIR/summary.md"
