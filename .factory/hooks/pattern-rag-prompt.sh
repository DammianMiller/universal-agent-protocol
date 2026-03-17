#!/usr/bin/env bash
# UAP Pattern RAG Hook for Factory Droid (UserPromptSubmit)
# Equivalent of opencode's uap-pattern-rag.ts middleware.
# Queries Qdrant for task-relevant patterns and injects them as context.
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

INPUT=$(cat)
PROMPT=$(echo "$INPUT" | python3 -c "import json,sys; print(json.load(sys.stdin).get('prompt',''))" 2>/dev/null || true)

if [ ${#PROMPT} -lt 20 ]; then
  exit 0
fi

TRUNCATED=$(echo "$PROMPT" | head -c 500)

PATTERNS=$("$VENV_PYTHON" "$QUERY_SCRIPT" "$TRUNCATED" --top 2 --min-score 0.35 --format context 2>/dev/null || true)

if [ -n "$PATTERNS" ]; then
  python3 -c "
import json, sys
output = {
  'hookSpecificOutput': {
    'hookEventName': 'UserPromptSubmit',
    'additionalContext': sys.argv[1]
  }
}
print(json.dumps(output))
" "$PATTERNS"
fi

exit 0
