# Evidence-Bound Ship (gate evidence)

> Policy: `evidence-bound-ship` · Enforcer: `src/policies/enforcers/evidence_bound_ship.py`
> · Writer: `src/delivery/gate-evidence.ts` · Escape hatch: `UAP_EVIDENCE_GATE_OFF=1`
> (operator launch environment only)

A deliver mission ends with its gates green against some `HEAD`. That `HEAD` is
the merge candidate a later ship action publishes. **Evidence binding** makes
the candidate carry its proof: at ship time, the enforcer requires a
machine-recorded artifact showing the mission's gates passed for *exactly* the
commit being shipped — not for some earlier or later tree.

## The contract

Ship-class actions (same detection as `expert-review-required`: `git commit` /
`push` / `merge`, `gh pr create` / `merge` / `ready`, pr-ready / signoff) are
**blocked** unless `.uap/evidence/<head-sha>.json` exists and validates:

```json
{
  "version": 1,
  "candidateSha": "<full HEAD sha the gates prove>",
  "recordedAt": "<ISO-8601>",
  "runId": "<deliver run id, optional>",
  "hatches": ["<gate-affecting env vars set at deliver time, audit only>"],
  "gates": [
    {
      "name": "test",
      "command": "npm test",
      "exitCode": 0,
      "outputTail": "<last ≤2000 chars of combined output>",
      "at": "<ISO-8601>"
    }
  ]
}
```

| Check | Rejection |
|---|---|
| Artifact missing | BLOCK — commit, then run `uap deliver` to record evidence for this HEAD |
| Oversized (>512KB) | BLOCK — read is capped before parsing; a payload is not evidence |
| Not parseable JSON | BLOCK — delete and re-run `uap deliver` |
| `version` ≠ 1 | BLOCK — re-record with the current CLI |
| `candidateSha` ≠ HEAD | BLOCK — evidence for a different commit proves nothing about this one |
| `recordedAt` < commit time | BLOCK — backdated (the commit did not exist to be gated yet); an *unresolvable* commit time also BLOCKs (fail-closed on anomaly) |
| `recordedAt` > now + 5min | BLOCK — future-dated (forged, or a badly skewed clock) |
| `recordedAt` older than the staleness window | BLOCK — stale; re-run `uap deliver` |
| No gate with `exitCode: 0` + `command` + `at` | BLOCK — empty/forged artifacts are not evidence |

The enforcer **fails closed** on every ambiguity. The only fail-open is a tree
that is not a git repository (or git itself missing) — non-UAP trees are
unaffected. It uses local git + the filesystem only: no network, no `gh`, and
it never throws uncaught inside the live policy chain.

## How deliver emits evidence

`uap deliver` records the artifact at the single completion seam every runner
kind (single / phased / orchestrated / ci-reconverge) converges on, right where
the run's outcome is persisted (`completeDeliveryTask` /
`recordDeliveryOutcome` in `src/cli/deliver.ts`). The gates come from the
**last passing** iteration's rung results — or, when the tree was already green
and the run short-circuited as `alreadyDelivered`, from the **baseline ladder
run** (`DeliveryResult.baselineGates`), so the commit → deliver → ship flow
never dead-ends. Emission is **fail-soft**: a warning is the whole failure
mode, so evidence recording can never break a mission.

The writer **refuses a dirty working tree** (`git status --porcelain` must be
empty): evidence claims the gates passed for `<sha>`, and with uncommitted
changes they provably ran against HEAD-plus-delta. The supported flow is:
commit the candidate, run `uap deliver` (baseline goes green, evidence binds
the clean HEAD), ship.

Writes are atomic (tmp + rename), and `.uap/` is git-ignored — evidence is a
local record, never committed payload.

Per-gate `at` is **reconstructed**, not measured: rungs carry durations but no
wall-clock finish time, so a gate's stamp is the recording time minus the
durations of the gates that ran after it. Honest ordering, approximate clock.

## Forgery resistance

`.uap/evidence/` is listed in enforcement-self-protect's `PROTECTED_TARGETS`
with **no agent carve-out**, and the interpreter-write rule (built for the
trust anchors) covers the directory too: shell redirects, Write/Edit tool
calls, `python3 -c`, `node -e`, and heredoc-fed interpreter writes are all
refused. The deliver CLI writes artifacts; the agent cannot. The trust root is
"only the tooling could have written this".

## Scope & limitations

This gate is a **local** perimeter, and it is honest about what that means:

- **Enforcement fires only on ship actions routed through the local policy
  chain.** A merge pressed in the GitHub web UI, or a push from a machine
  without the chain installed, never consults the enforcer. The remote-side
  complement is ordinary branch protection / required status checks; this
  policy is the local half, not a replacement for it.
- **`.uap/` never reaches CI** — it is git-ignored by design, so evidence is
  not a portable attestation another machine can verify. It proves something
  to *this* checkout about *this* HEAD.
- **`gh pr merge <N>` binds the LOCAL worktree HEAD.** The enforcer runs
  without network or `gh`, so it cannot resolve the PR's head ref. If the
  local branch has diverged from the PR head, the evidence validates the wrong
  commit. Ship from the branch you deliver on.
- **Squash/rebase merges mint a new remote commit** that no local evidence can
  bind — the merged SHA differs from the gated HEAD by construction. Treat
  those merges as covered by the remote-side controls above.
- **`git merge master` (upstream sync) requires evidence for HEAD**, the same
  as any ship action — consistent with `expert-review-required`. Re-run
  `uap deliver` on the synced tree first.
- **`--keep-best` rollback edge**: when a deliver run rolls the tree back to a
  pre-run snapshot, HEAD is unchanged but the recorded evidence describes the
  pre-rollback tree. The gates passed on that exact commit in both states, so
  the claim still holds — but the output tails describe a tree you may no
  longer have.

## Staleness semantics

Default window: **24 hours** from `recordedAt`. Rationale: evidence certifies a
commit, and a commit's content cannot drift — but the *environment* the gates
ran in can (dependencies updated, base branch moved, services changed). A day
is long enough to cover a normal deliver → review → ship cycle and short enough
that week-old green runs cannot launder a rebased branch. Operators can tune it
with `UAP_EVIDENCE_MAX_AGE_HOURS` in the **launch environment** — the agent
cannot set it (enforcement-self-protect refuses any assignment of the name,
inline or persisted, because a huge window quietly retires the check).

Note the flow-through consequence: ship gates bind evidence to `HEAD`, and the
writer requires a clean tree, so the order is commit → `uap deliver` → ship.
Amending or adding commits after the deliver run requires a fresh deliver run
to re-record evidence for the new candidate. That is the intended posture —
the gates must have passed on the exact commit being pushed.

## Escape hatch

`UAP_EVIDENCE_GATE_OFF=1` in the **launch environment** (operator-only). The
inline form (`UAP_EVIDENCE_GATE_OFF=1 git push`) is refused by
enforcement-self-protect — the agent composes its own command strings, so an
inline override would be self-granted, the same reasoning as `UAP_NO_REVIEW`.

## Related

- [Policies guide](../guides/POLICIES.md) — the executable policy framework
- [`uap deliver`](../guides/DELIVER.md) — the convergence harness that records evidence
- Schema doc: `src/policies/schemas/policies/evidence-bound-ship.md`
