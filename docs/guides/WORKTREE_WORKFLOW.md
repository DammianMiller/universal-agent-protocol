# Worktree Workflow

> Applies to UAP v1.224.0

> **🏭 Where this fits:** ISOLATION — the station where a normal agentic workflow smears half-finished edits across `main`, clobbers files, and lets parallel agents collide into corrupt merge state. **What it delivers:** every agent works on its own branch in its own checkout, so the project root stays clean, each unit of work has a tidy PR boundary, and any number of agents can run at once without stepping on each other.

UAP runs agents — often many of them at once — against a single repository. The
worktree workflow exists to keep every edit an agent makes isolated on its own
branch and its own checkout, so that agent work never touches the project root
and parallel agents never collide. Think of it as giving each agent its own
workstation on the [delivery pipeline](./DELIVERY_PIPELINE.md) instead of
crowding them around one bench. This guide explains why that matters, walks
through the full lifecycle, and documents every `uap worktree` subcommand.

The implementation lives in [`src/cli/worktree.ts`](../../src/cli/worktree.ts).

## Why isolation matters

When an agent edits files directly in the project root, three problems appear:

- **Cross-contamination** — a half-finished change sits in the working tree
  where the next operation (build, test, another agent) can trip over it.
- **No clean PR boundary** — there is no branch that contains *only* this unit
  of work, so review and rollback become guesswork.
- **Parallel collisions** — two agents writing to the same files at the same
  time produce corrupt, non-deterministic state.

A git worktree solves all three. Each feature gets its own directory under
`.worktrees/NNN-<slug>/` backed by its own branch (`feature/NNN-<slug>`). An
agent works entirely inside that directory; the project root stays clean, and
any number of worktrees can be active simultaneously without interfering.

## The lifecycle

```
uap worktree create <slug>     # 1. isolate: new branch + checkout under .worktrees/NNN-<slug>/
cd .worktrees/NNN-<slug>/      # 2. work: all edits happen here
uap worktree pr <id>           # 3. publish: sync with master, push, open a PR
uap worktree finish <id>       # 4. land: sync, push, merge the PR, then clean up
# (or) uap worktree cleanup <id>   manual teardown without merging
```

1. **Create** — `create` allocates the next numeric ID from a registry,
   builds the branch name `feature/NNN-<slug>`, and runs
   `git worktree add -b <branch> .worktrees/NNN-<slug> <base>`. The base branch
   defaults to the freshly-fetched `origin/<default>` — not your current branch —
   so a worktree is never born stale (override with `--from`, skip the fetch with
   `--no-fetch`). See [Parallel Agents](PARALLEL_AGENTS.md). The new worktree is
   recorded in a SQLite registry at `.uap/worktree_registry.db` so concurrent
   `create` calls never race on the same ID.
2. **Work** — `cd` into the worktree and make changes. Everything stays on the
   feature branch and inside the worktree directory.
3. **Publish** — `pr` syncs the branch with `origin/master` (a clean merge, or a
   clear failure asking you to resolve conflicts in the worktree), pushes the
   branch, and opens a PR via the `gh` CLI.
4. **Land** — `finish` does the full sync → push → ensure-PR → merge sequence,
   deletes the remote branch, then runs `cleanup` for you.
5. **Clean up** — `cleanup` removes the worktree, deletes the local and remote
   branch, and marks the registry entry as `cleaned`.

## The enforcement gate

`uap worktree ensure --strict` is the gate used by CI and by the per-edit
hook. It checks whether the current working directory is inside a
`.worktrees/` path and exits non-zero if it is not:

```bash
uap worktree ensure --strict   # exit 0 inside a worktree, exit 1 otherwise
```

In strict mode, when you are *not* in a worktree, it prints the remediation and
fails hard:

```
NOT in a worktree. All file edits are prohibited.
  Run: uap worktree create <slug>
  Then: cd .worktrees/<id>-<slug>/
```

Without `--strict`, `ensure` is advisory: it lists active worktrees (flagging
any sitting on `master`/`main`) and suggests next steps instead of exiting
non-zero. The strict variant is what you wire into a CI step or a pre-edit
check; the advisory variant is for interactive orientation.

The same `.worktrees/` containment is enforced at edit time by the
`worktree-required` policy enforcer — see [POLICIES.md](./POLICIES.md).

## Parallel-agent safety

The numeric ID is allocated from the SQLite registry, not from a directory
scan, so two agents calling `create` at the same moment get distinct IDs and
distinct branches. Because each agent operates in its own worktree directory on
its own branch, their edits, builds, and commits are fully isolated — the only
shared point is `origin/master`, which each branch syncs against at `pr`/`finish`
time. This is what makes conflict-free parallel agent execution possible.

## Command reference

All commands are subcommands of `uap worktree`, registered in
[`src/bin/cli.ts`](../../src/bin/cli.ts) and implemented in
[`src/cli/worktree.ts`](../../src/cli/worktree.ts).

### `create <slug>`

Create a new worktree and feature branch for `<slug>`.

| Flag | Description |
|------|-------------|
| `-f, --from <branch>` | Base branch (defaults to the fetched `origin/<default>`) |
| `--no-fetch` | Skip the base fetch (offline; accepts a possibly stale base) |
| `-d, --description <description>` | Optional worktree description |

```bash
uap worktree create add-user-auth
uap worktree create fix-login-bug --from master
```

Produces a branch `feature/NNN-add-user-auth` and a checkout at
`.worktrees/NNN-add-user-auth/`, where `NNN` is the next zero-padded ID.

### `list`

List all git worktrees under `.worktrees/`, with their ID, name, branch, and
path.

```bash
uap worktree list
```

### `pr <id>`

Create a pull request from the worktree identified by `<id>`. Syncs the branch
with `origin/master`, pushes it, then runs `gh pr create --fill`.

| Flag | Description |
|------|-------------|
| `--draft` | Create the PR as a draft |

```bash
uap worktree pr 7
uap worktree pr 7 --draft
```

### `finish <id>`

End-to-end landing: sync with `origin/master`, push, ensure a PR exists, merge
it (`gh pr merge --merge`), delete the remote branch, and then clean up the
worktree.

```bash
uap worktree finish 7
```

### `cleanup <id>`

Remove the worktree directory, delete the local and remote branch, and mark the
registry entry as `cleaned`. Use this to tear down a worktree without merging.

```bash
uap worktree cleanup 7
```

### `ensure`

Check whether you are working inside a worktree.

| Flag | Description |
|------|-------------|
| `--strict` | Exit with code 1 if not in a worktree (for use as a gate) |

```bash
uap worktree ensure            # advisory: list options
uap worktree ensure --strict   # gate: exit non-zero if not in a worktree
```

### `prune`

Prune stale worktrees from the registry and disk.

| Flag | Description | Default |
|------|-------------|---------|
| `-o, --older-than <days>` | Only prune worktrees older than N days | `30` |
| `-f, --force` | Skip the confirmation prompt | off |
| `-n, --dry-run` | Preview without making changes | off |

```bash
uap worktree prune --dry-run
uap worktree prune --older-than 14 --force
```

Stale worktrees are selected by age from the registry; pruning deletes the
worktree directory and removes the registry row.
