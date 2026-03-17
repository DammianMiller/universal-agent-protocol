# Universal Agent Memory (UAP) Protocol v1.0

**Status:** ✅ Production Ready  
**Criticality:** 🚨 LIFE OR DEATH - Payment System  
**Compliance Target:** 100%

---

## Executive Summary

The UAP Protocol provides a standardized framework for agent memory management, ensuring consistency, reliability, and auditability across all autonomous agent sessions. This is **not optional** - it's a critical safety requirement for the Universal Agent Memory platform.

### Why 100% Compliance Matters

| Risk                  | Impact                          | Mitigation                          |
| --------------------- | ------------------------------- | ----------------------------------- |
| Lost context          | Failed payments, duplicate work | Memory database with FTS5 search    |
| Race conditions       | Data corruption                 | Coordination DB with agent registry |
| Stale sessions        | Resource leaks                  | Heartbeat monitoring + auto-cleanup |
| Non-reproducible work | Debugging nightmares            | Worktree isolation + audit trail    |

---

## Architecture Overview

### Four-Layer Memory System

```
┌─────────────────────────────────────────────────────┐
│ L4: Knowledge Graph (entities, relationships)       │
│     - Semantic understanding                        │
│     - Context preservation                          │
├─────────────────────────────────────────────────────┤
│ L3: Semantic Memory (Qdrant vectors)                │
│     - Vector-based search                           │
│     - Similarity matching                           │
├─────────────────────────────────────────────────────┤
│ L2: Session Memories (high-importance decisions)    │
│     - Critical decisions                            │
│     - Importance ≥ 7                                │
├─────────────────────────────────────────────────────┤
│ L1: Working Memory (memories table, FTS5 index)     │
│     - Recent actions, observations, thoughts        │
│     - Full-text search                              │
└─────────────────────────────────────────────────────┘
```

---

## Core Components

### 1. UAP CLI (`tools/agents/uap/cli.py`)

The single source of truth for all memory operations.

**Mandatory Commands:**

- `uap task ready` - Verify system readiness
- `uap session start` / `end` - Session lifecycle
- `uap memory query` - Context retrieval
- `uap worktree create` - Isolated development
- `uap compliance check` - Protocol verification

### 2. Database Schema (`agents/data/memory/short_term.db`)

**Tables:**

- `memories` - All agent activity
- `session_memories` - High-importance decisions
- `entities` - Knowledge graph nodes
- `relationships` - Knowledge graph edges
- `memories_fts` - Full-text search index

### 3. Coordination Database (`agents/data/coordination/coordination.db`)

**Tables:**

- `agent_registry` - Active agent tracking
- `work_claims` - Task ownership
- `work_announcements` - Cross-agent communication
- `agent_messages` - Inter-agent messaging

### 4. Qdrant Vector Database (Optional)

For semantic search and similarity matching.

**Collection:** `uap_memory`  
**Vector Size:** 384 (all-MiniLM-L6-v2)  
**Distance:** COSINE

---

## Protocol Workflow

### Session Lifecycle

```
1. uap session start          ← Agent initialization
2. uap task ready             ← Verify readiness
3. uap memory query "<topic>" ← Load context
4. [WORK PERFORMED]           ← Using worktrees
5. uap task create action ... ← Log actions
6. uap session end            ← Clean up
```

### Worktree Workflow

```
1. User request received
2. uap task create goal "Implement feature X"
3. uap worktree create fix-feature-x
4. cd .worktrees/NNN-fix-feature-x/
5. [Make changes]
6. git add . && git commit -m "..."
7. git push origin NNN-fix-feature-x
8. Create PR via: uap worktree ... (manual step)
9. After merge: uap worktree cleanup NNN
```

### Memory Storage Pattern

```python
# During work
uap task create action "Analyzed payment flow"
uap memory store observation "Redis cache hit rate: 95%"

# High-importance decisions
sqlite3 ./agents/data/memory/short_term.db "
  INSERT INTO session_memories
  (session_id, timestamp, type, content, importance)
  VALUES ('current', datetime('now'), 'decision',
          'Chose PgDog over PgCat for connection pooling', 9)
"

# Store lessons learned
sqlite3 ./agents/data/memory/short_term.db "
  INSERT INTO memories (timestamp, type, content)
  VALUES (datetime('now'), 'lesson',
          'Always check network policies before deploying Redis')
"
```

---

## Compliance Checklist

### Pre-Session (MANDATORY)

- [ ] Run `uap task ready` - All systems operational
- [ ] Run `uap session start` - Initialize session ID
- [ ] Verify database exists: `ls agents/data/memory/short_term.db`
- [ ] Check coordination DB: `ls agents/data/coordination/coordination.db`

### During Work (MANDATORY)

- [ ] ALL changes in worktree: `uap worktree create <slug>`
- [ ] Log significant actions: `uap task create action "..."`
- [ ] Store decisions with importance ≥ 7
- [ ] Never modify files outside worktree

### Pre-Commit (MANDATORY)

- [ ] Review changes: `git diff --cached`
- [ ] Run tests if applicable
- [ ] Verify compliance: `uap compliance check`
- [ ] Check for secrets: `git diff --cached | grep -i secret`

### Post-Work (MANDATORY)

- [ ] End session: `uap session end`
- [ ] Clean up worktree after PR merge
- [ ] Store lesson in session_memories
- [ ] Update documentation if needed

---

## Critical Failure Modes & Recovery

### 1. Missing Memory Database

**Symptoms:** "Database not found" error  
**Recovery:**

```bash
tools/agents/migrations/apply.py
uap compliance check
```

### 2. Stale Agent in Coordination DB

**Symptoms:** Race conditions, duplicate work  
**Detection:**

```bash
sqlite3 agents/data/coordination/coordination.db "
  SELECT * FROM agent_registry
  WHERE status='active' AND last_heartbeat < datetime('now','-24h')
"
```

**Recovery:** Session start hook auto-cleans stale agents

### 3. FTS Index Corruption

**Symptoms:** `uap memory query` returns no results  
**Recovery:**

```bash
tools/agents/migrations/apply.py  # Rebuilds index
```

### 4. Worktree Orphaned

**Symptoms:** Worktree exists but PR merged elsewhere  
**Detection:** `uap worktree list`  
**Recovery:** `uap worktree cleanup <id>`

---

## Testing & Verification

### Run Compliance Tests

```bash
python3 tools/agents/tests/test_uap_compliance.py
```

Expected output:

```
test_01_memory_database_exists... ✅
test_02_memories_table_exists... ✅
...
✅ ALL COMPLIANCE TESTS PASSED
```

### Manual Verification

```bash
# 1. Check database schema
sqlite3 agents/data/memory/short_term.db ".tables"

# 2. Verify FTS index
sqlite3 agents/data/memory/short_term.db "SELECT name FROM sqlite_master WHERE type='table' AND name='memories_fts'"

# 3. Test CLI commands
uap task ready
uap compliance check

# 4. Check coordination DB
sqlite3 agents/data/coordination/coordination.db ".tables"
```

---

## Security Considerations

### Data Protection

- **No secrets in memory:** Never store API keys, passwords, or tokens
- **Session isolation:** Each session has unique ID, no cross-contamination
- **Audit trail:** All actions logged with timestamps

### Access Control

- **CLI permissions:** Only authorized agents can execute UAP commands
- **Database locks:** SQLite WAL mode prevents concurrent writes
- **Coordination DB:** Agent registry enforces single-writer per task

---

## Performance Characteristics

| Operation        | Latency | Notes                  |
| ---------------- | ------- | ---------------------- |
| Memory insert    | < 1ms   | SQLite in-memory cache |
| FTS search       | < 10ms  | Index-based lookup     |
| Session start    | < 5ms   | UUID generation        |
| Worktree create  | ~2s     | Git operation          |
| Compliance check | < 50ms  | Multiple DB queries    |

---

## Migration Guide

### From Legacy System (Pre-UAP)

1. **Backup existing data:**

   ```bash
   cp agents/data/memory/short_term.db agents/data/memory/short_term.db.backup
   ```

2. **Run migration:**

   ```bash
   tools/agents/migrations/apply.py
   ```

3. **Update hooks:**
   - Replace `sqlite3` commands with `uap` CLI
   - Update `.claude/hooks/session-start.sh`

4. **Verify compliance:**
   ```bash
   uap compliance check
   python3 tools/agents/tests/test_uap_compliance.py
   ```

---

## FAQ

**Q: Can I skip the worktree requirement?**  
A: No. Worktrees provide isolation and audit trail. Skipping them violates critical safety protocols.

**Q: What if Qdrant is down?**  
A: FTS5 index provides fallback search. Qdrant is optional for semantic search but recommended.

**Q: How do I handle multiple agents working on same task?**  
A: Use coordination DB to claim work: `work_claims` table prevents duplicate efforts.

**Q: Can I use external memory systems (e.g., Redis)?**  
A: Yes, as long as they sync with UAP database. Core protocol remains SQLite-based.

---

## References

- [UAP CLI Documentation](../tools/agents/uap/README.md)
- [Database Schema](../tools/agents/migrations/apply.py)
- [Compliance Tests](../tools/agents/tests/test_uap_compliance.py)
- [Session Start Hook](../../.claude/hooks/session-start.sh)

---

**Last Updated:** 2026-03-13  
**Version:** 1.0.0  
**Approved By:** UAP Architecture Review Board
