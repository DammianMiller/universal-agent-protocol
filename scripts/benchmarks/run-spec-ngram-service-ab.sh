#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
LLAMA_BIN="${LLAMA_BIN:-/home/cogtek/llama.cpp/.worktrees/001-llama-spec-rollback-fix/build-cuda/bin/llama-server}"
LLAMA_MODEL="${LLAMA_MODEL:-/home/cogtek/Downloads/Qwen3.5-35B-A3B-UD-IQ4_XS.gguf}"
MODEL_ID="${MODEL_ID:-qwen3.5-a3b-iq4xs}"
RUNS="${RUNS:-6}"
MAX_TOKENS="${MAX_TOKENS:-256}"
PROFILE="${PROFILE:-throughput}"
STAMP="$(date +%Y%m%d_%H%M%S)"
OUT_DIR="${ROOT_DIR}/benchmark-results/spec-ngram-ab-${STAMP}"
mkdir -p "$OUT_DIR"

function start_unit() {
  local spec_type="$1"
  local draft_max="$2"
  local draft_min="$3"
  local draft_p_min="$4"

  systemctl --user stop uap-llama-server-bench.service 2>/dev/null || true
  systemd-run --user --unit uap-llama-server-bench --property=Restart=no \
    "$LLAMA_BIN" \
    --model "$LLAMA_MODEL" \
    --host 0.0.0.0 \
    --port 8080 \
    --threads 32 \
    --ctx-size 262144 \
    --cache-type-k q4_0 \
    --cache-type-v q4_0 \
    --gpu-layers 99 \
    --flash-attn on \
    --batch-size 512 \
    --ubatch-size 512 \
    --parallel 1 \
    --no-context-shift \
    --n-predict 32768 \
    --repeat-penalty 1.0 \
    --defrag-thold 0.1 \
    --spec-type "$spec_type" \
    --draft-max "$draft_max" \
    --draft-min "$draft_min" \
    --draft-p-min "$draft_p_min" \
    --log-file /home/cogtek/llama.cpp/llama-server.log >/dev/null

  for _ in $(seq 1 120); do
    if curl -sf --max-time 2 http://127.0.0.1:8080/v1/models >/dev/null; then
      return 0
    fi
    sleep 1
  done

  echo "Timed out waiting for llama-server readiness" >&2
  return 1
}

function bench_json() {
  local out_file="$1"
  node "$ROOT_DIR/dist/bin/llama-server-optimize.js" spec-benchmark-live \
    --endpoint http://127.0.0.1:8080/v1 \
    --model "$MODEL_ID" \
    --runs "$RUNS" \
    --max-tokens "$MAX_TOKENS" \
    --profile "$PROFILE" \
    --json >"$out_file"
}

echo "[1/5] Stopping managed llama service for transient A/B runs"
systemctl --user stop uap-llama-server.service

echo "[2/5] Baseline: spec-type=none"
start_unit none 16 3 0.75
bench_json "$OUT_DIR/spec-none.json"

echo "[3/5] Variant A: ngram-cache default"
start_unit ngram-cache 16 3 0.75
bench_json "$OUT_DIR/spec-ngram-default.json"

echo "[4/5] Variant B: ngram-cache tuned"
start_unit ngram-cache 21 6 0.72
bench_json "$OUT_DIR/spec-ngram-tuned.json"

echo "[5/5] Restoring managed llama service"
systemctl --user stop uap-llama-server-bench.service
systemctl --user start uap-llama-server.service

python3 - "$OUT_DIR" <<'PY'
import json
import pathlib
import sys

out_dir = pathlib.Path(sys.argv[1])
none = json.loads((out_dir / "spec-none.json").read_text())
ngram_default = json.loads((out_dir / "spec-ngram-default.json").read_text())
ngram_tuned = json.loads((out_dir / "spec-ngram-tuned.json").read_text())

def tps(payload):
    return float(payload["liveSummary"]["tokensPerSecond"])

def latency(payload):
    return float(payload["liveSummary"]["avgLatencyMs"])

baseline_tps = tps(none)
default_tps = tps(ngram_default)
tuned_tps = tps(ngram_tuned)

report = {
    "baseline_none": none,
    "ngram_default": ngram_default,
    "ngram_tuned": ngram_tuned,
    "deltas": {
        "ngram_default_vs_none_tps_pct": round(((default_tps - baseline_tps) / baseline_tps) * 100, 2),
        "ngram_tuned_vs_none_tps_pct": round(((tuned_tps - baseline_tps) / baseline_tps) * 100, 2),
        "ngram_tuned_vs_default_tps_pct": round(((tuned_tps - default_tps) / default_tps) * 100, 2),
        "ngram_default_vs_none_latency_pct": round(((latency(ngram_default) - latency(none)) / latency(none)) * 100, 2),
        "ngram_tuned_vs_none_latency_pct": round(((latency(ngram_tuned) - latency(none)) / latency(none)) * 100, 2),
    },
}

(out_dir / "report.json").write_text(json.dumps(report, indent=2))

md = []
md.append("# Speculative ngram-cache A/B Report")
md.append("")
md.append("| Scenario | tok/s | avg latency ms |")
md.append("|---|---:|---:|")
md.append(f"| spec-type=none | {baseline_tps:.2f} | {latency(none):.2f} |")
md.append(f"| ngram-cache default (16/3/0.75) | {default_tps:.2f} | {latency(ngram_default):.2f} |")
md.append(f"| ngram-cache tuned (21/6/0.72) | {tuned_tps:.2f} | {latency(ngram_tuned):.2f} |")
md.append("")
md.append(f"- ngram default vs none (tok/s): {report['deltas']['ngram_default_vs_none_tps_pct']}%")
md.append(f"- ngram tuned vs none (tok/s): {report['deltas']['ngram_tuned_vs_none_tps_pct']}%")
md.append(f"- ngram tuned vs default (tok/s): {report['deltas']['ngram_tuned_vs_default_tps_pct']}%")
md.append(f"- ngram default vs none (latency): {report['deltas']['ngram_default_vs_none_latency_pct']}%")
md.append(f"- ngram tuned vs none (latency): {report['deltas']['ngram_tuned_vs_none_latency_pct']}%")

(out_dir / "report.md").write_text("\n".join(md) + "\n")
print(out_dir)
PY

echo "Report written to: $OUT_DIR/report.md"
cat "$OUT_DIR/report.md"
