#!/usr/bin/env bash
# Qwen3.8 Flash Next ("fn"), served on the LAN via litellm (192.168.2.200:8216, alias
# `large-model`): v2 single and manager (multiagent) engines, 5 passes each, reasoning on.
#
# Resumable. Re-run the same command after a stop, a dropped SSH session or a dead model
# server and it continues where it left off:
#   * pass level : a pass whose result file is complete (100 ids, no infra) is skipped;
#   * problem    : run_bench.py appends every solved problem to a checkpoint (jsonl), so a
#                  killed pass only re-solves what is missing or infra-failed;
#   * server     : before (re)launching a pass the proxy is probed; if it is down the driver
#                  waits and retries instead of failing. Passes that finish with infra records
#                  (proxy died mid-pass) are re-run automatically up to $INFRA_RETRIES times.
#
# The driver detaches itself (setsid/nohup) so a dropped terminal does not kill it.
#   FG=1 ./run_q38_fn_5pass.sh          run in the foreground instead
#   kill "$(cat runs/q38-fn-5pass/driver.pid)"   stop it (safe: re-run later to resume)
#   tail -f runs/q38-fn-5pass/logs/driver.log    watch progress
#
# Knobs (env): LITELLM_KEY (required; from escalation/.env), LITELLM_HOST, MODEL_ALIAS,
#              CAP, PAR, ENGINES, PASSES, INFRA_RETRIES

set -u
SELF="$(readlink -f "${BASH_SOURCE[0]}")"
cd "$(dirname "$SELF")/../.." || exit 1                 # codebase/v2-current
ROOT="$(cd ../.. && pwd)"                               # repo root
PYTHON=(uv run --no-project --python 3.12 --with 'datasets<4' --with numpy --with anthropic python)

export LCB_RELEASE=release_v6
export HF_HOME="${HF_HOME:-$HOME/.cache/huggingface}"
export MULTIAGENT_MAX_ITERS=${MULTIAGENT_MAX_ITERS:-10}
export MULTIAGENT_MAX_TASKS=${MULTIAGENT_MAX_TASKS:-12}

TAG=q38_fn
CAP=${CAP:-128000}
PAR=${PAR:-48}
ENGINES=${ENGINES:-"single multiagent"}
PASSES=${PASSES:-"1 2 3 4 5"}
INFRA_RETRIES=${INFRA_RETRIES:-3}
LITELLM_HOST=${LITELLM_HOST:-192.168.2.200:8216}
MODEL_ALIAS=${MODEL_ALIAS:-large-model}
BASE_URL="http://$LITELLM_HOST"
IDS=escalation/lcb100_hardest_v6.json
RUN="$ROOT/runs/q38-fn-5pass"
OUT="$RUN/results"; WS="$RUN/ws"; CKPT="$RUN/ckpt"; LOGS="$RUN/logs"
mkdir -p "$OUT" "$WS" "$CKPT" "$LOGS"

set -a; [ -f escalation/.env ] && . escalation/.env; set +a
LITELLM_CONFIG="${LITELLM_CONFIG:-/home/persis/litellm/config.yaml}"
LITELLM_KEY="${LITELLM_KEY:-$(grep -m1 'master_key:' "$LITELLM_CONFIG" 2>/dev/null | awk '{print $2}' | tr -d '"'"'")}"
if [ -z "${LITELLM_KEY:-}" ]; then
  echo "FATAL: LITELLM_KEY is not set (put it in escalation/.env or the environment)."
  echo "       The proxy at $LITELLM_HOST rejects every other bearer with 'No connected db'."
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

# --- proxy probes -------------------------------------------------------------------------
server_up() {   # cheap liveness check; does not queue behind generation
  curl -sf -m 20 "$BASE_URL/v1/models" -H "Authorization: Bearer $LITELLM_KEY" 2>/dev/null \
    | grep -q "\"$MODEL_ALIAS\""
}
wait_server() {
  local n=0
  until server_up; do
    n=$((n + 1)); [ $((n % 10)) -eq 1 ] && echo "[$(date +%H:%M:%S)] proxy $LITELLM_HOST / $MODEL_ALIAS not reachable, waiting (check $n)"
    sleep 60
  done
}
echo "[$(date +%H:%M:%S)] driver start  pid=$$  host=$LITELLM_HOST model=$MODEL_ALIAS engines=[$ENGINES] passes=[$PASSES]"
wait_server
if ! curl -sf -m 300 "$BASE_URL/v1/chat/completions" \
     -H "Authorization: Bearer $LITELLM_KEY" -H 'Content-Type: application/json' \
     -d "{\"model\":\"$MODEL_ALIAS\",\"messages\":[{\"role\":\"user\",\"content\":\"Reply with just: ok\"}],\"max_tokens\":64}" \
     > "$LOGS/probe.json"; then
  echo "FATAL: chat probe on $MODEL_ALIAS failed (see $LOGS/probe.json)"; rm -f "$RUN/driver.pid"; exit 1
fi
echo "  probe OK: $(python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print("model=%s tokens=%s" % (d.get("model"), (d.get("usage") or {}).get("completion_tokens")))' "$LOGS/probe.json")"

{ echo "sha=$(git rev-parse HEAD)"
  git status --porcelain -- escalation/ | sed 's/^/dirty: /'
  echo "model=groq:$MODEL_ALIAS (Qwen3.8 Flash Next via litellm $LITELLM_HOST) cap=$CAP parallel=$PAR release=$LCB_RELEASE ids=$IDS"
  echo "engines=[$ENGINES] passes=[$PASSES] reasoning=on max_iters=$MULTIAGENT_MAX_ITERS max_tasks=$MULTIAGENT_MAX_TASKS strict_format=1 checkpoint=per-problem"
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
      ESCALATION_OPENAI_BASE="$BASE_URL/v1/chat/completions" \
      GROQ_API_KEY="$LITELLM_KEY" \
      ESCALATION_GROQ_REASONING="" \
      ESCALATION_CLOUD_MAX_TOKENS="$CAP" \
      ESCALATION_CLOUD_TIMEOUT=7200 \
      MULTIAGENT_STRICT_FORMAT=1 \
      MULTIAGENT_MODEL="groq:$MODEL_ALIAS" \
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
    printf '%-24s %-10s ' "$name" "$(inspect "$OUT/${name}.json")"
    grep -h "pass@1 =" "$LOGS/${name}.log" 2>/dev/null | tail -1 || echo
  done
done
rm -f "$RUN/driver.pid"
echo "[$(date +%H:%M:%S)] Q38 FLASH-NEXT 5x SINGLE + 5x MANAGER DONE"
