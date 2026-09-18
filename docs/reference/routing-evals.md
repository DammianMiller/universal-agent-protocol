# Routing Evals

CI-enforced measurement of how well UAP's routable surfaces stay separable as
the registry grows: the pattern library (`.factory/patterns/index.json`), the
droid registry (`.factory/droids/`), and skills (`.factory/skills/`).

This is item 0.4 of the
[System-1 uplift plan](../plans/system1-uplift-2026-09-18.md) (lands with the
plan PR; merge order: plan first), after the
agent-dev-team precedent: rank-1 routing evals with planted traps, enforced in
CI, so a new or edited description that collides with an existing entry fails
the build instead of silently degrading routing.

This is a **separability proxy**, not a replica of production routing — the
production pattern router is keyword-substring multi-match, and droids/skills
are routed by the LLM reading descriptions. The report includes the production
router's fixture inclusion rate as an informational baseline alongside the
TF-IDF rank-1 numbers.

## Running

```bash
npm run eval:routing                  # console report, exit 1 below threshold
npm run eval:routing -- --json        # machine-readable report
npm run eval:routing -- --threshold 0.95
```

The same eval also runs as a vitest gate (`test/routing-eval.test.ts`, the
"shipped corpus eval" block) and in the `routing-evals` GitHub workflow.

## How it works

1. **Corpus loading** (`src/evals/routing-corpus.ts`): patterns, droids, and
   skills become uniform entries keyed `<kind>:<id>`. Entries without a
   frontmatter description fall back to their first body paragraph and are
   reported as *weak entries* — an unroutable-surface finding in itself.
2. **Ranking** (`src/evals/tfidf.ts`): pure-TypeScript TF-IDF with naive
   suffix stemming and stopword removal. No embedding model, no network —
   airgap-pure and deterministic.
3. **Evaluation** (`src/evals/routing-eval.ts`): fixtures in
   `evals/routing/cases.json` declare a kind, a natural-language query, and
   the expected entry id. Ranking is **kind-scoped** (patterns only against
   patterns, etc.), matching how the surfaces are actually consumed.

## Gate semantics

- **Rank-1 accuracy ≥ 90%** over positive cases (configurable via
  `--threshold`).
- **Negatives are hard-gated**: a case with `expect: null` fails the whole run
  when its top match shares **2+ distinct content tokens** with the query (a
  route claim resting on a single shared word is not a route), or scores above
  a 0.5 cosine backstop. This is ranker-agnostic by design — calibration showed
  raw cosine cannot separate near-domain negatives (single high-idf token, up
  to ~0.31) from weak positives (down to ~0.23). False-routing garbage input
  is not a percentage-point problem.
- **Fixture integrity**: a case referencing an entry that no longer exists is
  an error, not a failure — stale fixtures can never silently shrink the eval.

Local runs read the working tree, so untracked `.factory/` leftovers enter
the corpus; CI checkouts are clean, so the gate is deterministic there.
Local failures that CI doesn't reproduce usually mean untracked files.

## Maintaining fixtures

- Add one positive case per new pattern/droid/skill when you add the entry.
- Add a trap (`"trap": true`) whenever two entries are confusable — the
  diff-scoped vs proactive reviewer pairs are the canonical example. A trap
  must still have one defensibly correct answer.
- If a legitimate case fails, prefer improving the entry's description (that
  is the eval working as intended) over rewording the query to dodge the
  collision.
