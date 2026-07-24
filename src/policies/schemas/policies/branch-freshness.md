# Policy: Branch Freshness

**ID**: `policy-branch-freshness`
**Name**: Work Against the Latest Integration Branch
**Category**: workflow
**Level**: REQUIRED
**Enforcement Stage**: pre-exec
**Version**: 1.0

## Purpose

Multiple agents working the same codebase in parallel lose each other's work in two
distinct ways. Only one of them is a "merge conflict".

1. **Concurrent collision** — two agents hold the same file at the same moment.
   Git surfaces this loudly at merge time. Handled by `coordinate-file.sh`'s
   live-agent lock.
2. **Sequential drift** — agent A lands a change; agent B's branch was cut before
   that and never re-synced, so B edits a stale copy. B's merge silently reverts
   A's work, or forces a conflict resolution that a model resolves by picking its
   own version. Git does NOT warn about this. This is the expensive one.

This policy addresses (2): work must be based on, and kept close to, the current
integration branch.

## Rules

```rules
- title: "Fresh Base"
  keywords: ["worktree", "branch", "create", "start work", "new feature"]
  antiPatterns: ["branch from stale local", "no fetch before branching", "based on local master", "detached stale base"]

- title: "Stale File Guard"
  keywords: ["edit", "write", "modify", "change file"]
  antiPatterns: ["edit file changed upstream", "ignore upstream change", "overwrite landed work", "revert merged change"]

- title: "Drift Ceiling"
  keywords: ["edit", "write", "worktree", "long-running branch"]
  antiPatterns: ["hundreds of commits behind", "never synced", "stale worktree", "abandoned branch still edited"]
```

## Enforcement Behavior

### When Triggered

- **Worktree creation** — `uap worktree create` fetches and bases the new branch on
  `origin/<default>` rather than whatever the local checkout has at HEAD.
- **Every worktree file edit** — two independent checks:
  - *file-precise* (`coordinate-file.sh`): blocks when the specific file being
    edited has changed on the integration branch since this branch's merge-base.
  - *branch-coarse* (`branch_freshness.py`): warns at 50 commits behind, blocks at 200.

### Required Actions

1. Cut branches from the fetched remote tip, never from a stale local ref.
2. Before editing a file that moved upstream, run `uap worktree sync` and re-apply
   the change on top of the landed version.
3. Keep a branch within the drift ceiling for its whole life; sync routinely rather
   than once at `finish`, when resolution is most expensive.
4. Land PRs through `uap merge queue` so each merge re-syncs the PRs it impacts.

### Overrides

| Variable | Effect |
|---|---|
| `UAP_COORD_DRIFT=warn` | file-precise check warns instead of blocking |
| `UAP_COORD_DRIFT=off` | disable the file-precise check |
| `UAP_NO_FRESHNESS=1` | disable the branch-coarse check |
| `UAP_FRESHNESS_WARN` / `UAP_FRESHNESS_BLOCK` | tune the drift thresholds |
| `uap worktree create --no-fetch` | branch offline, accepting a possibly stale base |

All checks fail **open**: no remote, no git, or an unreadable coordination DB
allows the edit. Coordination being unavailable must never stop work.

## Rationale

Measured on this repository before these gates existed: 151 worktrees, the worst
1241 commits behind `origin/master`, 23 holding unmerged commits and 15 with
uncommitted files. A worktree created during that audit was born 1 commit behind
because creation read local `HEAD` and never fetched. None of that drift was
visible to any gate, and none of it produced a warning at edit time.
