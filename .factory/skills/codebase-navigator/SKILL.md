---
name: codebase-navigator
version: "2.0.0"
compatibility: CLAUDE.md v2.3.0+
------
name: codebase-navigator
version: "2.0.0"
compatibility: CLAUDE.md v2.3.0+
---

> **RTK Integration**: Supports `@hooks-session-start.md`, `@PreCompact.md`



> **RTK Integration**: Supports `@hooks-session-start.md`, `@PreCompact.md`

| name | description | argument-hint |
| --- | --- | --- |
| codebase-navigator | Use roam-code for fast codebase comprehension. Replaces multi-step grep/read exploration with single graph queries. Use before editing unfamiliar code, before multi-file refactors, and at session start. | symbol name, file path, or "health" |


#
## Protocol Integration

### DECISION LOOP Position

This skill applies at **step 5** of the DECISION LOOP:

```
1. CLASSIFY  -> complexity? backup needed? tools?
2. PROTECT   -> cp file file.bak (for configs, DBs)
3. MEMORY    -> query relevant context + past failures
4. AGENTS    -> check overlaps (if multi-agent)
5. SKILLS    -> @Skill:codebase-navigator.md for domain-specific guidance
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
# Codebase Navigator (roam-code)

Roam pre-indexes the codebase into a semantic graph (symbols, dependencies, call graphs, git history).
One command replaces 5-10 tool calls.

## When to Use
- **Before editing unfamiliar code**: `roam context <symbol>` gives callers, callees, affected tests, exact line ranges
- **Before multi-file changes**: `roam preflight <file>` shows blast radius + tests + complexity
- **At session start**: `roam health` for codebase overview (score 0-100)
- **Before committing**: `roam diff` shows blast radius of uncommitted changes
- **Finding symbols**: `roam search <pattern>` finds symbols ranked by PageRank

## Core Commands
```bash
roam understand              # Full codebase briefing
roam context <symbol>        # Files-to-read with exact line ranges
roam preflight <symbol>      # Blast radius + tests + complexity
roam health                  # Composite health score (0-100)
roam diff                    # Blast radius of uncommitted changes
roam search <pattern>        # Find symbols by name
roam file <path>             # File skeleton with definitions
roam deps <path>             # What a file imports / what imports it
roam impact <symbol>         # What breaks if this changes
```

## Rules
- Run `roam index` if the codebase changed significantly (auto-incremental otherwise)
- Prefer `roam context` over manual grep chains -- it's faster and more accurate
- Output is optimized for LLM consumption (compact, line ranges, no decoration)
- `--json` flag available on all commands for structured output



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
