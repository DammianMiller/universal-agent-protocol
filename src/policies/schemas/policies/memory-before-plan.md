# memory-before-plan

**Category**: workflow
**Level**: REQUIRED
**Enforcement Stage**: pre-exec
**Tags**: memory, uap, planning

## Rule

Before producing any implementation plan that spans 3+ steps or touches 3+ files, the agent MUST have queried `uap memory query <topic>` within the last 5 minutes. The UAP compliance protocol already mandates this; this policy enforces it.

## Why

Avoids re-deriving context already captured in prior sessions. Reduces duplicate work and keeps guidance coherent across agent runs.

## Enforcement

Python enforcer `memory_before_plan.py` checks `agents/data/memory/short_term.db` for a recent `uap memory query` action tagged with a relevant topic.

```rules
- title: "Plans must be preceded by memory query"
  keywords: [plan, implement, build, design, architect]
  antiPatterns: [no-memory-check, skip-history]
```
