---
name: polyglot
version: "2.0.0"
compatibility: CLAUDE.md v2.3.0+
------
name: polyglot
version: "2.0.0"
compatibility: CLAUDE.md v2.3.0+
---

> **RTK Integration**: Supports `@hooks-session-start.md`, `@PreCompact.md`



> **RTK Integration**: Supports `@hooks-session-start.md`, `@PreCompact.md`

| name | description | argument-hint |
| --- | --- | --- |
| polyglot | Use when tasks require code that compiles/runs in multiple languages simultaneously (polyglot programs). Requires exploiting language-specific comment syntax and parser quirks. | target languages (e.g. "C and Python") |


#
## Protocol Integration

### DECISION LOOP Position

This skill applies at **step 5** of the DECISION LOOP:

```
1. CLASSIFY  -> complexity? backup needed? tools?
2. PROTECT   -> cp file file.bak (for configs, DBs)
3. MEMORY    -> query relevant context + past failures
4. AGENTS    -> check overlaps (if multi-agent)
5. SKILLS    -> @Skill:polyglot.md for domain-specific guidance
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
# Polyglot Code Construction

## Detection
Keywords: "polyglot", "works in both", "compile as X and Y", "valid in both languages"

## Protocol
1. **Search for existing polyglot examples** for the target language pair before implementing
2. Identify comment syntax differences between languages:
   - C/C++: `//` and `/* */`
   - Python: `#` and `'''`/`"""`
   - Rust: `//` and `/* */`
   - Shell: `#`
3. Use comment-hiding technique: code for language A is hidden inside comments for language B
4. Test in BOTH compilers/interpreters separately
5. Verify exact output matches requirements for both

## Common Patterns
- **C + Python**: Use `#if 0` / `#endif` to hide Python from C, use `#` comments to hide C from Python
- **Rust + C**: Use `/*` / `*/` differences and macro tricks
- **Shell + Python**: Use `'''` as shell no-op and Python multi-line string

## Rules
- Always test with the exact compiler/interpreter versions specified
- Polyglot code often requires specific whitespace -- preserve it exactly
- Check for shebang requirements (`#!/usr/bin/env python3`)
- Use `chmod +x` if the file needs to be directly executable



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
