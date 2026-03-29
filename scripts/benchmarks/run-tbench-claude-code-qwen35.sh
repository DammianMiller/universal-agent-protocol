#!/bin/bash
#
# Harbor Terminal-Bench 2.0: latest UAP + OpenCode -> Qwen3.5
#
# Architecture:
#   OpenCode --(OpenAI-compatible :4000)--> Qwen3.5 35B A3B IQ4_XS
#
# This script:
#   1. Verifies prerequisites (harbor, docker, model server, proxy)
#   2. Runs the Harbor tbench benchmark with the OpenCodeUAP agent
#   4. Compares results against baseline (if available)
#
# Usage:
#   ./scripts/benchmarks/run-tbench-claude-code-qwen35.sh [options]
#
# Options:
#   --baseline          Also run a baseline (no UAP) for comparison
#   --quick             Run only 5 quick tasks instead of the full 12
#   --full-suite        Run all terminal-bench@2.0 tasks
#   --timeout MULT      Timeout multiplier (default: 6.0)
#   --help              Show this help
#
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
RESULTS_DIR="$PROJECT_ROOT/benchmark-results/claude_code_qwen35_$TIMESTAMP"

# ==============================================================================
# Configuration
# ==============================================================================
LLAMA_CPP_BASE="${LLAMA_CPP_BASE:-http://192.168.1.165:8080/v1}"
PROXY_PORT="${PROXY_PORT:-4000}"
PROXY_HOST="${PROXY_HOST:-0.0.0.0}"
PROXY_URL="http://localhost:${PROXY_PORT}"
MODEL_NAME="claude-sonnet-4-20250514"  # Spoofed model ID for proxy compatibility
TIMEOUT_MULT="${TIMEOUT_MULT:-6.0}"
START_PROXY=false
RUN_BASELINE=false
TASK_SET="quick-12"  # quick-5, quick-12, or full

# Quick-12 tasks (default): representative sample across all categories
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

# Quick-5 tasks: fast smoke test
QUICK_5_TASKS=(
    "password-recovery"
    "extract-elf"
    "log-summary-date-ranges"
    "chess-best-move"
    "filter-js-from-html"
)

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

# ==============================================================================
# Argument parsing
# ==============================================================================
while [[ $# -gt 0 ]]; do
    case $1 in
        --baseline)
            RUN_BASELINE=true; shift ;;
        --quick)
            TASK_SET="quick-5"; shift ;;
        --full-suite)
            TASK_SET="full"; shift ;;
        --timeout)
            TIMEOUT_MULT="$2"; shift 2 ;;
        --help)
            echo "Usage: $0 [options]"
            echo ""
            echo "Run Terminal-Bench 2.0 with UAP + Claude Code via Anthropic Proxy -> Qwen3.5"
            echo ""
            echo "Options:"
            echo "  --baseline       Also run a no-UAP baseline for A/B comparison"
            echo "  --quick          Run only 5 tasks (smoke test)"
            echo "  --full-suite     Run all terminal-bench@2.0 tasks"
            echo "  --timeout MULT   Timeout multiplier (default: 6.0)"
            echo "  --help           Show this help"
            echo ""
            echo "Environment Variables:"
            echo "  LLAMA_CPP_BASE   Qwen3.5 endpoint (default: http://192.168.1.165:4000/v1)"
            echo "  TIMEOUT_MULT     Timeout multiplier (default: 6.0)"
            echo ""
            echo "Architecture:"
            echo "  OpenCode --(OpenAI-compatible API)--> Qwen3.5 @ :4000"
            exit 0
            ;;
        *)
            echo -e "${RED}Unknown option: $1${NC}"; exit 1 ;;
    esac
done

# ==============================================================================
# Prerequisites
# ==============================================================================
echo -e "${CYAN}${BOLD}"
echo "=================================================================="
echo "  Terminal-Bench 2.0: latest UAP + OpenCode"
echo "  Model: Qwen3.5 35B A3B (IQ4_XS) @ $LLAMA_CPP_BASE"
echo "  Proxy: $PROXY_URL"
echo "  Timestamp: $TIMESTAMP"
echo "=================================================================="
echo -e "${NC}"

# Check Harbor CLI
if ! command -v harbor &> /dev/null; then
    echo -e "${RED}[FAIL] Harbor CLI not found in PATH${NC}" >&2
    echo "  Install: pip install harbor-ai" >&2
    exit 1
fi
echo -e "${GREEN}[OK]${NC} Harbor CLI: $(which harbor)"

# Check Docker
if ! docker info > /dev/null 2>&1; then
    echo -e "${RED}[FAIL] Docker daemon not running${NC}" >&2
    exit 1
fi
echo -e "${GREEN}[OK]${NC} Docker available"

# Check Node/NPM for opencode installation inside container templates
if ! command -v node &> /dev/null; then
    echo -e "${YELLOW}[WARN]${NC} node not found on host; Harbor container setup will install runtime as needed"
fi

# Check Qwen3.5 model server
echo -n "Checking Qwen3.5 model server at $LLAMA_CPP_BASE... "
if curl -sf --max-time 5 "${LLAMA_CPP_BASE}/models" > /dev/null 2>&1; then
    echo -e "${GREEN}OK${NC}"
else
    echo -e "${RED}UNREACHABLE${NC}"
    echo -e "${RED}[FAIL] Cannot reach llama-server at ${LLAMA_CPP_BASE}${NC}" >&2
    echo "  Start it with: llama-server --model qwen3.5-a3b-iq4xs.gguf ..." >&2
    exit 1
fi

# ==============================================================================
# Select tasks
# ==============================================================================
case "$TASK_SET" in
    quick-5)
        TASKS=("${QUICK_5_TASKS[@]}")
        echo -e "\n${CYAN}Task set: quick-5 (smoke test)${NC}"
        ;;
    quick-12)
        TASKS=("${QUICK_12_TASKS[@]}")
        echo -e "\n${CYAN}Task set: quick-12 (representative sample)${NC}"
        ;;
    full)
        TASKS=()  # Empty = all tasks in dataset
        echo -e "\n${CYAN}Task set: full (all terminal-bench@2.0 tasks)${NC}"
        ;;
esac

if [ ${#TASKS[@]} -gt 0 ]; then
    echo "  Tasks (${#TASKS[@]}):"
    for t in "${TASKS[@]}"; do
        echo "    - $t"
    done
fi

# ==============================================================================
# Build task arguments
# ==============================================================================
TASK_ARGS=""
for task in "${TASKS[@]}"; do
    TASK_ARGS="$TASK_ARGS -t $task"
done

# ==============================================================================
# Export environment for UAP + OpenCode
# ==============================================================================
export LLAMA_CPP_BASE="$LLAMA_CPP_BASE"
export USE_UAP="true"
export UAP_MEMORY_ENABLED="true"
export UAP_PATTERNS_RAG_ENABLED="true"
export PROJECT_ROOT="$PROJECT_ROOT"
# Ensure benchmarks inject the local UAP project (not the npm package)
export UAP_LOCAL_PROJECT="$PROJECT_ROOT"
export UAP_LOCAL_PATH="/uap-local"
export PYTHONPATH="${PROJECT_ROOT}:${PYTHONPATH:-}"

mkdir -p "$RESULTS_DIR"

# ==============================================================================
# Run UAP + OpenCode benchmark
# ==============================================================================
echo ""
echo -e "${CYAN}${BOLD}Starting UAP + OpenCode benchmark...${NC}"
echo -e "  Agent:    tools.agents.opencode_uap_agent:OpenCodeUAP"
echo -e "  Model:    qwen-proxy/qwen35-a3b-iq4xs"
echo -e "  Timeout:  ${TIMEOUT_MULT}x"
echo -e "  Results:  $RESULTS_DIR/"
echo ""

JOB_NAME="uap_opencode_qwen35_${TIMESTAMP}"

harbor run \
    --orchestrator local \
    -d terminal-bench@2.0 \
    --agent-import-path tools.agents.opencode_uap_agent:OpenCodeUAP \
    -m "qwen-proxy/qwen35-a3b-iq4xs" \
    $TASK_ARGS \
    -n 1 \
    --max-retries 2 \
    --timeout-multiplier "$TIMEOUT_MULT" \
    --jobs-dir "$RESULTS_DIR" \
    --job-name "$JOB_NAME" \
    --ak "api_endpoint=$LLAMA_CPP_BASE" \
    --debug 2>&1 | tee "$RESULTS_DIR/${JOB_NAME}.log"

echo ""
echo -e "${GREEN}UAP + OpenCode benchmark complete${NC}"
echo "  Results: $RESULTS_DIR/$JOB_NAME/"

# ==============================================================================
# Optionally run baseline (no UAP) for A/B comparison
# ==============================================================================
if [ "$RUN_BASELINE" = true ]; then
    echo ""
    echo -e "${CYAN}${BOLD}Starting BASELINE (no UAP) benchmark...${NC}"

    export USE_UAP="false"
    unset UAP_MEMORY_ENABLED
    unset UAP_PATTERNS_RAG_ENABLED

    BASELINE_JOB="baseline_opencode_qwen35_${TIMESTAMP}"

    harbor run \
        --orchestrator local \
        -d terminal-bench@2.0 \
        --agent-import-path tools.agents.opencode_uap_agent:OpenCodeBaseline \
        -m "llama.cpp/qwen35-a3b-iq4xs" \
        $TASK_ARGS \
        -n 1 \
        --max-retries 2 \
        --timeout-multiplier "$TIMEOUT_MULT" \
        --jobs-dir "$RESULTS_DIR" \
        --job-name "$BASELINE_JOB" \
        --debug 2>&1 | tee "$RESULTS_DIR/${BASELINE_JOB}.log"

    echo ""
    echo -e "${GREEN}Baseline benchmark complete${NC}"
    echo "  Results: $RESULTS_DIR/$BASELINE_JOB/"
fi

# ==============================================================================
# Results summary
# ==============================================================================
echo ""
echo -e "${CYAN}${BOLD}=================================================================${NC}"
echo -e "${CYAN}${BOLD}  Benchmark Results Summary${NC}"
echo -e "${CYAN}${BOLD}=================================================================${NC}"
echo ""
echo "  Architecture: OpenCode -> Qwen3.5 @ ${LLAMA_CPP_BASE}"
echo "  Task set: $TASK_SET (${#TASKS[@]} tasks)"
echo "  Timeout: ${TIMEOUT_MULT}x"
echo ""
echo "  UAP results:      $RESULTS_DIR/$JOB_NAME/"

if [ "$RUN_BASELINE" = true ]; then
    echo "  Baseline results: $RESULTS_DIR/$BASELINE_JOB/"
fi

echo ""

# Parse results if available
if [ -d "$RESULTS_DIR/$JOB_NAME" ]; then
    echo "  Trial results:"
    for trial_dir in "$RESULTS_DIR/$JOB_NAME"/*/; do
        [ -d "$trial_dir" ] || continue
        status_file="$trial_dir/status.json"
        if [ -f "$status_file" ]; then
            status=$(jq -r '.status' "$status_file" 2>/dev/null) || status="unknown"
            task_name=$(basename "$trial_dir")
            case "$status" in
                success|passed) echo -e "    ${GREEN}PASS${NC} $task_name" ;;
                failure|failed) echo -e "    ${RED}FAIL${NC} $task_name" ;;
                *)              echo -e "    ${YELLOW}$status${NC} $task_name" ;;
            esac
        fi
    done
fi

echo ""
echo -e "${GREEN}Done.${NC}"
