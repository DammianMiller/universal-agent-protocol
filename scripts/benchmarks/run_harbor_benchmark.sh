#!/bin/bash
set -e

# Terminal-Bench 2.0 Benchmark via Harbor Containers
# Runs REAL container-based tests with UAP agent

API_ENDPOINT="${API_ENDPOINT:-http://192.168.1.165:8080/v1}"
MODEL_NAME="qwen3.5-a3b-iq4xs"

RED='\033[0;31m' GREEN='\033[0;32m' YELLOW='\033[1;33m' CYAN='\033[0;36m' NC='\033[0m'

echo -e "${CYAN}╔══════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║    Terminal-Bench 2.0 Harbor Benchmark   ║${NC}"  
echo -e "${CYAN}║    Real Container-Based Testing          ║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════════╝${NC}\n"

# Check prerequisites
if ! command -v harbor &> /dev/null; then 
    echo -e "${RED}[ERROR] Harbor CLI not found!${NC}" >&2
    exit 1
fi

if ! docker info > /dev/null 2>&1; then
    echo -e "${RED}[ERROR] Docker daemon not running!${NC}" >&2  
    exit 1
fi

echo -e "${GREEN}✓ Harbor CLI available${NC}"
echo -e "${GREEN}✓ Docker available${NC}\n"

export API_ENDPOINT MODEL_NAME

RESULTS_DIR="results/harbor-tbench/$(date +%Y%m%d_%H%M%S)"
mkdir -p "$RESULTS_DIR"

echo -e "${YELLOW}[Configuration]${NC}"
echo "  Model:          $MODEL_NAME"  
echo "  API Endpoint:   $API_ENDPOINT"
echo "  Results Dir:    $RESULTS_DIR\n"

# Run benchmark with Harbor using local orchestrator (CPU-only)
echo -e "${GREEN}[INFO] Starting REAL container-based benchmark...${NC}"
echo "This executes tasks in isolated Docker containers via Harbor" >&2
echo "" >&2

harbor run \
    --orchestrator local \
    -d terminal-bench@2.0 \
    --agent-import-path tools.agents.uap_agent:UAPAgent \
    --model qwen3.5-a3b-iq4xs \
    --n-concurrent 1 \
    --max-retries 2 \
    --timeout-multiplier 3.0 \
    --jobs-dir "$RESULTS_DIR" \
    --debug 2>&1 | tee "$RESULTS_DIR/benchmark.log"

# Show results summary
echo "" >&2  
echo -e "${GREEN}═══════════════════════════════════════════${NC}" >&2  
echo -e "${CYAN}Benchmark Results${NC}" >&2
echo "═══════════════════════════════════════════" >&2

if [[ -d "$RESULTS_DIR/jobs" ]]; then 
    for trial_dir in "$RESULTS_DIR"/jobs/*; do 
        [[ -d "$trial_dir" ]] || continue
        
        status_file="$trial_dir/status.json"
        if [[ -f "$status_file" ]]; then 
            status=$(jq -r '.status' "$status_file" 2>/dev/null) || status="unknown"
            
            case "$status" in
                success|passed) echo "✓ $(basename $trial_dir): PASSED" >&2 ;;  
                failure|failed) echo "✗ $(basename $trial_dir): FAILED" >&2 ;;
                *)              echo "? $(basename $trial_dir): $status" >&2 ;; 
            esac
        fi
    done
fi

echo "" >&2  
echo -e "${GREEN}Benchmark complete! Results: $RESULTS_DIR/${NC}" >&2
