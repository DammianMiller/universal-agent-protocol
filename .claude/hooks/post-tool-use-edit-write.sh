#!/usr/bin/env bash
# UAP Build Gate Reminder — INFORMATIONAL hook
# Event: PostToolUse (matcher: Edit|Write)
# Reminds about pre-edit build gate after .ts file modifications.
# Enforces: pre-edit-build-gate policy.
# Always exits 0 (never blocks).
set -euo pipefail

# Read tool input from stdin (JSON)
INPUT=$(cat)

# Extract file_path from tool_input
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // .tool_input.filePath // empty' 2>/dev/null || true)

# If we can't determine the file path, exit silently
if [ -z "$FILE_PATH" ]; then
  exit 0
fi

# Only remind for TypeScript files
if echo "$FILE_PATH" | grep -qE '\.tsx?$'; then
  echo "[BUILD GATE] TypeScript file modified: $(basename "$FILE_PATH"). Run 'npm run build' before editing the next file. See policies/pre-edit-build-gate.md"
fi

# Remind about file backup policy for any file edit
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-.}"
BACKUP_DIR="${PROJECT_DIR}/.uap-backups/$(date +%Y-%m-%d)"
RELATIVE_PATH="${FILE_PATH#"$PROJECT_DIR"/}"

# Check if backup exists for this file
if [ ! -f "${BACKUP_DIR}/${RELATIVE_PATH}" ] 2>/dev/null; then
  # Only warn for source files, not generated or runtime files
  if ! echo "$FILE_PATH" | grep -qE '(node_modules|dist|\.uap-backups|agents/data|\.git)/'; then
    echo "[BACKUP REMINDER] No backup found for $(basename "$FILE_PATH"). Policy requires: mkdir -p $(dirname "${BACKUP_DIR}/${RELATIVE_PATH}") && cp \"$FILE_PATH\" \"${BACKUP_DIR}/${RELATIVE_PATH}\""
  fi
fi

exit 0
