#!/usr/bin/env bash
# UAP Pattern RAG Session Start Hook for Factory Droid
# Equivalent of opencode's uap-pattern-rag.ts session.created event.
# Loads general project patterns at session start.
# Fails safely - never blocks the agent.
# Works for both Claude Code (Factory) and OpenCode environments.
set -euo pipefail

# Determine project directory (Factory uses FACTORY_PROJECT_DIR, OpenCode uses PWD)
PROJECT_DIR="${FACTORY_PROJECT_DIR:-$(pwd)}"
QUERY_SCRIPT="$PROJECT_DIR/agents/scripts/query_patterns.py"

# Find Python (prefer venv, fallback to system)
VENV_PYTHON="$PROJECT_DIR/agents/.venv/bin/python3"
if [ ! -f "$VENV_PYTHON" ]; then
    VENV_PYTHON=$(which python3 2>/dev/null || which python 2>/dev/null || echo "")
fi

if [ -z "$VENV_PYTHON" ] || [ ! -f "$QUERY_SCRIPT" ]; then
  exit 0
fi

PATTERNS=$("$VENV_PYTHON" "$QUERY_SCRIPT" "coding agent best practices security" --top 2 --format context 2>/dev/null || true)

if [ -n "$PATTERNS" ]; then
  python3 -c "
import json, sys
output = {
  'hookSpecificOutput': {
    'hookEventName': 'SessionStart',
    'additionalContext': sys.argv[1]
  }
}
print(json.dumps(output))
" "$PATTERNS"
fi

exit 0
