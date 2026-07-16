# commitment-reserve

**Category**: safety
**Level**: REQUIRED
**Enforcement Stage**: pre-exec
**Tags**: safety, reversibility, backup, restraint, never-go-full

## Rule

An **all-in move with no way back** is blocked until a reserve exists. Commit
hard to an approach — but never commit everything ("never go full": the ones
who hold something back are the ones who can still recover).

Matching is segment-anchored and quote-aware: a rule fires only when the
segment's leading verb is `git`/`rm`, so a `grep`, an `echo`, or a commit
message that merely *mentions* a destructive pattern never trips the gate.

Blocked without a reserve (`Bash`/`run_bash`):

- `git reset --hard` — reserve: `git stash` first (an inline
  `git stash && …` in the same command also counts).
- Forced push (`--force`, `-f`, `+refspec`) — `--force-with-lease` is allowed
  by this gate; if the project's git-safety hook blocks that too, the
  sanctioned fallback is a merge commit, not a bigger hammer.
- `git clean -f…` / `--force` — reserve: `git stash -u` first. Dry runs
  (`-n` / `--dry-run`) stay allowed.
- `git checkout`/`restore` wholesale discards — final arg `.`/`*`, including
  `checkout HEAD -- .`, `restore --worktree .`, and bare `checkout -f`.
- Recursive **and** forced delete (`rm -rf` and flag-order variants) of a
  protected source root (`src`, `test`, `tests`, `lib`, `tools`, `scripts`,
  the policy-definition dir), of the whole tree (`.`, `*`, `/`), or of a
  parent/home escape (`..`, `~`). Scratch/derived dirs stay allowed at any
  depth (`node_modules`, `dist`, `src/__pycache__`, `src/generated`, …) —
  they are reconstructible; source is not.

Blocked stub overwrites (`Write`):

- Overwriting an existing source file ≥ 4 KiB with content under 20% of its
  size — the signature of a real implementation being gutted into a stub.
  Reserve: back the file up to `.uap-backups/<today>/` first. The backup is
  **verified**: a real regular file (not a symlink) of at least half the
  original's size — an empty or unrelated same-named file does not count.
  Incremental `Edit` operations are never touched.

Unlocks:

- An inline reserve-**creating** stash (`git stash`, `git stash push`,
  `-u`/`--include-untracked`). Reserve-destroying or inert stash subcommands
  (`drop`, `clear`, `pop`, `list`, `show`, `apply`, `branch`) do **not**
  unlock.
- `UAP_RESERVE_OK=1` **only as a leading env assignment of the destructive
  segment itself** (set it only after creating the backup/stash). A mention
  elsewhere in the command does not count.
- A verified same-day `.uap-backups/` backup, for stub overwrites.

Operator overrides: `UAP_RESERVE_OK=1` / `UAP_COMMITMENT_RESERVE_OFF=1` in
the environment; `DELIVER_ACTIVE=1` sessions are exempt (the deliver harness
keeps its own snapshot reserve).

## Why

Every catastrophic agent incident on this project was a full-commitment
failure: real implementation files deleted into stubs to satisfy gates,
destructive resets that vaporized uncommitted work, force-pushes with nothing
held back. The rule is not "never do destructive things" — it is "destructive
moves are allowed only once something is held in reserve", so the recovery
path always stays open.
