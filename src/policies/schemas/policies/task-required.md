# task-required

**Category**: workflow
**Level**: REQUIRED
**Enforcement Stage**: pre-exec
**Tags**: uap, task, workflow, enforcement

## Rule

A UAP task MUST be `in_progress` before any mutating work. When no row in
`.uap/tasks/tasks.db` has `status='in_progress'`, the enforcer blocks:

- `Edit` / `Write` / `MultiEdit` on non-exempt paths
- Bash ship actions: `git commit`, `git push`, `gh pr create`

Exempt path prefixes (no task required): `.claude/`, `.cursor/`, `.opencode/`,
`.codex/`, `.forge/`, `.uap/`, `.policy-tools/`, `src/policies/`, `scripts/`,
`docs/`.

To proceed: `uap task create --type <task|bug|feature> --title "<desc>"` then
`uap task update <id> --status in_progress` (or `uap task claim <id>`).

## Why

The UAP compliance protocol's "create a task before work" step has historically
been delivered as SessionStart text injection — advisory guidance the agent can
silently skip. Observed in practice: a full multi-PR session completed with zero
`uap task create` calls because nothing enforced it.

A `pre-exec` policy enforcer makes the task requirement a hard gate rather than a
suggestion, so UAP task tracking is guaranteed rather than best-effort. This is
the task-tracking analogue of `worktree-required`.

## Enforcement

Python enforcer `task_required.py` resolves the primary worktree root via
`git rev-parse --git-common-dir` (so it works from linked worktrees), reads
`.uap/tasks/tasks.db`, and blocks when `COUNT(*) WHERE status='in_progress'` is
zero.

Fail-open: if UAP task tracking is not initialised (no `tasks.db`) or the DB is
unreadable, the operation is allowed — non-UAP repositories are unaffected.
Override for one-off meta-work: `UAP_NO_TASK=1`.

```rules
- title: "A UAP task must be in_progress before mutating work"
  keywords: [edit, write, multiedit, bash, git commit, git push, gh pr create]
  antiPatterns: [no-task, untracked-work, skip-task-create]
```
