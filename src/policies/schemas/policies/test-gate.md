# test-gate

**Category**: quality
**Level**: REQUIRED
**Enforcement Stage**: review
**Tags**: testing, pr, quality

## Rule

At PR-ready time, every changed service under `services/**` or `apps/**` MUST have a corresponding test delta (`tests/**` or `<service>/**/*.test.*`, `*_test.py`, `*.spec.ts`).

## Why

Session-end logs show `Tests: false` far more often than `true`. Review-stage gating ensures shipping code without tests is an explicit override, not the default.

## Enforcement

Python enforcer `test_gate.py` diffs `git diff --name-only origin/main...HEAD` against test-path regexes; blocks PR signoff if any changed service lacks a test file in the same PR.

```rules
- title: "Changed services require test deltas"
  keywords: [pr, commit, merge, review, signoff]
  antiPatterns: [no-tests, skip-tests, tests-later]
```
