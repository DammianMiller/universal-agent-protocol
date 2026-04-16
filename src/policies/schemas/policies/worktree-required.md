# worktree-required

**Category**: workflow
**Level**: REQUIRED
**Enforcement Stage**: pre-exec
**Tags**: git, worktree, isolation, uap

## Rule

All `Edit`, `Write`, `MultiEdit` calls on tracked files MUST occur inside a UAP worktree at `.worktrees/NNN-<slug>/`. Exemptions:

- Harness config under `.claude/`, `.cursor/`, `.opencode/`, `.codex/`, `.uap/`
- New files under `src/policies/`, `scripts/`, `docs/`
- Explicit override: user says "work directly" or `--no-worktree`

## Why

CLAUDE.md v2.3.0 mandates worktrees; the existing hook warns but doesn't block. Formalizing closes the gap — protects in-flight user edits from agent collisions.

## Enforcement

Python enforcer `worktree_required.py` checks whether the target file path is under `.worktrees/` and whether the session has an active worktree slug.

```rules
- title: "File edits must occur in a worktree"
  keywords: [edit, write, multiedit, create-file, modify-file]
  antiPatterns: [primary-checkout, no-worktree, direct-main]
```
