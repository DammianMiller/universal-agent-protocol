| name | description |
| --- | --- |
| worktree-workflow | Git worktree management for AI agents. Isolate multi-file changes, auto-create PRs, and cleanup. Use for features touching 3+ files. |

# UAP Worktree Workflow

## When to Use
| Change Scope | Workflow |
|-------------|----------|
| Single-file fix (<20 lines) | Direct commit to feature branch |
| Multi-file change (2-5 files) | Worktree recommended |
| Feature/refactor (3+ files) | Worktree required |

## Commands
```bash
uap worktree create <slug>           # Create isolated worktree
cd .worktrees/NNN-<slug>/            # Enter worktree
git add -A && git commit -m "type: description"
uap worktree pr <id>                 # Create PR (runs tests)
uap worktree cleanup <id>            # Cleanup after merge
```

## Rules
- Never commit directly to main
- Always cleanup after merge
- Worktree auto-creates feature branch with sequential numbering
