#!/usr/bin/env bash
# UAP Session Start Hook for ForgeCode (ZSH-native terminal agent)
COORD_DB="${PROJECT_DIR}/agents/data/coordination/coordination.db"
DB_PATH="${PROJECT_DIR}/agents/data/memory/short_term.db"

if [ ! -f "$DB_PATH" ]; then
  exit 0
fi

# Auto-create coordination DB if missing (self-healing)
if [ ! -f "$COORD_DB" ]; then
  mkdir -p "$(dirname "$COORD_DB")"
  sqlite3 "$COORD_DB" "
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 10000;

    CREATE TABLE IF NOT EXISTS agent_registry (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, session_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('active','idle','completed','failed')),
      current_task TEXT, worktree_branch TEXT, started_at TEXT NOT NULL,
      last_heartbeat TEXT NOT NULL, capabilities TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_agent_registry_session ON agent_registry(session_id);
    CREATE INDEX IF NOT EXISTS idx_agent_registry_status ON agent_registry(status);

    CREATE TABLE IF NOT EXISTS agent_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, channel TEXT NOT NULL,
      from_agent TEXT, to_agent TEXT,
      type TEXT NOT NULL CHECK(type IN ('request','response','notification','claim','release')),
      payload TEXT NOT NULL, priority INTEGER DEFAULT 5,
      created_at TEXT NOT NULL, read_at TEXT, expires_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_messages_channel ON agent_messages(channel);
    CREATE INDEX IF NOT EXISTS idx_messages_to_agent ON agent_messages(to_agent);
    CREATE INDEX IF NOT EXISTS idx_messages_created ON agent_messages(created_at);

    CREATE TABLE IF NOT EXISTS work_announcements (
      id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL,
      agent_name TEXT, worktree_branch TEXT,
      intent_type TEXT NOT NULL CHECK(intent_type IN ('editing','reviewing','refactoring','testing','documenting')),
      resource TEXT NOT NULL, description TEXT, files_affected TEXT,
      estimated_completion TEXT, announced_at TEXT NOT NULL, completed_at TEXT,
      FOREIGN KEY (agent_id) REFERENCES agent_registry(id)
    );
    CREATE INDEX IF NOT EXISTS idx_announcements_agent ON work_announcements(agent_id);
    CREATE INDEX IF NOT EXISTS idx_announcements_resource ON work_announcements(resource);
    CREATE INDEX IF NOT EXISTS idx_announcements_active ON work_announcements(completed_at) WHERE completed_at IS NULL;

    CREATE TABLE IF NOT EXISTS work_claims (
      id INTEGER PRIMARY KEY AUTOINCREMENT, resource TEXT NOT NULL,
      agent_id TEXT NOT NULL, claim_type TEXT NOT NULL CHECK(claim_type IN ('exclusive','shared')),
      claimed_at TEXT NOT NULL, expires_at TEXT,
      FOREIGN KEY (agent_id) REFERENCES agent_registry(id)
    );
    CREATE INDEX IF NOT EXISTS idx_claims_agent ON work_claims(agent_id);
    CREATE INDEX IF NOT EXISTS idx_claims_resource ON work_claims(resource);

    CREATE TABLE IF NOT EXISTS deploy_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL,
      action_type TEXT NOT NULL CHECK(action_type IN ('commit','push','merge','deploy','workflow')),
      target TEXT NOT NULL, payload TEXT,
      status TEXT NOT NULL CHECK(status IN ('pending','batched','executing','completed','failed')),
      batch_id TEXT, queued_at TEXT NOT NULL, execute_after TEXT,
      priority INTEGER DEFAULT 5, dependencies TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_deploy_status ON deploy_queue(status);
    CREATE INDEX IF NOT EXISTS idx_deploy_batch ON deploy_queue(batch_id);
    CREATE INDEX IF NOT EXISTS idx_deploy_target ON deploy_queue(target);

    CREATE TABLE IF NOT EXISTS deploy_batches (
      id TEXT PRIMARY KEY, created_at TEXT NOT NULL, executed_at TEXT,
      status TEXT NOT NULL CHECK(status IN ('pending','executing','completed','failed')),
      result TEXT
    );
  " 2>/dev/null || true
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
  echo "$output"
fi
