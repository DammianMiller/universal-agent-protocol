# Policy: Mandatory Testing & Deployment Verification

**ID**: `policy-mandatory-testing-deployment`
**Name**: Mandatory Testing and Deployment Verification
**Category**: testing
**Level**: REQUIRED
**Enforcement Stage**: review
**Version**: 1.0

## Purpose

This policy enforces that all code changes MUST complete testing, deployment verification, and quality checks before a task can be marked as DONE or closed. This prevents incomplete work from being considered finished.

## Rules

```rules
- title: "Testing Requirement"
  keywords: ["done", "complete", "finish", "close", "resolve", "merge"]
  antiPatterns: ["incomplete test", "no test coverage", "untested code", "skip test"]

- title: "Deployment Verification Required"
  keywords: ["deploy", "production", "release", "push", "merge"]
  antiPatterns: ["unverified deployment", "no smoke test", "deployment failed"]

- title: "Quality Gate Enforcement"
  keywords: ["quality", "lint", "type-check", "coverage", "security"]
  antiPatterns: ["disable lint", "bypass type check", "low coverage", "security warning"]

- title: "Documentation Requirement"
  keywords: ["document", "readme", "api", "changelog", "migration"]
  antiPatterns: ["no documentation", "missing changelog", "undocumented change"]
```

## Enforcement Behavior

### When Triggered

This policy is enforced during the **review stage** when:

- Task status is being changed to DONE, COMPLETE, or CLOSED
- Pull request is being merged
- Deployment is being finalized
- Release is being published

### Required Actions Before Completion

1. **Testing Verification**
   - All unit tests must pass (≥80% coverage)
   - Integration tests must pass
   - E2E tests must pass for critical paths
   - No new test failures introduced

2. **Deployment Verification**
   - Deployment to staging/preview environment successful
   - Smoke tests passed in target environment
   - Rollback plan verified (if applicable)
   - No deployment warnings/errors

3. **Quality Checks**
   - Linting passes without errors
   - Type checking passes (for TypeScript projects)
   - Security scan shows no critical/high vulnerabilities
   - Performance benchmarks within acceptable range

4. **Documentation**
   - Code comments updated for public APIs
   - README.md updated if CLI/tools changed
   - Changelog entry added
   - Breaking changes documented

### Verification Checklist

Before marking work as DONE, verify:

- [ ] All tests passing (`npm test`, `yarn test`, etc.)
- [ ] Test coverage maintained or improved
- [ ] Code linting passes (`npm run lint`)
- [ ] Type checking passes (if TypeScript)
- [ ] Deployment to staging successful
- [ ] Smoke tests passed in staging
- [ ] No new security vulnerabilities
- [ ] Documentation updated
- [ ] Changelog updated
- [ ] Reviewers approved
- [ ] No unresolved TODOs or FIXMEs

### Anti-Patterns to Avoid

❌ **DO NOT** mark tasks as DONE when:

- Tests are failing or skipped
- Deployment hasn't been verified
- Code quality gates are bypassed
- Documentation is missing or outdated
- Critical bugs remain open
- Security warnings are ignored
- Rollback plan doesn't exist for breaking changes

## Implementation Notes

This policy should be enforced by:

1. **CI/CD pipelines** - Block merges if tests fail
2. **Code review tools** - Require passing quality checks
3. **Task management systems** - Block status changes without verification
4. **Policy gate system** - Validate before allowing completion commands

## Related Policies

- `policy-code-quality` - General code quality requirements
- `policy-security-gate` - Security scanning requirements
- `policy-deployment-safety` - Deployment safety checks

---

_Last Updated: 2026-03-18_
_Author: Miller Tech UAP System_
