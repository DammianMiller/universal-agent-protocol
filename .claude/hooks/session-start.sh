#!/usr/bin/env bash
# UAM Session Start Hook for Claude Code
# 1. Cleans stale agents (heartbeat >24h old)
# 2. Injects open loops and recent daily context
# 3. READS AND OBEYS 100% CLAUDE.md - ensures adherence to architecture, security, and operational guidelines
# Fails safely - never blocks the agent.
set -euo pipefail

# Load CLAUDE.md for context on architectural constraints and patterns
CLAUDE_MD="${PROJECT_DIR}/CLAUDE.md"
if [ -f "$CLAUDE_MD" ]; then
  # Extract key constraints from CLAUDE.md for session context
  CLAUDE_CONSTRAINTS=$(grep -E '(# Core Rules|# Cluster Decision Tree|# Pre-Task Checklist|# Code Quality Standards)' "$CLAUDE_MD" 2>/dev/null || echo "")
fi

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-.}"
DB_PATH="${PROJECT_DIR}/agents/data/memory/short_term.db"
COORD_DB="${PROJECT_DIR}/agents/data/coordination/coordination.db"

if [ ! -f "$DB_PATH" ]; then
  exit 0
fi

# Clean stale agents from coordination DB (heartbeat >24h old)
if [ -f "$COORD_DB" ]; then
  sqlite3 "$COORD_DB" "
    DELETE FROM work_claims WHERE agent_id IN (
      SELECT id FROM agent_registry
      WHERE status IN ('active','idle') AND last_heartbeat < datetime('now','-24 hours')
    );
    DELETE FROM work_announcements WHERE agent_id IN (
      SELECT id FROM agent_registry
      WHERE status IN ('active','idle') AND last_heartbeat < datetime('now','-24 hours')
    ) AND completed_at IS NULL;
    UPDATE agent_registry SET status='failed'
      WHERE status IN ('active','idle') AND last_heartbeat < datetime('now','-24 hours');
    DELETE FROM agent_registry
      WHERE status IN ('completed','failed') AND started_at < datetime('now','-7 days');
    DELETE FROM agent_messages WHERE created_at < datetime('now','-24 hours');
  " 2>/dev/null || true
fi

output=""

# Recent memories (last 24h, high importance)
recent=$(sqlite3 "$DB_PATH" "
  SELECT type, content FROM memories
  WHERE timestamp >= datetime('now', '-1 day')
  ORDER BY id DESC
  LIMIT 10;
" 2>/dev/null || true)

if [ -n "$recent" ]; then
  output+="## Recent Memory Context"$'\n'
  output+="$recent"$'\n\n'
fi

# Open loops from session memories
open_loops=$(sqlite3 "$DB_PATH" "
  SELECT content FROM session_memories
  WHERE type IN ('action','goal','decision')
    AND importance >= 7
  ORDER BY id DESC
  LIMIT 5;
" 2>/dev/null || true)

if [ -n "$open_loops" ]; then
  output+="## Open Loops"$'\n'
  output+="$open_loops"$'\n'
fi

# Add CLAUDE.md adherence reminder if constraints were loaded
if [ -n "${CLAUDE_CONSTRAINTS:-}" ]; then
  output+="## CLAUDE.md Adherence Constraints"$'\n'
  output+="$CLAUDE_CONSTRAINTS"$'\n\n'
fi

if [ -n "$output" ]; then
  echo "$output"
fi
