#!/usr/bin/env bash
# UAP Git Hooks Installer
# Installs pre-commit and pre-push hooks that enforce UAP policies.
#
# Usage: bash scripts/hooks/install-hooks.sh
#
# Hooks installed:
#   pre-commit  — Worktree enforcement, secret scan, debug code check
#   pre-push    — Build, test, type-check, lint gates

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
HOOKS_DIR="${PROJECT_ROOT}/.git/hooks"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

echo -e "${YELLOW}=== UAP Git Hooks Installer ===${NC}"
echo ""

if [[ ! -d "$HOOKS_DIR" ]]; then
  echo -e "${RED}Error: .git/hooks directory not found. Are you in a git repo?${NC}"
  exit 1
fi

install_hook() {
  local hook_name="$1"
  local source="${SCRIPT_DIR}/${hook_name}"
  local target="${HOOKS_DIR}/${hook_name}"

  if [[ ! -f "$source" ]]; then
    echo -e "${RED}  Source not found: ${source}${NC}"
    return 1
  fi

  # Backup existing hook if it's not a sample
  if [[ -f "$target" && ! "$target" == *.sample ]]; then
    cp "$target" "${target}.backup.$(date +%s)"
    echo -e "${YELLOW}  Backed up existing ${hook_name} hook${NC}"
  fi

  cp "$source" "$target"
  chmod +x "$target"
  echo -e "${GREEN}  Installed: ${hook_name}${NC}"
}

install_hook "pre-commit"
install_hook "pre-push"

echo ""
echo -e "${GREEN}All hooks installed successfully.${NC}"
echo ""
echo "Hooks enforce:"
echo "  pre-commit: worktree usage, no secrets, no debug code"
echo "  pre-push:   build, tests, type-check, lint"
echo ""
echo -e "${YELLOW}To bypass in emergencies: git commit --no-verify${NC}"
echo -e "${YELLOW}To uninstall: rm .git/hooks/pre-commit .git/hooks/pre-push${NC}"
