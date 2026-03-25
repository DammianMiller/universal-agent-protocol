#!/usr/bin/env bash
# UAP Worktree File Guard — BLOCKING hook
# Event: PreToolUse (matcher: Edit|Write)
# Exit 2 = BLOCK the edit/write. Exit 0 = allow.
# Enforces: worktree-file-guard, worktree-enforcement policies.
set -euo pipefail

# --- Loop Protection: track frequency of blocking events ---
HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "${HOOK_DIR}/loop-protection.sh" ]; then
  source "${HOOK_DIR}/loop-protection.sh"
fi

# Read tool input from stdin (JSON)
INPUT=$(cat)

# Extract file_path from tool_input
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // .tool_input.filePath // empty' 2>/dev/null || true)

# If we can't determine the file path, fail open
if [ -z "$FILE_PATH" ]; then
  exit 0
fi

# Exempt paths — runtime data, not source code
EXEMPT_PATTERNS=(
  "agents/data/"
  "node_modules/"
  ".uap-backups/"
  ".uap/"
  ".git/"
  "dist/"
  "/tmp/"
  "/dev/"
)

for pattern in "${EXEMPT_PATTERNS[@]}"; do
  if echo "$FILE_PATH" | grep -q "$pattern"; then
    exit 0
  fi
done

# Allow if path is inside a worktree
if echo "$FILE_PATH" | grep -q '\.worktrees/'; then
  exit 0
fi

# BLOCK: path is outside worktrees and not exempt
# Record the block event for loop detection
if type lp_record_invocation &>/dev/null; then
  lp_record_invocation "pre-tool-edit-block"
fi
echo '{"decision":"block","reason":"WORKTREE POLICY VIOLATION: File path is outside .worktrees/. All edits must target files inside a worktree. Run: uap worktree create <slug> then edit files in .worktrees/NNN-<slug>/. See policies/worktree-file-guard.md"}' >&2
exit 2
