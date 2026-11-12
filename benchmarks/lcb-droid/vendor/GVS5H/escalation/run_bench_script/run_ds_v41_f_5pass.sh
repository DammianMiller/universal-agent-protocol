#!/usr/bin/env bash

set -u
SELF="$(readlink -f "${BASH_SOURCE[0]}")"
cd "$(dirname "$SELF")/../.." || exit 1                 # codebase/v2-current
ROOT="$(cd ../.. && pwd)"                               # repo root
PYTHON=(uv run --no-project --python 3.12 --with 'datasets<4' --with numpy --with anthropic python)

set -a; [ -f escalation/.env ] && . escalation/.env; set +a   # sourced first: .env overrides the shell env

export LCB_RELEASE=release_v6
export HF_HOME="${HF_HOME:-$HOME/.cache/huggingface}"
export MULTIAGENT_MAX_ITERS=${MULTIAGENT_MAX_ITERS:-10}
export MULTIAGENT_MAX_TASKS=${MULTIAGENT_MAX_TASKS:-12}

TAG=ds_v41_f
CAP=${CAP:-128000}                 # deepseek-flash accepts max_tokens up to 384K
PAR=${PAR:-32}
ENGINES=${ENGINES:-"single multiagent"}
PASSES=${PASSES:-"1 2 3 4 5"}
INFRA_RETRIES=${INFRA_RETRIES:-3}
PROBE_TIMEOUT=${PROBE_TIMEOUT:-120}    # per chat-probe attempt; the probe retries, it is not fatal
DS_MODEL=${DS_MODEL:-deepseek-flash}   # served by DeepSeek-V4.1-Flash
BASE_URL="https://api.deepseek.com"
IDS=escalation/lcb100_hardest_v6.json
RUN="$ROOT/runs/ds-v41-f-5pass"
OUT="$RUN/results"; WS="$RUN/ws"; CKPT="$RUN/ckpt"; LOGS="$RUN/logs"

if [ -z "${DEEPSEEK_API:-}" ]; then
  echo "FATAL: DEEPSEEK_API is not set (put the DeepSeek API key in escalation/.env or the environment)."
  exit 1
fi
mkdir -p "$OUT" "$WS" "$CKPT" "$LOGS"
if ! grep -q BENCH_CHECKPOINT escalation/run_bench.py; then
  echo "FATAL: escalation/run_bench.py lacks the BENCH_CHECKPOINT hook; per-problem resume would not work."
  exit 1
fi

# --- single instance + detach -------------------------------------------------------------
if [ -z "${RUN_DETACHED:-}" ]; then
  exec 9>"$RUN/.lock"
  if ! flock -n 9; then
    echo "another driver is already running (pid $(cat "$RUN/driver.pid" 2>/dev/null)); exiting"
    exit 1
  fi
  if [ "${FG:-0}" != 1 ]; then
    RUN_DETACHED=1 setsid nohup "$SELF" "$@" >> "$LOGS/driver.log" 2>&1 < /dev/null &
    echo "detached pid=$!   log: $LOGS/driver.log   (FG=1 for foreground)"
    exit 0
  fi
fi
echo $$ > "$RUN/driver.pid"
CHILD=""
trap 'echo "[$(date +%H:%M:%S)] stop requested; killing current pass"; [ -n "$CHILD" ] && kill -TERM -- "-$CHILD" 2>/dev/null; wait; rm -f "$RUN/driver.pid"; exit 130' INT TERM

# --- API probes ---------------------------------------------------------------------------
server_up() {   # cheap liveness check; does not queue behind generation
  curl -sf -m 20 "$BASE_URL/models" -H "Authorization: Bearer $DEEPSEEK_API" 2>/dev/null \
    | grep -q "\"$DS_MODEL\""
}
wait_server() {
  local n=0
  until server_up; do
    n=$((n + 1)); [ $((n % 10)) -eq 1 ] && echo "[$(date +%H:%M:%S)] api.deepseek.com / $DS_MODEL not reachable, waiting (check $n)"
    sleep 60
  done
}
chat_up() {   # true once the model actually emits a token. Streamed: /models can answer in 0.5s
              # while generation is stalled, and a blocking probe cannot tell those apart.
  curl -sN -m "$PROBE_TIMEOUT" "$BASE_URL/chat/completions" \
    -H "Authorization: Bearer $DEEPSEEK_API" -H 'Content-Type: application/json' \
    -d "{\"model\":\"$DS_MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"Reply with just: ok\"}],\"max_tokens\":64,\"stream\":true}" \
    > "$LOGS/probe.sse" 2>/dev/null
  grep -q '"content":"[^"]\|"reasoning_content":"[^"]' "$LOGS/probe.sse"
}
wait_chat() {   # not fatal: park here until the API generates, so the driver self-starts on recovery
  local n=0
  until chat_up; do
    n=$((n + 1))
    echo "[$(date +%H:%M:%S)] $DS_MODEL reachable but produced no token in ${PROBE_TIMEOUT}s (probe $n); waiting"
    sleep 60
  done
}
echo "[$(date +%H:%M:%S)] driver start  pid=$$  api=$BASE_URL model=$DS_MODEL engines=[$ENGINES] passes=[$PASSES]"
wait_server
wait_chat
echo "  probe OK: $(python3 - "$LOGS/probe.sse" <<'PY'
import json, sys
model, content, reasoning = "", 0, 0
for line in open(sys.argv[1]):
    if not line.startswith("data: ") or line.strip() == "data: [DONE]":
        continue
    try:
        d = json.loads(line[6:])
    except json.JSONDecodeError:
        continue
    model = d.get("model") or model
    delta = ((d.get("choices") or [{}])[0].get("delta")) or {}
    content += len(delta.get("content") or "")
    reasoning += len(delta.get("reasoning_content") or "")
print("model=%s content_chars=%d reasoning=%s" % (model, content, "yes" if reasoning else "NO"))
PY
)"

{ echo "sha=$(git rev-parse HEAD)"
  git status --porcelain -- escalation/ | sed 's/^/dirty: /'
  echo "model=groq:$DS_MODEL (DeepSeek V4.1 Flash, first-party $BASE_URL) cap=$CAP parallel=$PAR release=$LCB_RELEASE ids=$IDS"
  echo "engines=[$ENGINES] passes=[$PASSES] reasoning=on(api default, effort=high) max_iters=$MULTIAGENT_MAX_ITERS max_tasks=$MULTIAGENT_MAX_TASKS strict_format=1 checkpoint=per-problem"
} > "$OUT/run_config.txt"

# --- result inspection --------------------------------------------------------------------
# prints "ok" | "infra N" | "partial" | "missing"; exit 0 only for "ok"
inspect() {
  IDS="$IDS" python3 - "$1" <<'PY'
import json, os, sys
want = json.load(open(os.environ["IDS"]))
try:
    d = json.load(open(sys.argv[1]))["lcb"]
except Exception:
    print("missing" if not os.path.exists(sys.argv[1]) else "partial"); sys.exit(1)
got = [r["question_id"] for r in d["records"]]
if got != want:
    print("partial"); sys.exit(1)
n = d.get("n_infra") or sum(1 for r in d["records"] if r.get("status") == "infra")
if n:
    print(f"infra {n}"); sys.exit(1)
print("ok")
PY
}

launch() {   # one attempt of one pass; blocks; returns run_bench.py's exit code
  local name=$1 eng=$2 out="$OUT/${name}.json"
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
      --engine "$eng" --only lcb --lcb 100 --ids-file "$IDS" --parallel "$PAR" --out "$out" \
      >> "$LOGS/${name}.log" 2>&1 &
  CHILD=$!
  wait "$CHILD"; local rc=$?
  CHILD=""
  return $rc
}

run_pass() {
  local eng=$1 p=$2 name="${TAG}_${1}_p${2}" state tries=0
  local out="$OUT/${name}.json"
  state=$(inspect "$out") && { echo "[skip done] $name"; return; }
  [ -f "$out.infra-accepted" ] && { echo "[skip done] $name ($state, accepted earlier)"; return; }
  while :; do
    local ckpt_n=0
    [ -f "$CKPT/${name}.jsonl" ] && ckpt_n=$(wc -l < "$CKPT/${name}.jsonl")
    echo "[$(date +%H:%M:%S)] start $name  (state=$state, checkpoint=$ckpt_n problems, attempt $((tries + 1)))"
    wait_server
    launch "$name" "$eng"; local rc=$?
    state=$(inspect "$out")
    echo "[$(date +%H:%M:%S)] end   $name  rc=$rc state=$state"
    [ "$state" = ok ] && break
    tries=$((tries + 1))
    if [ "$tries" -ge "$INFRA_RETRIES" ]; then
      case "$state" in
        infra*) echo "  !! $name still has infra records after $tries attempts; accepting (infra-excluded in grading)"
                touch "$out.infra-accepted"; break ;;
        *)      echo "  !! $name did not complete after $tries attempts; giving up on this pass for now"; break ;;
      esac
    fi
    echo "  -> retrying $name in 60s (only missing/infra problems are re-solved)"; sleep 60
  done
  grep -E "pass@1|status breakdown" "$LOGS/${name}.log" | tail -2 | sed 's/^/  /'
}

for eng in $ENGINES; do
  for p in $PASSES; do
    run_pass "$eng" "$p"
  done
done

echo; echo "==== SUMMARY ===="
for eng in $ENGINES; do
  for p in $PASSES; do
    name="${TAG}_${eng}_p${p}"
    line=$(grep -h "pass@1 =" "$LOGS/${name}.log" 2>/dev/null | tail -1)
    printf '%-24s %-10s %s\n' "$name" "$(inspect "$OUT/${name}.json")" "${line:--}"
  done
done
rm -f "$RUN/driver.pid"
echo "[$(date +%H:%M:%S)] DEEPSEEK V4.1 FLASH 5x SINGLE + 5x MANAGER DONE"
