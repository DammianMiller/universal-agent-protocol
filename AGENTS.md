<!-- UAP-MEMORY-BRIDGE:START (managed by `uap memory bridge`) -->
## Memory — managed by UAP (unified, cross-agent)

Your persistent memory is the **UAP memory system** — ONE store shared by every
coding agent on this project, NOT a per-agent memory file. Use it, not a local one:

- **Recall FIRST** on non-trivial work: `uap memory query "<topic>"` (semantic long-term search).
- **Store** durable facts/decisions/lessons: `uap memory store "<fact>"`.
- **Status**: `uap memory status`.

Recent UAP memories (auto-mirrored — do not hand-edit; refresh with `uap memory bridge`):
  - (lesson, i7) [deliver] STOPPED (interrupted, resumable — not a gate failure) after 1 turn(s), best 67% of gates — model qwen35-a3b — task: history
  - (lesson, i7) [deliver] STOPPED (interrupted, resumable — not a gate failure) after 5 turn(s), best 83% of gates — model qwen35-a3b — task: Harden the UAP
  - (lesson, i7) [deliver] NOT delivered after 17 turn(s), best 83% of gates — model qwen35-a3b — task: Fix security gap in src/delivery/user-validation.ts: 
  - (lesson, i7) [deliver] NOT delivered after 13 turn(s), best 33% of gates — model qwen35-a3b — task: Fix security gap in src/delivery/user-validation.ts: 
  - (lesson, i7) [deliver] NOT delivered after 5 turn(s), best 0% of gates — model opus-4.8 — task: Make the UAP deliver autoroute + project lock single-flig
  - (lesson, i7) [deliver] NOT delivered after 5 turn(s), best 0% of gates — model opus-4.8 — task: Make the UAP deliver autoroute + project lock single-flig
  - (decision, i6) [orchestrator] task 'history-scaffold' (History Module Scaffold) built — interface: src/history/config.ts: function resolveHistoryConfig(ove
  - (decision, i6) [deliver] delivered in 1 turn(s) — model qwen35-a3b — task: [mission:#1:131c4b30] Create the file docs/scratch/mission-smoke.md containing o

Read and write here so every agent compounds the same knowledge instead of siloed recall.
<!-- UAP-MEMORY-BRIDGE:END -->

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

## Quality Gate

When `.uap/quality-metrics.json` exists, the quality-metrics gate polices
complexity, coverage, duplication, and explicit `any` types on changed code:

- `uap quality check` - Check for new or worsened metric violations
- `uap quality baseline --update` - Freeze current debt into `.uap/quality-baseline.json` (reviewer sign-off required)

## Pre-Compact

Before context compaction, save state:

```
bash .codex/hooks/pre-compact.sh
```
