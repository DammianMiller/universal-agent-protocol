# blocking-prerequisites-code-changes-only

**Category**: custom
**Level**: RECOMMENDED
**Enforcement Stage**: pre-exec
**Tags**: extracted, CLAUDE

## Rule

Before any code change can proceed, these gates must pass in order:

1. **Schema Diff Gate** -- If the change touches schemas or API contracts, diff before and after.
2. **Worktree Gate** -- Must be working inside a worktree (not project root)
3. **Build Gate** -- `npm run build` must pass
4. **Test Gate** -- `npm test` must pass

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
