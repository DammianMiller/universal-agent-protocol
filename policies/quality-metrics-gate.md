# quality-metrics-gate

**Category**: custom
**Level**: RECOMMENDED
**Enforcement Stage**: pre-exec
**Tags**: extracted, CLAUDE

## Rule

This project polices software-quality metrics deterministically. When
`.uap/quality-metrics.json` exists (create with `uap quality init`), the
gate enforces at edit time (proxy enforcer `quality_metrics_gate.py`) and at
commit/CI time (`npm run quality`):

- Cyclomatic complexity < 22 and cognitive complexity < 22 per function
- Halstead difficulty < 80 (with rust-code-analysis installed)
- LOC < 500 per file
- Coverage 100% (vitest `coverage/coverage-summary.json`)
- CRAP < 25 per function (cc²·(1−cov)³ + cc)
- Surviving mutants 0 — `npm run quality:mutate` (Stryker incremental, changed files)
- Dead code 0 (knip/vulture when installed), duplicated blocks 0 (jscpd)
- Explicit `any`/`unknown` types: 0

Existing debt is frozen in `.uap/quality-baseline.json` (`uap quality
baseline --update`): only NEW or WORSENED violations block. Regenerating the
baseline is a deliberate act — do it only with reviewer sign-off. External
tools are optional: missing ones skip their metric with a warning; the
built-in scanner (LOC, complexity, any-types) always runs. Escape hatch:
`UAP_QUALITY_GATE_OFF=1`.

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
