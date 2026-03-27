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

CONTEXT_LEVEL="${UAP_CONTEXT_LEVEL:-}"
if [ -z "$CONTEXT_LEVEL" ] && [ -f "${PROJECT_DIR}/.factory/config.json" ]; then
  CONTEXT_LEVEL=$(python3 - <<PY 2>/dev/null || true
import json
path = "${PROJECT_DIR}/.factory/config.json"
try:
    data = json.load(open(path, "r", encoding="utf-8"))
    for key in ("contextLevel", "context_level"):
        if key in data and isinstance(data[key], str):
            print(data[key])
            raise SystemExit
    hooks = data.get("hooks") or {}
    for key in ("contextLevel", "context_level"):
        if key in hooks and isinstance(hooks[key], str):
            print(hooks[key])
            raise SystemExit
except Exception:
    pass
PY
  )
fi
CONTEXT_LEVEL="${CONTEXT_LEVEL:-normal}"

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

TRUNCATE_LEN=250
TOP_K=2
if [ "$CONTEXT_LEVEL" = "quiet" ]; then
  TRUNCATE_LEN=150
  TOP_K=1
elif [ "$CONTEXT_LEVEL" = "verbose" ]; then
  TRUNCATE_LEN=500
  TOP_K=2
fi

TRUNCATED=$(echo "$PROMPT" | head -c "$TRUNCATE_LEN")

PATTERNS=$("$VENV_PYTHON" "$QUERY_SCRIPT" "$TRUNCATED" --top "$TOP_K" --min-score 0.35 --format context 2>/dev/null || true)

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
