#!/bin/bash
#
# Full Terminal-Bench 2.0 Benchmark: UAM v3.1.0 vs Baseline
# Runs all 3 models x 2 configs = 6 total benchmark runs
#
# Models: Claude Opus 4.5, GPT 5.2 Codex, GLM 4.7
# Configs: Baseline (no UAM), With UAM
#
# Usage:
#   export FACTORY_API_KEY="your-key"
#   ./scripts/run-full-benchmark.sh [options]
#
# Options:
#   --model <model>         Run only this model (e.g. anthropic/claude-opus-4-5)
#   --baseline-only         Skip UAM runs
#   --uam-only              Skip baseline runs
#   --concurrency <n>       Parallel tasks per run (default: 4)
#   --timeout-mult <f>      Timeout multiplier (default: 2.0)
#   --dry-run               Print commands without executing
#   --resume <timestamp>    Resume a previous run using its timestamp
#   --help                  Show help
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
RESULTS_DIR="$PROJECT_ROOT/benchmark-results"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

# Models in Harbor format
declare -A MODEL_MAP=(
    ["anthropic/claude-opus-4-5"]="opus45"
    ["openai/gpt-5.2-codex"]="gpt52"
    ["zhipu/glm-4.7"]="glm47"
)

ALL_MODELS=("anthropic/claude-opus-4-5" "openai/gpt-5.2-codex" "zhipu/glm-4.7")

# Defaults
CONCURRENCY=4
TIMEOUT_MULT=2.0
DATASET="terminal-bench@2.0"
RUN_BASELINE=true
RUN_UAM=true
DRY_RUN=false
SELECTED_MODELS=("${ALL_MODELS[@]}")
RESUME_TS=""

# Track run results for summary
declare -A RUN_STATUS
declare -A RUN_JOBS

usage() {
    sed -n '2,/^$/p' "$0" | sed 's/^#//' | sed 's/^ //'
    exit 0
}

parse_args() {
    while [[ $# -gt 0 ]]; do
        case $1 in
            --model) SELECTED_MODELS=("$2"); shift 2 ;;
            --baseline-only) RUN_UAM=false; shift ;;
            --uam-only) RUN_BASELINE=false; shift ;;
            --concurrency) CONCURRENCY="$2"; shift 2 ;;
            --timeout-mult) TIMEOUT_MULT="$2"; shift 2 ;;
            --dry-run) DRY_RUN=true; shift ;;
            --resume) RESUME_TS="$2"; TIMESTAMP="$2"; shift 2 ;;
            --help) usage ;;
            *) echo "Unknown option: $1"; exit 1 ;;
        esac
    done
}

check_prerequisites() {
    if ! command -v harbor &>/dev/null; then
        echo "Error: 'harbor' CLI not found. Install from https://github.com/laude-institute/harbor"
        exit 1
    fi

    if [[ -z "${FACTORY_API_KEY:-}" ]] && [[ -z "${DROID_API_KEY:-}" ]] && [[ -z "${ANTHROPIC_API_KEY:-}" ]]; then
        echo "Error: No API key found. Set FACTORY_API_KEY, DROID_API_KEY, or ANTHROPIC_API_KEY"
        echo "Get your Factory key at: https://app.factory.ai/settings/api-keys"
        exit 1
    fi
}

log() {
    local level="$1"; shift
    local ts
    ts=$(date +"%H:%M:%S")
    case "$level" in
        INFO)  echo -e "[$ts] \033[36mINFO\033[0m  $*" ;;
        OK)    echo -e "[$ts] \033[32mOK\033[0m    $*" ;;
        WARN)  echo -e "[$ts] \033[33mWARN\033[0m  $*" ;;
        ERROR) echo -e "[$ts] \033[31mERROR\033[0m $*" ;;
        RUN)   echo -e "[$ts] \033[35mRUN\033[0m   $*" ;;
    esac
}

run_harbor() {
    local config_type="$1"   # "baseline" or "uam"
    local model="$2"
    local model_short="${MODEL_MAP[$model]}"
    local job_name="${config_type}_${model_short}_${TIMESTAMP}"
    local log_file="$RESULTS_DIR/${job_name}.log"
    local run_key="${config_type}_${model_short}"

    # Skip if already completed (resume mode)
    if [[ -n "$RESUME_TS" ]] && [[ -f "$RESULTS_DIR/${job_name}/result.json" ]]; then
        log INFO "Skipping $job_name (already completed)"
        RUN_STATUS[$run_key]="skipped"
        RUN_JOBS[$run_key]="$job_name"
        return 0
    fi

    log RUN "$config_type | $model | job=$job_name"

    local cmd=(
        harbor run
        -d "$DATASET"
        -m "$model"
        -n "$CONCURRENCY"
        --timeout-multiplier "$TIMEOUT_MULT"
        --job-name "$job_name"
        --jobs-dir "$RESULTS_DIR"
    )

    if [[ "$config_type" == "baseline" ]]; then
        # Baseline: vanilla claude-code agent with no UAM context
        cmd+=(-a claude-code --ak "system_prompt=")
    else
        # UAP: custom agent with classified preamble and pre-execution hooks
        cmd+=(--agent-import-path "uap_harbor.uap_agent:UAPAgent")
    fi

    if [[ "$DRY_RUN" == true ]]; then
        echo "  [DRY RUN] ${cmd[*]}"
        RUN_STATUS[$run_key]="dry-run"
        RUN_JOBS[$run_key]="$job_name"
        return 0
    fi

    mkdir -p "$RESULTS_DIR"

    local start_time
    start_time=$(date +%s)

    if "${cmd[@]}" 2>&1 | tee "$log_file"; then
        RUN_STATUS[$run_key]="success"
    else
        RUN_STATUS[$run_key]="failed"
        log WARN "$job_name exited with non-zero status"
    fi

    RUN_JOBS[$run_key]="$job_name"

    local end_time
    end_time=$(date +%s)
    local duration=$(( end_time - start_time ))
    local hours=$(( duration / 3600 ))
    local minutes=$(( (duration % 3600) / 60 ))

    log OK "$job_name completed in ${hours}h ${minutes}m"
}

print_summary() {
    echo ""
    echo "================================================================"
    echo "  BENCHMARK SUMMARY"
    echo "================================================================"
    echo ""
    printf "  %-12s %-30s %-10s %s\n" "Config" "Model" "Status" "Job Name"
    printf "  %-12s %-30s %-10s %s\n" "------" "-----" "------" "--------"

    for model in "${SELECTED_MODELS[@]}"; do
        local model_short="${MODEL_MAP[$model]}"
        for config in baseline uam; do
            local key="${config}_${model_short}"
            local status="${RUN_STATUS[$key]:-not-run}"
            local job="${RUN_JOBS[$key]:-N/A}"
            printf "  %-12s %-30s %-10s %s\n" "$config" "$model" "$status" "$job"
        done
    done

    echo ""
    echo "  Results directory: $RESULTS_DIR"
    echo "  Timestamp: $TIMESTAMP"
    echo ""
}

generate_report() {
    log INFO "Generating comparison report..."

    local report_script="$SCRIPT_DIR/generate-comparison-report.ts"
    if [[ ! -f "$report_script" ]]; then
        log WARN "Report generator not found at $report_script"
        log INFO "Generating basic summary instead..."
        generate_basic_report
        return
    fi

    # Run the TypeScript report generator
    local report_output
    report_output="$RESULTS_DIR/FULL_COMPARISON_${TIMESTAMP}.md"

    local job_args=""
    for model in "${SELECTED_MODELS[@]}"; do
        local model_short="${MODEL_MAP[$model]}"
        if [[ "$RUN_BASELINE" == true ]]; then
            local bj="${RUN_JOBS[baseline_${model_short}]:-}"
            if [[ -n "$bj" ]]; then
                job_args="$job_args --baseline $RESULTS_DIR/$bj"
            fi
        fi
        if [[ "$RUN_UAM" == true ]]; then
            local uj="${RUN_JOBS[uam_${model_short}]:-}"
            if [[ -n "$uj" ]]; then
                job_args="$job_args --uam $RESULTS_DIR/$uj"
            fi
        fi
    done

    if npx tsx "$report_script" \
        --output "$report_output" \
        --timestamp "$TIMESTAMP" \
        $job_args 2>&1; then
        log OK "Report saved to $report_output"
    else
        log WARN "TypeScript report generator failed, falling back to basic report"
        generate_basic_report
    fi
}

generate_basic_report() {
    local report_file="$RESULTS_DIR/FULL_COMPARISON_${TIMESTAMP}.md"

    cat > "$report_file" << HEADER
# Terminal-Bench 2.0 Full Comparison: UAM v3.1.0 vs Baseline

**Generated:** $(date -Iseconds)
**Dataset:** $DATASET (89 tasks)
**UAM Version:** 3.1.0
**Concurrency:** $CONCURRENCY | **Timeout Multiplier:** $TIMEOUT_MULT

## Results Summary

| Model | Config | Pass Rate | Passed | Failed | Errors |
|-------|--------|-----------|--------|--------|--------|
HEADER

    for model in "${SELECTED_MODELS[@]}"; do
        local model_short="${MODEL_MAP[$model]}"
        for config in baseline uam; do
            local key="${config}_${model_short}"
            local job="${RUN_JOBS[$key]:-}"
            local result_file="$RESULTS_DIR/$job/result.json"

            if [[ -n "$job" ]] && [[ -f "$result_file" ]]; then
                local stats
                stats=$(python3 -c "
import json, sys
with open('$result_file') as f:
    d = json.load(f)
evals = d['stats']['evals']
for k, v in evals.items():
    rw = v.get('reward_stats', {}).get('reward', {})
    p = len(rw.get('1.0', []))
    f = len(rw.get('0.0', []))
    total = p + f
    rate = p/total*100 if total > 0 else 0
    err = v.get('n_errors', 0)
    print(f'{rate:.1f}%|{p}|{f}|{err}')
" 2>/dev/null || echo "N/A|N/A|N/A|N/A")

                IFS='|' read -r rate passed failed errors <<< "$stats"
                echo "| $model | $config | $rate | $passed | $failed | $errors |" >> "$report_file"
            else
                echo "| $model | $config | N/A | N/A | N/A | N/A |" >> "$report_file"
            fi
        done
    done

    # Add per-model delta section
    cat >> "$report_file" << 'DELTAS'

## Per-Model UAM Delta

DELTAS

    for model in "${SELECTED_MODELS[@]}"; do
        local model_short="${MODEL_MAP[$model]}"
        local bj="${RUN_JOBS[baseline_${model_short}]:-}"
        local uj="${RUN_JOBS[uam_${model_short}]:-}"
        local b_result="$RESULTS_DIR/$bj/result.json"
        local u_result="$RESULTS_DIR/$uj/result.json"

        if [[ -f "$b_result" ]] && [[ -f "$u_result" ]]; then
            echo "### $model" >> "$report_file"
            echo "" >> "$report_file"

            python3 -c "
import json
with open('$b_result') as f:
    bd = json.load(f)
with open('$u_result') as f:
    ud = json.load(f)

def get_tasks(data):
    evals = data['stats']['evals']
    for k, v in evals.items():
        rw = v.get('reward_stats', {}).get('reward', {})
        passed = set(t.split('__')[0] for t in rw.get('1.0', []))
        failed = set(t.split('__')[0] for t in rw.get('0.0', []))
        return passed, failed
    return set(), set()

bp, bf = get_tasks(bd)
up, uf = get_tasks(ud)

uam_wins = sorted(up - bp)
baseline_wins = sorted(bp - up)
both_pass = sorted(bp & up)
both_fail = sorted(bf & uf)

b_rate = len(bp)/(len(bp)+len(bf))*100 if (len(bp)+len(bf))>0 else 0
u_rate = len(up)/(len(up)+len(uf))*100 if (len(up)+len(uf))>0 else 0
delta = u_rate - b_rate

print(f'| Metric | Value |')
print(f'|--------|-------|')
print(f'| Baseline pass rate | {b_rate:.1f}% ({len(bp)}/{len(bp)+len(bf)}) |')
print(f'| UAM pass rate | {u_rate:.1f}% ({len(up)}/{len(up)+len(uf)}) |')
print(f'| **Net delta** | **{delta:+.1f}%** ({len(uam_wins)-len(baseline_wins):+d} tasks) |')
print(f'| UAM wins | {len(uam_wins)} tasks |')
print(f'| Baseline wins | {len(baseline_wins)} tasks |')
print(f'| Both pass | {len(both_pass)} tasks |')
print(f'| Both fail | {len(both_fail)} tasks |')
print()

if uam_wins:
    print('**UAM wins:** ' + ', '.join(uam_wins))
    print()
if baseline_wins:
    print('**Baseline wins:** ' + ', '.join(baseline_wins))
    print()
" >> "$report_file" 2>/dev/null || echo "Unable to parse results for $model" >> "$report_file"
            echo "" >> "$report_file"
        fi
    done

    echo "" >> "$report_file"
    echo "---" >> "$report_file"
    echo "*Report generated by \`scripts/run-full-benchmark.sh\` at $(date -Iseconds)*" >> "$report_file"

    log OK "Basic report saved to $report_file"
}

# === Main ===

main() {
    parse_args "$@"

    echo "================================================================"
    echo "  Terminal-Bench 2.0 Full Benchmark"
    echo "  UAM v3.1.0 vs Baseline | $(date)"
    echo "================================================================"
    echo ""
    echo "  Models:      ${SELECTED_MODELS[*]}"
    echo "  Configs:     $([ "$RUN_BASELINE" = true ] && echo "baseline ")$([ "$RUN_UAM" = true ] && echo "uam")"
    echo "  Concurrency: $CONCURRENCY"
    echo "  Timeout:     ${TIMEOUT_MULT}x"
    echo "  Results:     $RESULTS_DIR"
    echo "  Timestamp:   $TIMESTAMP"
    echo ""

    check_prerequisites

    # Run each model x config combination
    local run_count=0
    local total_runs=0

    for model in "${SELECTED_MODELS[@]}"; do
        [[ "$RUN_BASELINE" == true ]] && (( total_runs++ )) || true
        [[ "$RUN_UAM" == true ]] && (( total_runs++ )) || true
    done

    log INFO "Starting $total_runs benchmark runs..."

    for model in "${SELECTED_MODELS[@]}"; do
        if [[ "$RUN_BASELINE" == true ]]; then
            (( run_count++ )) || true
            log INFO "Run $run_count/$total_runs"
            run_harbor "baseline" "$model"
        fi

        if [[ "$RUN_UAM" == true ]]; then
            (( run_count++ )) || true
            log INFO "Run $run_count/$total_runs"
            run_harbor "uam" "$model"
        fi
    done

    # Generate report
    generate_report

    # Print summary
    print_summary

    log OK "All benchmark runs complete."
}

main "$@"
