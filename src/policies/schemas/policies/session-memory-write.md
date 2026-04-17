# session-memory-write

**Category**: workflow
**Level**: REQUIRED
**Enforcement Stage**: post-exec
**Tags**: memory, session, uap

## Rule

A session that changed code (Edit/Write/MultiEdit occurred) MUST insert at least one `session_memories` row with `type IN ('decision','lesson','pattern')` before terminating.

## Why

Session-end logs show most sessions end with no memory write even when code changed. Lessons evaporate. UAP's memory system only works if write-back happens.

## Enforcement

Python enforcer `session_memory_write.py` runs on session-end hook: if code_changed=true, verify a matching row exists in `agents/data/memory/short_term.db`.

```rules
- title: "Close the learning loop on code sessions"
  keywords: [session-end, stop, terminate, finish]
  antiPatterns: [no-memory-write, skip-lesson]
```
