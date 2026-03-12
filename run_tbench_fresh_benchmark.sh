#!/bin/bash
set -e

# Fresh Terminal-Bench 2.0 Benchmark via Harbor + Containers
# Tests UAP 3.0+ with Qwen3.5 on 12 tasks

API_ENDPOINT="${API_ENDPOINT:-http://192.168.1.165:8080/v1}"
MODEL_NAME="qwen3.5-a3b-iq4xs"

RED='\033[0;31m' GREEN='\033[0;32m' YELLOW='\033[1;33m' CYAN='\033[0;36m' NC='\033[0m'

echo -e "${CYAN}╔══════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║    Fresh Terminal-Bench 2.0 Benchmark    ║${NC}"  
echo -e "${CYAN}║    UAP 3.0+ + Qwen3.5 via Harbor         ║${NC}"
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

# Create fresh results directory
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
RESULTS_DIR="results/tbench-harbor-fresh/${TIMESTAMP}"
mkdir -p "$RESULTS_DIR"

echo -e "${YELLOW}[Configuration]${NC}"
echo "  Model:          $MODEL_NAME"  
echo "  API Endpoint:   $API_ENDPOINT"
echo "  Results Dir:    $RESULTS_DIR\n"

# Run fresh benchmark with Harbor using local orchestrator (CPU-only)
echo -e "${GREEN}[INFO] Starting FRESH container-based benchmark...${NC}"
echo "This executes tasks in isolated Docker containers via Harbor" >&2
echo "Tasks will run through UAP agent wrapping Qwen3.5 API calls" >&2
echo "" >&2

# Use Harbor to run the benchmark
harbor run \
    --orchestrator local \
    -d terminal-bench@2.0 \
    --agent-import-path tools.agents.uam_agent:UAMAgent \
    --model qwen3.5-a3b-iq4xs \
    --n-concurrent 1 \
    --max-retries 2 \
    --timeout-multiplier 3.0 \
    --jobs-dir "$RESULTS_DIR" \
    --debug > "$RESULTS_DIR/harbor_run.log" 2>&1 &

HARBOR_PID=$!
echo "Harbor benchmark started (PID: $HARBOR_PID)" >&2

# Monitor progress
echo "" >&2
echo -e "${GREEN}[INFO] Monitoring benchmark progress...${NC}" >&2
sleep 5 && \
tail -20 "$RESULTS_DIR/harbor_run.log" 2>/dev/null | grep -E "^\[|Creating|Starting|trial" | head -10 || echo "Waiting for Harbor to initialize..." >&2

# Wait for completion (with timeout)
TIMEOUT=600
ELAPSED=0
while kill -0 $HARBOR_PID 2>/dev/null && [[ $ELAPSED -lt $TIMEOUT ]]; do
    sleep 30
    ELAPSED=$((ELAPSED + 30))
    
    if [[ $((ELAPSED % 120)) -eq 0 ]]; then
        echo -ne "\r[$(date +%H:%M:%S)] Progress: ${ELAPSED}s elapsed..." >&2
    fi
done

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
    
    # Count results
    TOTAL=$(ls -d "$RESULTS_DIR"/jobs/* 2>/dev/null | wc -l)
    PASSED=$(grep -r '"status": "success"' "$RESULTS_DIR"/jobs/*/status.json 2>/dev/null | wc -l)
    
    echo "" >&2  
    echo -e "${GREEN}Summary: ${PASSED}/${TOTAL} tasks completed${NC}" >&2
else
    echo -e "${RED}[ERROR] No results found!${NC}" >&2
    tail -50 "$RESULTS_DIR/harbor_run.log" 2>/dev/null | head -30 >&2
fi

echo "" >&2  
echo -e "${GREEN}Fresh benchmark complete! Results: $RESULTS_DIR/${NC}" >&2

# Show log summary
echo "" >&2
echo -e "${YELLOW}[Log Summary]${NC}" >&2
grep -E "PASS|FAIL|Error" "$RESULTS_DIR/harbor_run.log" 2>/dev/null | tail -10 >&2 || echo "No verification results in log" >&2
