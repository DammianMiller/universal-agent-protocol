#!/usr/bin/env bash
# Qwen3.8-27B-FP8 (local vLLM via litellm), 5 passes x {single, manager}, LCB-100 pinned ids.

set -u
cd "$(dirname "${BASH_SOURCE[0]}")/../.." || exit 1
ROOT="$(cd ../.. && pwd)"
export PATH="$HOME/.local/bin:$PATH"
command -v uv >/dev/null || { echo "FATAL: uv not on PATH ($PATH)"; exit 1; }
PYTHON=(uv run --no-project --python 3.12 --with 'datasets<4' --with numpy --with anthropic python)
export LCB_RELEASE=release_v6
export HF_HOME="${HF_HOME:-$HOME/.cache/huggingface}"
export MULTIAGENT_MAX_ITERS=10 MULTIAGENT_MAX_TASKS=12
OUT="$ROOT/runs/4models-1pass-reason-on/results"
WS="$ROOT/runs/4models-1pass-reason-on/ws"
IDS=escalation/lcb100_hardest_v6.json
mkdir -p "$OUT" "$WS"

set -a; [ -f escalation/.env ] && . escalation/.env; set +a
LITELLM_CONFIG="${LITELLM_CONFIG:-/home/persis/litellm/config.yaml}"
K="${LITELLM_KEY:-$(grep -m1 'master_key:' "$LITELLM_CONFIG" 2>/dev/null | awk '{print $2}')}"
TAG=q38
REMAIN=${REMAIN:-8}
TOTAL=100
PAR=${PAR:-12}

launch() {
  local eng=$1 p=$2
  local out="$OUT/${TAG}_${eng}_p${p}.json"
  if [ -f "$out" ]; then echo "[skip done] ${TAG}_${eng}_p${p}"; return 1; fi
  local cap=250000 par=12
  if [ "$eng" = "multiagent" ]; then cap=128000; par=24; fi
  echo "[$(date +%H:%M:%S)] start ${TAG}_${eng}_p${p} (cap=${cap} parallel=${par})"
  env ESCALATION_OPENAI_BASE="http://localhost:8216/v1/chat/completions" \
      GROQ_API_KEY="$K" \
      ESCALATION_GROQ_REASONING="" \
      ESCALATION_CLOUD_MAX_TOKENS="$cap" \
      ESCALATION_CLOUD_TIMEOUT=14400 \
      MULTIAGENT_MODEL="groq:small-model" \
      MULTIAGENT_WS="$WS/${TAG}_${eng}_p${p}" \
    "${PYTHON[@]}" escalation/run_bench.py \
      --engine "$eng" --only lcb --lcb "$TOTAL" --ids-file "$IDS" --parallel "$par" --out "$out" \
      > "/tmp/camp_${TAG}_${eng}_p${p}.log" 2>&1 &
  LAST_PID=$!
  return 0
}

wait_almost() {
  local eng=$1 p=$2
  local out="$OUT/${TAG}_${eng}_p${p}.json"
  local log="/tmp/camp_${TAG}_${eng}_p${p}.log"
  while true; do
    [ -f "$out" ] && { echo "[$(date +%H:%M:%S)] ${TAG}_${eng}_p${p} finished"; return; }
    if ! kill -0 "$LAST_PID" 2>/dev/null; then
      echo "[$(date +%H:%M:%S)] !! ${TAG}_${eng}_p${p} EXITED without writing $out"
      echo "   last log lines:"; tail -5 "$log" 2>/dev/null | sed 's/^/   /'
      return 1
    fi
    local d=0
    if [ -f "$log" ]; then d=$(grep -c 'done (' "$log" 2>/dev/null) || d=0; fi
    if [ "$d" -ge $((TOTAL - REMAIN)) ]; then
      echo "[$(date +%H:%M:%S)] ${TAG}_${eng}_p${p} at ${d}/${TOTAL} -- releasing next"
      return
    fi
    sleep 60
  done
}

for p in 1 2 3 4 5; do
  for eng in single multiagent; do
    if launch "$eng" "$p"; then
      wait_almost "$eng" "$p" || { echo "[$(date +%H:%M:%S)] ABORTING campaign"; exit 1; }
    fi
  done
done
while pgrep -f "run_bench.py --engine .* --lcb ${TOTAL}" >/dev/null; do sleep 60; done
echo "[$(date +%H:%M:%S)] ${TAG} 5 PASSES DONE"
