# Parallel Agents: Staying Collision-Free and Current

How several agents work one codebase at once without overwriting each other, and
without drifting away from the branch everything has to merge into.

## The two failure modes

Only one of these is what people mean by "merge conflict", and it is the less
expensive one.

| | Concurrent collision | Sequential drift |
|---|---|---|
| **What happens** | Two agents hold the same file at the same moment | Agent A lands a change; agent B's branch predates it and was never re-synced, so B edits a stale copy |
| **Who notices** | Git, loudly, at merge time | Nobody. B's merge silently reverts A's work, or a model "resolves" the conflict by keeping its own version |
| **Covered by** | Live-agent lock in `coordinate-file.sh` | Everything on this page |

This repo currently has **151 worktrees; the worst is ~1242 commits behind
`origin/master`; 24 hold unmerged commits and 15 have uncommitted files.** A
worktree created during the audit that produced this system was born 1 commit
behind, because creation read local `HEAD` and never fetched.

Those numbers are the *starting* state, not a solved problem — the layers below
stop it getting worse and make it visible. Reconciling the existing backlog is a
`uap worktree hygiene` / `uap worktree prune` job.

## The layers

Each layer catches what the one before it cannot. All of them fail **open** — no
remote, no git, or an unavailable coordination DB always allows the edit.

### 1. Fresh at birth

`uap worktree create <slug>` fetches and bases the new branch on
`origin/<default>`, not on whatever the local checkout happens to have at HEAD.

```bash
uap worktree create my-feature              # branches from the fetched remote tip
uap worktree create my-feature --from x     # explicit base still wins
uap worktree create my-feature --no-fetch   # offline; accepts a possibly stale base
```

The default branch is resolved from `origin/HEAD`, then `origin/master`, then
`origin/main`, then the current local branch, with a final literal `master`
fallback if even that fails.

> If your integration branch is neither `master` nor `main` and `origin/HEAD` is
> unset (common on `--single-branch` clones), resolution falls through to *the
> branch you are standing on*. Set it once — `git remote set-head origin -a` — or
> pass `--from` explicitly.

### 2. Fresh while you work

```bash
uap worktree sync              # run from INSIDE a worktree — syncs the cwd
uap worktree sync --id 117     # a specific worktree, from anywhere
uap worktree sync --all        # every worktree
```

With no flags it operates on the current directory and does not verify that it is
a worktree — run it from the main checkout and it merges into whatever branch that
checkout is on. Worktrees with uncommitted changes are skipped, not merged.

Previously the only sync happened at `uap worktree finish` — the most expensive
possible moment to discover a conflict. Sync early and often instead.

### 3. Blocked from overwriting landed work

Before any worktree edit, `coordinate-file.sh` checks whether **that specific
file** changed on the integration branch since your branch's merge-base. If it
did, the edit is blocked:

```
STALE FILE: src/cli/worktree.ts has changed on origin/master since your branch
point (you are 12 commits behind). Editing this copy risks silently reverting
work that already landed. Run 'uap worktree sync' first.
```

Scoped to the single file, so a stale branch touching untouched files keeps
working — no blanket freeze. The check depends only on git, so it still runs when
the coordination DB is missing. Its `git fetch` is throttled (default 600s) so it
never turns every edit into a network round-trip.

| Variable | Effect |
|---|---|
| `UAP_COORD_DRIFT=warn` | warn instead of block |
| `UAP_COORD_DRIFT=off` | disable |
| `UAP_COORD_FETCH_SECONDS` | fetch throttle (default 600) |

An in-progress merge, rebase, cherry-pick or revert is exempt — the files you must
edit to resolve a conflict are by definition the ones that moved upstream.

### 4. Blocked from drifting too far

The `branch-freshness` enforcer (`src/policies/enforcers/branch_freshness.py`)
warns at 50 commits behind and blocks at 200 — the backstop for a branch whose
whole model of the codebase has gone stale, where the eventual merge is a rewrite
rather than a merge. Where layer 3 is file-precise, this is branch-coarse.

```
branch-freshness: this worktree is 1242 commits behind origin/master (limit 200).
Edits here are being written against a codebase that has moved on, and the merge
will be a rewrite rather than a merge. Run `uap worktree sync` first.
```

| Variable | Effect |
|---|---|
| `UAP_FRESHNESS_WARN` | advisory threshold (default 50) |
| `UAP_FRESHNESS_BLOCK` | blocking threshold (default 200) |
| `UAP_NO_FRESHNESS=1` | disable |

Only worktree edits are in scope; the main checkout is governed by
`worktree-required`. Fails open on a repo with no remote. It is part of the
`team` policy scenario — `uap policy select` to enable it.

The same 200-commit figure drives the `STALE — safe to prune` marker in
`uap worktree hygiene`, which is a report, not a gate.

The 200-commit figure also drives the `STALE — safe to prune` marker in
`uap worktree hygiene`, which is a report, not a gate.

### 5. Serialized landing

Two independently-green PRs can still break each other on merge. That is not
hypothetical: PR #577 landed a legitimate infra file while a stale test asserting
its absence lived on master, turning CI red and blocking every version bump.

```bash
uap merge queue              # prints the plan only — never merges without --yes
uap merge queue --yes        # land one at a time, re-syncing impacted PRs after each
uap merge queue --yes --limit 3
```

Merging is irreversible and unattended, so **`--yes` is required**; the bare
command is a plan. At most 10 PRs per run by default (`--limit`). `--force` lands
PRs whose checks are not green — the CI safety this page argues for, deliberately
switched off.

Priority bands, highest first:

| Band | Matches |
|---|---|
| 0 | labels containing `p0`, `critical`, `hotfix`, `security` |
| 1 | labels containing `bug`, `fix`, `p1`; or branch `fix/…`, `hotfix/…` |
| 2 | everything else |
| 3 | branch `chore/…`, `docs/…` |

Note the docs/chore band matches on **branch name**, not title — a PR titled
`docs: …` on `feature/x` sorts into band 2. Ties break on smaller diff first, then
least-recently-updated. After each merge, every PR that touches the same files
**or the same ownership lane** is re-synced onto the new base before the next
merge. PRs whose checks are still running are skipped rather than waited on, so a
second run is often needed to drain the queue.

### 6. Prevention: ownership lanes

The layers above react to collisions. Lanes make them avoidable: partition the
tree so concurrent agents can be pointed at different areas.

`.uap-ownership.json` in the repo root — **tracked on purpose**, since a lane map
that cannot be committed cannot be shared between agents, clones or CI. An
untracked `.uap/ownership.json` overrides it for per-machine tweaks.

```json
{
  "lanes": {
    "cli":      ["src/cli/**", "src/bin/**"],
    "delivery": ["src/delivery/**"],
    "policy":   ["src/policies/**", "policies/**"]
  }
}
```

```bash
uap coord ownership                          # show the lane map
uap coord ownership src/cli/worktree.ts      # which lane, and is it held?
```

Unmapped paths belong to no lane and are never blocked, so a partial map degrades
to previous behavior rather than freezing work. Lanes feed the merge queue, where
they catch the semantic conflict that file-overlap misses entirely: two PRs
editing *different* files in the same module.

> Lanes are currently **advisory plus merge-queue input**. The scheduling
> primitive that would hand agents disjoint lanes automatically
> (`selectDisjoint`) is exported and tested but has no production caller yet — no
> scheduler consumes it. Today you consult lanes; nothing assigns by them.

### 7. Hygiene

Silent accumulation is how parallel work gets lost.

```bash
uap worktree hygiene           # per-worktree drift, unmerged commits, dirty files
uap worktree hygiene --brief   # one-line advisory (used by the session banner)
uap worktree prune --older-than 30
```

The session banner surfaces the advisory automatically when anything needs
attention, and stays silent otherwise.

## Recommended loop

```bash
uap worktree create my-feature     # fresh base, guaranteed
# ... work; the drift check blocks you if a file moves under you ...
uap worktree sync                  # cheap, do it often
uap worktree pr <id>
uap merge queue                    # land serialized, re-sync the rest
```
