# UAP Database Schema Reference

This document provides accurate database schema definitions for all UAP SQLite databases.

## Short-Term Memory Database

**Location:** `agents/data/memory/short_term.db`

### Table: memories

```sql
CREATE TABLE memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('action', 'observation', 'thought', 'goal', 'lesson', 'decision')),
    content TEXT NOT NULL,
    project_id TEXT NOT NULL DEFAULT 'default',
    importance INTEGER NOT NULL DEFAULT 5
);

CREATE INDEX idx_memories_project_id ON memories(project_id);
CREATE INDEX idx_memories_timestamp ON memories(timestamp);
CREATE INDEX idx_memories_type ON memories(type);
CREATE INDEX idx_memories_project_type ON memories(project_id, type);
CREATE INDEX idx_memories_importance ON memories(importance DESC);
```

### Table: memories_fts (FTS5)

```sql
CREATE VIRTUAL TABLE memories_fts USING fts5(
    content,
    type,
    content='memories',
    content_rowid='id',
    tokenize='porter unicode61'
);
```

### Table: session_memories

```sql
CREATE TABLE session_memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    type TEXT NOT NULL,
    content TEXT NOT NULL,
    importance INTEGER DEFAULT 5
);

CREATE UNIQUE INDEX idx_session_unique ON session_memories(session_id, content);
CREATE INDEX idx_session_id ON session_memories(session_id);
CREATE INDEX idx_session_timestamp ON session_memories(timestamp);
CREATE INDEX idx_session_importance ON session_memories(importance DESC);
CREATE INDEX idx_session_id_importance ON session_memories(session_id, importance DESC);
```

### Table: entities (Knowledge Graph L4)

```sql
CREATE TABLE entities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    mention_count INTEGER NOT NULL DEFAULT 1,
    UNIQUE(type, name)
);

CREATE INDEX idx_entities_type ON entities(type);
```

### Table: relationships (Knowledge Graph L4)

```sql
CREATE TABLE relationships (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id INTEGER NOT NULL,
    target_id INTEGER NOT NULL,
    relation TEXT NOT NULL,
    strength REAL NOT NULL DEFAULT 1.0,
    timestamp TEXT NOT NULL,
    UNIQUE(source_id, target_id, relation),
    FOREIGN KEY (source_id) REFERENCES entities(id),
    FOREIGN KEY (target_id) REFERENCES entities(id)
);

CREATE INDEX idx_relationships_source ON relationships(source_id);
CREATE INDEX idx_relationships_target ON relationships(target_id);
```

## Coordination Database

**Location:** `agents/data/coordination/coordination.db`

### Table: agent_registry

```sql
CREATE TABLE agent_registry (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    session_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('active', 'idle', 'completed', 'failed')),
    current_task TEXT,
    worktree_branch TEXT,
    started_at TEXT NOT NULL,
    last_heartbeat TEXT NOT NULL,
    capabilities TEXT
);

CREATE INDEX idx_agent_registry_session ON agent_registry(session_id);
CREATE INDEX idx_agent_registry_status ON agent_registry(status);
```

### Table: agent_messages

```sql
CREATE TABLE agent_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel TEXT NOT NULL,
    from_agent TEXT,
    to_agent TEXT,
    type TEXT NOT NULL CHECK(type IN ('request', 'response', 'notification', 'claim', 'release')),
    payload TEXT NOT NULL,
    priority INTEGER DEFAULT 5,
    created_at TEXT NOT NULL,
    read_at TEXT,
    expires_at TEXT
);

CREATE INDEX idx_messages_channel ON agent_messages(channel);
CREATE INDEX idx_messages_to_agent ON agent_messages(to_agent);
CREATE INDEX idx_messages_created ON agent_messages(created_at);
```

### Table: work_announcements

```sql
CREATE TABLE work_announcements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT NOT NULL,
    agent_name TEXT,
    worktree_branch TEXT,
    intent_type TEXT NOT NULL CHECK(intent_type IN ('editing', 'reviewing', 'refactoring', 'testing', 'documenting')),
    resource TEXT NOT NULL,
    description TEXT,
    files_affected TEXT,
    estimated_completion TEXT,
    announced_at TEXT NOT NULL,
    completed_at TEXT,
    FOREIGN KEY (agent_id) REFERENCES agent_registry(id)
);

CREATE INDEX idx_announcements_agent ON work_announcements(agent_id);
CREATE INDEX idx_announcements_resource ON work_announcements(resource);
CREATE INDEX idx_announcements_active ON work_announcements(completed_at) WHERE completed_at IS NULL;
```

### Table: work_claims (Legacy)

```sql
CREATE TABLE work_claims (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    resource TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    claim_type TEXT NOT NULL CHECK(claim_type IN ('exclusive', 'shared')),
    claimed_at TEXT NOT NULL,
    expires_at TEXT,
    FOREIGN KEY (agent_id) REFERENCES agent_registry(id)
);

CREATE INDEX idx_claims_agent ON work_claims(agent_id);
CREATE INDEX idx_claims_resource ON work_claims(resource);
```

### Table: deploy_queue

```sql
CREATE TABLE deploy_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_id TEXT NOT NULL,
    action_type TEXT NOT NULL CHECK(action_type IN ('commit', 'push', 'merge', 'deploy', 'workflow')),
    target TEXT NOT NULL,
    payload TEXT,
    status TEXT NOT NULL CHECK(status IN ('pending', 'batched', 'executing', 'completed', 'failed')),
    batch_id TEXT,
    queued_at TEXT NOT NULL,
    execute_after TEXT,
    priority INTEGER DEFAULT 5,
    dependencies TEXT
);

CREATE INDEX idx_deploy_status ON deploy_queue(status);
CREATE INDEX idx_deploy_batch ON deploy_queue(batch_id);
CREATE INDEX idx_deploy_target ON deploy_queue(target);
```

### Table: deploy_batches

```sql
CREATE TABLE deploy_batches (
    id TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    executed_at TEXT,
    status TEXT NOT NULL CHECK(status IN ('pending', 'executing', 'completed', 'failed')),
    result TEXT
);
```

## Task Database

**Location:** `./.uap/tasks/tasks.db`

### Table: tasks

```sql
CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT,
    type TEXT NOT NULL CHECK(type IN ('task', 'bug', 'feature', 'epic', 'chore', 'story')) DEFAULT 'task',
    status TEXT NOT NULL CHECK(status IN ('open', 'in_progress', 'blocked', 'done', 'wont_do')) DEFAULT 'open',
    priority INTEGER NOT NULL CHECK(priority BETWEEN 0 AND 4) DEFAULT 2,
    assignee TEXT,
    worktree_branch TEXT,
    labels TEXT,
    notes TEXT,
    parent_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    due_date TEXT,
    closed_at TEXT,
    closed_reason TEXT,
    FOREIGN KEY (parent_id) REFERENCES tasks(id)
);

CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_type ON tasks(type);
CREATE INDEX idx_tasks_priority ON tasks(priority);
CREATE INDEX idx_tasks_assignee ON tasks(assignee);
CREATE INDEX idx_tasks_parent ON tasks(parent_id);
CREATE INDEX idx_tasks_due_date ON tasks(due_date);
```

### Table: task_dependencies

```sql
CREATE TABLE task_dependencies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_task TEXT NOT NULL,
    to_task TEXT NOT NULL,
    dep_type TEXT NOT NULL CHECK(dep_type IN ('blocks', 'related', 'discovered_from')),
    created_at TEXT NOT NULL,
    FOREIGN KEY (from_task) REFERENCES tasks(id),
    FOREIGN KEY (to_task) REFERENCES tasks(id),
    UNIQUE(from_task, to_task)
);

CREATE INDEX idx_deps_from ON task_dependencies(from_task);
CREATE INDEX idx_deps_to ON task_dependencies(to_task);
CREATE INDEX idx_deps_type ON task_dependencies(dep_type);
```

### Table: task_history

```sql
CREATE TABLE task_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL,
    field TEXT NOT NULL,
    old_value TEXT,
    new_value TEXT,
    changed_by TEXT,
    changed_at TEXT NOT NULL,
    FOREIGN KEY (task_id) REFERENCES tasks(id)
);

CREATE INDEX idx_history_task ON task_history(task_id);
CREATE INDEX idx_history_time ON task_history(changed_at);
```

### Table: task_activity

```sql
CREATE TABLE task_activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    activity TEXT NOT NULL CHECK(activity IN ('claimed', 'released', 'commented', 'updated', 'created', 'closed')),
    details TEXT,
    timestamp TEXT NOT NULL,
    FOREIGN KEY (task_id) REFERENCES tasks(id)
);

CREATE INDEX idx_activity_task ON task_activity(task_id);
CREATE INDEX idx_activity_agent ON task_activity(agent_id);
```

### Table: task_summaries

```sql
CREATE TABLE task_summaries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    original_ids TEXT NOT NULL,
    summary TEXT NOT NULL,
    labels TEXT,
    closed_period TEXT,
    created_at TEXT NOT NULL
);

CREATE INDEX idx_summaries_period ON task_summaries(closed_period);
```

## Database Configuration

All databases use:

- **Journal mode:** WAL (Write-Ahead Logging)
- **Synchronous:** NORMAL
- **Busy timeout:** 10,000ms
- **Cache size:** -64000 pages (64MB)

## Migration Notes

### Memory Database Migrations

- Added `importance` column to `memories` table
- Widen CHECK constraint on `memories.type` to include 'lesson' and 'decision'
- Added `description` column to `entities` table
- Added `strength` column to `relationships` table

### Task Database Migrations

- Added `due_date` column (v4.9.0)
- Added `closed_at` and `closed_reason` columns (v9.4.0)

## See Also

- [API Reference](./API_REFERENCE.md)
- [Memory System Architecture](../../docs/architecture/SYSTEM_ANALYSIS.md)
- [Multi-Agent Coordination](../../docs/reference/FEATURES.md#multi-agent-coordination)
