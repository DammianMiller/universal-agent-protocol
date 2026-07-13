# pay2u-architecture-rules

**Category**: safety
**Level**: REQUIRED
**Enforcement Stage**: pre-exec
**Tags**: pay2u, architecture, adr, invariants, example-pack

## Rule

These are load-bearing. If an edit would violate one of them, STOP and
surface the conflict — do not silently work around it.

| Rule ID        | Invariant                                                                  | ADR        |
| ---------------- | ---------------------------------------------------------------------------- | ------------ |
| COOKIE-ONLY | Bearer tokens stay inside the cluster. FE holds only the httpOnly cookie. | ADR-0007 |
| ZITADEL-IDP | Zitadel is the sole OIDC provider. No second IdP without ADR update. | ADR-0004 |
| OO-UNIFIED | Unified observability plane — no parallel stacks. | ADR-0005 |
| PIPELINE-ONLY | Infrastructure changes only via pipeline (no manual prod edits). | ADR-0006 |
| THREE-CLUSTERS | Three independent cluster concerns must stay independent. | ADR-001 + contracts/critical_clusters.rego |

Full ADR index: `docs/adr/`. UAP policies enforce these at tool-call time
(see `agents/data/memory/policies.db`); when a policy blocks a call, read
the relevant ADR first, then adjust the plan.

---

## Why

Extracted from AGENTS.md during `uap setup` — a project-specific rule promoted to a reviewable UAP policy.
