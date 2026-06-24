# workdir-scope

**Category**: safety
**Level**: REQUIRED
**Enforcement Stage**: pre-exec
**Tags**: filesystem, scope, safety, permission

## Rule

File-mutating tool calls MUST stay within the project working directory. A
`Write`, `Edit`, `MultiEdit`, or `NotebookEdit` whose target — or a `Bash`
command whose create/move destination (`mkdir`, `touch`, `cp`, `mv`, `install`,
`tee`, output redirection) — resolves OUTSIDE the working tree is **blocked**.

In scope (allowed): the current working tree and main checkout (worktrees
included), relative paths, and a scratch allow-list (`/tmp`, `$TMPDIR`,
`~/.cache/uap`, `~/.config/uap`, plus `UAP_WORKDIR_ALLOW` prefixes).

## Why

Agents running with `--dangerously-skip-permissions` emit absolute paths that can
escape the project (a sibling at `~/dev`, or a garbled name like
`octopusspace-shooter`), silently creating directories and writing files outside
the intended workspace. Stepping outside the current path must require explicit
operator permission — not happen silently.

## Enforcement

Python enforcer `workdir_scope.py` resolves each target/destination against the
working-tree roots and rejects any that fall outside (minus the scratch
allow-list). Escape hatch: `UAP_WORKDIR_SCOPE_OFF=1` allows everything;
`UAP_WORKDIR_ALLOW=/extra/prefix:...` widens the allow-list.

```rules
- title: "File writes must stay inside the project working directory"
  keywords: [write, edit, multiedit, notebookedit, mkdir, create-file, bash]
  antiPatterns: []
```
