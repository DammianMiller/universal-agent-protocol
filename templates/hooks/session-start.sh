#!/usr/bin/env bash
# UAP Session Start Hook (universal - all coding harnesses)
# COMPLIANCE ENFORCEMENT: Outputs mandatory protocol checklist
# that the AI agent MUST complete before any work begins.
# Fails safely - never blocks the agent.
set -euo pipefail

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-${FACTORY_PROJECT_DIR:-${CURSOR_PROJECT_DIR:-.}}}"
DB_PATH="${PROJECT_DIR}/agents/data/memory/short_term.db"
COORD_DB="${PROJECT_DIR}/agents/data/coordination/coordination.db"

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

# ============================================================
# MANDATORY: Auto-register this agent + start heartbeat
# ============================================================
AGENT_ID="claude-${SESSION_ID:-$(head -c 6 /dev/urandom | od -An -tx1 | tr -d ' \n')}"
AGENT_NAME="claude-code"

if [ -f "$COORD_DB" ]; then
  # Register this agent
  sqlite3 "$COORD_DB" "
    INSERT OR REPLACE INTO agent_registry (id, name, session_id, status, capabilities, started_at, last_heartbeat)
    VALUES ('${AGENT_ID}', '${AGENT_NAME}', '${AGENT_ID}', 'active', '[]', datetime('now'), datetime('now'));
  " 2>/dev/null || true

  # Check for other active agents and their work
  OTHER_AGENTS=$(sqlite3 "$COORD_DB" "
    SELECT id || ': ' || COALESCE(current_task, 'idle')
    FROM agent_registry
    WHERE status='active' AND id != '${AGENT_ID}'
    ORDER BY last_heartbeat DESC LIMIT 5;
  " 2>/dev/null || true)

  ACTIVE_WORK=$(sqlite3 "$COORD_DB" "
    SELECT agent_id || ' -> ' || resource
    FROM work_announcements
    WHERE completed_at IS NULL
    ORDER BY announced_at DESC LIMIT 5;
  " 2>/dev/null || true)
fi

# Export agent ID for downstream tools
export UAP_AGENT_ID="${AGENT_ID}"

# Start background heartbeat (every 30s, auto-stops when shell exits)
if [ -f "$COORD_DB" ]; then
  (
    while true; do
      sleep 30
      sqlite3 "$COORD_DB" "UPDATE agent_registry SET last_heartbeat=datetime('now') WHERE id='${AGENT_ID}';" 2>/dev/null || break
    done
  ) &
  HEARTBEAT_PID=$!
  # Ensure heartbeat stops, announcements close, and agent deregisters on exit
  trap "kill $HEARTBEAT_PID 2>/dev/null; sqlite3 \"$COORD_DB\" \"UPDATE work_announcements SET completed_at=datetime('now') WHERE agent_id='${AGENT_ID}' AND completed_at IS NULL; UPDATE agent_registry SET status='completed' WHERE id='${AGENT_ID}';\" 2>/dev/null" EXIT
fi

output=""

# ============================================================
# UAP SESSION BANNER - Rich Operational Data
# ============================================================
SESSION_ID=$(head -c 6 /dev/urandom | od -An -tx1 | tr -d ' \n' | head -c 6)
TASK_DB="${PROJECT_DIR}/.uap/tasks/tasks.db"
PKG_VERSION=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('${PROJECT_DIR}/package.json','utf8')).version)}catch{console.log('?')}" 2>/dev/null || echo "?")

# Gather task stats
TASK_TOTAL=0; TASK_OPEN=0; TASK_PROGRESS=0; TASK_BLOCKED=0; TASK_DONE=0
if [ -f "$TASK_DB" ]; then
  TASK_TOTAL=$(sqlite3 "$TASK_DB" "SELECT COUNT(*) FROM tasks;" 2>/dev/null || echo 0)
  TASK_OPEN=$(sqlite3 "$TASK_DB" "SELECT COUNT(*) FROM tasks WHERE status='open';" 2>/dev/null || echo 0)
  TASK_PROGRESS=$(sqlite3 "$TASK_DB" "SELECT COUNT(*) FROM tasks WHERE status='in_progress';" 2>/dev/null || echo 0)
  TASK_BLOCKED=$(sqlite3 "$TASK_DB" "SELECT COUNT(*) FROM tasks WHERE status='blocked';" 2>/dev/null || echo 0)
  TASK_DONE=$(sqlite3 "$TASK_DB" "SELECT COUNT(*) FROM tasks WHERE status='done' OR status='wont_do';" 2>/dev/null || echo 0)
fi

# Gather memory stats
MEM_ENTRIES=0; MEM_SIZE="0 KB"
if [ -f "$DB_PATH" ]; then
  MEM_ENTRIES=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM memories;" 2>/dev/null || echo 0)
  MEM_SIZE=$(du -h "$DB_PATH" 2>/dev/null | cut -f1 || echo "?")
fi

# Gather agent stats
AGENT_COUNT=0
if [ -f "$COORD_DB" ]; then
  AGENT_COUNT=$(sqlite3 "$COORD_DB" "SELECT COUNT(*) FROM agent_registry WHERE status='active';" 2>/dev/null || echo 0)
fi

# Qdrant status
QDRANT_STATUS="OFF"
if docker ps --filter name=qdrant --format "{{.Status}}" 2>/dev/null | grep -q "Up"; then
  QDRANT_STATUS="ON"
fi

# Git branch
GIT_BRANCH=$(git -C "$PROJECT_DIR" branch --show-current 2>/dev/null || echo "?")
GIT_DIRTY=$(git -C "$PROJECT_DIR" status --porcelain 2>/dev/null | wc -l | tr -d ' ')

# Worktree count
WORKTREE_COUNT=0
if [ -d "${PROJECT_DIR}/.worktrees" ]; then
  WORKTREE_COUNT=$(find "${PROJECT_DIR}/.worktrees" -maxdepth 1 -mindepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')
fi

# Pattern count
PATTERN_COUNT=0
if [ -f "${PROJECT_DIR}/.factory/patterns/index.json" ]; then
  PATTERN_COUNT=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('${PROJECT_DIR}/.factory/patterns/index.json','utf8')).patterns?.length||0)}catch{console.log(0)}" 2>/dev/null || echo 0)
fi

# Skill count
SKILL_COUNT=$(find "${PROJECT_DIR}/.claude/skills" "${PROJECT_DIR}/.factory/skills" -name "SKILL.md" 2>/dev/null | wc -l | tr -d ' ')

# Droid count
DROID_COUNT=$(find "${PROJECT_DIR}/.factory/droids" -name "*.md" -not -name "test-droid-*" 2>/dev/null | wc -l | tr -d ' ')

# Build task progress bar (20 chars wide)
if [ "$TASK_TOTAL" -gt 0 ]; then
  TASK_PCT=$((TASK_DONE * 100 / TASK_TOTAL))
  FILLED=$((TASK_DONE * 20 / TASK_TOTAL))
  EMPTY=$((20 - FILLED))
  TASK_BAR=$(printf '%0.s█' $(seq 1 $FILLED 2>/dev/null) 2>/dev/null)$(printf '%0.s░' $(seq 1 $EMPTY 2>/dev/null) 2>/dev/null)
else
  TASK_PCT=0
  TASK_BAR="░░░░░░░░░░░░░░░░░░░░"
fi

# Render banner
W=62
output+="╭$(printf '─%.0s' $(seq 1 $W))╮"$'\n'
output+="│ UAP  Universal Agent Protocol  v${PKG_VERSION}$(printf ' %.0s' $(seq 1 $((W - 40 - ${#PKG_VERSION}))))│"$'\n'
output+="│ Session: ${SESSION_ID}  $(date '+%Y-%m-%d %H:%M:%S')  Branch: ${GIT_BRANCH}$(printf ' %.0s' $(seq 1 $((W - 42 - ${#GIT_BRANCH}))))│"$'\n'
output+="├$(printf '─%.0s' $(seq 1 $W))┤"$'\n'

# Task status line
if [ "$TASK_TOTAL" -gt 0 ]; then
  output+="│ Tasks: ${TASK_BAR} ${TASK_PCT}% (${TASK_DONE}/${TASK_TOTAL})$(printf ' %.0s' $(seq 1 $((W - 38 - ${#TASK_PCT} - ${#TASK_DONE} - ${#TASK_TOTAL}))))│"$'\n'
  TASK_DETAIL="${TASK_OPEN} open  ${TASK_PROGRESS} active  ${TASK_BLOCKED} blocked  ${TASK_DONE} done"
  output+="│   ${TASK_DETAIL}$(printf ' %.0s' $(seq 1 $((W - 3 - ${#TASK_DETAIL}))))│"$'\n'
else
  output+="│ Tasks: No tasks tracked yet$(printf ' %.0s' $(seq 1 $((W - 28))))│"$'\n'
fi

# Memory & infrastructure line
MEM_LINE="Memory: ${MEM_ENTRIES} entries (${MEM_SIZE})  Qdrant: ${QDRANT_STATUS}"
output+="│ ${MEM_LINE}$(printf ' %.0s' $(seq 1 $((W - 1 - ${#MEM_LINE}))))│"$'\n'

# Agents, patterns, skills line
INFRA_LINE="Agents: ${AGENT_COUNT}  Patterns: ${PATTERN_COUNT}  Skills: ${SKILL_COUNT}  Droids: ${DROID_COUNT}"
output+="│ ${INFRA_LINE}$(printf ' %.0s' $(seq 1 $((W - 1 - ${#INFRA_LINE}))))│"$'\n'

# Git & worktree line
GIT_LINE="Git: ${GIT_DIRTY} uncommitted  Worktrees: ${WORKTREE_COUNT}"
output+="│ ${GIT_LINE}$(printf ' %.0s' $(seq 1 $((W - 1 - ${#GIT_LINE}))))│"$'\n'

output+="├$(printf '─%.0s' $(seq 1 $W))┤"$'\n'

# Active policies (read from DB if available)
POLICY_DB="${PROJECT_DIR}/agents/data/memory/policies.db"
POLICY_LINE="Policies: [ON] IaC Parity  [ON] File Backup"
if [ -f "$POLICY_DB" ]; then
  ACTIVE_POLICIES=$(sqlite3 "$POLICY_DB" "SELECT COUNT(*) FROM policies WHERE isActive=1;" 2>/dev/null || echo 0)
  REQUIRED_POLICIES=$(sqlite3 "$POLICY_DB" "SELECT COUNT(*) FROM policies WHERE isActive=1 AND level='REQUIRED';" 2>/dev/null || echo 0)
  POLICY_LINE="Policies: ${ACTIVE_POLICIES} active (${REQUIRED_POLICIES} REQUIRED)"
fi
output+="│ ${POLICY_LINE}$(printf ' %.0s' $(seq 1 $((W - 1 - ${#POLICY_LINE}))))│"$'\n'

# Deploy queue status
DEPLOY_PENDING=0
if [ -f "$COORD_DB" ]; then
  DEPLOY_PENDING=$(sqlite3 "$COORD_DB" "SELECT COUNT(*) FROM deploy_queue WHERE status='pending';" 2>/dev/null || echo 0)
fi
if [ "$DEPLOY_PENDING" -gt 0 ] 2>/dev/null; then
  DEPLOY_LINE="Deploy: ${DEPLOY_PENDING} pending actions (run 'uap deploy flush')"
  output+="│ ${DEPLOY_LINE}$(printf ' %.0s' $(seq 1 $((W - 1 - ${#DEPLOY_LINE}))))│"$'\n'
fi

# Memory layers
L3_STATUS="?"
[ "$QDRANT_STATUS" = "ON" ] && L3_STATUS="ON"
output+="│ Layers:  L1:ON  L2:ON  L3:${L3_STATUS}  L4:ON$(printf ' %.0s' $(seq 1 $((W - 37 - ${#L3_STATUS}))))│"$'\n'

output+="╰$(printf '─%.0s' $(seq 1 $W))╯"$'\n'
output+=""$'\n'

# ============================================================
# WORKTREE ENFORCEMENT GATE — HARD BLOCK
# Detects if session is on main/master outside a worktree.
# Emits a blocking system-reminder that overrides all other work.
# ============================================================
IS_IN_WORKTREE="false"
CURRENT_BRANCH=$(git -C "$PROJECT_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
GIT_DIR_VAL=$(git -C "$PROJECT_DIR" rev-parse --git-dir 2>/dev/null || echo "")
GIT_COMMON_DIR_VAL=$(git -C "$PROJECT_DIR" rev-parse --git-common-dir 2>/dev/null || echo "")
if [[ "$GIT_DIR_VAL" != "$GIT_COMMON_DIR_VAL" ]]; then
  IS_IN_WORKTREE="true"
fi
# Also check if CWD is inside .worktrees/
if echo "$PROJECT_DIR" | grep -q '\.worktrees/' 2>/dev/null; then
  IS_IN_WORKTREE="true"
fi

if [[ "$IS_IN_WORKTREE" == "false" && ("$CURRENT_BRANCH" == "main" || "$CURRENT_BRANCH" == "master") ]]; then
  # List active worktrees for the agent to resume
  ACTIVE_WORKTREES=""
  if [ -d "${PROJECT_DIR}/.worktrees" ]; then
    ACTIVE_WORKTREES=$(find "${PROJECT_DIR}/.worktrees" -maxdepth 1 -mindepth 1 -type d -printf '%f\n' 2>/dev/null || ls "${PROJECT_DIR}/.worktrees" 2>/dev/null || true)
  fi

  output+="<system-reminder>"$'\n'
  output+="## CRITICAL WORKTREE VIOLATION DETECTED"$'\n'
  output+=""$'\n'
  output+="You are on branch '${CURRENT_BRANCH}' in the project root."$'\n'
  output+="ALL file changes are PROHIBITED until you create and enter a worktree."$'\n'
  output+=""$'\n'
  output+="### MANDATORY FIRST ACTION (before ANY file edits):"$'\n'
  output+="1. Run: uap worktree create <slug>"$'\n'
  output+="2. All subsequent file edits MUST target .worktrees/NNN-<slug>/"$'\n'
  output+="3. Do NOT edit any file in the project root directory."$'\n'
  output+="4. Version bumps MUST be done on the feature branch, not master."$'\n'
  output+=""$'\n'

  if [ -n "$ACTIVE_WORKTREES" ]; then
    output+="### Active worktrees (you may resume one):"$'\n'
    output+="$ACTIVE_WORKTREES"$'\n'
    output+="To resume: cd .worktrees/<name>"$'\n'
    output+=""$'\n'
  fi

  output+="This directive overrides ALL other instructions. No exceptions."$'\n'
  output+="</system-reminder>"$'\n\n'
fi

# ============================================================
# COORDINATION SELF-TEST — Verify announce/overlap pipeline
# ============================================================
if [ -f "$COORD_DB" ]; then
  # Verify announce works by inserting a session-scope announcement
  sqlite3 "$COORD_DB" "
    INSERT INTO work_announcements (agent_id, agent_name, worktree_branch, intent_type, resource, description, announced_at)
    VALUES ('${AGENT_ID}', '${AGENT_NAME}', '$(git -C "$PROJECT_DIR" branch --show-current 2>/dev/null || echo "unknown")',
            'editing', 'session-scope', 'Session ${AGENT_ID} active', datetime('now'));
  " 2>/dev/null || true

  # Detect overlapping work from other agents
  OVERLAPS=$(sqlite3 "$COORD_DB" "
    SELECT a.agent_id || ' on ' || a.resource || ' (' || a.intent_type || ')'
    FROM work_announcements a
    WHERE a.completed_at IS NULL
      AND a.agent_id != '${AGENT_ID}'
    ORDER BY a.announced_at DESC LIMIT 5;
  " 2>/dev/null || true)
fi

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
output+="### BEFORE FIRST EDIT (MANDATORY):"$'\n'
output+="5. BACKUP all files you will modify: cp <file> .uap-backups/$(date +%Y-%m-%d)/<file>"$'\n'
output+="   Or use: mkdir -p .uap-backups/$(date +%Y-%m-%d) && cp -r <dir> .uap-backups/$(date +%Y-%m-%d)/"$'\n'
output+=""$'\n'
output+="### DURING WORK:"$'\n'
output+="6. ALL file changes MUST use worktree: uap worktree create <slug>"$'\n'
output+="7. Work in .worktrees/NNN-<slug>/ directory"$'\n'
output+=""$'\n'
output+="### BEFORE COMMIT:"$'\n'
output+="8. Self-review: git diff"$'\n'
output+="9. Run tests if applicable"$'\n'
output+=""$'\n'
output+="### AFTER WORK:"$'\n'
output+="10. Store lesson: sqlite3 ./agents/data/memory/short_term.db \"INSERT INTO session_memories (session_id,timestamp,type,content,importance) VALUES ('current',datetime('now'),'decision','<summary of work and lessons>',7);\""$'\n'
output+="11. Clean up worktree after PR merge: uap worktree cleanup <id>"$'\n'
output+=""$'\n'
output+="### MULTI-AGENT COORDINATION (MANDATORY):"$'\n'
output+="Your agent ID is: ${AGENT_ID}"$'\n'
output+="12. Before editing files, announce work: uap agent announce --resources '<file1>,<file2>' --description '<what>'"$'\n'
output+="13. Check for conflicts: uap agent overlaps"$'\n'
output+="14. After completing work: uap agent complete <announcement-id>"$'\n'
output+=""$'\n'

if [ -n "$OTHER_AGENTS" ]; then
  output+="### ACTIVE AGENTS (coordinate with them):"$'\n'
  output+="$OTHER_AGENTS"$'\n'
  output+=""$'\n'
fi

if [ -n "$ACTIVE_WORK" ]; then
  output+="### ACTIVE WORK ANNOUNCEMENTS (avoid conflicts):"$'\n'
  output+="$ACTIVE_WORK"$'\n'
  output+=""$'\n'
fi

if [ -n "$OVERLAPS" ]; then
  output+="### ⚠ OVERLAP DETECTED — Other agents are actively working:"$'\n'
  output+="$OVERLAPS"$'\n'
  output+="You MUST run 'uap agent overlaps' before editing any shared files."$'\n'
  output+=""$'\n'
fi

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
  mem_count=$(echo "$recent" | wc -l)
  output+="[MEMORY] ${mem_count} recent memories loaded (last 24h)"$'\n'
  output+="## Recent Memory Context"$'\n'
  output+="$recent"$'\n\n'
else
  output+="[MEMORY] No recent memories found (last 24h)"$'\n\n'
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

# In-progress tasks (show what's actively being worked on)
if [ -f "$TASK_DB" ] && [ "$TASK_PROGRESS" -gt 0 ]; then
  active_tasks=$(sqlite3 "$TASK_DB" "SELECT '  [' || id || '] ' || title FROM tasks WHERE status='in_progress' ORDER BY priority ASC LIMIT 5;" 2>/dev/null || true)
  if [ -n "$active_tasks" ]; then
    output+="## Active Tasks"$'\n'
    output+="$active_tasks"$'\n'
  fi
fi

# Blocked tasks warning
if [ -f "$TASK_DB" ] && [ "$TASK_BLOCKED" -gt 0 ]; then
  blocked_tasks=$(sqlite3 "$TASK_DB" "SELECT '  [' || id || '] ' || title FROM tasks WHERE status='blocked' ORDER BY priority ASC LIMIT 3;" 2>/dev/null || true)
  if [ -n "$blocked_tasks" ]; then
    output+=$'\n'"## Blocked Tasks (need attention)"$'\n'
    output+="$blocked_tasks"$'\n'
  fi
fi

if [ -n "$output" ]; then
  echo "$output"
fi
