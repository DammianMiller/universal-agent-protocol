#!/usr/bin/env bash
# DeepSeek V4.1 Flash ("ds_v41_f") manager arm, run as an overlapping campaign.


set -u
SELF="$(readlink -f "${BASH_SOURCE[0]}")"
cd "$(dirname "$SELF")/../.." || exit 1                 # codebase/v2-current
ROOT="$(cd ../.. && pwd)"                               # repo root
PYTHON=(uv run --no-project --python 3.12 --with 'datasets<4' --with numpy --with anthropic python)

set -a; [ -f escalation/.env ] && . escalation/.env; set +a

export LCB_RELEASE=release_v6
export HF_HOME="${HF_HOME:-$HOME/.cache/huggingface}"
export MULTIAGENT_MAX_ITERS=${MULTIAGENT_MAX_ITERS:-10}
export MULTIAGENT_MAX_TASKS=${MULTIAGENT_MAX_TASKS:-12}

TAG=ds_v41_f
ENG=multiagent
CAP=${CAP:-128000}
PAR=${PAR:-100}
PASSES=${PASSES:-"3 4 5"}
REMAIN=${REMAIN:-8}
TOTAL=100
DS_MODEL=${DS_MODEL:-deepseek-flash}
BASE_URL="https://api.deepseek.com"
IDS=escalation/lcb100_hardest_v6.json
RUN="$ROOT/runs/ds-v41-f-5pass"
OUT="$RUN/results"; WS="$RUN/ws"; CKPT="$RUN/ckpt"; LOGS="$RUN/logs"

if [ -z "${DEEPSEEK_API:-}" ]; then
  echo "FATAL: DEEPSEEK_API is not set (put the DeepSeek API key in escalation/.env)."
  exit 1
fi
mkdir -p "$OUT" "$WS" "$CKPT" "$LOGS"
if ! grep -q BENCH_CHECKPOINT escalation/run_bench.py; then
  echo "FATAL: escalation/run_bench.py lacks the BENCH_CHECKPOINT hook; progress cannot be counted."
  exit 1
fi

# --- single instance + detach -------------------------------------------------------------
if [ -z "${RUN_DETACHED:-}" ]; then
  exec 9>"$RUN/.campaign.lock"
  if ! flock -n 9; then
    echo "another campaign is already running (pid $(cat "$RUN/campaign.pid" 2>/dev/null)); exiting"
    exit 1
  fi
  if [ "${FG:-0}" != 1 ]; then
    RUN_DETACHED=1 setsid nohup "$SELF" "$@" >> "$LOGS/campaign.log" 2>&1 < /dev/null &
    echo "detached pid=$!   log: $LOGS/campaign.log   (FG=1 for foreground)"
    exit 0
  fi
fi
echo $$ > "$RUN/campaign.pid"

launch() {
  local p=$1 name="${TAG}_${ENG}_p${p}" out="$OUT/${TAG}_${ENG}_p${p}.json"
  if [ -f "$out" ]; then echo "[$(date +%H:%M:%S)] [skip done] $name"; return 1; fi
  echo "[$(date +%H:%M:%S)] start $name (cap=$CAP parallel=$PAR)"
  setsid env \
      ESCALATION_OPENAI_BASE="$BASE_URL/chat/completions" \
      GROQ_API_KEY="$DEEPSEEK_API" \
      ESCALATION_GROQ_REASONING="" \
      ESCALATION_CLOUD_MAX_TOKENS="$CAP" \
      ESCALATION_CLOUD_TIMEOUT=7200 \
      MULTIAGENT_STRICT_FORMAT=1 \
      MULTIAGENT_MODEL="groq:$DS_MODEL" \
      MULTIAGENT_WS="$WS/${name}" \
      BENCH_CHECKPOINT="$CKPT/${name}.jsonl" \
    "${PYTHON[@]}" escalation/run_bench.py \
      --engine "$ENG" --only lcb --lcb "$TOTAL" --ids-file "$IDS" --parallel "$PAR" --out "$out" \
      >> "$LOGS/${name}.log" 2>&1 &
  LAST_PID=$!
  return 0
}

wait_almost() {
  local p=$1 name="${TAG}_${ENG}_p${p}" out="$OUT/${TAG}_${ENG}_p${p}.json"
  while true; do
    [ -f "$out" ] && { echo "[$(date +%H:%M:%S)] $name finished"; return 0; }
    if ! kill -0 "$LAST_PID" 2>/dev/null; then
      echo "[$(date +%H:%M:%S)] !! $name EXITED without writing $out"
      echo "   last log lines:"; tail -5 "$LOGS/${name}.log" 2>/dev/null | sed 's/^/   /'
      return 1
    fi
    local d=0
    [ -f "$CKPT/${name}.jsonl" ] && d=$(wc -l < "$CKPT/${name}.jsonl" 2>/dev/null) && d=${d// /}
    if [ "${d:-0}" -ge $((TOTAL - REMAIN)) ]; then
      echo "[$(date +%H:%M:%S)] $name at ${d}/${TOTAL} -- releasing next"
      return 0
    fi
    sleep 60
  done
}

echo "[$(date +%H:%M:%S)] campaign start pid=$$ engine=$ENG passes=[$PASSES] remain=$REMAIN par=$PAR"
for p in $PASSES; do
  if launch "$p"; then
    wait_almost "$p" || { echo "[$(date +%H:%M:%S)] ABORTING campaign"; rm -f "$RUN/campaign.pid"; exit 1; }
  fi
done

while pgrep -f "run_bench.py --engine $ENG --only lcb --lcb $TOTAL" >/dev/null; do sleep 60; done

echo
echo "==== SUMMARY ===="
for p in $PASSES; do
  name="${TAG}_${ENG}_p${p}"
  line=$(grep -h "pass@1 =" "$LOGS/${name}.log" 2>/dev/null | tail -1)
  printf '%-26s %s\n' "$name" "${line:--}"
done
rm -f "$RUN/campaign.pid"
echo "[$(date +%H:%M:%S)] DS V4.1 FLASH MANAGER CAMPAIGN DONE (passes $PASSES)"
