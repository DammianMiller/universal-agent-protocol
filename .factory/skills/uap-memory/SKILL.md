---
name: uap-memory
description: Query and store persistent memory across sessions using UAP. Use when you need to recall prior context, store lessons learned, or check what was done in previous sessions.
---

# UAP Memory Skill

## When to use
- At the start of any task to check for prior context
- After completing work to store lessons learned
- When you need to recall decisions or patterns from previous sessions

## Commands

### Query Memory
```bash
uap memory query "<search terms>"
```
Returns relevant memories matching the search terms.

### Store Memory
```bash
uap memory store "<content>" --importance <1-10>
```
Stores a new memory entry. Use importance 7-10 for critical decisions,
4-6 for useful context, 1-3 for minor notes.

### Memory Status
```bash
uap memory status
```
Shows memory system health and statistics.
