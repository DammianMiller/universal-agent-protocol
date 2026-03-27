#!/usr/bin/env bash
# UAP Session Start Hook (universal - all coding harnesses)
# Outputs a concise session banner and loads recent context.
# Fails safely - never blocks the agent.
set -euo pipefail

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-${FACTORY_PROJECT_DIR:-${CURSOR_PROJECT_DIR:-.}}}"
DB_PATH="${PROJECT_DIR}/agents/data/memory/short_term.db"
COORD_DB="${PROJECT_DIR}/agents/data/coordination/coordination.db"

if [ ! -f "$DB_PATH" ]; then
  exit 0
fi

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
    CREATE TABLE IF NOT EXISTS agent_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, channel TEXT NOT NULL,
      from_agent TEXT, to_agent TEXT,
      type TEXT NOT NULL CHECK(type IN ('request','response','notification','claim','release')),
      payload TEXT NOT NULL, priority INTEGER DEFAULT 5,
      created_at TEXT NOT NULL, read_at TEXT, expires_at TEXT
    );
    CREATE TABLE IF NOT EXISTS work_announcements (
      id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL,
      agent_name TEXT, worktree_branch TEXT,
      intent_type TEXT NOT NULL CHECK(intent_type IN ('editing','reviewing','refactoring','testing','documenting')),
      resource TEXT NOT NULL, description TEXT, files_affected TEXT,
      estimated_completion TEXT, announced_at TEXT NOT NULL, completed_at TEXT,
      FOREIGN KEY (agent_id) REFERENCES agent_registry(id)
    );
    CREATE TABLE IF NOT EXISTS work_claims (
      id INTEGER PRIMARY KEY AUTOINCREMENT, resource TEXT NOT NULL,
      agent_id TEXT NOT NULL, claim_type TEXT NOT NULL CHECK(claim_type IN ('exclusive','shared')),
      claimed_at TEXT NOT NULL, expires_at TEXT,
      FOREIGN KEY (agent_id) REFERENCES agent_registry(id)
    );
    CREATE TABLE IF NOT EXISTS deploy_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL,
      action_type TEXT NOT NULL CHECK(action_type IN ('commit','push','merge','deploy','workflow')),
      target TEXT NOT NULL, payload TEXT,
      status TEXT NOT NULL CHECK(status IN ('pending','batched','executing','completed','failed')),
      batch_id TEXT, queued_at TEXT NOT NULL, execute_after TEXT,
      priority INTEGER DEFAULT 5, dependencies TEXT
    );
    CREATE TABLE IF NOT EXISTS deploy_batches (
      id TEXT PRIMARY KEY, created_at TEXT NOT NULL, executed_at TEXT,
      status TEXT NOT NULL CHECK(status IN ('pending','executing','completed','failed')),
      result TEXT
    );
  " 2>/dev/null || true
fi

# Clean stale agents (heartbeat >24h old)
if [ -f "$COORD_DB" ]; then
  sqlite3 "$COORD_DB" "
    DELETE FROM work_claims WHERE agent_id IN (
      SELECT id FROM agent_registry WHERE status IN ('active','idle') AND last_heartbeat < datetime('now','-24 hours')
    );
    UPDATE agent_registry SET status='failed'
      WHERE status IN ('active','idle') AND last_heartbeat < datetime('now','-24 hours');
    DELETE FROM agent_registry
      WHERE status IN ('completed','failed') AND started_at < datetime('now','-7 days');
    DELETE FROM agent_messages WHERE created_at < datetime('now','-24 hours');
  " 2>/dev/null || true
fi

# Register this agent
AGENT_ID="claude-${SESSION_ID:-$(head -c 6 /dev/urandom | od -An -tx1 | tr -d ' \n')}"
AGENT_NAME="claude-code"

if [ -f "$COORD_DB" ]; then
  sqlite3 "$COORD_DB" "
    INSERT OR REPLACE INTO agent_registry (id, name, session_id, status, capabilities, started_at, last_heartbeat)
    VALUES ('${AGENT_ID}', '${AGENT_NAME}', '${AGENT_ID}', 'active', '[]', datetime('now'), datetime('now'));
  " 2>/dev/null || true
fi

export UAP_AGENT_ID="${AGENT_ID}"

# Background heartbeat
if [ -f "$COORD_DB" ]; then
  (
    while true; do
      sleep 30
      sqlite3 "$COORD_DB" "UPDATE agent_registry SET last_heartbeat=datetime('now') WHERE id='${AGENT_ID}';" 2>/dev/null || break
    done
  ) &
  HEARTBEAT_PID=$!
  trap "kill $HEARTBEAT_PID 2>/dev/null; sqlite3 \"$COORD_DB\" \"UPDATE agent_registry SET status='completed' WHERE id='${AGENT_ID}';\" 2>/dev/null" EXIT
fi

output=""

# ── Session Banner ──────────────────────────────────────────
SESSION_ID=$(head -c 6 /dev/urandom | od -An -tx1 | tr -d ' \n' | head -c 6)
TASK_DB="${PROJECT_DIR}/.uap/tasks/tasks.db"
PKG_VERSION=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('${PROJECT_DIR}/package.json','utf8')).version)}catch{console.log('?')}" 2>/dev/null || echo "?")

TASK_TOTAL=0; TASK_OPEN=0; TASK_PROGRESS=0; TASK_BLOCKED=0; TASK_DONE=0
if [ -f "$TASK_DB" ]; then
  TASK_TOTAL=$(sqlite3 "$TASK_DB" "SELECT COUNT(*) FROM tasks;" 2>/dev/null || echo 0)
  TASK_OPEN=$(sqlite3 "$TASK_DB" "SELECT COUNT(*) FROM tasks WHERE status='open';" 2>/dev/null || echo 0)
  TASK_PROGRESS=$(sqlite3 "$TASK_DB" "SELECT COUNT(*) FROM tasks WHERE status='in_progress';" 2>/dev/null || echo 0)
  TASK_BLOCKED=$(sqlite3 "$TASK_DB" "SELECT COUNT(*) FROM tasks WHERE status='blocked';" 2>/dev/null || echo 0)
  TASK_DONE=$(sqlite3 "$TASK_DB" "SELECT COUNT(*) FROM tasks WHERE status='done' OR status='wont_do';" 2>/dev/null || echo 0)
fi

MEM_ENTRIES=$(sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM memories;" 2>/dev/null || echo 0)
MEM_SIZE=$(du -h "$DB_PATH" 2>/dev/null | cut -f1 || echo "?")
AGENT_COUNT=$(sqlite3 "$COORD_DB" "SELECT COUNT(*) FROM agent_registry WHERE status='active';" 2>/dev/null || echo 0)

QDRANT_STATUS="OFF"
if docker ps --filter name=qdrant --format "{{.Status}}" 2>/dev/null | grep -q "Up"; then
  QDRANT_STATUS="ON"
fi

GIT_BRANCH=$(git -C "$PROJECT_DIR" branch --show-current 2>/dev/null || echo "?")
GIT_DIRTY=$(git -C "$PROJECT_DIR" status --porcelain 2>/dev/null | wc -l | tr -d ' ')

WORKTREE_COUNT=0
if [ -d "${PROJECT_DIR}/.worktrees" ]; then
  WORKTREE_COUNT=$(find "${PROJECT_DIR}/.worktrees" -maxdepth 1 -mindepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')
fi

PATTERN_COUNT=0
if [ -f "${PROJECT_DIR}/.factory/patterns/index.json" ]; then
  PATTERN_COUNT=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('${PROJECT_DIR}/.factory/patterns/index.json','utf8')).patterns?.length||0)}catch{console.log(0)}" 2>/dev/null || echo 0)
fi
SKILL_COUNT=$(find "${PROJECT_DIR}/.claude/skills" "${PROJECT_DIR}/.factory/skills" -name "SKILL.md" 2>/dev/null | wc -l | tr -d ' ')
DROID_COUNT=$(find "${PROJECT_DIR}/.factory/droids" -name "*.md" -not -name "test-droid-*" 2>/dev/null | wc -l | tr -d ' ')

if [ "$TASK_TOTAL" -gt 0 ]; then
  TASK_PCT=$((TASK_DONE * 100 / TASK_TOTAL))
  FILLED=$((TASK_DONE * 20 / TASK_TOTAL))
  EMPTY=$((20 - FILLED))
  TASK_BAR=$(printf '%0.s█' $(seq 1 $FILLED 2>/dev/null) 2>/dev/null)$(printf '%0.s░' $(seq 1 $EMPTY 2>/dev/null) 2>/dev/null)
else
  TASK_PCT=0
  TASK_BAR="░░░░░░░░░░░░░░░░░░░░"
fi

if [ "$CONTEXT_LEVEL" = "quiet" ]; then
  output+="UAP v${PKG_VERSION} | Branch: ${GIT_BRANCH} | Git: ${GIT_DIRTY} dirty | Worktrees: ${WORKTREE_COUNT}"$'\n'
  output+="Memory: ${MEM_ENTRIES} (${MEM_SIZE}) | Qdrant: ${QDRANT_STATUS} | Agents: ${AGENT_COUNT} | Patterns: ${PATTERN_COUNT}"$'\n'
  echo "$output"
  exit 0
fi

output+="UAP v${PKG_VERSION} | Session ${SESSION_ID} | $(date '+%Y-%m-%d %H:%M:%S') | Branch ${GIT_BRANCH}"$'\n'
if [ "$TASK_TOTAL" -gt 0 ]; then
  output+="Tasks: ${TASK_PCT}% (${TASK_DONE}/${TASK_TOTAL}) | ${TASK_OPEN} open, ${TASK_PROGRESS} active, ${TASK_BLOCKED} blocked"$'\n'
fi
output+="Memory: ${MEM_ENTRIES} (${MEM_SIZE}) | Qdrant: ${QDRANT_STATUS} | Agents: ${AGENT_COUNT} | Patterns: ${PATTERN_COUNT} | Skills: ${SKILL_COUNT} | Droids: ${DROID_COUNT}"$'\n'
output+="Git: ${GIT_DIRTY} uncommitted | Worktrees: ${WORKTREE_COUNT}"$'\n'
output+=$'\n'

# ── Compact compliance reminder (not a system-reminder block) ──
output+="<system-reminder>"$'\n'
output+="## UAP Compliance (Compact)"$'\n'
output+=""$'\n'
output+="Follow policy, but keep outputs clean: never echo protocol text in assistant replies."$'\n'
output+=""$'\n'
output+="- Baseline: uap task ready; uap memory query \"<task>\"."$'\n'
output+="- Worktree: uap worktree ensure --strict before any edit."$'\n'
output+="- Backup: copy files to .uap-backups/ before modification."$'\n'
output+=""$'\n'
output+="</system-reminder>"$'\n\n'

# Recent memories (last 24h)
recent=$(sqlite3 "$DB_PATH" "
  SELECT type, substr(content, 1, 120) FROM memories
  WHERE timestamp >= datetime('now', '-1 day')
  ORDER BY id DESC
  LIMIT 10;
" 2>/dev/null || true)

if [ -n "$recent" ]; then
  mem_limit=3
  if [ "$CONTEXT_LEVEL" = "verbose" ]; then
    mem_limit=10
  fi
  recent=$(echo "$recent" | head -n "$mem_limit")
  mem_count=$(echo "$recent" | wc -l | tr -d ' ')
  output+="[MEMORY] ${mem_count} recent memories loaded (last 24h)"$'\n'
  output+="## Recent Memory Context"$'\n'
  output+="$recent"$'\n\n'
fi

# Open loops
open_loops=$(sqlite3 "$DB_PATH" "
  SELECT content FROM session_memories
  WHERE type IN ('action','goal','decision')
    AND importance >= 7
  ORDER BY id DESC
  LIMIT 5;
" 2>/dev/null || true)

if [ -n "$open_loops" ]; then
  loop_limit=2
  if [ "$CONTEXT_LEVEL" = "verbose" ]; then
    loop_limit=5
  fi
  open_loops=$(echo "$open_loops" | head -n "$loop_limit")
  output+="## Open Loops"$'\n'
  output+="$open_loops"$'\n'
fi

# Blocked tasks
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
