#!/bin/bash

# Overnight Benchmark Runner for UAP
# Runs extended benchmark suite for comprehensive validation
# Intended to run at 2:00 AM daily via cron

set -euo pipefail

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
RESULTS_DIR="${PROJECT_ROOT}/benchmark-results/overnight-$(date +%Y%m%d-%H%M%S)"
LOG_FILE="${RESULTS_DIR}/benchmark.log"

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Logging function
log() {
    local level=$1
    shift
    local message="$*"
    local timestamp=$(date '+%Y-%m-%d %H:%M:%S')
    echo -e "${timestamp} [${level}] ${message}" | tee -a "${LOG_FILE}"
}

log_info() { log "INFO" "$*"; }
log_warn() { log "WARN" "$*"; }
log_error() { log "ERROR" "$*"; }
log_success() { log "SUCCESS" "$*"; }

# Cleanup function
cleanup() {
    log_info "Cleaning up..."
    # Kill any remaining benchmark processes
    pkill -f "benchmark-qwen35" 2>/dev/null || true
    pkill -f "benchmark-server" 2>/dev/null || true
}

trap cleanup EXIT

# Main execution
main() {
    log_info "========================================"
    log_info "UAP Overnight Benchmark Suite"
    log_info "Started: $(date)"
    log_info "========================================"

    # Create results directory
    mkdir -p "${RESULTS_DIR}"
    log_info "Results will be saved to: ${RESULTS_DIR}"

    # Pre-flight checks
    log_info "Running pre-flight checks..."
    
    # Check Node.js
    if ! command -v node &> /dev/null; then
        log_error "Node.js is not installed"
        exit 1
    fi
    log_info "Node.js version: $(node --version)"

    # Check npm
    if ! command -v npm &> /dev/null; then
        log_error "npm is not installed"
        exit 1
    fi
    log_info "npm version: $(npm --version)"

    # Check if project is initialized
    if [ ! -f "${PROJECT_ROOT}/package.json" ]; then
        log_error "package.json not found. Run from project root."
        exit 1
    fi

    # Install dependencies if needed
    log_info "Checking dependencies..."
    if [ ! -d "${PROJECT_ROOT}/node_modules" ]; then
        log_info "Installing dependencies..."
        cd "${PROJECT_ROOT}"
        npm install >> "${LOG_FILE}" 2>&1
    fi

    # Build project
    log_info "Building project..."
    cd "${PROJECT_ROOT}"
    npm run build >> "${LOG_FILE}" 2>&1
    log_success "Build completed"

    # Run benchmark suite
    log_info "Starting benchmark suite..."
    log_info "Running 10 representative tasks (short suite)..."

    # Run the short benchmark suite
    cd "${PROJECT_ROOT}"
    npm run benchmark:short -- --results-dir "${RESULTS_DIR}" >> "${LOG_FILE}" 2>&1
    
    local exit_code=$?
    
    if [ $exit_code -eq 0 ]; then
        log_success "Benchmark suite completed successfully"
        
        # Generate report
        log_info "Generating benchmark report..."
        if [ -f "${RESULTS_DIR}/results.json" ]; then
            npm run benchmark:report -- --input "${RESULTS_DIR}/results.json" --output "${RESULTS_DIR}/report.md" >> "${LOG_FILE}" 2>&1 || true
            log_success "Report generated: ${RESULTS_DIR}/report.md"
        fi
        
        log_success "All benchmarks completed. See ${RESULTS_DIR}/report.md for results"
    else
        log_error "Benchmark suite failed with exit code ${exit_code}"
        log_error "Check ${LOG_FILE} for details"
        exit $exit_code
    fi

    log_info "========================================"
    log_info "Benchmark Suite Completed"
    log_info "Finished: $(date)"
    log_info "Results: ${RESULTS_DIR}"
    log_info "========================================"
}

# Run main function
main "$@"
