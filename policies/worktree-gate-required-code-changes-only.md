# worktree-gate-required-code-changes-only

**Category**: custom
**Level**: RECOMMENDED
**Enforcement Stage**: pre-exec
**Tags**: extracted, CLAUDE

## Rule

Before editing ANY source file, verify you are working inside a worktree:

1. Run `uap worktree ensure --strict` -- must exit 0
2. If not in a worktree, run `uap worktree create <slug>` first
3. All file paths in edit operations must be under `.worktrees/NNN-<slug>/`
4. Never edit files in the project root directory
5. Version bumps must be done on the feature branch, not master

This gate applies to ALL file types: .ts, .md, .json, .sh, .yaml, configs, tests, docs.
No exceptions for "small changes", "just docs", or "version bumps".

**Read-only tasks** (analysis, diagnostics, queries) do NOT require a worktree.

---

---

---

---

---

---

---

---

---

---

---

---

---

---

---

---

---

---

---

---

---

---

---

---

---

## Why

Extracted from CLAUDE.md during `uap setup` — a project-specific rule promoted to a reviewable UAP policy.
