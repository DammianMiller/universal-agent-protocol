# quality-metrics-gate

**Category**: quality
**Level**: REQUIRED
**Enforcement Stage**: pre-exec
**Tags**: quality, complexity, coverage, mutation, duplication, metrics

## Rule

A `Write`, `Edit`, or `MultiEdit` to a source file whose post-edit content
violates the thresholds in `.uap/quality-metrics.json` is **blocked** unless
the violation is already recorded in `.uap/quality-baseline.json` at an
equal-or-worse value. This is a **ratchet**: existing debt is frozen in the
baseline, new or worsened debt is refused.

Default thresholds (configurable per project):

- Cyclomatic complexity < 22 per function
- Cognitive complexity < 22 per function
- Halstead difficulty < 80 per function (via rust-code-analysis, when installed)
- Lines of code < 500 per file
- Test coverage 100% (via coverage-summary.json, at commit/CI time)
- CRAP score < 25 per function (cc²·(1−cov)³ + cc)
- Surviving mutants: 0 (Stryker incremental on changed files, via `uap quality mutate`)
- Dead code: 0 (knip / vulture, when installed)
- Redundant code: 0 (jscpd, when installed)
- Explicit `any`/`unknown` types: 0

The gate is **inactive** (fails open) when `.uap/quality-metrics.json` is
absent — policing is opt-in per project via `uap quality init`. Languages
without installed tooling are skipped with a logged warning; the built-in
heuristic scanner (LOC, cyclomatic, cognitive, any-types) always runs for
TS/JS/Py/Java/C#/C/C++/Rust/Go and similar brace or indent languages.

## Why

Quality metrics only police outcomes when enforcement is deterministic and
immediate. An LLM reviewer asked "is cognitive complexity < 22?" estimates;
a gate that computes the number at edit time does not. The baseline ratchet
makes the strict thresholds adoptable on real codebases: day one, the gate
enforces "never regress"; the baseline then only shrinks as debt is paid
down. Judgment calls (waivers, gaming detection — assertion-free tests,
complexity split into worse trivial functions) belong to the parallel expert
review, which consumes the machine report via the `quality` block of the
review artifact.

## Enforcement

Python enforcer `quality_metrics_gate.py` (stdlib-only) computes the fast-path metrics
(LOC, cyclomatic, cognitive, any-types) on the reconstructed post-edit content
and ratchets against `.uap/quality-baseline.json`. It mirrors
`src/quality/{scanner,complexity,baseline}.ts` — a parity test
(`test/quality/quality-gate-enforcer.test.ts`) locks the violation signatures
the two implementations produce, since the CLI-written baseline is consumed by
the enforcer.

Slow metrics (coverage, CRAP, Halstead, duplication, dead code, mutation) are
enforced by `uap quality check` at commit/CI time, not per edit.

Escape hatch: `UAP_QUALITY_GATE_OFF=1`. Deliberate debt acceptance:
`uap quality baseline --update` (committed, reviewable in git).

**Scanner upgrade caveat:** a baseline generated with the built-in heuristic
scanner uses heuristic signatures (`name@line`). Installing lizard or
rust-code-analysis later re-identifies complexity violations with
authoritative names/offsets, so previously grandfathered entries may block
once after the upgrade. Regenerate the baseline (`uap quality baseline
--update`) when adopting an external scanner.

```rules
- title: "New or worsened metric debt is blocked; the baseline only shrinks"
  keywords: [complexity, cyclomatic, cognitive, halstead, coverage, CRAP, mutation, duplication, dead code, any type, quality gate, ratchet]
  antiPatterns: ["function over complexity threshold", "file over 500 LOC", "explicit any", "untested new code", "baseline regeneration without review"]
```
