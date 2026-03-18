#!/usr/bin/env bash
# UAP Test Count Verification Gate
# Verifies that new test cases exist in the current diff.
#
# Usage:
#   bash scripts/verify-test-count.sh              # Check staged + unstaged changes
#   bash scripts/verify-test-count.sh --staged      # Check only staged changes
#   bash scripts/verify-test-count.sh --branch      # Check all commits on current branch vs main/master
#
# Exit codes:
#   0 = At least 2 new test cases found
#   1 = Insufficient new test cases (blocks completion)

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

fail() { echo -e "${RED}[TEST-GATE] BLOCKED: $1${NC}"; exit 1; }
warn() { echo -e "${YELLOW}[TEST-GATE] $1${NC}"; }
ok()   { echo -e "${GREEN}[TEST-GATE] $1${NC}"; }

MODE="${1:-all}"
MIN_TESTS=2

# Determine the diff to analyze
case "$MODE" in
  --staged)
    DIFF=$(git diff --cached --unified=0 -- 'test/**/*.test.ts' 'test/**/*.test.js' 'test/**/*.spec.ts' 'test/**/*.spec.js' 2>/dev/null || echo "")
    DIFF_DESC="staged changes"
    ;;
  --branch)
    # Find the base branch
    BASE_BRANCH=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@' || echo "master")
    MERGE_BASE=$(git merge-base "$BASE_BRANCH" HEAD 2>/dev/null || echo "HEAD~10")
    DIFF=$(git diff "$MERGE_BASE"..HEAD --unified=0 -- 'test/**/*.test.ts' 'test/**/*.test.js' 'test/**/*.spec.ts' 'test/**/*.spec.js' 2>/dev/null || echo "")
    DIFF_DESC="branch changes (vs $BASE_BRANCH)"
    ;;
  *)
    # All changes: staged + unstaged + untracked test files
    DIFF=$(git diff HEAD --unified=0 -- 'test/**/*.test.ts' 'test/**/*.test.js' 'test/**/*.spec.ts' 'test/**/*.spec.js' 2>/dev/null || echo "")
    # Also check untracked test files
    UNTRACKED=$(git ls-files --others --exclude-standard -- 'test/**/*.test.ts' 'test/**/*.test.js' 'test/**/*.spec.ts' 'test/**/*.spec.js' 2>/dev/null || echo "")
    if [[ -n "$UNTRACKED" ]]; then
      for file in $UNTRACKED; do
        if [[ -f "$file" ]]; then
          FILE_CONTENT=$(cat "$file")
          DIFF="${DIFF}
${FILE_CONTENT}"
        fi
      done
    fi
    DIFF_DESC="all changes (staged + unstaged + untracked)"
    ;;
esac

echo -e "${YELLOW}[TEST-GATE] Checking for new test cases in ${DIFF_DESC}...${NC}"

if [[ -z "$DIFF" ]]; then
  # Check if any source code was changed
  SRC_CHANGES=$(git diff HEAD --name-only -- 'src/**/*.ts' 2>/dev/null | wc -l || echo "0")
  SRC_STAGED=$(git diff --cached --name-only -- 'src/**/*.ts' 2>/dev/null | wc -l || echo "0")
  TOTAL_SRC=$((SRC_CHANGES + SRC_STAGED))

  if [[ "$TOTAL_SRC" -eq 0 ]]; then
    ok "No source code changes detected — test gate not applicable"
    exit 0
  else
    fail "Source code was changed ($TOTAL_SRC files) but no test files were modified.
  Every code change MUST include at least $MIN_TESTS new test cases.
  Add tests in test/<feature>.test.ts using vitest (describe/it/expect).
  See: policies/completion-gate.md"
  fi
fi

# Count new test cases: lines starting with + that contain it( or test(
# These patterns match vitest/jest test declarations
NEW_IT_CALLS=$(echo "$DIFF" | grep -c "^\+.*\b\(it\|test\)\s*(" 2>/dev/null || echo "0")

# Also count new describe blocks as supporting evidence
NEW_DESCRIBE_CALLS=$(echo "$DIFF" | grep -c "^\+.*\bdescribe\s*(" 2>/dev/null || echo "0")

# Count new expect assertions
NEW_EXPECTS=$(echo "$DIFF" | grep -c "^\+.*\bexpect\s*(" 2>/dev/null || echo "0")

echo "  New it()/test() calls:  $NEW_IT_CALLS"
echo "  New describe() blocks:  $NEW_DESCRIBE_CALLS"
echo "  New expect() assertions: $NEW_EXPECTS"

if [[ "$NEW_IT_CALLS" -ge "$MIN_TESTS" ]]; then
  ok "Found $NEW_IT_CALLS new test cases (minimum: $MIN_TESTS)"
  exit 0
fi

# If we have fewer it() calls but have meaningful expects, give a detailed message
if [[ "$NEW_IT_CALLS" -gt 0 ]]; then
  fail "Found only $NEW_IT_CALLS new test case(s), but minimum is $MIN_TESTS.
  Add at least $((MIN_TESTS - NEW_IT_CALLS)) more test case(s).
  Tests must use it() or test() with expect() assertions.
  See: policies/completion-gate.md"
fi

fail "No new test cases found in the diff.
  Every code change MUST include at least $MIN_TESTS new test cases.
  Add tests in test/<feature>.test.ts using vitest (describe/it/expect).
  See: policies/completion-gate.md"
