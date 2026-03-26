---
name: uap-worktree
description: Manage git worktrees for safe, isolated code changes. Use before making any file edits to ensure changes are in an isolated branch.
---

# UAP Worktree Skill

## When to use
- Before making ANY code changes
- To list or clean up existing worktrees

## Workflow

1. **Create worktree**: `uap worktree create <slug>`
2. **Work in worktree**: All edits in `.worktrees/<id>-<slug>/`
3. **List worktrees**: `uap worktree list`
4. **Cleanup**: `uap worktree cleanup <id>`

## Rules
- Never edit files in the project root directory
- Always verify you are in a worktree before editing
- Run `uap worktree ensure --strict` to verify
