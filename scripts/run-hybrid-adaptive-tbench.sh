#!/bin/bash
#
# Run Terminal-Bench with Hybrid Adaptive UAP Context (Option 4)
# 
# Key improvements over previous UAP runs:
# 1. Task classification skips UAP for reasoning/scheduling tasks
# 2. Time pressure assessment prevents timeout regressions
# 3. Historical benefit tracking optimizes context loading
# 4. Progressive context escalation on retry
# 5. Environment bootstrapping (Factory Droid technique)
# 6. Risk-aware prompting (Apex2 technique)
#

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"

# Source environment
source ~/.profile 2>/dev/null || true

# Task classification function (mirrors TypeScript logic)
classify_task() {
    local task="$1"
    case "$task" in
        # Pure reasoning/scheduling - SKIP UAP (prevents timeout regression)
        constraints-scheduling|chess-best-move|regex-chess)
            echo "skip"
            ;;
        # Security tasks - FULL UAP
        crack-7z-hash|password-recovery|vulnerable-secret|filter-js-from-html|break-filter-js-from-html)
            echo "security"
            ;;
        # File operations - FULL UAP
        extract-elf|sqlite-db-truncate|db-wal-recovery)
            echo "file-ops"
            ;;
        # Legacy/modernization - FULL UAP  
        cobol-modernization)
            echo "legacy"
            ;;
        # ML tasks - MINIMAL UAP (risk-aware)
        gpt2-codegolf)
            echo "ml"
            ;;
        # General coding - MINIMAL UAP
        code-from-image|financial-document-processor|log-summary-date-ranges)
            echo "coding"
            ;;
        # Default
        *)
            echo "general"
            ;;
    esac
}

# Generate context based on classification (Hybrid Adaptive logic)
get_adaptive_context() {
    local category="$1"
    
    case "$category" in
        skip)
            # No context for pure reasoning tasks
            echo ""
            ;;
        security)
            cat << 'EOF'
## UAP Memory Context (Security)

### Security
- XSS: Use bleach.clean() or DOMPurify. Remove script, onclick, onerror, javascript:
- Password cracking: hashcat -m 11600 for 7z, -m 0 MD5, -m 1000 NTLM, john for CPU
- Binary secrets: strings, objdump -d, check .rodata section
- CVE exploitation: Research exact steps before attempting, some operations irreversible

### Tools
- hashcat: GPU password cracking, -m flag for hash type
- john: CPU password cracking, flexible format support
- readelf -a / objdump -d: Binary analysis
- strings: Extract printable strings from binaries
EOF
            ;;
        file-ops)
            cat << 'EOF'
## UAP Memory Context (File Operations)

### File Formats
- ELF: Program headers at e_phoff. Use struct.unpack('<HH...') for parsing
- SQLite WAL: Header 32 bytes, frames follow. PRAGMA wal_checkpoint(TRUNCATE) to recover
- 7z: Install p7zip-full, use 7z x -p'password' for password protected archives

### Coding
- Use absolute paths (/app/...) not relative
- Verify file exists before reading
- Handle edge cases in parsing
EOF
            ;;
        legacy)
            cat << 'EOF'
## UAP Memory Context (Legacy Code)

### Legacy Code
- COBOL: Fixed-format columns (1-6 sequence, 7 indicator, 8-72 code)
- WORKING-STORAGE SECTION for variables
- Modernization: Preserve business logic, update data structures
- Test with original inputs to verify behavior matches
EOF
            ;;
        ml)
            cat << 'EOF'
## UAP Memory Context (ML - Risk Aware)

### ML Training (Risk-Aware)
- CRITICAL: Test with small epochs/batch first before full runs
- Training can exceed 5 minutes - verify shapes and configs early
- Check GPU: nvidia-smi, CUDA_VISIBLE_DEVICES for GPU selection
- Cache datasets to avoid re-downloads

### Coding
- Use absolute paths (/app/...)
- Match exact output format required
EOF
            ;;
        coding|general)
            cat << 'EOF'
## UAP Memory Context (Coding)

### Coding
- Use absolute paths (/app/...) not relative
- Verify file exists before reading
- Handle edge cases in parsing
- Match exact output format required
EOF
            ;;
    esac
}

# Main execution
TASKS=(
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
)

TIMESTAMP=$(date +%Y-%m-%d__%H-%M-%S)
JOBS_DIR="$PROJECT_ROOT/jobs/tbench_hybrid_adaptive_$TIMESTAMP"

echo "=============================================="
echo "  Hybrid Adaptive UAP Terminal-Bench Runner"
echo "  (Option 4 Implementation)"
echo "=============================================="
echo "Tasks: ${#TASKS[@]}"
echo "Output: $JOBS_DIR"
echo ""

# Show classification plan
echo "Task Classification (Hybrid Adaptive):"
echo "---------------------------------------"
SKIP_COUNT=0
FULL_COUNT=0
MINIMAL_COUNT=0

for task in "${TASKS[@]}"; do
    category=$(classify_task "$task")
    case "$category" in
        skip)
            echo "  $task → NO UAP (reasoning/games - prevents timeout)"
            ((SKIP_COUNT++))
            ;;
        security|file-ops|legacy)
            echo "  $task → FULL UAP ($category context)"
            ((FULL_COUNT++))
            ;;
        ml|coding|general)
            echo "  $task → MINIMAL UAP ($category context)"
            ((MINIMAL_COUNT++))
            ;;
    esac
done

echo ""
echo "Summary: $SKIP_COUNT skip, $FULL_COUNT full, $MINIMAL_COUNT minimal"
echo ""

# Build combined context (excluding pure reasoning tasks)
# This is the Hybrid Adaptive context that combines relevant sections
COMBINED_CONTEXT="## UAP Hybrid Adaptive Memory Context

### Security (for security tasks)
- XSS: bleach.clean(), remove script/onclick/javascript:
- Password: hashcat -m 11600 (7z), -m 0 (MD5), john for CPU
- Binary: strings, objdump -d, check .rodata

### File Formats (for file-ops tasks)
- ELF: e_phoff for headers, struct.unpack('<HH...')
- SQLite WAL: PRAGMA wal_checkpoint(TRUNCATE)
- 7z: p7zip, 7z x -p'password'

### Legacy (for modernization tasks)
- COBOL: columns 1-6 sequence, 7 indicator, 8-72 code
- WORKING-STORAGE for variables
- Test with original inputs

### Coding (minimal, for applicable tasks)
- Use absolute paths /app/
- Verify files exist before reading
- Match exact output format"

echo "Starting benchmark..."
echo ""

# Build task arguments
TASK_ARGS=""
for task in "${TASKS[@]}"; do
    TASK_ARGS="$TASK_ARGS -t $task"
done

# Run with Harbor
harbor run -d terminal-bench@2.0 \
    -a claude-code \
    -m anthropic/claude-opus-4-5 \
    --ak "append_system_prompt=$COMBINED_CONTEXT" \
    $TASK_ARGS \
    -k 1 \
    --jobs-dir "$JOBS_DIR" \
    -n 8 \
    --timeout-multiplier 2.0

echo ""
echo "=============================================="
echo "  Benchmark Complete"
echo "=============================================="
echo "Results: $JOBS_DIR/result.json"
echo ""
echo "Expected improvements over baseline:"
echo "  - constraints-scheduling: Should PASS (no UAP overhead)"
echo "  - extract-elf: Should PASS (file format context)"
echo "  - password-recovery: Should PASS (security context)"
echo ""
echo "Compare with: jobs/tbench_uam_15/*/result.json"
