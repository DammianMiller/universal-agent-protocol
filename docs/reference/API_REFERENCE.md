# UAP API Reference

**Version:** 1.0.0  
**Last Updated:** 2026-03-13  
**Status:** ✅ Production Ready

---

## Executive Summary

This document provides a complete reference for all UAP CLI commands, database schema, and API endpoints.

---

## 1. CLI Commands

### 1.1 Task Commands

#### `uap task ready`

**Description:** Initialize task metadata and verify system readiness

**Usage:**

```bash
uap task ready
```

**Output:**

```
✅ UAP system ready
- Memory database: OK
- Pattern RAG: OK
- Coordination DB: OK
- Worktrees: OK
```

#### `uap task complete`

**Description:** Archive task results and update coordination

**Usage:**

```bash
uap task complete
```

**Options:**

- `--reason <text>` - Reason for task completion
- `--notes <text>` - Additional notes

**Output:**

```
Task completed
- Results archived
- Coordination DB updated
- Memory updated
```

#### `uap task create <goal>`

**Description:** Create tracked task

**Usage:**

```bash
uap task create "Fix authentication bug"
```

**Options:**

- `--priority <level>` - Priority (critical, high, medium, low)
- `--assignee <agent>` - Agent assignment

**Output:**

```
Task created: 123
Goal: Fix authentication bug
Priority: medium
Created: 2026-03-13T10:30:00Z
```

#### `uap task list`

**Description:** List all tasks

**Usage:**

```bash
uap task list
```

**Options:**

- `--active` - Show only active tasks
- `--completed` - Show only completed tasks
- `--json` - Output as JSON

**Output:**

```
Active Tasks:
  123: Fix authentication bug (medium)
  124: Add search feature (high)

Completed Tasks:
  122: Update documentation (low)
```

#### `uap task claim <id>`

**Description:** Claim task (announces to other agents)

**Usage:**

```bash
uap task claim 123
```

**Output:**

```
Task 123 claimed by agent-1
```

#### `uap task release <id>`

**Description:** Complete task

**Usage:**

```bash
uap task release 123
```

**Output:**

```
Task 123 released
```

### 1.2 Memory Commands

#### `uap memory status`

**Description:** Check memory system status

**Usage:**

```bash
uap memory status
```

**Output:**

```
Memory System Status:
- Short-term: 42/50 entries
- Long-term: 1,234 entries (Qdrant)
- Pattern RAG: 58 patterns indexed
- Health: OK
```

#### `uap memory query <search>`

**Description:** Search memories

**Usage:**

```bash
uap memory query "authentication"
```

**Options:**

- `--top-k <n>` - Number of results (default: 2)
- `--threshold <score>` - Similarity threshold (default: 0.35)
- `--verbose` - Show full content

**Output:**

```
Found 3 memories:
1. [0.87] "Always validate CSRF tokens in auth flows"
2. [0.72] "Redis cache hit rate: 95%"
3. [0.65] "Use PgDog for connection pooling"
```

#### `uap memory store <content>`

**Description:** Store a learning

**Usage:**

```bash
uap memory store "Best practice: Always backup before destructive actions"
```

**Options:**

- `--type <type>` - Memory type (lesson, observation, decision)
- `--importance <n>` - Importance score (1-10, default: 5)

**Output:**

```
Memory stored
- ID: 456
- Type: lesson
- Importance: 8
- Session: current
```

#### `uap memory start`

**Description:** Start Qdrant for semantic search

**Usage:**

```bash
uap memory start
```

**Options:**

- `--port <n>` - Port (default: 6333)
- `--data-dir <path>` - Data directory

**Output:**

```
Starting Qdrant...
Qdrant running at http://localhost:6333
Collections: agent_memory, agent_patterns
```

#### `uap memory list`

**Description:** List all memories

**Usage:**

```bash
uap memory list
```

**Options:**

- `--limit <n>` - Number of entries (default: 50)
- `--type <type>` - Filter by type
- `--json` - Output as JSON

**Output:**

```
Recent Memories:
  456: Best practice: Always backup... (lesson)
  455: Redis cache hit rate: 95% (observation)
  454: Use PgDog for connection... (decision)
```

### 1.3 Worktree Commands

#### `uap worktree create <name>`

**Description:** Create isolated branch

**Usage:**

```bash
uap worktree create fix-auth-bug
```

**Options:**

- `--base <branch>` - Base branch (default: main)
- `--description <text>` - Description

**Output:**

```
Worktree created: 001-fix-auth-bug
Branch: feature/001-fix-auth-bug
Directory: .worktrees/001-fix-auth-bug/
Ready for changes
```

#### `uap worktree list`

**Description:** List active worktrees

**Usage:**

```bash
uap worktree list
```

**Output:**

```
Active Worktrees:
  001-fix-auth-bug    feature/001-fix-auth-bug    2 hours ago
  002-add-search      feature/002-add-search      5 hours ago
```

#### `uap worktree pr <id>`

**Description:** Create PR from worktree

**Usage:**

```bash
uap worktree pr 001-fix-auth-bug
```

**Output:**

```
PR Created: https://github.com/org/repo/pull/123
Branch: feature/001-fix-auth-bug
Title: Fix authentication bug
```

#### `uap worktree cleanup <id>`

**Description:** Remove worktree

**Usage:**

```bash
uap worktree cleanup 001-fix-auth-bug
```

**Output:**

```
Worktree cleaned up: 001-fix-auth-bug
Branch deleted: feature/001-fix-auth-bug
Directory removed: .worktrees/001-fix-auth-bug/
```

### 1.4 Droid Commands

#### `uap droids list`

**Description:** List available droids

**Usage:**

```bash
uap droids list
```

**Output:**

```
Available Droids:
  typescript-node-expert  - TypeScript, Node.js
  security-auditor        - Security review
  performance-optimizer   - Performance tuning
  documentation-expert    - Documentation
  database-expert         - Database
  devops-expert           - DevOps
  testing-expert          - Testing
  code-reviewer           - Code review
```

#### `uap droids add <name>`

**Description:** Create new expert droid

**Usage:**

```bash
uap droids add my-specialist
```

**Options:**

- `--specialization <text>` - Specialization
- `--patterns <ids>` - Pattern IDs
- `--skills <names>` - Skill names

**Output:**

```
Droid created: my-specialist
Specialization: Custom task
Patterns: P08, P19, P26
Skills: git-forensics
```

### 1.5 Skill Commands

#### `uap skills list`

**Description:** List enabled skills

**Usage:**

```bash
uap skills list
```

**Output:**

```
Enabled Skills:
  git-forensics       - Git history analysis
  polyglot            - Multi-language code
  batch-review        - Bulk PR review
  adversarial         - Security testing
```

#### `uap skills enable <name>`

**Description:** Enable skill

**Usage:**

```bash
uap skills enable git-forensics
```

**Output:**

```
Skill enabled: git-forensics
```

#### `uap skills disable <name>`

**Description:** Disable skill

**Usage:**

```bash
uap skills disable old-skill
```

**Output:**

```
Skill disabled: old-skill
```

#### `uap skills docs <name>`

**Description:** View skill documentation

**Usage:**

```bash
uap skills docs git-forensics
```

**Output:**

```
Git Forensics Skill

Usage:
  uap task create action "Analyze git history"

Patterns:
  P03 - Backup First
  P15 - Check Logs

Best Practices:
  - Always backup before destructive actions
  - Check git logs for sensitive data
  - Use git filter-branch to clean history
```

### 1.6 Compliance Commands

#### `uap compliance check`

**Description:** Verify protocol compliance

**Usage:**

```bash
uap compliance check
```

**Output:**

```
Compliance Check:
✅ Memory database: OK
✅ Pattern RAG: OK
✅ Worktrees: OK
✅ Coordination DB: OK
✅ Hooks: OK

Status: COMPLIANT
```

#### `uap hooks status`

**Description:** Check hook status

**Usage:**

```bash
uap hooks status
```

**Output:**

```
Hook Status:
✅ SessionStart: Installed
✅ PreCompact: Installed
✅ PreToolUse: Installed
✅ PostToolUse: Installed
✅ TaskCompletion: Installed
```

#### `uap hooks install <name>`

**Description:** Install hooks

**Usage:**

```bash
uap hooks install all
```

**Options:**

- `all` - Install all hooks
- `session-start` - Session start hook only
- `pre-compact` - Pre-compact hook only
- etc.

**Output:**

```
Hooks installed:
✅ SessionStart
✅ PreCompact
✅ PreToolUse
✅ PostToolUse
✅ TaskCompletion
```

---

## 2. Database Schema

### 2.1 Short-term Memory Database

**Location:** `agents/data/memory/short_term.db`

#### Table: memories

```sql
CREATE TABLE memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    type TEXT NOT NULL,  -- action, observation, thought, lesson
    content TEXT NOT NULL,
    importance INTEGER DEFAULT 5,  -- 1-10
    metadata TEXT  -- JSON
);

CREATE INDEX idx_memories_session ON memories(session_id);
CREATE INDEX idx_memories_timestamp ON memories(timestamp);
CREATE INDEX idx_memories_type ON memories(type);
```

#### Table: memories_fts (FTS5 index)

```sql
CREATE VIRTUAL TABLE memories_fts USING fts5(
    content,
    content_rowid='memories'
);
```

#### Table: session_memories

```sql
CREATE TABLE session_memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    type TEXT NOT NULL,  -- decision, lesson, observation
    content TEXT NOT NULL,
    importance INTEGER NOT NULL,  -- ≥7
    metadata TEXT  -- JSON
);

CREATE INDEX idx_session_memories_session ON session_memories(session_id);
```

### 2.2 Knowledge Graph Database

#### Table: entities

```sql
CREATE TABLE entities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    name TEXT NOT NULL,
    type TEXT NOT NULL,  -- concept, object, person, etc.
    properties TEXT,  -- JSON
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_entities_session ON entities(session_id);
CREATE INDEX idx_entities_type ON entities(type);
```

#### Table: relationships

```sql
CREATE TABLE relationships (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    source_id INTEGER NOT NULL,
    target_id INTEGER NOT NULL,
    type TEXT NOT NULL,  -- relates_to, depends_on, etc.
    properties TEXT,  -- JSON
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (source_id) REFERENCES entities(id),
    FOREIGN KEY (target_id) REFERENCES entities(id)
);

CREATE INDEX idx_relationships_session ON relationships(session_id);
CREATE INDEX idx_relationships_source ON relationships(source_id);
CREATE INDEX idx_relationships_target ON relationships(target_id);
```

### 2.3 Coordination Database

**Location:** `agents/data/coordination/coordination.db`

#### Table: agent_registry

```sql
CREATE TABLE agent_registry (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT UNIQUE NOT NULL,
    status TEXT NOT NULL,  -- active, idle, completed, failed
    started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_heartbeat DATETIME DEFAULT CURRENT_TIMESTAMP,
    metadata TEXT  -- JSON
);

CREATE INDEX idx_agent_registry_status ON agent_registry(status);
```

#### Table: work_claims

```sql
CREATE TABLE work_claims (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    claimed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME,
    UNIQUE(agent_id, task_id)
);

CREATE INDEX idx_work_claims_task ON work_claims(task_id);
CREATE INDEX idx_work_claims_agent ON work_claims(agent_id);
```

#### Table: work_announcements

```sql
CREATE TABLE work_announcements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    announcement TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    completed_at DATETIME,
    FOREIGN KEY (task_id) REFERENCES work_claims(task_id)
);
```

#### Table: agent_messages

```sql
CREATE TABLE agent_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sender_id TEXT NOT NULL,
    receiver_id TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    read BOOLEAN DEFAULT FALSE,
    FOREIGN KEY (sender_id) REFERENCES agent_registry(agent_id),
    FOREIGN KEY (receiver_id) REFERENCES agent_registry(agent_id)
);

CREATE INDEX idx_agent_messages_receiver ON agent_messages(receiver_id);
CREATE INDEX idx_agent_messages_created ON agent_messages(created_at);
```

---

## 3. API Endpoints

### 3.1 Memory API

#### GET /api/memory/status

**Description:** Get memory system status

**Response:**

```json
{
  "short_term": {
    "total_entries": 42,
    "max_entries": 50,
    "health": "ok"
  },
  "long_term": {
    "total_entries": 1234,
    "provider": "qdrant",
    "health": "ok"
  },
  "pattern_rag": {
    "total_patterns": 58,
    "health": "ok"
  }
}
```

#### POST /api/memory/query

**Description:** Query memory

**Request:**

```json
{
  "query": "authentication",
  "top_k": 2,
  "threshold": 0.35
}
```

**Response:**

```json
{
  "results": [
    {
      "content": "Always validate CSRF tokens in auth flows",
      "score": 0.87,
      "type": "lesson",
      "importance": 8
    }
  ]
}
```

#### POST /api/memory/store

**Description:** Store memory

**Request:**

```json
{
  "content": "Best practice: Always backup before destructive actions",
  "type": "lesson",
  "importance": 8
}
```

**Response:**

```json
{
  "id": 456,
  "status": "stored",
  "timestamp": "2026-03-13T10:30:00Z"
}
```

### 3.2 Task API

#### GET /api/tasks

**Description:** List tasks

**Query Parameters:**

- `active` - Show only active tasks
- `completed` - Show only completed tasks

**Response:**

```json
{
  "tasks": [
    {
      "id": 123,
      "goal": "Fix authentication bug",
      "status": "active",
      "priority": "medium",
      "created_at": "2026-03-13T10:00:00Z"
    }
  ]
}
```

#### POST /api/tasks

**Description:** Create task

**Request:**

```json
{
  "goal": "Fix authentication bug",
  "priority": "medium"
}
```

**Response:**

```json
{
  "id": 123,
  "status": "created",
  "created_at": "2026-03-13T10:30:00Z"
}
```

### 3.3 Worktree API

#### GET /api/worktrees

**Description:** List worktrees

**Response:**

```json
{
  "worktrees": [
    {
      "id": "001-fix-auth-bug",
      "branch": "feature/001-fix-auth-bug",
      "created_at": "2026-03-13T08:30:00Z",
      "status": "active"
    }
  ]
}
```

#### POST /api/worktrees

**Description:** Create worktree

**Request:**

```json
{
  "name": "fix-auth-bug",
  "base": "main"
}
```

**Response:**

```json
{
  "id": "001-fix-auth-bug",
  "branch": "feature/001-fix-auth-bug",
  "status": "created"
}
```

---

## 4. Error Codes

| Code | Message             | Description             |
| ---- | ------------------- | ----------------------- |
| 400  | Bad Request         | Invalid parameters      |
| 401  | Unauthorized        | Authentication required |
| 404  | Not Found           | Resource not found      |
| 500  | Internal Error      | Server error            |
| 503  | Service Unavailable | System not ready        |

---

**Last Updated:** 2026-03-13  
**Version:** 1.0.0  
**Status:** ✅ Production Ready
