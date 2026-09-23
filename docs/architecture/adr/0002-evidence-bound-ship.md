# ADR-0002: Evidence-bound merge candidates (gate evidence)

- **Status**: Accepted
- **Date**: 2026-09-18
- **Policy**: `evidence-bound-ship` (`src/policies/schemas/policies/evidence-bound-ship.md`)
- **Enforcer**: `src/policies/enforcers/evidence_bound_ship.py`
- **Writer**: `src/delivery/gate-evidence.ts` (emit seam: `src/cli/deliver.ts`)
- **Reference**: `docs/reference/evidence-bound-ship.md`

## Context

Deliver missions claim "all gates pass", but nothing bound that claim to the
commit a ship action actually publishes. An agent could run the gates on one
tree, then amend, swap, or dirty the commit and ship code the gates never saw —
the existing ship gates (`expert-review-required`) trusted a *review verdict*,
not machine proof tied to a SHA. Uplift 1.4 requires merge candidates to carry
their gate evidence.

Two properties make such evidence worth anything, and both shaped the design:

1. **The agent must not be able to write it.** A `.uap/evidence/<sha>.json`
   the agent can forge is worse than none — it converts "no proof" into
   "plausible proof". `.uap/evidence/` is therefore a self-protect
   PROTECTED_TARGET with no carve-out, and the interpreter-write rule
   (`python3 -c`, `node -e`, heredoc) covers the directory, because the
   verb-based Bash scan cannot see an interpreter-mediated write.
2. **The evidence must name the exact commit it proves.** Binding to "the
   branch" or "whenever the gates ran" re-admits the swap. So the artifact
   records `candidateSha = HEAD` and is only written against a **clean** tree —
   with uncommitted changes the gates provably ran against HEAD-plus-delta,
   and the claim would be unprovable.

## Decision

- The deliver CLI records `.uap/evidence/<head-sha>.json` at the single
  completion seam all runner kinds converge on, from the **last passing**
  iteration's rung results (or the baseline ladder run when the run
  short-circuits as `alreadyDelivered` — otherwise the supported commit →
  deliver → ship flow dead-ends on an already-green tree).
- The ship enforcer **fails closed** on missing, oversized (>512KB),
  malformed, wrong-version, SHA-mismatched, backdated, future-dated
  (>5min skew), stale (default 24h), or gate-empty evidence; an unresolvable
  commit time also blocks. The only fail-open is a tree that is not a git
  repository.
- Ship-action detection is **shared** with `expert-review-required` (imported
  `is_ship_action`) so the two gates can never disagree on what a ship is.
- Operator hatches are environment-only (`UAP_EVIDENCE_GATE_OFF=1`,
  `UAP_EVIDENCE_MAX_AGE_HOURS`); the agent cannot set either inline or
  persistently — enforcement-self-protect refuses the assignment text.

### Fail-soft emit / fail-closed gate asymmetry

Evidence **emission** never breaks a mission (a warning is the whole failure
mode): a deliver run must not fail because bookkeeping failed. The **gate**
fails closed: a ship without verifiable evidence is refused. The asymmetry has
a real recovery cost — when emission silently fails (dirty tree, unborn HEAD),
the operator's only feedback is a warning line, and the ship block arrives
later, detached from its cause. We accept this because the block message names
the fix (`commit, then re-run uap deliver`) and the escape hatch exists for
genuinely blocked operators. The alternative (fail-hard emission) would wedge
missions on a provenance feature; the other alternative (fail-open gate)
deletes the control.

## Consequences

- The supported flow is **commit → `uap deliver` → ship**. A deliver run that
  leaves the tree dirty emits no evidence (warns only); the subsequent ship is
  blocked until the candidate is committed and deliver re-run.
- **Local-only perimeter**: the gate fires only for ship actions routed
  through this machine's policy chain. GitHub-web merges and machines without
  the chain bypass it; squash/rebase merges mint a remote SHA no local
  evidence can bind. Branch protection / required status checks remain the
  remote-side complement (see the reference doc's Scope & limitations).
- `gh pr merge <N>` binds the **local** HEAD (no network/`gh` in the policy
  chain); shipping from a checkout diverged from the PR head validates the
  wrong commit and is blocked by design.
- Per-gate timestamps are reconstructed from rung durations, not measured —
  honest ordering, approximate clock; documented in the schema.
- The artifact carries a `hatches` audit field (which gate-affecting env vars
  were set at deliver time) so a reviewer can see the gates ran with e.g. the
  quality gate disabled; the enforcer deliberately does not act on it.
