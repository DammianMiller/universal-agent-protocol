#!/usr/bin/env bash
set -euo pipefail

# Colors
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
HOOKS_DIR="${PROJECT_ROOT}/.git/hooks"

echo -e "${BLUE}🔧 Universal Agent Memory - Complete Setup${NC}"
echo "================================================"
echo ""

# ============================================================================
# DEPENDENCY CHECKS
# ============================================================================

echo -e "${BLUE}Checking dependencies...${NC}"
echo ""

MISSING_DEPS=()
RECOMMENDED_DEPS=()

# Required dependencies
echo -e "${YELLOW}Required dependencies:${NC}"

if ! command -v node &> /dev/null; then
    echo -e "  ${RED}✗${NC} Node.js (>= 18.0.0)"
    MISSING_DEPS+=("Node.js >= 18.0.0")
else
    NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
    if [ "$NODE_VERSION" -lt 18 ]; then
        echo -e "  ${RED}✗${NC} Node.js (>= 18.0.0, found $(node -v))"
        MISSING_DEPS+=("Node.js >= 18.0.0")
    else
        echo -e "  ${GREEN}✓${NC} Node.js $(node -v)"
    fi
fi

if ! command -v npm &> /dev/null; then
    echo -e "  ${RED}✗${NC} npm"
    MISSING_DEPS+=("npm")
else
    echo -e "  ${GREEN}✓${NC} npm $(npm -v)"
fi

if ! command -v git &> /dev/null; then
    echo -e "  ${RED}✗${NC} git"
    MISSING_DEPS+=("git")
else
    echo -e "  ${GREEN}✓${NC} git $(git --version | cut -d' ' -f3)"
fi

if ! command -v npx &> /dev/null; then
    echo -e "  ${RED}✗${NC} npx"
    MISSING_DEPS+=("npx")
else
    echo -e "  ${GREEN}✓${NC} npx"
fi

echo ""
echo -e "${YELLOW}Recommended dependencies (optional but useful):${NC}"

if command -v docker &> /dev/null; then
    echo -e "  ${GREEN}✓${NC} Docker (enables local Qdrant for semantic search)"
else
    echo -e "  ${YELLOW}⚠${NC} Docker (install for local Qdrant: `curl -fsSL https://get.docker.com | sh`)"
    RECOMMENDED_DEPS+=("Docker")
fi

if command -v python3 &> /dev/null; then
    PYTHON_VERSION=$(python3 --version | cut -d' ' -f2)
    echo -e "  ${GREEN}✓${NC} Python 3 (${PYTHON_VERSION}) (enables Pattern RAG)"
else
    echo -e "  ${YELLOW}⚠${NC} Python 3 (install for Pattern RAG: `brew install python` or `apt install python3`)"
    RECOMMENDED_DEPS+=("Python 3")
fi

if command -v pre-commit &> /dev/null; then
    echo -e "  ${GREEN}✓${NC} pre-commit (enables advanced git hooks)"
else
    echo -e "  ${YELLOW}⚠${NC} pre-commit (install for advanced hooks: `pip install pre-commit`)"
fi

echo ""

# ============================================================================
# INSTALLATION
# ============================================================================

if [ ${#MISSING_DEPS[@]} -gt 0 ]; then
    echo -e "${RED}❌ Missing required dependencies:${NC}"
    for dep in "${MISSING_DEPS[@]}"; do
        echo -e "  - ${dep}"
    done
    echo ""
    echo "Please install the missing dependencies and run this script again."
    echo ""
    echo "Quick install commands:"
    echo "  # macOS:"
    echo "  brew install node git python docker"
    echo ""
    echo "  # Ubuntu/Debian:"
    echo "  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -"
    echo "  sudo apt-get install -y nodejs python3 docker.io"
    echo ""
    echo "  # Windows (using winget):"
    echo "  winget install OpenJS.NodeJS.LTS"
    echo "  winget install Git.Git"
    echo "  winget install Python.Python.3.12"
    echo "  winget install Docker.DockerDesktop"
    echo ""
    exit 1
fi

# Install npm dependencies
echo -e "${BLUE}Installing npm dependencies...${NC}"
cd "$PROJECT_ROOT"

if [ ! -d "node_modules" ]; then
    npm install
    echo -e "${GREEN}✓${NC} npm dependencies installed"
else
    echo -e "${GREEN}✓${NC} npm dependencies already installed (skipping)"
fi

# Build TypeScript
echo ""
echo -e "${BLUE}Building TypeScript...${NC}"
npm run build
if [ $? -eq 0 ]; then
    echo -e "${GREEN}✓${NC} TypeScript build completed"
else
    echo -e "${RED}✗${NC} TypeScript build failed"
    exit 1
fi

# ============================================================================
# GIT HOOKS SETUP
# ============================================================================

echo ""
echo -e "${BLUE}Setting up git hooks...${NC}"

# Create hooks directory if it doesn't exist
if [ ! -d "$HOOKS_DIR" ]; then
    echo -e "  ${YELLOW}⚠${NC} Not a git repository, skipping hooks setup"
else
    # Create hooks directory
    mkdir -p "$HOOKS_DIR"
    
    # Pre-commit hook - enforces worktree usage and code quality
    cat > "${HOOKS_DIR}/pre-commit" << 'HOOKEOF'
#!/usr/bin/env bash
# UAP Pre-Commit Hook — Enforces worktree usage and code quality
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'; NC='\033[0m'
fail() { echo -e "${RED}[PRE-COMMIT] BLOCKED: $1${NC}"; exit 1; }
warn() { echo -e "${YELLOW}[PRE-COMMIT] WARNING: $1${NC}"; }
ok()   { echo -e "${GREEN}[PRE-COMMIT] $1${NC}"; }

PROJECT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"

# Gate 1: Worktree Enforcement — NO EXCEPTIONS
UAP_CONFIG="${PROJECT_ROOT}/.uap.json"
WORKTREE_ENABLED="true"
if [[ -f "$UAP_CONFIG" ]] && command -v python3 &>/dev/null; then
  WORKTREE_ENABLED=$(python3 -c "
import json
try:
    c = json.load(open('$UAP_CONFIG'))
    print('true' if c.get('template',{}).get('sections',{}).get('worktreeWorkflow', True) else 'false')
except: print('true')
" 2>/dev/null || echo "true")
fi

if [[ "$WORKTREE_ENABLED" == "true" ]]; then
  CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
  GIT_COMMON_DIR=$(git rev-parse --git-common-dir 2>/dev/null || echo "")
  GIT_DIR=$(git rev-parse --git-dir 2>/dev/null || echo "")
  IS_WORKTREE="false"
  if [[ "$GIT_DIR" != "$GIT_COMMON_DIR" ]]; then IS_WORKTREE="true"; fi

  if [[ "$IS_WORKTREE" == "false" && ("$CURRENT_BRANCH" == "main" || "$CURRENT_BRANCH" == "master") ]]; then
    fail "Direct commits to '$CURRENT_BRANCH' are prohibited. No exceptions.
  Use a worktree: uap worktree create <slug>
  Then work in: .worktrees/<id>-<slug>/
  Version bumps must be done on the feature branch before merging.
  See: policies/worktree-enforcement.md"
  fi
  ok "Worktree check passed"
fi

# Gate 2: No secrets in staged files
STAGED_FILES=$(git diff --cached --name-only --diff-filter=ACM 2>/dev/null || echo "")
for file in $STAGED_FILES; do
  case "$file" in
    .env|.env.*|*.pem|*.key|credentials.json|*secret*|*.p12)
      fail "Potential secret file staged: $file";;
  esac
done
ok "Secret scan passed"

# Gate 3: No debug code (warning only)
TS_STAGED=$(echo "$STAGED_FILES" | grep '\.ts$' || true)
if [[ -n "$TS_STAGED" ]]; then
  for file in $TS_STAGED; do
    if [[ -f "$file" ]]; then
      MATCHES=$(git diff --cached -U0 -- "$file" 2>/dev/null | grep '^+' | grep -n 'console\.log\|debugger;' | head -3 || true)
      if [[ -n "$MATCHES" ]]; then
        warn "Debug code in ${file}: ${MATCHES}"
      fi
    fi
  done
fi

ok "All pre-commit gates passed"
HOOKEOF
    chmod +x "${HOOKS_DIR}/pre-commit"
    echo "  ✓ Created pre-commit hook"

    # Commit-msg hook - validates commit messages
    cat > "${HOOKS_DIR}/commit-msg" << 'EOF'
#!/bin/bash
#
# UAP Commit-msg Hook
#
# Ensures commit messages follow conventional commits format:
# - feat: New feature
# - fix: Bug fix
# - docs: Documentation
# - style: Formatting
# - refactor: Code refactoring
# - test: Tests
# - chore: Maintenance
#

COMMIT_MSG_FILE=$1
COMMIT_MSG=$(cat "$COMMIT_MSG_FILE")

# Skip if commit is empty or merge commit
if [[ -z "$COMMIT_MSG" ]] || [[ "$COMMIT_MSG" == "Merge"* ]]; then
    exit 0
fi

# Check for conventional commit format
if echo "$COMMIT_MSG" | grep -qE "^(feat|fix|docs|style|refactor|test|chore|perf|ci|build|revert)(\([a-z-]+\))?: .+"; then
    echo "✓ Commit message format valid"
    exit 0
else
    echo "Warning: Commit message doesn't follow conventional commits format."
    echo "Recommended format: type(scope): description"
    echo "Types: feat, fix, docs, style, refactor, test, chore, perf, ci, build, revert"
    echo ""
    echo "Examples:"
    echo "  feat: Add worktree creation command"
    echo "  fix(api): Resolve memory database path issue"
    echo "  docs: Update README with setup instructions"
    echo ""
    echo "Continue with commit? [y/N] "
    read -r response
    if [[ "$response" =~ ^(yes|y|Y)$ ]]; then
        exit 0
    else
        echo "Commit aborted. Please edit your commit message."
        exit 1
    fi
fi
EOF
    chmod +x "${HOOKS_DIR}/commit-msg"
    echo "  ✓ Created commit-msg hook"

    # Pre-push hook - runs tests before pushing
    cat > "${HOOKS_DIR}/pre-push" << 'EOF'
#!/bin/bash
#
# UAP Pre-push Hook
#
# Runs tests before pushing to remote
#

echo "Running tests before push..."
if npm test 2>&1 | tail -5; then
    if [ ${PIPESTATUS[0]} -eq 0 ]; then
        echo "✓ All tests passed"
        exit 0
    fi
fi

echo "Error: Tests failed. Fix tests before pushing."
exit 1
EOF
    chmod +x "${HOOKS_DIR}/pre-push"
    echo "  ✓ Created pre-push hook"

    echo ""
    echo -e "${GREEN}✓${NC} Git hooks configured successfully"
fi

# ============================================================================
# OPTIONAL: CREATE .GITCHRCL (for GitHub CLI)
# ============================================================================

if command -v gh &> /dev/null; then
    echo ""
    echo -e "${BLUE}GitHub CLI detected. Setting up default PR template...${NC}"
    
    if [ ! -f "${PROJECT_ROOT}/.github/pull_request_template.md" ]; then
        mkdir -p "${PROJECT_ROOT}/.github"
        cat > "${PROJECT_ROOT}/.github/pull_request_template.md" << 'EOF'
<!-- UAP Worktree PR Template -->
## Summary
<!-- Describe what this PR does -->

## Changes
<!-- List key changes -->
- 

## Testing
<!-- How did you test this? -->
- [ ] Tests pass: `npm test`
- [ ] Linting passes: `npm run lint`
- [ ] Manually tested (if applicable)

## Related Issue
<!-- Link to related issue if any -->
Closes #

---
<!-- UAP - Created via worktree: uap worktree pr -->
EOF
        echo "  ✓ Created PR template"
    fi
fi

# ============================================================================
# SETUP COMPLETE
# ============================================================================

echo ""
echo -e "${GREEN}✅ Setup complete!${NC}"
echo ""

if [ ${#RECOMMENDED_DEPS[@]} -gt 0 ]; then
    echo -e "${YELLOW}Recommended: Install missing optional dependencies${NC}"
    for dep in "${RECOMMENDED_DEPS[@]}"; do
        echo "  - ${dep}"
    done
    echo ""
    echo "You can install these later. Core functionality will work without them."
    echo ""
fi

echo -e "${BLUE}Next steps:${NC}"
echo ""
echo "1. Initialize UAP in your project:"
echo "   npx universal-agent-protocol init"
echo ""
echo "2. Review the generated CLAUDE.md"
echo ""
echo "3. Start working - your AI assistant will follow the workflows!"
echo ""
echo "Optional: Set up cloud memory backends"
echo "   export GITHUB_TOKEN=your_token"
echo "   export QDRANT_API_KEY=your_key"
echo "   export QDRANT_URL=your_url"
echo ""
echo "Documentation: https://github.com/DammianMiller/universal-agent-protocol"