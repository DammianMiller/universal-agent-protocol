# artifact-hygiene

**Category**: quality
**Level**: REQUIRED
**Enforcement Stage**: pre-exec
**Tags**: git, hygiene, artifacts

## Rule

Binary artifacts (`*.png`, `*.jpg`, `*.pdf`, `*.zip`, `*.tar.gz`, `*.db`, `*.sqlite*`) MUST NOT be committed outside:

- `docs/**`
- `tests/**/__screenshots__/**`
- `apps/**/public/**`, `apps/**/static/**`, `apps/**/assets/**`
- `agents/data/memory/**` (scoped state)

## Why

Repo root currently has 80+ loose audit PNGs, screenshots, and stale DBs — bloats the repo, confuses reviewers, breaks shallow clones. Keeping artifacts in curated subdirs preserves git performance.

## Enforcement

Python enforcer `artifact_hygiene.py` inspects `git status` / new Write targets and rejects blocked paths.

```rules
- title: "Binary artifacts belong in curated dirs"
  keywords: [write, create-file, commit, git-add]
  antiPatterns: [.png, .jpg, .zip, .tar.gz, .sqlite]
```
