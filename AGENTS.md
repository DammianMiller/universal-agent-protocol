# AGENTS.md - UAP Integration

## Universal Agent Protocol (UAP)

This project uses UAP for persistent memory, multi-agent coordination,
pattern libraries, and policy enforcement across sessions.

## Session Start

```
bash .codex/hooks/session-start.sh
```

## Quick Reference

| Command | Purpose |
|---------|---------|
| `uap memory query "<terms>"` | Search memory |
| `uap memory store "<content>" --importance <1-10>` | Store lesson |
| `uap worktree create <slug>` | Create worktree (required before edits) |
| `uap worktree list` | List active worktrees |
| `uap task ready` | Check task readiness |
| `uap patterns query "<desc>"` | Query patterns |
| `uap dashboard` | Session dashboard |

## Enforcement Hooks

| Hook | Event | Effect |
|------|-------|--------|
| `pre-tool-use-edit-write.sh` | Before file edits | BLOCKS edits outside `.worktrees/` |
| `pre-tool-use-bash.sh` | Before shell commands | BLOCKS dangerous commands |
| `post-tool-use-edit-write.sh` | After file edits | Reminds about build gate |
| `post-compact.sh` | After compaction | Re-injects policies |
| `stop.sh` | Before session end | Checks completion gates |
| `session-end.sh` | Session cleanup | Cleans agent registration |

Exempt paths: `agents/data/`, `node_modules/`, `.uap-backups/`, `.uap/`, `.git/`, `dist/`

## Active Policies

1. **worktree-enforcement** -- All file changes in `.worktrees/NNN-slug/`
2. **pre-edit-build-gate** -- `npm run build` before/after `.ts` edits
3. **completion-gate** -- 2+ tests, build, lint, version bump before DONE
4. **semver-versioning** -- `npm run version:patch/minor/major` (no manual edits)
5. **mandatory-file-backup** -- Backup files before modification

**Note:** Read-only tasks (analysis, diagnostics, queries) are exempt from worktree and build gates.
