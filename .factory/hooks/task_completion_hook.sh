#!/usr/bin/env bash
# Task Completion Hook for Reinforcement Learning
# Records task outcome when worktree is cleaned up (indicating task completion)
# Works for both Claude Code (Factory) and OpenCode environments.
# Fails safely - never blocks cleanup.

set -euo pipefail

# Determine project directory
PROJECT_DIR="${FACTORY_PROJECT_DIR:-$(pwd)}"
RECORD_SCRIPT="$PROJECT_DIR/agents/scripts/record_task_outcome.py"

# Find Python
VENV_PYTHON="$PROJECT_DIR/agents/.venv/bin/python3"
if [ ! -f "$VENV_PYTHON" ]; then
    VENV_PYTHON=$(which python3 2>/dev/null || which python 2>/dev/null || echo "")
fi

if [ -z "$VENV_PYTHON" ] || [ ! -f "$RECORD_SCRIPT" ]; then
    # Silently exit - don't block cleanup
    exit 0
fi

# Extract task info from git log if available
TASK_TYPE="task"
SUMMARY="completed task"
SUCCESS="true"
ITERATIONS=1

# Try to get task info from recent commit
if git rev-parse --git-dir > /dev/null 2>&1; then
    LAST_MSG=$(git log -1 --pretty=%s 2>/dev/null || echo "")
    
    # Infer task type from commit message prefix
    case "$LAST_MSG" in
        feat:*|feature:*) TASK_TYPE="feature" ;;
        fix:*|bug:*) TASK_TYPE="bug" ;;
        refactor:*) TASK_TYPE="refactor" ;;
        infra:*|terraform:*|k8s:*) TASK_TYPE="infra" ;;
        docs:*|doc:*) TASK_TYPE="docs" ;;
        test:*) TASK_TYPE="test" ;;
    esac
    
    # Use commit message as summary (first line only)
    SUMMARY=$(echo "$LAST_MSG" | head -c 100)
fi

# Record the outcome (silently)
# Determine success/failure flag for record_task_outcome.py
if [ "$SUCCESS" = "true" ]; then
    OUTCOME_FLAG="--success"
else
    OUTCOME_FLAG="--failure"
fi

"$VENV_PYTHON" "$RECORD_SCRIPT" \
    --task-type "$TASK_TYPE" \
    --summary "$SUMMARY" \
    $OUTCOME_FLAG \
    --iterations "$ITERATIONS" \
    2>/dev/null || true

exit 0
