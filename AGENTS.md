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

## Enforcement Hooks

The following hooks enforce UAP policies. Run them at the appropriate lifecycle points:

### Before File Edits (BLOCKING)
```
echo '{"tool_input":{"file_path":"<path>"}}' | bash .codex/hooks/pre-tool-use-edit-write.sh
```
Blocks edits outside `.worktrees/` (exempt: agents/data/, node_modules/, .uap-backups/, .uap/, .git/, dist/).

### Before Shell Commands (BLOCKING)
```
echo '{"tool_input":{"command":"<cmd>"}}' | bash .codex/hooks/pre-tool-use-bash.sh
```
Blocks: terraform apply/destroy, git push --force, direct master commits, manual version edits.

### After File Edits (Informational)
```
echo '{"tool_input":{"file_path":"<path>"}}' | bash .codex/hooks/post-tool-use-edit-write.sh
```
Reminds about build gate for .ts files and backup policy.

### After Context Compaction
```
bash .codex/hooks/post-compact.sh
```
Re-injects all active policies and session state after compaction.

### Before Session End
```
bash .codex/hooks/stop.sh
```
Checks completion gates: tests written, build fresh, version bumped.

### Session Cleanup
```
bash .codex/hooks/session-end.sh
```
Cleans up agent registration, work claims, and old backups.

## Active Policies [all REQUIRED]

1. **worktree-enforcement** — All file changes in .worktrees/NNN-slug/
2. **worktree-file-guard** — Edit/Write paths must be inside worktrees
3. **pre-edit-build-gate** — npm run build before/after .ts edits
4. **completion-gate** — 2+ tests, build, lint, version bump before DONE
5. **semver-versioning** — npm run version:patch/minor/major (no manual edits)
6. **mandatory-file-backup** — Backup files before modification
7. **iac-state-parity** — All infra changes reflected in IaC
8. **iac-pipeline-enforcement** — No local terraform apply/destroy
9. **kubectl-verify-backport** — kubectl changes backported to IaC
10. **definition-of-done-iac** — Pipeline apply + kubectl verify required
11. **image-asset-verification** — Script-based, not vision-based [RECOMMENDED]
