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

Before this system existed, this repo had **151 worktrees; the worst was 1241
commits behind `origin/master`; 23 held unmerged commits and 15 had uncommitted
files.** A worktree created during that audit was born 1 commit behind, because
creation read local `HEAD` and never fetched.

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

The default branch is resolved from `origin/HEAD`, then `master`, then `main` —
never hard-coded.

### 2. Fresh while you work

```bash
uap worktree sync              # merge the integration branch into this worktree
uap worktree sync --id 117     # a specific worktree
uap worktree sync --all        # every worktree
```

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

### 4. Blocked from drifting too far

The `branch-freshness` enforcer warns at 50 commits behind and blocks at 200 —
the backstop for a branch whose whole model of the codebase has gone stale.
Tune with `UAP_FRESHNESS_WARN` / `UAP_FRESHNESS_BLOCK`, disable with
`UAP_NO_FRESHNESS=1`.

### 5. Serialized landing

Two independently-green PRs can still break each other on merge. That is not
hypothetical: PR #577 landed a legitimate infra file while a stale test asserting
its absence lived on master, turning CI red and blocking every version bump.

```bash
uap merge queue --dry-run    # show the landing order and what each merge invalidates
uap merge queue              # land one at a time, re-syncing impacted PRs after each
```

Order is fixes → features → docs, then smaller diffs, then oldest. After each
merge, every PR that touches the same files **or the same ownership lane** is
re-synced onto the new base before the next merge.

### 6. Prevention: ownership lanes

The layers above react to collisions. Lanes stop them being possible: partition
the tree, and hand concurrent agents work from different lanes.

`.uap/ownership.json`:

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
to previous behavior rather than freezing work. Lanes also feed the merge queue,
where they catch the semantic conflict that file-overlap misses entirely: two PRs
editing *different* files in the same module.

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
