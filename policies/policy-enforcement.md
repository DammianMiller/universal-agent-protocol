# policy-enforcement

**Category**: custom
**Level**: RECOMMENDED
**Enforcement Stage**: pre-exec
**Tags**: extracted, AGENT

## Rule

### Policy Levels

| Level | Behavior |
|-------|----------|
| REQUIRED | Blocks execution, throws `PolicyViolationError` |
| RECOMMENDED | Logged but does not block |
| OPTIONAL | Informational only |

### Creating a Policy

```markdown
<!-- POLICY: security-audit -->
# Security Audit Required

**Level**: REQUIRED
**Stage**: pre-commit

When modifying authentication-related files, ensure:
1. Input validation is implemented
2. CSRF tokens are validated
3. Rate limiting is configured
```

---

## Why

Extracted from AGENT.md during `uap setup` — a project-specific rule promoted to a reviewable UAP policy.
