#!/usr/bin/env bash
# UAP Session Start Hook for Claude Code
# COMPLIANCE ENFORCEMENT: Outputs mandatory protocol checklist
# that the AI agent MUST complete before any work begins.
# Fails safely - never blocks the agent.
set -euo pipefail

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

# ============================================================
# COMPLIANCE ENFORCEMENT BLOCK
# This is injected as system context. The AI MUST follow these.
# ============================================================
output+="<system-reminder>"$'\n'
output+="## UAP COMPLIANCE - MANDATORY PROTOCOL"$'\n'
output+=""$'\n'
output+="You MUST complete these steps IN ORDER before doing ANY work."$'\n'
output+="Skipping ANY step is a critical protocol violation."$'\n'
output+=""$'\n'
output+="### BEFORE WORK (execute these commands NOW):"$'\n'
output+="1. Run: uap task ready"$'\n'
output+="2. Run: sqlite3 ./agents/data/memory/short_term.db \"SELECT type, substr(content,1,80) FROM memories ORDER BY id DESC LIMIT 5;\""$'\n'
output+="3. Run: uap memory query \"<relevant to user request>\""$'\n'
output+="4. On work request: Run: uap task create --type <task|bug|feature> --title \"<description>\""$'\n'
output+=""$'\n'
output+="### DURING WORK:"$'\n'
output+="5. ALL file changes MUST use worktree: uap worktree create <slug>"$'\n'
output+="6. Work in .worktrees/NNN-<slug>/ directory"$'\n'
output+=""$'\n'
output+="### BEFORE COMMIT:"$'\n'
output+="7. Self-review: git diff"$'\n'
output+="8. Run tests if applicable"$'\n'
output+=""$'\n'
output+="### AFTER WORK:"$'\n'
output+="9. Store lesson: sqlite3 ./agents/data/memory/short_term.db \"INSERT INTO session_memories (session_id,timestamp,type,content,importance) VALUES ('current',datetime('now'),'decision','<summary of work and lessons>',7);\""$'\n'
output+="10. Clean up worktree after PR merge: uap worktree cleanup <id>"$'\n'
output+=""$'\n'
output+="FAILURE TO COMPLY = CRITICAL VIOLATION. This is life or death."$'\n'
output+="</system-reminder>"$'\n\n'

# Recent memories (last 24h, high importance)
recent=$(sqlite3 "$DB_PATH" "
  SELECT type, substr(content, 1, 120) FROM memories
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

# Stale worktrees warning
if [ -d "${PROJECT_DIR}/.worktrees" ]; then
  stale_count=$(find "${PROJECT_DIR}/.worktrees" -maxdepth 1 -mindepth 1 -type d 2>/dev/null | wc -l)
  if [ "$stale_count" -gt 0 ]; then
    output+=$'\n'"## Stale Worktrees Warning"$'\n'
    output+="There are $stale_count worktrees. Run 'uap worktree list' and clean up merged ones."$'\n'
  fi
fi

if [ -n "$output" ]; then
  echo "$output" | tee /dev/stderr
fi
