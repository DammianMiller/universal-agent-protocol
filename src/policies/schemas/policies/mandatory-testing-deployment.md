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
- title: "Mandatory Test Creation"
  keywords: ["done", "complete", "finish", "close", "resolve", "merge"]
  antiPatterns: ["no new tests", "zero tests added", "skip test creation", "tests not written"]

- title: "Testing Requirement"
  keywords: ["done", "complete", "finish", "close", "resolve", "merge"]
  antiPatterns: ["incomplete test", "no test coverage", "untested code", "skip test"]

- title: "Version Bump Required"
  keywords: ["done", "complete", "finish", "close", "resolve", "merge", "push"]
  antiPatterns: ["manual version edit", "no version bump", "skip version", "version not bumped"]

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

1. **Mandatory Test Creation**
   - At least 2 new test cases MUST be written for every code change
   - Tests must cover the new or changed behavior (not unrelated code)
   - Tests must follow existing patterns: `test/<feature>.test.ts` using vitest (`describe`/`it`/`expect`)
   - Tests must assert correctness (not just "it doesn't throw")
   - Bug fixes: at least one test must reproduce the bug scenario
   - New features: tests must cover the happy path and at least one edge case

2. **Testing Verification**
   - All unit tests must pass including the new ones
   - Test coverage maintained or improved (no regression)
   - Integration tests must pass
   - E2E tests must pass for critical paths
   - No new test failures introduced

3. **Version Bump**
   - Version must be bumped via `npm run version:patch`, `version:minor`, or `version:major`
   - Manual edits to `package.json` version field are prohibited
   - Commit type determines bump level: fix->patch, feat->minor, breaking->major
   - CHANGELOG.md is updated automatically by the version script
   - Git tag is created automatically

4. **Deployment Verification**
   - Deployment to staging/preview environment successful
   - Smoke tests passed in target environment
   - Rollback plan verified (if applicable)
   - No deployment warnings/errors

5. **Quality Checks**
   - Linting passes without errors
   - Type checking passes (for TypeScript projects)
   - Security scan shows no critical/high vulnerabilities
   - Performance benchmarks within acceptable range

6. **Documentation**
   - Code comments updated for public APIs
   - README.md updated if CLI/tools changed
   - Changelog entry added (automated via version bump script)
   - Breaking changes documented

### Verification Checklist

Before marking work as DONE, verify:

- [ ] At least 2 new tests written for changed code
- [ ] New tests assert correctness (not just "doesn't throw")
- [ ] All tests passing (`npm test`)
- [ ] Test coverage maintained or improved
- [ ] Code linting passes (`npm run lint`)
- [ ] Type checking passes (`tsc --noEmit`)
- [ ] Version bumped via `npm run version:patch/minor/major`
- [ ] CHANGELOG.md updated (automated via version script)
- [ ] Git tag created (automated via version script)
- [ ] Deployment to staging successful (if applicable)
- [ ] Smoke tests passed in staging (if applicable)
- [ ] No new security vulnerabilities
- [ ] Documentation updated
- [ ] Reviewers approved
- [ ] No unresolved TODOs or FIXMEs

### Anti-Patterns to Avoid

❌ **DO NOT** mark tasks as DONE when:

- No new tests were written for code changes
- Tests are failing or skipped
- Version was not bumped or was bumped manually
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
