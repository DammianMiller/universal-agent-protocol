# quality-gate

**Category**: custom
**Level**: RECOMMENDED
**Enforcement Stage**: pre-exec
**Tags**: extracted, AGENTS

## Rule

When `.uap/quality-metrics.json` exists, the quality-metrics gate polices
complexity, coverage, duplication, and explicit `any` types on changed code:

- `uap quality check` - Check for new or worsened metric violations
- `uap quality baseline --update` - Freeze current debt into `.uap/quality-baseline.json` (reviewer sign-off required)

## Why

Extracted from AGENTS.md during `uap setup` — a project-specific rule promoted to a reviewable UAP policy.
