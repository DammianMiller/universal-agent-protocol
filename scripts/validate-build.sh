#!/usr/bin/env bash
# UAP Pre-Edit Build Gate
# Run before and after editing TypeScript files to ensure build integrity.
#
# Usage:
#   bash scripts/validate-build.sh          # Quick: tsc --noEmit only
#   bash scripts/validate-build.sh --full   # Full: tsc build + lint check
#
# Exit codes:
#   0 = build passes (safe to edit / edit was clean)
#   1 = build fails (do NOT proceed with more edits; fix first)

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
MODE="${1:-quick}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

log_ok()   { echo -e "${GREEN}[BUILD-GATE] $1${NC}"; }
log_fail() { echo -e "${RED}[BUILD-GATE] $1${NC}"; }
log_warn() { echo -e "${YELLOW}[BUILD-GATE] $1${NC}"; }

cd "$PROJECT_DIR"

if [[ "$MODE" == "--full" ]]; then
  echo -e "${YELLOW}[BUILD-GATE] Running full build validation...${NC}"

  # Step 1: Full TypeScript compilation
  if npm run build 2>&1; then
    log_ok "TypeScript build passed"
  else
    log_fail "TypeScript build FAILED - fix errors before continuing"
    exit 1
  fi

  # Step 2: Lint check (if available)
  if command -v npx &>/dev/null && [[ -f ".eslintrc.json" || -f ".eslintrc.cjs" || -f ".eslintrc.js" || -f "eslint.config.js" || -f "eslint.config.mjs" ]]; then
    if npx eslint src/ --quiet 2>&1; then
      log_ok "Lint check passed"
    else
      log_warn "Lint warnings detected (non-blocking)"
    fi
  fi

  log_ok "Full build validation passed"
else
  echo -e "${YELLOW}[BUILD-GATE] Running quick type check...${NC}"

  # Quick mode: type-check only (no emit), faster than full build
  if npx tsc --noEmit 2>&1; then
    log_ok "Type check passed"
  else
    log_fail "Type check FAILED - fix errors before continuing"
    exit 1
  fi

  log_ok "Quick validation passed"
fi
