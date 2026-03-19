# Worktree File Guard

All file-mutating operations (write, edit, create, delete, rename) MUST target paths within an active worktree (`.worktrees/NNN-<slug>/`). Operations targeting the project root are BLOCKED.

## Enforcement Level

[REQUIRED]

## Rules

1. **File writes must target worktree paths.** Any tool call that writes, edits, creates, deletes, or renames a file must target a path inside `.worktrees/`. Paths in the project root are prohibited.

2. **Exempt paths.** The following paths are exempt from worktree enforcement because they contain runtime data, not source code:
   - `agents/data/` (memory databases, coordination DBs)
   - `node_modules/` (package dependencies)
   - `.uap-backups/` (backup directory)
   - `.uap/` (UAP configuration and registry)
   - `.git/` (git internals)
   - `dist/` (build output)

3. **Version bumps on feature branches only.** The `version-bump.sh` script must be run on a feature branch inside a worktree, not on main/master.

## When Triggered

This policy is enforced when:

- Any MCP tool call includes "write", "edit", "create", "delete", or "rename" in the tool name
- The `filePath` or `path` argument points to a location outside `.worktrees/`
- The path is not in the exempt list

## Anti-Patterns

DO NOT:

- Edit files in the project root directory
- Run version bumps on main/master
- Bypass worktree enforcement for "small changes"
- Create files outside worktrees even for "temporary" purposes

## Related Policies

- `worktree-enforcement` — Mandatory worktree usage for all file changes
- `completion-gate` — Worktree usage is part of the completion checklist
- `pre-edit-build-gate` — Build verification happens inside the worktree
