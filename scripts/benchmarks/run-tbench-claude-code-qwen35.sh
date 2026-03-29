#!/bin/bash
#
# Harbor Terminal-Bench 2.0: UAP + Claude Code via Anthropic Proxy -> Qwen3.5
#
# Architecture:
#   Claude Code --(Anthropic :4000)--> Anthropic Proxy --(OpenAI :8080)--> llama.cpp (Qwen3.5)
#
# This script:
#   1. Verifies prerequisites (harbor, docker, model server, proxy)
#   2. Optionally starts the Anthropic proxy if not running
#   3. Runs the Harbor tbench benchmark with the UAPAgent (Claude Code)
#   4. Compares results against baseline (if available)
#
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
RESULTS_DIR="$PROJECT_ROOT/benchmark-results/claude_code_qwen35_$TIMESTAMP"

LLAMA_CPP_BASE="${LLAMA_CPP_BASE:-http://192.168.1.165:8080/v1}"
PROXY_PORT="${PROXY_PORT:-4000}"
PROXY_HOST="${PROXY_HOST:-0.0.0.0}"
PROXY_URL="http://localhost:${PROXY_PORT}"
MODEL_NAME="claude-sonnet-4-20250514"
TIMEOUT_MULT="${TIMEOUT_MULT:-6.0}"
START_PROXY=false
RUN_BASELINE=false
TASK_SET="quick-12"

QUICK_12_TASKS=(
    "crack-7z-hash"
    "filter-js-from-html"
    "password-recovery"
    "sqlite-db-truncate"
    "extract-elf"
    "cobol-modernization"
    "gpt2-codegolf"
    "code-from-image"
    "log-summary-date-ranges"
    "financial-document-processor"
    "chess-best-move"
    "docker-compose-setup"
)

QUICK_5_TASKS=(
    "password-recovery"
    "extract-elf"
    "log-summary-date-ranges"
    "chess-best-move"
    "filter-js-from-html"
)

RED='[0;31m'
GREEN='[0;32m'
YELLOW='[1;33m'
CYAN='[0;36m'
BOLD='[1m'
NC='[0m'

while [[ $# -gt 0 ]]; do
    case $1 in
        --start-proxy) START_PROXY=true; shift ;;
        --baseline) RUN_BASELINE=true; shift ;;
        --quick) TASK_SET="quick-5"; shift ;;
        --full-suite) TASK_SET="full"; shift ;;
        --timeout) TIMEOUT_MULT="$2"; shift 2 ;;
        --help)
            echo "Usage: $0 [options]"
            echo "  --start-proxy    Start the Anthropic proxy before benchmarking"
            echo "  --baseline       Also run a no-UAP baseline for A/B comparison"
            echo "  --quick          Run only 5 tasks (smoke test)"
            echo "  --full-suite     Run all terminal-bench@2.0 tasks"
            echo "  --timeout MULT   Timeout multiplier (default: 6.0)"
            echo "  LLAMA_CPP_BASE defaults to http://192.168.1.165:8080/v1"
            echo "  PROXY_PORT defaults to 4000"
            exit 0
            ;;
        *) echo -e "${RED}Unknown option: $1${NC}"; exit 1 ;;
    esac
done

echo -e "${CYAN}${BOLD}"
echo "=================================================================="
echo "  Terminal-Bench 2.0: UAP + Claude Code via Anthropic Proxy"
echo "  Upstream llama.cpp: $LLAMA_CPP_BASE"
echo "  Proxy: $PROXY_URL"
echo "  Timestamp: $TIMESTAMP"
echo "=================================================================="
echo -e "${NC}"

command -v harbor >/dev/null || { echo -e "${RED}[FAIL] Harbor CLI not found${NC}" >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo -e "${RED}[FAIL] Docker daemon not running${NC}" >&2; exit 1; }

if ! command -v claude >/dev/null; then
    echo -e "${YELLOW}[WARN]${NC} Claude Code CLI not found -- Harbor UAPAgent will install it in container"
fi

echo -n "Checking Qwen3.5 model server at $LLAMA_CPP_BASE... "
curl -sf --max-time 5 "${LLAMA_CPP_BASE}/models" >/dev/null && echo -e "${GREEN}OK${NC}" || { echo -e "${RED}UNREACHABLE${NC}" >&2; exit 1; }

echo -n "Checking Anthropic proxy at $PROXY_URL... "
if curl -sf --max-time 3 "${PROXY_URL}/health" >/dev/null; then
    echo -e "${GREEN}OK${NC}"
elif [ "$START_PROXY" = true ]; then
    echo -e "${YELLOW}STARTING${NC}"
    mkdir -p "$PROJECT_ROOT/benchmark-results"
    LLAMA_CPP_BASE="$LLAMA_CPP_BASE" \
    PROXY_PORT="$PROXY_PORT" \
    PROXY_HOST="$PROXY_HOST" \
    PROXY_LOG_LEVEL="INFO" \
    nohup python3 "$PROJECT_ROOT/tools/agents/scripts/anthropic_proxy.py" > "$PROJECT_ROOT/benchmark-results/proxy_${TIMESTAMP}.log" 2>&1 &
    for i in $(seq 1 20); do
        if curl -sf --max-time 2 "${PROXY_URL}/health" >/dev/null; then
            echo -e "${GREEN}Proxy ready${NC}"
            break
        fi
        sleep 1
    done
    curl -sf --max-time 3 "${PROXY_URL}/health" >/dev/null || { echo -e "${RED}[FAIL] Proxy failed to start${NC}" >&2; exit 1; }
else
    echo -e "${RED}NOT RUNNING${NC}" >&2
    exit 1
fi

case "$TASK_SET" in
    quick-5) TASKS=("${QUICK_5_TASKS[@]}") ;;
    quick-12) TASKS=("${QUICK_12_TASKS[@]}") ;;
    full) TASKS=() ;;
esac

TASK_ARGS=""
for task in "${TASKS[@]}"; do
    TASK_ARGS="$TASK_ARGS -t $task"
done

export ANTHROPIC_BASE_URL="$PROXY_URL"
export ANTHROPIC_API_KEY="sk-uap-proxy"
export ANTHROPIC_MODEL="$MODEL_NAME"
export ANTHROPIC_DEFAULT_SONNET_MODEL="$MODEL_NAME"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="$MODEL_NAME"
export ANTHROPIC_DEFAULT_OPUS_MODEL="$MODEL_NAME"
export CLAUDE_CODE_SUBAGENT_MODEL="$MODEL_NAME"
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC="1"
export USE_UAP="true"
export UAP_MEMORY_ENABLED="true"
export UAP_PATTERNS_RAG_ENABLED="true"
export PROJECT_ROOT="$PROJECT_ROOT"
export UAP_LOCAL_PROJECT="$PROJECT_ROOT"
export UAP_LOCAL_PATH="/uap-local"
export PYTHONPATH="${PROJECT_ROOT}:${PYTHONPATH:-}"

mkdir -p "$RESULTS_DIR"
JOB_NAME="uap_claude_code_qwen35_${TIMESTAMP}"

harbor run \
    --orchestrator local \
    -d terminal-bench@2.0 \
    --agent-import-path tools.uap_harbor.uap_agent:UAPAgent \
    -m "$MODEL_NAME" \
    $TASK_ARGS \
    -n 1 \
    --max-retries 2 \
    --timeout-multiplier "$TIMEOUT_MULT" \
    --jobs-dir "$RESULTS_DIR" \
    --job-name "$JOB_NAME" \
    --ak "api_endpoint=http://host.docker.internal:${PROXY_PORT}/v1" \
    --debug 2>&1 | tee "$RESULTS_DIR/${JOB_NAME}.log"
