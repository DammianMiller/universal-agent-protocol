#!/bin/bash
#
# Run Terminal-Bench 2.0 with UAP/OpenCode Integration
# Tests Qwen3.5 with opencode+UAM performance using latest UAP integrations
#
# Usage:
#   # Quick tests (12 tasks) - Recommended starting point
#   ./scripts/run-tbench-qwen35-quick.sh
#   
#   # Full suite (88 tasks) - Run after quick tests pass
#   ./scripts/run-tbench-qwen35-full.sh --full-suite
#
# UAP/OpenCode Integrations:
# - Session hooks for memory loading on session start
# - Pre-compact markers for context preservation
# - Command tools (uap_memory_query, uap_task_create, etc.)
# - Droid invocation system
# - Skill injection for domain knowledge
# - Pattern RAG retrieval
#
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
RESULTS_DIR="$PROJECT_ROOT/benchmark-results"
TIMESTAMP=$(date +%Y-%m-%d__%H-%M-%S)

# ============================================================================
# CONFIGURATION
# ============================================================================

# Models - opencode + in-container tool-choice-proxy -> llama.cpp directly
# Bypasses UAP Anthropic proxy (proven 20-40% pass rate in historical runs)
# Currently running Qwen3.5-35B-A3B-UD-Q4_K_XL.gguf on llama.cpp
MODELS=(
    "llama.cpp/qwen35-a3b-iq4xs"
)

# Direct llama.cpp endpoint (OpenAI API) — opencode + its in-container proxy
export UAP_API_ENDPOINT="http://192.168.1.165:8080/v1"

# Quick test subset - Tasks selected for local Qwen3.5-A3B Q4_K_XL via claude-local
QUICK_TESTS=(
    # Easy tasks
    "fix-git"
    "openssl-selfsigned-cert"
    "regex-log"

    # File operations
    "sqlite-db-truncate"

    # Coding/general
    "log-summary-date-ranges"
    "financial-document-processor"
)

# Full suite (88 tasks) - All terminal-bench@2.0 tasks
FULL_TESTS=(
    "crack-7z-hash"
    "filter-js-from-html"
    "cobol-modernization"
    "code-from-image"
    "sqlite-db-truncate"
    "extract-elf"
    "db-wal-recovery"
    "vulnerable-secret"
    "chess-best-move"
    "log-summary-date-ranges"
    "password-recovery"
    "gpt2-codegolf"
    "constraints-scheduling"
    "financial-document-processor"
    "regex-chess"
    # Add remaining 73 tasks as they become available in terminal-bench@2.0
)

# UAP Integration settings
USE_SESSION_HOOKS=${USE_SESSION_HOOKS:-true}
USE_PRE_COMPACT=${USE_PRE_COMPACT:-true}
MEMORY_QUERIES=${MEMORY_QUERIES:-true}
DROID_INVOKE=${DROID_INVOKE:-false}
SKILL_INJECTION=${SKILL_INJECTION:-true}

# Benchmark settings
N_CONCURRENT=${N_CONCURRENT:-1}
TIMEOUT_MULT=${TIMEOUT_MULT:-6.0}  # Matches historical successful runs (uap-10.x.x-final)
DATASET="terminal-bench@2.0"

# ============================================================================
# UAP CONTEXT GENERATION (Hybrid Adaptive)
# ============================================================================

generate_uap_context() {
    cat << 'EOF'
## UAP/OpenCode Integration Context

### Session Hooks Active
- Memory loading on session start: YES
- Pre-compact markers: YES
- Auto-completion tracking: YES

### Available Tools
- uap_memory_query: Query past lessons and decisions
- uap_task_create: Track work items
- uap_worktree_create: Isolated development environment
- uap_droid_invoke: Specialized agent assistance
- uap_patterns_query: Coding pattern retrieval
- uap_skill_load: Domain-specific knowledge injection

### Memory System Status
- Short-term DB: ./agents/data/memory/short_term.db
- Coordination DB: ./agents/data/coordination/coordination.db
- Recent memories loaded from last 24h
- High-importance decisions (>=7) prioritized

### Droids Available
- terminal-bench-optimizer: Task-specific optimization
- code-quality-guardian: Code quality review
- security-auditor: Security task expertise
- performance-optimizer: Performance tuning

### Skills Loaded
- terminal-bench-strategies: Battle-tested patterns
- compression: File compression techniques
- chess-engine: Chess notation and strategies
- adversarial: Security testing patterns

### Pattern RAG
- Queryable coding patterns via Qdrant
- Domain-specific retrieval enabled
- 30+ Terminal-Bench knowledge entries loaded

### Best Practices
1. Always use worktree for file changes
2. Check memory before starting complex tasks
3. Store lessons after completing tasks
4. Use droids for specialized domains (security, ML)
5. Leverage pattern RAG for code patterns
EOF
}

# ============================================================================
# TASK CLASSIFICATION
# ============================================================================

classify_task() {
    local task="$1"
    case "$task" in
        # Pure reasoning/scheduling - SKIP UAP (prevents timeout regression)
        constraints-scheduling|chess-best-move|regex-chess)
            echo "skip"
            ;;
        # Security tasks - FULL UAP with security context
        crack-7z-hash|password-recovery|vulnerable-secret|filter-js-from-html|break-filter-js-from-html)
            echo "security"
            ;;
        # File operations - FULL UAP with file format context
        extract-elf|sqlite-db-truncate|db-wal-recovery)
            echo "file-ops"
            ;;
        # Legacy/modernization - FULL UAP with legacy context
        cobol-modernization)
            echo "legacy"
            ;;
        # ML tasks - MINIMAL UAP (risk-aware, test small first)
        gpt2-codegolf)
            echo "ml"
            ;;
        # General coding - MINIMAL UAP with basic context
        code-from-image|financial-document-processor|log-summary-date-ranges)
            echo "coding"
            ;;
        # Default
        *)
            echo "general"
            ;;
    esac
}

# ============================================================================
# BENCHMARK EXECUTION
# ============================================================================

run_benchmark() {
    local model="$1"
    local test_subset=("${@:2}")
    local model_safe=$(echo "$model" | tr '.-' '_')
    local job_name="qwen35_uap_${model_safe}_${TIMESTAMP}"
    mkdir -p "$RESULTS_DIR"
    local results_file="$RESULTS_DIR/${job_name}.json"
    
    echo "=============================================================="
    echo "  Terminal-Bench 2.0: Qwen3.5 with UAP/OpenCode Integration"
    echo "=============================================================="
    echo "Model: $model"
    echo "Tests: ${#test_subset[@]}"
    echo "Concurrent: $N_CONCURRENT"
    echo "Timeout multiplier: $TIMEOUT_MULT"
    echo ""
    
    # Show task classification
    echo "Task Classification (Hybrid Adaptive UAP):"
    echo "-------------------------------------------"
    local skip_count=0
    local full_count=0
    local minimal_count=0
    
    for task in "${test_subset[@]}"; do
        local category=$(classify_task "$task")
        case "$category" in
            skip)
                echo "  $task → NO UAP (reasoning/games)"
                ((skip_count++)) || true
                ;;
            security|file-ops|legacy)
                echo "  $task → FULL UAP ($category context)"
                ((full_count++)) || true
                ;;
            ml|coding|general)
                echo "  $task → MINIMAL UAP ($category context)"
                ((minimal_count++)) || true
                ;;
        esac
    done
    
    echo ""
    echo "Summary: $skip_count skip, $full_count full, $minimal_count minimal"
    echo ""
    
    # Build task arguments
    local task_args=""
    for task in "${test_subset[@]}"; do
        task_args="$task_args -t $task"
    done
    
    # Create results directory
    mkdir -p "$RESULTS_DIR"
    
    # Run with Harbor using UAP integration
    echo "Starting benchmark..."
    echo ""
    
    harbor run \
        -d "$DATASET" \
        --agent-import-path tools.agents.opencode_uap_agent:OpenCodeUAP \
        -m "$model" \
        $task_args \
        -k 1 \
        --jobs-dir "$RESULTS_DIR" \
        --job-name "$job_name" \
        -n "$N_CONCURRENT" \
        --timeout-multiplier "$TIMEOUT_MULT" \
        2>&1 | tee "$RESULTS_DIR/${job_name}.log"
    
    echo ""
    echo "=============================================================="
    echo "Benchmark Complete"
    echo "=============================================================="
    echo "Results: $RESULTS_DIR/$job_name/result.json"
    echo "Log: $RESULTS_DIR/${job_name}.log"
    echo ""
    
    # Show expected improvements
    echo "Expected Improvements with UAP/OpenCode:"
    echo "-----------------------------------------"
    echo "  - Security tasks (crack-7z-hash, filter-js-from-html): +15-20%"
    echo "  - File operations (extract-elf, sqlite-db-truncate): +10-15%"
    echo "  - Legacy code (cobol-modernization): +20-25%"
    echo "  - ML tasks (gpt2-codegolf): +5-10% (risk-aware)"
    echo "  - Reasoning tasks (chess-best-move): No change (UAP skip)"
    echo ""
    
    # Display summary if available
    if [ -f "$RESULTS_DIR/$job_name/summary.json" ]; then
        echo "Quick Summary:"
        cat "$RESULTS_DIR/$job_name/summary.json" | jq '.' 2>/dev/null || \
            cat "$RESULTS_DIR/$job_name/summary.json"
    fi
    
    echo ""
    
    return 0
}

# ============================================================================
# REPORTING
# ============================================================================

generate_report() {
    local job_name="$1"
    local report_file="$RESULTS_DIR/QWEN35_UAP_REPORT_${TIMESTAMP}.md"
    
    echo "Generating comparison report..."
    
    cat > "$report_file" << EOF
# Qwen3.5 + UAP/OpenCode Integration Benchmark Report

**Generated:** $(date -Iseconds)
**Model:** qwen/qwen-3.5
**Dataset:** terminal-bench@2.0
**Integration:** UAP v0.9.1 + OpenCode Plugins

## Configuration

### UAP Integrations Enabled
- Session Hooks: $USE_SESSION_HOOKS
- Pre-Compact Markers: $USE_PRE_COMPACT
- Memory Queries: $MEMORY_QUERIES
- Droid Invocation: $DROID_INVOKE
- Skill Injection: $SKILL_INJECTION

### Benchmark Settings
- Concurrent trials: $N_CONCURRENT
- Timeout multiplier: $TIMEOUT_MULT
- Task count: ${#QUICK_TESTS[@]} (quick) or ${#FULL_TESTS[@]} (full)

## Task Classification

| Category | Count | Description |
|----------|-------|-------------|
| Skip | $(( $(classify_task chess-best-move) == "skip" ? 1 : 0 )) | Pure reasoning tasks (no UAP overhead) |
| Full | - | Security, file-ops, legacy (full context) |
| Minimal | - | ML, coding (minimal context) |

## Results Summary

See individual job directories for detailed results.

### Expected Performance
Based on prior UAM runs with Opus 4.5:
- Overall improvement expected: +8-12%
- Security tasks: +15-20%
- File operations: +10-15%
- Legacy code: +20-25%

### Files
- Results: $RESULTS_DIR/$job_name/
- Log: $RESULTS_DIR/${job_name}.log
- Summary: $RESULTS_DIR/$job_name/summary.json

## Next Steps

1. Review individual task results
2. Check for timeout issues
3. Analyze memory query effectiveness
4. Consider full suite (88 tasks) if quick tests pass
EOF
    
    echo "Report saved to: $report_file"
}

# ============================================================================
# MAIN EXECUTION
# ============================================================================

main() {
    local run_full=false
    
    # Parse arguments
    while [[ $# -gt 0 ]]; do
        case $1 in
            --full-suite)
                run_full=true
                shift
                ;;
            --help)
                echo "Usage: $0 [options]"
                echo ""
                echo "Run Terminal-Bench with Qwen3.5 and UAP/OpenCode integration"
                echo ""
                echo "Options:"
                echo "  --full-suite    Run all 88 tasks instead of quick subset (12)"
                echo "  --help          Show this help"
                echo ""
                echo "Environment Variables:"
                echo "  N_CONCURRENT       Concurrent trials (default: 4)"
                echo "  TIMEOUT_MULT       Timeout multiplier (default: 1.5)"
                echo "  USE_SESSION_HOOKS  Enable session hooks (default: true)"
                echo "  DROID_INVOKE       Enable droid invocation (default: false)"
                echo ""
                echo "Examples:"
                echo "  $0                        # Run quick tests (12 tasks)"
                echo "  $0 --full-suite          # Run full suite (88 tasks)"
                echo "  N_CONCURRENT=2 $0       # Run with 2 concurrent trials"
                exit 0
                ;;
            *)
                echo "Unknown option: $1"
                exit 1
                ;;
        esac
    done
    
    # Using opencode + in-container tool-choice-proxy -> llama.cpp directly
    # This is the historical successful config (uap-10.x.x-final: 20-40% pass rate)
    echo "Using opencode + tool-choice-proxy"
    echo "Endpoint: $UAP_API_ENDPOINT"
    echo "Model: llama.cpp/qwen35-a3b-iq4xs (Qwen3.5-35B-A3B-UD-Q4_K_XL.gguf)"
    
    # Create results directory
    mkdir -p "$RESULTS_DIR"
    
    # Select test suite
    local tests=("${QUICK_TESTS[@]}")
    if [ "$run_full" = true ]; then
        echo "Running full suite (88 tasks)..."
        echo ""
        tests=("${FULL_TESTS[@]}")
    else
        echo "Running quick tests (12 tasks)..."
        echo ""
    fi
    
    # Run benchmark for each model
    for model in "${MODELS[@]}"; do
        run_benchmark "$model" "${tests[@]}"
        generate_report "qwen35_uap_${model}_$TIMESTAMP"
    done
    
    echo ""
    echo "=============================================================="
    echo "Benchmark complete!"
    echo "=============================================================="
    echo ""
    
    if [ "$run_full" = false ]; then
        echo "Quick tests completed. Review results and decide:"
        echo ""
        echo "  - If success rate >= 70%: Proceed with full suite (88 tasks)"
        echo "  - If success rate < 70%: Review failures and optimize"
        echo ""
        echo "To run full suite:"
        echo "  $0 --full-suite"
        echo ""
    fi
}

main "$@"