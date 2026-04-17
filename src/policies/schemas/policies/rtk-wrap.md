# rtk-wrap

**Category**: custom
**Level**: REQUIRED
**Enforcement Stage**: pre-exec
**Tags**: rtk, tokens, efficiency

## Rule

These commands MUST be invoked via `rtk` wrapper, not directly: `git`, `kubectl`, `docker`, `docker-compose`, `npm`, `pnpm`, `yarn`, `helm`, `terraform`.

Exception: `rtk` meta-commands (`rtk gain`, `rtk discover`, `rtk proxy`, `rtk --version`).

## Why

RTK delivers 60–90% token reduction on dev ops (`~/.claude/RTK.md`). Missing the wrap = proportional context waste.

## Enforcement

Python enforcer `rtk_wrap.py` inspects the Bash command string and blocks if a wrapped binary is invoked without the `rtk ` prefix.

```rules
- title: "Wrap heavy CLIs with rtk"
  keywords: [bash, shell, git, kubectl, docker, npm, pnpm, yarn, helm, terraform]
  antiPatterns: [raw-kubectl, raw-git, raw-docker, raw-npm]
```
