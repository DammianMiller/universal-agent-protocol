# AGENTS.md - UAP Integration for Codex CLI

## Universal Agent Protocol (UAP)

This project uses UAP for persistent memory, multi-agent coordination,
pattern libraries, and policy enforcement across sessions.

## Session Start

At the beginning of each session, run the following to load context:

```
bash .codex/hooks/session-start.sh
```

## Memory System

Use the UAP memory system to query and store knowledge:

- **Query memory**: `uap memory query "<search terms>"`
- **Store lesson**: `uap memory store "<content>" --importance <1-10>`
- **Memory status**: `uap memory status`

## Worktree Workflow

All code changes MUST use worktrees for safe git workflow:

1. `uap worktree create <slug>` - Create isolated worktree
2. Make changes in the worktree directory
3. `uap worktree cleanup <id>` - Clean up after merge
4. `uap worktree list` - List active worktrees

## Pattern Library

Query task-relevant patterns before starting work:

- `uap patterns query "<task description>"`

## Task Management

- `uap task create "<description>"` - Create a new task
- `uap task list` - List current tasks
- `uap task ready` - Check task readiness

## Agent Coordination

- `uap agent status` - Show agent coordination status
- `uap dashboard` - Show UAP session dashboard

## Pre-Compact

Before context compaction, save state:

```
bash .codex/hooks/pre-compact.sh
```
