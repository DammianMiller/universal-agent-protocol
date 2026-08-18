# rtk-wrap

**Category**: custom
**Level**: RECOMMENDED
**Default**: off
**Enforcement Stage**: pre-exec
**Tags**: rtk, tokens, efficiency

## Rule

Opt-in. Enable with `uap policy enable <id>`; disable with `uap policy disable <id>`.

When enabled, these commands SHOULD be invoked via the `rtk` wrapper rather than directly: `git`, `kubectl`, `docker`, `docker-compose`, `npm`, `pnpm`, `yarn`, `helm`, `terraform`.

Exceptions: `rtk` meta-commands (`rtk gain`, `rtk discover`, `rtk proxy`, `rtk --version`), and any invocation whose output will be PARSED — those must use `rtk proxy` (see below).

## Why

RTK delivers 60–90% token reduction on dev ops (`~/.claude/RTK.md`). Missing the wrap = proportional context waste.

## Why it is off by default

rtk rewrites command output for reading, and does not detect when the caller
asked for machine-readable output. Measured against real git in this repo:

| command | git | via rtk |
|---|---|---|
| `worktree list --porcelain` | 46 entries | **0 entries** |
| `branch --format='%(refname:short)'` | 55 refs | 142 lines, wrong set |
| `diff --name-only HEAD` | 3 paths | 3 paths + a `--- Changes ---` block |
| `status --porcelain` | 12 lines | 11 |

`rtk proxy git ...` is byte-exact on all of them.

While this policy was REQUIRED, that mangled output was what every agent read.
An agent parsing `^worktree ` out of `rtk git worktree list --porcelain` sees
nothing and concludes there are no worktrees — during a prune, the difference
between "skip" and "delete". The enforcer now routes parsed invocations to
`rtk proxy`, but the underlying trade is a judgement call, so it is offered
rather than imposed.

## Enforcement

Python enforcer `rtk_wrap.py` inspects the Bash command string and blocks if a wrapped binary is invoked without the `rtk ` prefix.

```rules
- title: "Wrap heavy CLIs with rtk"
  keywords: [bash, shell, git, kubectl, docker, npm, pnpm, yarn, helm, terraform]
  antiPatterns: [raw-kubectl, raw-git, raw-docker, raw-npm]
```
