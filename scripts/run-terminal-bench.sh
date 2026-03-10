#!/bin/bash
#
# Run Terminal-Bench 2.0 with UAP-integrated agents
# Compares Droid with and without UAP memory across multiple models
#
# This benchmark uses the FACTORY_API_KEY which provides access to all models:
# - Claude Opus 4.5 (Anthropic)
# - GPT 5.2 Codex (OpenAI)  
# - GLM 4.7 (Zhipu)
#
# Usage:
#   export FACTORY_API_KEY="your-factory-api-key"
#   ./scripts/run-terminal-bench.sh
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
RESULTS_DIR="$PROJECT_ROOT/benchmark-results"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

# Models to test - Harbor/LiteLLM format (provider/model)
# These are mapped through Factory API when using droid
HARBOR_MODELS=(
    "anthropic/claude-opus-4-5"
    "openai/gpt-5.2-codex"
    "zhipu/glm-4.7"
)

# Factory/Droid model names (used by improved-benchmark.ts)
FACTORY_MODELS=(
    "claude-opus-4-5-20251101"
    "gpt-5.2-codex"
    "glm-4.7"
)

# Configuration
N_CONCURRENT=${N_CONCURRENT:-4}
TIMEOUT_MULT=${TIMEOUT_MULT:-1.0}
DATASET="terminal-bench@2.0"

# Check for API keys
check_api_keys() {
    # Factory API key provides access to all models
    if [ -z "$FACTORY_API_KEY" ] && [ -z "$DROID_API_KEY" ]; then
        echo "Error: FACTORY_API_KEY or DROID_API_KEY must be set"
        echo ""
        echo "The Factory API key provides unified access to:"
        echo "  - Claude Opus 4.5 (Anthropic)"
        echo "  - GPT 5.2 Codex (OpenAI)"
        echo "  - GLM 4.7 (Zhipu)"
        echo ""
        echo "Get your key at: https://app.factory.ai/settings/api-keys"
        exit 1
    fi
    
    echo "Using Factory API for model access"
    
    # For Harbor's direct provider access, these may also be needed
    if [ -z "$ANTHROPIC_API_KEY" ]; then
        echo "Note: ANTHROPIC_API_KEY not set - Harbor will use Factory routing"
    fi
    
    if [ -z "$OPENAI_API_KEY" ]; then
        echo "Note: OPENAI_API_KEY not set - Harbor will use Factory routing"
    fi
}

# Create results directory
mkdir -p "$RESULTS_DIR"

# Run benchmark for a specific model with UAP
run_with_uam() {
    local model=$1
    local model_safe=$(echo "$model" | tr '.-' '_')
    local job_name="uam_${model_safe}_${TIMESTAMP}"
    
    echo "=================================================="
    echo "Running: $model WITH UAP memory"
    echo "=================================================="
    
    harbor run \
        -d "$DATASET" \
        -a claude-code \
        -m "$model" \
        -n "$N_CONCURRENT" \
        --timeout-multiplier "$TIMEOUT_MULT" \
        --job-name "$job_name" \
        --jobs-dir "$RESULTS_DIR" \
        --ak "use_uam=true" \
        --ak "project_root=$PROJECT_ROOT" \
        2>&1 | tee "$RESULTS_DIR/${job_name}.log"
    
    echo "Results saved to: $RESULTS_DIR/$job_name"
}

# Run benchmark for a specific model without UAP (baseline)
run_without_uam() {
    local model=$1
    local model_safe=$(echo "$model" | tr '.-' '_')
    local job_name="baseline_${model_safe}_${TIMESTAMP}"
    
    echo "=================================================="
    echo "Running: $model WITHOUT UAP (baseline)"
    echo "=================================================="
    
    harbor run \
        -d "$DATASET" \
        -a claude-code \
        -m "$model" \
        -n "$N_CONCURRENT" \
        --timeout-multiplier "$TIMEOUT_MULT" \
        --job-name "$job_name" \
        --jobs-dir "$RESULTS_DIR" \
        2>&1 | tee "$RESULTS_DIR/${job_name}.log"
    
    echo "Results saved to: $RESULTS_DIR/$job_name"
}

# Run with custom UAP agent
run_custom_agent() {
    local model=$1
    local with_memory=$2
    local model_safe=$(echo "$model" | tr '.-' '_')
    local memory_label=$([ "$with_memory" = "true" ] && echo "uap" || echo "baseline")
    local job_name="${memory_label}_custom_${model_safe}_${TIMESTAMP}"
    
    echo "=================================================="
    echo "Running: $model with custom UAP agent (memory=$with_memory)"
    echo "=================================================="
    
    harbor run \
        -d "$DATASET" \
        --agent-import-path "$PROJECT_ROOT/src/harbor/uam_agent:UAMAgent" \
        -m "$model" \
        -n "$N_CONCURRENT" \
        --timeout-multiplier "$TIMEOUT_MULT" \
        --job-name "$job_name" \
        --jobs-dir "$RESULTS_DIR" \
        --ak "use_memory=$with_memory" \
        --ak "project_root=$PROJECT_ROOT" \
        2>&1 | tee "$RESULTS_DIR/${job_name}.log"
    
    echo "Results saved to: $RESULTS_DIR/$job_name"
}

# Generate comparison report
generate_report() {
    echo "=================================================="
    echo "Generating comparison report..."
    echo "=================================================="
    
    local report_file="$RESULTS_DIR/TERMINAL_BENCH_COMPARISON_${TIMESTAMP}.md"
    
    cat > "$report_file" << EOF
# Terminal-Bench 2.0 UAP Comparison Report

**Generated:** $(date -Iseconds)
**Dataset:** $DATASET (89 tasks)

## Configuration
- Concurrent trials: $N_CONCURRENT
- Timeout multiplier: $TIMEOUT_MULT
- Models tested: ${MODELS[*]}

## Results Summary

| Model | Without UAP | With UAP | Improvement |
|-------|-------------|----------|-------------|
EOF

    # Parse results from each run
    for model in "${MODELS[@]}"; do
        local model_safe=$(echo "$model" | tr '.-' '_')
        local baseline_dir="$RESULTS_DIR/baseline_${model_safe}_${TIMESTAMP}"
        local uam_dir="$RESULTS_DIR/uam_${model_safe}_${TIMESTAMP}"
        
        local baseline_acc="N/A"
        local uam_acc="N/A"
        local improvement="N/A"
        
        # Try to read results
        if [ -f "$baseline_dir/summary.json" ]; then
            baseline_acc=$(jq -r '.accuracy // "N/A"' "$baseline_dir/summary.json" 2>/dev/null || echo "N/A")
        fi
        
        if [ -f "$uam_dir/summary.json" ]; then
            uam_acc=$(jq -r '.accuracy // "N/A"' "$uam_dir/summary.json" 2>/dev/null || echo "N/A")
        fi
        
        if [[ "$baseline_acc" != "N/A" && "$uam_acc" != "N/A" ]]; then
            improvement=$(echo "$uam_acc - $baseline_acc" | bc 2>/dev/null || echo "N/A")
            improvement="${improvement}%"
        fi
        
        echo "| $model | $baseline_acc | $uam_acc | $improvement |" >> "$report_file"
    done
    
    cat >> "$report_file" << EOF

## Detailed Results

See individual job directories for full task-level results.

### Key Findings

Based on our improved UAP implementation:
- Dynamic memory retrieval based on task classification
- Hierarchical prompting with recency bias
- Multi-turn execution with error feedback

### Files
EOF

    ls -la "$RESULTS_DIR"/*_${TIMESTAMP}* 2>/dev/null >> "$report_file" || echo "No result directories found" >> "$report_file"
    
    echo ""
    echo "Report saved to: $report_file"
}

# Main execution
main() {
    echo "=================================================="
    echo "Terminal-Bench 2.0 UAP Comparison Benchmark"
    echo "=================================================="
    echo "Timestamp: $TIMESTAMP"
    echo "Results directory: $RESULTS_DIR"
    echo ""
    
    check_api_keys
    
    # Parse arguments
    local run_baseline=true
    local run_uam=true
    local use_custom=false
    local selected_models=("${HARBOR_MODELS[@]}")
    
    while [[ $# -gt 0 ]]; do
        case $1 in
            --baseline-only)
                run_uam=false
                shift
                ;;
            --uap-only)
                run_baseline=false
                shift
                ;;
            --custom-agent)
                use_custom=true
                shift
                ;;
            --model)
                selected_models=("$2")
                shift 2
                ;;
            --help)
                echo "Usage: $0 [options]"
                echo "Options:"
                echo "  --baseline-only   Run only baseline (no UAP)"
                echo "  --uap-only        Run only with UAP"
                echo "  --custom-agent    Use custom UAP agent instead of claude-code"
                echo "  --model MODEL     Test only this model"
                echo "  --help            Show this help"
                exit 0
                ;;
            *)
                echo "Unknown option: $1"
                exit 1
                ;;
        esac
    done
    
    # Run benchmarks
    for model in "${selected_models[@]}"; do
        if [ "$run_baseline" = true ]; then
            if [ "$use_custom" = true ]; then
                run_custom_agent "$model" "false"
            else
                run_without_uam "$model"
            fi
        fi
        
        if [ "$run_uam" = true ]; then
            if [ "$use_custom" = true ]; then
                run_custom_agent "$model" "true"
            else
                run_with_uam "$model"
            fi
        fi
    done
    
    # Generate report
    generate_report
    
    echo ""
    echo "=================================================="
    echo "Benchmark complete!"
    echo "=================================================="
}

main "$@"
