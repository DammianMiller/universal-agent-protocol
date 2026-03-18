# Worktree Enforcement

ALL file changes MUST use a git worktree. No exceptions. Direct commits to main/master are prohibited.

## Rules

1. **Create a worktree before any file change.** Run `uap worktree create <slug>` before editing any file. This creates an isolated branch in `.worktrees/NNN-<slug>/` and registers it in the coordination database.

2. **Work inside the worktree directory.** All edits, builds, and tests happen in `.worktrees/NNN-<slug>/`, not in the project root. The project root on main/master is read-only for development purposes.

3. **One worktree per task.** Each logical unit of work (bug fix, feature, refactor) gets its own worktree and branch. Do not mix unrelated changes in a single worktree.

4. **Changes go through PRs.** Use `uap worktree pr <id>` to push the branch and create a pull request. Direct pushes to main/master are prohibited.

5. **Cleanup is mandatory.** After a PR is merged, run `uap worktree cleanup <id>` to remove the worktree, delete local and remote branches, and update the coordination database. Stale worktrees are a policy violation.

6. **Scope is total.** This applies to all file types: application code, TypeScript, configs, workflows, documentation, CLAUDE.md itself, policy files, test files. No file type is exempt.

## Workflow Sequence

```
uap worktree create <slug>           # Create isolated worktree
cd .worktrees/NNN-<slug>/            # Enter worktree directory
<make changes, build, test>          # All work happens here
git add -A && git commit -m "..."    # Commit in worktree
uap worktree pr <id>                 # Push branch, create PR
<PR review and merge>                # Standard review process
uap worktree cleanup <id>            # Remove worktree (MANDATORY)
```

## When Triggered

This policy is enforced when:

- Any file is being created, modified, or deleted
- Any commit is being made
- Any push to the repository is being performed
- Task completion is being claimed (worktree must have been used)

## Exceptions

Worktree creation may be skipped ONLY when:

- Running read-only commands (git status, git log, uap task list, etc.)
- The project has worktrees explicitly disabled in `.uap.json` (`template.sections.worktreeWorkflow: false`)
- Emergency hotfix with explicit user authorization (must be documented)

## Anti-Patterns

DO NOT:

- Commit directly to main/master
- Edit files in the project root instead of a worktree
- Mix unrelated changes in a single worktree
- Leave stale worktrees after PR merge
- Push directly to main without a PR
- Skip worktree creation for "small changes" or "just docs"
- Create worktrees but work in the project root

## Enforcement Level

[REQUIRED]

## Related Policies

- `completion-gate` — Worktree usage is part of the completion checklist
- `mandatory-testing-deployment` — Tests run inside the worktree
- `pre-edit-build-gate` — Build verification happens inside the worktree
