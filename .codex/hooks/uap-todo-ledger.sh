#!/usr/bin/env bash
# UAP Hands-free auto-seed — PostToolUse(TodoWrite)
# Mirror the model's plan (TodoWrite todo list) into the completion ledger so an
# interactive multi-step build auto-seeds a ledger with zero manual `init`.
# Silent, fail-open: never blocks or perturbs the session.
set -uo pipefail
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-${FACTORY_PROJECT_DIR:-${CURSOR_PROJECT_DIR:-.}}}"
INPUT="$(timeout 2 cat 2>/dev/null || true)"
if command -v uap >/dev/null 2>&1; then
  ( cd "$PROJECT_DIR" && printf '%s' "$INPUT" | uap handsfree sync-todos >/dev/null 2>&1 ) || true
fi
exit 0
