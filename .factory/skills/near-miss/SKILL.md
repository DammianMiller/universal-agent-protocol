---
name: near-miss
version: "2.0.0"
compatibility: CLAUDE.md v2.3.0+
------
name: near-miss
version: "2.0.0"
compatibility: CLAUDE.md v2.3.0+
---

> **RTK Integration**: Supports `@hooks-session-start.md`, `@PreCompact.md`



> **RTK Integration**: Supports `@hooks-session-start.md`, `@PreCompact.md`

| name | description | argument-hint |
| --- | --- | --- |
| near-miss | Use when >50% of tests pass but not all. Focuses on fixing specific failing tests without breaking passing ones. Reserve 30% of time budget for this iteration loop. | failing test output or test names |


#
## Protocol Integration

### DECISION LOOP Position

This skill applies at **step 5** of the DECISION LOOP:

```
1. CLASSIFY  -> complexity? backup needed? tools?
2. PROTECT   -> cp file file.bak (for configs, DBs)
3. MEMORY    -> query relevant context + past failures
4. AGENTS    -> check overlaps (if multi-agent)
5. SKILLS    -> @Skill:near-miss.md for domain-specific guidance
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
# Near-Miss Iteration

## Detection
Test results show partial success: 8/9, 6/7, 5/6, or any >50% pass rate with failures remaining.

## Protocol
1. Run tests with verbose output to identify exact failures
2. Extract ONLY failing test names
3. Read failing test source code to understand the exact requirement
4. Fix the specific issue without touching passing code
5. Re-run ONLY the failing test first: `pytest test_file.py::test_name -v`
6. Then run full suite to verify no regressions
7. Repeat until 100% or time budget exhausted

## Rules
- **Reserve 30% of time** for this iteration loop
- Fix ONE test at a time -- do not batch fixes
- Never refactor passing code while fixing failures
- If a fix breaks a passing test, revert and try a different approach
- Never give up on a task that is >50% passing -- small fixes flip outcomes
- Read the assertion message carefully -- it often contains the expected value



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
