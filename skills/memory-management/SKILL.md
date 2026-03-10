| name | description |
| --- | --- |
| memory-management | 4-layer memory system for AI coding agents. Store and retrieve lessons, decisions, and context across sessions using SQLite + vector search. Use when building agents that need persistent memory. |

# UAP Memory Management

## 4-Layer Architecture
```
L1 Working  | SQLite short_term.db | Fast scratchpad   | <1ms
L2 Session  | SQLite session_mem   | Current session    | <5ms
L3 Semantic | Qdrant vectors       | Cross-session      | ~50ms
L4 Knowledge| SQLite entities/rels | Relationship graph | <20ms
```

## Quick Start
```bash
npm install -g universal-agent-protocol
uap init
uap memory start     # Start Qdrant for semantic search (optional)
uap memory status    # Check memory health
```

## Store Memories
```bash
# Working memory (auto-pruned)
sqlite3 ./agents/data/memory/short_term.db \
  "INSERT INTO memories (timestamp,type,content) VALUES (datetime('now'),'action','...');"

# Semantic memory (cross-session)
uap memory store lesson "Learned X about Y" --tags tag1,tag2 --importance 8

# Session memory
sqlite3 ./agents/data/memory/short_term.db \
  "INSERT INTO session_memories (session_id,timestamp,type,content,importance) VALUES ('current',datetime('now'),'decision','...',7);"
```

## Query Memories
```bash
uap memory query "how to handle auth errors"   # Semantic search
sqlite3 ./agents/data/memory/short_term.db \
  "SELECT content FROM memories WHERE type='failure_analysis' ORDER BY timestamp DESC LIMIT 5;"
```

## Decay
`effective_importance = importance * (0.95 ^ days_since_access)`
