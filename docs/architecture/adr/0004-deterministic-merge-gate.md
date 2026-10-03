# ADR 0004: The deterministic merge gate — evidence, not testimony

- Status: Accepted
- Date: 2026-10-03 (branch `feature/332-merge-gate`, Choir-uplift PR 2 of 2)
- Guide: `docs/guides/MISSIONS.md` (Merge gate section) · Visual: `docs/visual/merge-gate.html`
- Builds on: ADR-0003 (mission orchestrator; this gate is the landing half of the seam ADR-0003 documented)

## Context

ADR-0003's orchestrator keeps a mission moving until a deliver run reports DONE
against frozen acceptance. But a DONE report is **testimony**, not evidence:
a run can claim delivery with a stub still in the diff, with its final
iteration actually failing, under acceptance criteria a later replan has
superseded, or — worst case — in a diff that also rewrites the very gates that
would judge it. Choir's merge discipline contributes the closing insight: the
merge is the moment to recompute the verdict deterministically from recorded
evidence, before the work becomes irreversible.

The merge queue (`uap merge queue`) already serializes landings and re-syncs
impacted PRs, but its pre-merge check was only `gh pr checks` — CI greenness.
CI cannot see mission semantics at all.

## Decision

Four deterministic checks run between a mission-linked PR and master. All four
are recomputed from recorded evidence at gate time — no model calls (the
acceptance judge already ran inside deliver; the gate verifies its recorded
outcome, it does not re-judge), and no parsing of acceptance text out of
instruction strings (the ADR-0003 seam: `verifyAcceptanceHash`, the marker
hash, the attempt ledger).

1. **Provenance / statement immutability.** The PR's `[mission:#N:<hash8>]`
   marker must match the mission's CURRENT frozen acceptance hash. A PR cut
   before a replan was built to superseded criteria — it fails, even though
   its CI is green. Independently, the ledger itself must be intact: the stored
   acceptance text must still hash to the stored hash (`verifyAcceptanceHash`),
   so a hand-edited `.uap/missions.db` cannot launder acceptance.
2. **Green recompute.** Tier 1: the gate-evidence artifact deliver records on
   success (`.uap/evidence/<candidateSha>.json`, uplift 1.4) — every gate's
   exit code bound to the exact HEAD it proved. Production delivered runs
   persist WITHOUT a run checkpoint (deliver clears it on success), so the
   artifact, not run-state history, is the seam that survives a real
   delivery; a present-but-invalid artifact (red gate exit, environment
   hatch, candidate-sha drift, malformed JSON) is a hard failure. Tier 2:
   when no artifact was checked, run-state history must show a passing final
   iteration (and 100% acceptance when the judge ran). Tier 3 is refused:
   a bare `delivered` status with no artifact and no history is testimony,
   not evidence. Status is read FRESH from disk, and when both pids are
   known the run-state pid must match the pid the orchestrator spawned
   (PR-1 provenance discipline). No salvage proposal may await a ruling —
   landing past an open proposal would bypass the approval gate. Note: a
   `history`-tier run whose `acceptanceMet` is undefined also covers the
   case where the acceptance judge itself errored mid-deliver (the
   convergence loop fails open and records no fraction) — closing that
   ambiguity is PR-1 follow-up, tracked there.
3. **Sorry-delta.** The ADDED lines of the diff (never removed lines —
   deleting a TODO is progress) are scanned for stub markers (`todo!()`,
   `NotImplementedError`, TODO/FIXME, placeholder implementations) in
   non-test, non-docs files (tests stub seams by design; docs quote the
   markers they describe), and for apology/escape phrasing ("sorry",
   "I couldn't", "unable to complete") in added lines and the run's
   declared summaries. Lines longer than 8 KB are skipped — a bounded-gap
   placeholder pattern was quadratic on adversarial multi-megabyte lines
   (security review).
4. **Axiom-honesty.** The diff may not touch gate infrastructure — enforcer
   hooks, CI workflows, policy enforcers, the quality baseline, the
   version-bump script, capacity policy, the merge gate and queue
   themselves, their evidence gatherer, and the mission ledger functions the
   first two checks consume — without explicit acknowledgment. DELETED,
   RENAMED, and BINARY gate-infra files are captured too (`git rm` on a
   hook is the purest form of weakening it). The prefix list is hard-coded
   in the gate's own source, not a config file: an externalized list could
   be edited by the very PR it judges, while any edit to the list trips
   axiom-honesty against the gate itself — the list protects itself by
   being the gate. A PR may not weaken (or rewrite) the checks that judge
   it. Acknowledgment is operator-visible: `--allow-gate-infra` on the CLI,
   or a `gate-infra` PR label in the queue. There is deliberately NO
   environment escape hatch (`UAP_*_OFF` is not consulted), and the queue's
   `--force` flag skips stale CI checks but NOT this gate — a force flag is
   exactly the gate-off escape this check exists to refuse.

The pure decision core is `evaluateMergeGate` (`src/delivery/merge-gate.ts`);
evidence gathering (`gatherGateEvidence`) and PR wiring (`gatePr`) live in
`src/cli/merge-gate.ts`. The queue gates only PRs carrying a mission marker;
unmarked PRs proceed as before (the gate is opt-in by provenance, not a tax
on every PR).

## Consequences

- `uap merge gate <missionId>` is the operator surface (also `--json` for CI).
- The queue skips (never force-merges) a PR whose gate fails, listing every
  failed check so an operator sees all reasons at once — the core reports a
  full finding list, not first-fail. A transient `gh pr diff` failure maps
  to a per-PR skip (`gate: error`), never a crash of the whole batch; the
  diff is fetched lazily, so marker-less PRs cost no extra `gh` calls.
- A delivered run's recorded history is trusted only in aggregate: status,
  final-iteration pass, acceptance fraction. The gate never trusts summaries
  as evidence of completion — summaries are scanned for apologies, which is
  the opposite direction of trust.
- Honest limits, recorded so the messages are not oversold: `verifyAcceptanceHash`
  detects only INCONSISTENT hand-edits (text edited without recomputing the
  stored hash); an attacker who edits both passes — it is a consistency
  check, not a signature. The PR marker is author-asserted: any collaborator
  can paste a green mission's marker into an unrelated PR, though doing so
  only ever ADDS checks (an omitted marker faces none), and the queue warns
  loudly about unmarked agent-style PRs on worktree-pattern branches. The
  residual trust bottom is the agent-writable `state.json`/evidence files
  themselves; the pid corroboration and the ledger-side attempt history
  narrow, but do not eliminate, that surface.
- A single marker gates only the mission it names; multi-mission PRs are
  follow-up work (extract all markers, require all linked missions to pass).

## Alternatives considered

- **Re-run the acceptance judge at merge time** — rejected: a model call at
  the gate makes the gate non-deterministic and re-bills the most expensive
  step to guard against a claim that was already judged once. The recorded
  fraction plus the stub/infra scans close the honest-failure modes
  deterministically.
- **Gate every PR through mission semantics** — rejected: PRs without
  missions (docs, chores) have no acceptance to verify; forcing a marker
  would create the exact kind of ceremony agents learn to game. Provenance
  opts a PR in.
- **Block gate-infra changes outright** — rejected: legitimate work sometimes
  IS the gate system (this PR). The requirement is acknowledgment, not
  prohibition — and the acknowledgment is recorded in the PR's labels where
  a reviewer sees it.
