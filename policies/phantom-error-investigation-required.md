# phantom-error-investigation-required

**Category**: custom
**Level**: RECOMMENDED
**Enforcement Stage**: pre-exec
**Tags**: extracted, CLAUDE

## Rule

When encountering errors that don't reproduce or seem inconsistent:
1. Reproduce independently on individual files
2. Clear caches (`.eslintcache`, `node_modules/.vite`, etc.)
3. Verify reported lines actually contain the problematic code
4. Only accept errors as valid after thorough investigation

## Why

Extracted from CLAUDE.md during `uap setup` — a project-specific rule promoted to a reviewable UAP policy.
