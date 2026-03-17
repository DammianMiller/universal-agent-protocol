# Memory System Guide Template

**Version**: 1.0.0
**Last Updated**: {{STRUCTURE_DATE}}

---

## Memory Layers

| Layer        | Storage                   | Capacity                 | Latency |
| ------------ | ------------------------- | ------------------------ | ------- |
| L1 Working   | SQLite `memories`         | {{SHORT_TERM_LIMIT}} max | <1ms    |
| L2 Session   | SQLite `session_memories` | Current session          | <5ms    |
| L3 Semantic  | {{LONG_TERM_BACKEND}}     | Unlimited                | ~50ms   |
| L4 Knowledge | SQLite `entities/rels`    | Graph                    | <20ms   |

**Database**: `./{{MEMORY_DB_PATH}}`
**Vector DB**: {{LONG_TERM_BACKEND}} at `{{LONG_TERM_ENDPOINT}}`

---

## Working Memory (L1)

Quick actions stored directly in SQLite.

```bash
# Store action
sqlite3 ./{{MEMORY_DB_PATH}} "INSERT INTO memories (timestamp,type,content) VALUES (datetime('now'),'action','...');"

# Query recent
sqlite3 ./{{MEMORY_DB_PATH}} "SELECT * FROM memories ORDER BY id DESC LIMIT 10;"
```

---

## Session Memory (L2)

Session-specific context for current task.

```bash
# Store decision
sqlite3 ./{{MEMORY_DB_PATH}} "INSERT INTO session_memories (session_id,timestamp,type,content,importance) VALUES ('current',datetime('now'),'decision','...',7);"
```

---

## Semantic Memory (L3)

Long-term lessons stored in Qdrant vector database.

```bash
# Store lesson
{{MEMORY_STORE_CMD}} lesson "..." --tags t1,t2 --importance 8

# Query relevant lessons
{{MEMORY_QUERY_CMD}} "security best practices"
```

---

## Pattern RAG

Patterns are retrieved dynamically from the `{{PATTERN_RAG_COLLECTION}}` collection.

Top-2 relevant patterns are injected per task (score >= {{PATTERN_RAG_THRESHOLD}}).

```bash
# Query patterns
{{PATTERN_RAG_QUERY_CMD}} "task description"

# Re-index patterns
{{PATTERN_RAG_INDEX_CMD}}

# Check status
uap patterns status
```

---

## Pattern Files

Patterns are defined in `.factory/patterns/`:

```
.factory/patterns/
├── P12_output_existence.md
├── P13_iterative_refinement.md
├── ...
├── IaC-Parity.md
└── index.json
```

To add a new pattern:

1. Create `P37_new_pattern.md` in `.factory/patterns/`
2. Add entry to `index.json`
3. Run `python agents/scripts/index_patterns.py`

---

## Reinforcement Learning

Pattern effectiveness is tracked for self-improvement.

```bash
# View pattern effectiveness
sqlite3 ./agents/data/memory/reinforcement.db "SELECT * FROM v_pattern_effectiveness;"

# View recent outcomes
sqlite3 ./agents/data/memory/reinforcement.db "SELECT * FROM v_recent_outcomes;"
```

---

## Qdrant Setup

```bash
# Start Qdrant
docker run -p 6333:6333 qdrant/qdrant

# Or with persistence
docker run -p 6333:6333 -v $(pwd)/qdrant_data:/qdrant/storage qdrant/qdrant
```

---

## See Also

- `.factory/patterns/` - Pattern definitions
- `agents/scripts/index_patterns.py` - Pattern indexing
- `agents/scripts/query_patterns.py` - Pattern query
