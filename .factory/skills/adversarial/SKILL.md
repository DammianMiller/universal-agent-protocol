---
name: adversarial
version: '2.0.0'
category: Security
priority: 9
triggers:
  - bypass
  - break
  - exploit
  - circumvent
  - evade
  - filter
  - XSS
  - injection
  - sanitize
compatibility: CLAUDE.md v2.3.0+
---

# Adversarial Thinking

> **Integration**: Load via `@Skill:adversarial.md` in DECISION LOOP step 5  
> **RTK Integration**: Supports `@hooks-session-start.md`, `@PreCompact.md`

## Overview

Adversarial thinking for security research, vulnerability assessment, and bypass testing. Requires attacker mindset while maintaining defensive best practices.

## When to Activate

Use this skill when tasks involve:

- Security testing or penetration testing
- Bypassing filters, validators, or rate limiters
- Vulnerability research (ethical/security contexts only)
- Understanding attack vectors for defense planning
- Testing input sanitization and validation

## Detection Keywords

"bypass", "break", "exploit", "circumvent", "evade", "filter", "XSS", "injection", "sanitize", "vulnerability", "penetration", "audit"

## Protocol Integration

### DECISION LOOP Position

This skill applies at **step 5** of the DECISION LOOP:

```
1. CLASSIFY  -> complexity? backup needed? tools?
2. PROTECT   -> cp file file.bak (for configs, DBs)
3. MEMORY    -> query relevant context + past failures
4. AGENTS    -> check overlaps (if multi-agent)
5. SKILLS    -> @Skill:adversarial.md for domain-specific guidance
6. WORK      -> implement (ALWAYS use worktree for ANY file changes)
7. REVIEW    -> self-review diff before testing
8. TEST      -> completion gates pass
9. LEARN     -> store outcome in memory
```

### Required Pre-Checks

Before applying adversarial patterns:

- [ ] **MANDATORY**: Worktree created (`uap worktree create <slug>`)
- [ ] Schema diff gate completed (if tests involved)
- [ ] Environment check performed
- [ ] Memory queried for relevant past failures
- [ ] Ethical guidelines confirmed (security research only)

## Attack Vector Enumeration

### Systematic Checklist

1. **Case variation**: `<ScRiPt>`, `SELECT` vs `select`
2. **Encoding**: URL encode (`%3C`), HTML entities (`&#60;`), Unicode (`\u003c`)
3. **Null bytes**: `%00` to truncate strings
4. **Double encoding**: `%253C` -> `%3C` -> `<`
5. **Context breaking**: Close existing tag/string before injecting
6. **Event handlers**: `onerror=`, `onload=`, `onfocus=`
7. **Alternative syntax**: Template literals, `eval()`, `Function()`
8. **Whitespace tricks**: Tabs, newlines, zero-width characters
9. **Protocol handlers**: `javascript:`, `data:`, `vbscript:`
10. **Mutation XSS**: HTML parser normalization differences

### Testing Protocol

- Test EACH vector until one works -- do not stop at first failure
- Document all vectors tried and results
- Use established libraries when building defenses (DOMPurify, bleach)

## Defensive Patterns

**CRITICAL: When building defense, ALWAYS use allow-list approach**

```python
# ❌ NEVER use blacklist/regex to filter malicious patterns
if re.search(r'<script|javascript:', user_input):  # WRONG

# ✅ Use established security libraries
import bleach
clean = bleach.clean(user_input, tags=[], attributes={})

# ✅ Or parameterized queries for SQL
cursor.execute("SELECT * FROM users WHERE id = ?", (user_id,))
```

## UAP Protocol Compliance

### Completion Gates Checklist

Before reporting task complete:

```
[x] Schema diffed against test expectations
[x] Tests: X/Y (must be 100%, run 3+ times)
[x] Outputs verified: ls -la
[x] Worktree created and PR prepared
[x] MANDATORY cleanup after PR merge
```

### Verifier-First Integration

If tests are involved:

1. **Schema Diff Gate**: Compare output schema against test expectations BEFORE running verifier
2. **Environment Check**: `python3 --version; which pip3 gcc make node npm`
3. **Run Verifier**: After each change, minimum 3 runs with TESTS output format

## Memory Integration

### Store Lessons Learned

```bash
uap memory store "Adversarial pattern: <pattern_name> bypassed <defense_type>" \
  --tags adversarial,<category> --importance 8
```

### Query Relevant Context

```bash
uap memory query "adversarial bypass <target_type>"
```

## Common Pitfalls

1. **Never skip worktree**: ALWAYS use `uap worktree create <slug>` before any file changes
2. **Never claim security via regex**: Use established libraries (bleach, DOMPurify)
3. **Never test on production**: Always use isolated environments
4. **Never forget cleanup**: Run `uap worktree cleanup <id>` after PR merge

## Success Criteria

- [ ] All tests pass (100%, 3+ runs)
- [ ] Schema verified against test expectations
- [ ] Worktree cleanup completed
- [ ] Lessons stored in memory
- [ ] No debug artifacts left behind
- [ ] Ethical guidelines followed

## References

- CLAUDE.md v2.3.0: Universal Agent Patterns (P1-P39)
- OWASP Top 10: https://owasp.org/www-project-top-ten/
- Pattern P10: Whitelist-First Sanitization
- Pattern P20: "bypass/break/exploit" Attacker Mindset

---

**Last Updated**: 2026-03-09  
**Compatibility**: CLAUDE.md v2.3.0+  
**RTK Includes**: `@hooks-session-start.md`, `@PreCompact.md`
