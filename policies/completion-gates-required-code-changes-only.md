# completion-gates-required-code-changes-only

**Category**: custom
**Level**: RECOMMENDED
**Enforcement Stage**: pre-exec
**Tags**: extracted, CLAUDE

## Rule

Claiming DONE is prohibited until ALL of the following pass:

1. **New tests** -- At least 2 new test cases covering changed behavior (vitest, `test/` dir)
2. **Testing** -- `npm test` passes with no failures
3. **Build** -- `npm run build` succeeds with zero errors
4. **Lint & Type-check** -- `tsc --noEmit` passes cleanly
5. **Version bump** -- `npm run version:patch/minor/major` based on commit type (no manual edits)
6. **Deployment** -- If touching deployable artifacts, staging deploy + smoke tests must pass
7. **Self-review** -- Diff reviewed for correctness, no debug code, no secrets, no unresolved TODOs

### Versioning

```bash
npm run version:patch   # fix, chore, refactor, docs, test, style, ci
npm run version:minor   # feat (new backwards-compatible functionality)
npm run version:major   # breaking changes (feat! or BREAKING CHANGE)
```

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
