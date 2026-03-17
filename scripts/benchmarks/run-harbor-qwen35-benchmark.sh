#!/bin/bash
# Harbor Containerized Benchmark for Qwen3.5 - UAP vs Baseline Comparison

set -e

PROJECT_ROOT="/home/cogtek/dev/miller-tech/universal-agent-memory"
HARBOR_CONFIGS="$PROJECT_ROOT/harbor-configs"
RESULTS_DIR="$PROJECT_ROOT/benchmark-results/qwen35_harbor_containers"

echo "=================================================="
echo "Harbor Containerized Benchmark - Qwen3.5 UAP vs Baseline"
echo "=================================================="
echo ""

# Ensure results directory exists
mkdir -p "$RESULTS_DIR"

# Function to run Harbor benchmark with specific config
run_harbor_benchmark() {
    local config_file=$1
    local env_override=""
    
    if [[ $config_file == *"baseline"* ]]; then
        echo "⚙️  Running BASELINE (No UAP) configuration..."
        export USE_UAP=false
    else
        echo "🔧 Running UAP 3.0+OpenCode configuration..."  
        export USE_UAP=true
        export QDRANT_ENDPOINT="localhost:6333"
    fi
    
    # Run Harbor benchmark (using local orchestrator for containerized env)
    harbor run \
        --config "$HARBOR_CONFIGS/$config_file" \
        --results-dir "$RESULTS_DIR/$(basename $config_file .yaml)_run_$(date +%Y%m%d_%H%M%S)" \
        --n-concurrent 2 \
        --timeout-multiplier 1.5 \
        --max-retries 2 \
        || echo "Benchmark failed for config: $config_file"
}

# Check if Harbor is available
if ! command -v harbor &> /dev/null; then
    echo "❌ Error: Harbor CLI not found in PATH"
    exit 1
fi

echo "✓ Harbor CLI detected at $(which harbor)"
echo ""

# Run both configurations sequentially (can be run in parallel with different result dirs)
echo "Starting UAP configuration benchmark..."
run_harbor_benchmark "qwen35_uap_quick_suite.yaml"

sleep 60 # Brief pause between runs

echo ""
echo "Starting BASELINE configuration benchmark..."  
run_harbor_benchmark "qwen35_baseline_no_uap.yaml"

echo ""
echo "=================================================="
echo "Harbor benchmarks completed!"
echo "Results saved to: $RESULTS_DIR/"
ls -la "$RESULTS_DIR/" || echo "No results found (check logs above)"
