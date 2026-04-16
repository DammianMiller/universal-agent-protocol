# doc-live-over-report

**Category**: quality
**Level**: REQUIRED
**Enforcement Stage**: pre-exec
**Tags**: docs, hygiene, debt

## Rule

New files matching these patterns under `infra/**`, `docs/**`, or repo root are BLOCKED:

- `*_REPORT.md`
- `*_COMPLETE.md`
- `*_SUMMARY.md`
- `*_FIX_<date>.md`, `*_<YYYY-MM-DD>.md`
- `*_PLAN.md` (use tasks, not doc files)

Agents MUST update canonical README.md / runbooks instead.

## Why

The repo contains ~30 retrospective markdown reports under `infra/` — they rot, nobody reads them, and they bury live docs. The user's global rule: truth lives in code + canonical docs, not dated reports.

## Enforcement

Python enforcer `doc_live_over_report.py` inspects the target path of `Write` operations and rejects matching filenames.

```rules
- title: "No dated retrospective doc files"
  keywords: [write, create-file, markdown]
  antiPatterns: [_REPORT.md, _COMPLETE.md, _SUMMARY.md, _PLAN.md, _FIX_]
```
