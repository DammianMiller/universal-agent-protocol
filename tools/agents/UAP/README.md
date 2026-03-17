# Unified Agent Memory (UAP) Protocol CLI

**Version:** 1.0.0  
**Status:** ✅ Production Ready  
**Compliance:** 100% UAP Protocol Compliant

---

## Overview

The UAP CLI is the command-line interface for managing agent memory systems and enforcing protocol compliance. All agent hooks, workflows, and automation MUST use these commands to ensure consistency across sessions.

---

## Installation

### Prerequisites

- Python 3.10+
- SQLite3 (usually pre-installed)
- No external dependencies required

### Setup

```bash
# Make CLI executable
chmod +x tools/agents/UAP/cli.py

# Add to PATH (optional)
ln -s $(pwd)/tools/agents/UAP/cli.py /usr/local/bin/UAP
```

---

## Commands

### Task Management

#### Check Readiness

```bash
UAP task ready
```

Verifies all UAP components are initialized and ready for work.

**Output:**

```
=== UAP Task Readiness Check ===

✅ Memory database: /path/to/agents/data/memory/short_term.db
📝 Recent activity (last 5 entries):
   [2026-03-10T08:00:00Z] action: Created worktree: fix-bug-123
   ...

✅ UAP Protocol Ready - You can proceed with work
```

#### Create Task

```bash
UAP task create <type> "<title>"
```

**Types:** `action`, `observation`, `thought`, `goal`

**Example:**

```bash
UAP task create action "Implemented new feature X"
UAP task create goal "Complete migration to TypeScript"
```

---

### Memory Operations

#### Query Memory

```bash
UAP memory query "<topic>" [-n limit]
```

Searches memory using full-text search or keyword matching.

**Examples:**

```bash
UAP memory query "Redis caching" -n 10
UAP memory query "database migration"
```

#### Store Memory

```bash
UAP memory store <type> "<content>" [--importance N]
```

**Example:**

```bash
UAP memory store lesson "Always check network policies first" --importance 9
```

---

### Worktree Management

#### Create Worktree

```bash
UAP worktree create <slug>
```

Creates a new git worktree for isolated development.

**Example:**

```bash
UAP worktree create fix-auth-bug-123
```

#### List Worktrees

```bash
UAP worktree list
```

Shows all active worktrees.

#### Cleanup Worktree

```bash
UAP worktree cleanup <id-or-slug>
```

Removes a merged worktree and records the action.

---

### Session Management

#### Start Session

```bash
UAP session start
```

Initializes a new agent session with unique ID.

**Example:**

```bash
$ UAP session start
✅ Session started: a1b2c3d4
   Timestamp: 2026-03-10T08:00:00Z

📝 Remember to run 'UAP session end' when done
```

#### End Session

```bash
UAP session end
```

Cleans up the current session and updates coordination database.

---

### Compliance Verification

#### Check Compliance

```bash
UAP compliance check
```

Verifies all UAP protocol requirements are met.

**Output:**

```
=== UAP Protocol Compliance Check ===

✅ Memory database initialized
✅ Table 'memories' exists
✅ Table 'session_memories' exists
✅ Table 'entities' exists
✅ Table 'relationships' exists
✅ Full-text search index exists
✅ Coordination database initialized
✅ Worktrees directory exists (3 worktrees)

========================================
✅ UAP Protocol COMPLIANT - All checks passed
```

---

## Database Schema

### Core Tables

#### memories

Stores all agent actions, observations, and thoughts.

```sql
CREATE TABLE memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('action','observation','thought','goal')),
    content TEXT NOT NULL
);
```

#### session_memories

High-importance decisions and goals for the current session.

```sql
CREATE TABLE session_memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    type TEXT NOT NULL,
    content TEXT NOT NULL,
    importance INTEGER CHECK(importance >= 1 AND importance <= 10),
    UNIQUE(session_id, id)
);
```

#### entities (Knowledge Graph)

Nodes representing services, databases, patterns, etc.

```sql
CREATE TABLE entities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL,
    description TEXT,
    mention_count INTEGER DEFAULT 0,
    last_seen TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
```

#### relationships (Knowledge Graph)

Edges connecting entities.

```sql
CREATE TABLE relationships (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id INTEGER REFERENCES entities(id),
    target_id INTEGER REFERENCES entities(id),
    relation TEXT NOT NULL,
    strength REAL DEFAULT 1.0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(source_id, target_id, relation)
);
```

#### memories_fts (Full-Text Search)

FTS5 index for efficient topic-based queries.

---

## Integration with Hooks

### Session Start Hook

```bash
# .claude/hooks/session-start.sh

# Initialize session
UAP session start

# Check readiness
UAP task ready

# Query recent context
UAP memory query "current project" --limit 5
```

### Pre-Commit Hook

```bash
# .git/hooks/pre-commit

# Verify compliance before commit
UAP compliance check
if [ $? -ne 0 ]; then
    echo "❌ UAP Compliance check failed"
    exit 1
fi
```

---

## Migration Guide

### Upgrade from Legacy Memory System

1. **Run database migration:**

   ```bash
   tools/agents/migrations/apply.py
   ```

2. **Verify compliance:**

   ```bash
   UAP compliance check
   ```

3. **Update hooks to use CLI:**
   - Replace `sqlite3` commands with `UAP memory query`
   - Replace manual worktree creation with `UAP worktree create`

---

## Troubleshooting

### "Database not found" Error

```bash
# Initialize memory database
tools/agents/migrations/apply.py
```

### "Table not found" Error

```bash
# Run migration to add missing tables
tools/agents/migrations/apply.py
```

### FTS Search Not Working

```bash
# Recreate FTS index
tools/agents/migrations/apply.py
```

---

## Testing

Run compliance tests:

```bash
python3 tools/agents/tests/test_uam_compliance.py
# or with pytest:
pytest tools/agents/tests/test_uam_compliance.py -v
```

Expected output:

```
test_01_memory_database_exists... ✅
test_02_memories_table_exists... ✅
...
========================================
✅ ALL COMPLIANCE TESTS PASSED
```

---

## License

Internal Use Only - UAP Team

---

## Support

For issues or questions:

- Review documentation in `docs/UAP_PROTOCOL.md`
- Check compliance tests for examples
- Run `UAP --help` for usage information
