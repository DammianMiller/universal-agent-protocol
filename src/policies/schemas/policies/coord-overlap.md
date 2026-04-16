# coord-overlap

**Category**: workflow
**Level**: RECOMMENDED
**Enforcement Stage**: pre-exec
**Tags**: agents, coordination, parallelism

## Rule

Before spawning a second or subsequent Agent/sub-agent that will write files, call `uap coordination check <paths>` to detect overlap with in-flight agents.

## Why

Multi-harness setup (.claude, .cursor, .opencode, .codex, .forge all present) creates collision risk. Overlap causes lost work and merge pain. `uap coordination check` is already available — unused.

## Enforcement

Python enforcer `coord_overlap.py` queries `agents/data/coordination/coordination.db` for active reservations on the target paths and blocks if conflicts exist.

```rules
- title: "Parallel agents require overlap check"
  keywords: [agent, spawn, subagent, parallel, delegate]
  antiPatterns: [skip-coord, no-reservation, overlap-ignore]
```
