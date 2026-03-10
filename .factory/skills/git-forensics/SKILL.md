---
name: git-forensics
version: "2.0.0"
compatibility: CLAUDE.md v2.3.0+
------
name: git-forensics
version: "2.0.0"
compatibility: CLAUDE.md v2.3.0+
---

> **RTK Integration**: Supports `@hooks-session-start.md`, `@PreCompact.md`



> **RTK Integration**: Supports `@hooks-session-start.md`, `@PreCompact.md`

| name | description | argument-hint |
| --- | --- | --- |
| git-forensics | Use when tasks involve git recovery, corrupted repos, lost commits, reflog analysis, or git repo repair. Forensic approach required -- not standard git commands. | git error message or recovery goal |


#
## Protocol Integration

### DECISION LOOP Position

This skill applies at **step 5** of the DECISION LOOP:

```
1. CLASSIFY  -> complexity? backup needed? tools?
2. PROTECT   -> cp file file.bak (for configs, DBs)
3. MEMORY    -> query relevant context + past failures
4. AGENTS    -> check overlaps (if multi-agent)
5. SKILLS    -> @Skill:git-forensics.md for domain-specific guidance
6. WORK      -> implement (ALWAYS use worktree for ANY file changes)
7. REVIEW    -> self-review diff before testing
8. TEST      -> completion gates pass
9. LEARN     -> store outcome in memory
```
# Protocol Integration

### DECISION LOOP Position

This skill applies at **step 5** of the DECISION LOOP:

```
1. CLASSIFY  -> complexity? backup needed? tools?
2. PROTECT   -> cp file file.bak (for configs, DBs)
3. MEMORY    -> query relevant context + past failures
4. AGENTS    -> check overlaps (if multi-agent)
5. SKILLS    -> @Skill:<skill-name>.md for domain-specific guidance
6. WORK      -> implement (ALWAYS use worktree for ANY file changes)
7. REVIEW    -> self-review diff before testing
8. TEST      -> completion gates pass
9. LEARN     -> store outcome in memory
```
# Git Recovery Forensics

## Detection
Keywords: "recover", "corrupted", "lost commit", "fix git", "reflog", "fsck", "broken repo"

## Protocol
1. **BACKUP FIRST**: `cp -r .git .git.bak`
2. Check integrity: `git fsck --full --no-dangling`
3. Check reflog: `git reflog` (commits survive even after reset)
4. Check loose objects: `find .git/objects -type f`
5. Recover from pack files if needed: `git unpack-objects < .git/objects/pack/*.pack`
6. Try `git stash list` for stashed changes
7. Use `git log --all --oneline` to find orphaned branches

## Common Fixes
- **Corrupted HEAD**: `git symbolic-ref HEAD refs/heads/main`
- **Missing objects**: `git fetch origin && git reset --hard origin/main`
- **Detached HEAD with work**: `git reflog` then `git checkout -b recovery <hash>`
- **Broken index**: `rm .git/index && git reset`

## Rules
- **NEVER** run destructive commands without `.git.bak` backup
- Use `--dry-run` first for any destructive operation
- Check `git reflog` before anything -- commits almost always survive
- Use `git cat-file -t <hash>` to inspect object types



## UAP Protocol Compliance

### MANDATORY Worktree Enforcement

Before applying this skill:
- [ ] **MANDATORY**: Worktree created (`uap worktree create <slug>`)
- [ ] Schema diff gate completed (if tests involved)
- [ ] Environment check performed
- [ ] Memory queried for relevant past failures

### Completion Gates Checklist

```
[x] Schema diffed against test expectations
[x] Tests: X/Y (must be 100%, run 3+ times)
[x] Outputs verified: ls -la
[x] Worktree created and PR prepared
[x] MANDATORY cleanup after PR merge
```



## UAP Protocol Compliance

### MANDATORY Worktree Enforcement

Before applying this skill:
- [ ] **MANDATORY**: Worktree created (`uap worktree create <slug>`)
- [ ] Schema diff gate completed (if tests involved)
- [ ] Environment check performed
- [ ] Memory queried for relevant past failures

### Completion Gates Checklist

```
[x] Schema diffed against test expectations
[x] Tests: X/Y (must be 100%, run 3+ times)
[x] Outputs verified: ls -la
[x] Worktree created and PR prepared
[x] MANDATORY cleanup after PR merge
```
