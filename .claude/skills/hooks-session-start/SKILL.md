---
name: hooks-session-start
description: Session initialization hook that cleans stale agents, injects recent memory context, and ensures 100% CLAUDE.md adherence
---

# Session Start Hook

Automated session initialization that maintains agent health, context, and CLAUDE.md compliance.

## Purpose

This hook runs at the start of each agent session to:

1. Clean stale agents from coordination database (heartbeat >24h old)
2. Inject recent memory context (last 24h, high importance)
3. Surface open loops and active goals
4. **READ AND OBEY CLAUDE.md** - Explicitly loads and surfaces architectural constraints, security rules, and quality gates from CLAUDE.md

## Functions

### Stale Agent Cleanup

Removes agents that haven't heartbeated in 24 hours:

- Deletes stale work claims
- Cancels open work announcements
- Marks agents as 'failed'
- Purges old agent registry entries (>7 days)
- Clears old messages (>24h)

### Context Injection

Provides recent context:

- **Recent Memories**: Last 10 high-importance memories from 24h
- **Open Loops**: Top 5 action/goal/decision items with importance >= 7

## Usage

Automatically invoked by opencode at session start. No manual invocation needed.

## Location

`scripts/hooks/session-start.sh`

## Database Paths

- Memory DB: `agents/data/memory/short_term.db`
- Coordination DB: `agents/data/coordination/coordination.db`
