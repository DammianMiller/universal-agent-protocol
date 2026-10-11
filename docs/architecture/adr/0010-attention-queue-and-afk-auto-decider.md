# ADR 0010: Attention queue and the AFK auto-decider

- Status: Proposed
- Date: 2026-10-11 (branch `feature/354-bridge-p3-autonomy`)
- Spec: bridge-program Phase 3 (A1 autonomy, A2 attention), responding to
  the "blocks on the operator / no safe way to proceed unattended" gap in
  mtlynch.io's *Why Are Coding Agents So Dumb?*
- Supersedes: none — extends the placement park path (ADR 0006's pending
  approvals) and the session-start surface; adds a new module, no schema it
  depends on changes.

## Context

When a decision is genuinely the operator's — a placement parked until a
swap is approved, a grant that exceeds standing consent — the system had
two bad options: stall the run waiting for a human, or silently drop the
ask and pick a default nobody signed off on. mtlynch's complaint applies
verbatim: the agent is either dumb-but-safe (idle) or autonomous-but-
unaccountable (silent).

The missing piece is not more automation; it is a **visible decision
queue with recorded consequences**:

- every ask carries its own context (what was requested, why it parked)
  so the operator can answer it cold, minutes or hours later;
- every ask carries a **safe default** the asking surface itself vouches
  for — an action that is correct *without further consent* (for a parked
  placement: let the pending request expire on its own TTL — nothing is
  loaded, nothing is evicted);
- an absent operator is expected, not exceptional: long unattended runs
  are a first-class mode.

## Decision

1. **A2 — the attention queue** (`src/delivery/attention.ts`):
   `.uap/attention.json` holds bounded, pending-or-resolved items
   (`kind`, `title`, `detail`, `source`, optional `safeDefault{decision,
   rationale}`, `graceDeadline`, `status`). Surfaces:
   - **one queue per CHECKOUT, not per cwd**: the file lives in the MAIN
     checkout's `.uap/` (resolved via `mainCheckoutRoot`, the same anchor
     the policy-liveness fix established on 2026-07-13), because three
     surfaces with three different cwds (dashboard server process, CLI,
     session-start hook inside a worktree) would otherwise write and read
     three different files and the rail would silently no-op — flagged
     BLOCKER by the architecture review. `UAP_ATTENTION_QUEUE` pins an
     explicit file for tests and odd layouts.
   - **enqueue sites** vouch for their own safe default and may PIN the
     item's deadline to the ask's own expiry (`expiresAt`): the placement
     site pins to the pending entry's TTL, so the decider adopts at the
     moment the pending actually expires — never advertising an actionable
     swap for a dead pending, never recording an adoption before the
     expiry it describes. Generic sites use the grace window. Only one
     enqueue site ships with this ADR: the placement admit path (a park
     that found no auto plan) enqueues a review-request sourced
     `placement:<id>` whose safe default is the TTL expiry — the recorded
     rationale says plainly that nothing is loaded or evicted by waiting.
     A resolved ask (forward / auto-load) never enters the queue, and the
     only park reason with options to apply (`not_resident`) gets the
     "apply" instruction; the no-option reasons say so plainly instead of
     inviting a decision that cannot be made.
   - **the asking surface also CLOSES its asks**: applying or dismissing a
     pending placement resolves the matching attention item by origin
     (`resolveAttentionBySource`), so the queue learns of decisions made
     through the placement surface itself — otherwise a later sweep would
     record a false AFK adoption over an operator decision that was
     actually made.
   - **read surfaces**: `uap attention list/ack/decide` (CLI, new) and the
     session-start hook, which sweeps, summarizes what was auto-decided
     while away, and shows the top OPEN items so every session opens with
     what is waiting on the operator. The default view is the open set
     (pending + acknowledged + escalated) — an escalated ask is the
     loudly-unresolved class and must not drop out of the casual view.
   - **enqueue dedupes on open asks**: by `source` (the ledger's rule) AND
     by (kind, title) — an expired-pending client retrying every TTL mints
     a new placement id per retry, and without content dedupe an
     unattended weekend would mint one never-pruned ask per retry. Each
     item still self-resolves at its own pinned deadline.
   - **sanitized twice**: at ingest AND on load. The file lives in
     shared-write `.uap/` (writable by every agent on the project, and a
     cloned third-party repo need not gitignore it), so the load path
     re-applies the control-char/length sanitizer and validates
     `kind`/`status` against their enums — a planted row with ANSI escapes
     or a planted `safeDefault` must not reach operator terminals or ride
     a sweep wearing its `[auto]` label (security review, F1).
   - **fail-open everywhere**: the queue is an observability rail — a
     corrupt or unwritable store logs a warning and never blocks the
     asking surface (all enqueue call sites are best-effort; a failed
     persist returns null instead of a phantom item). `source` is
     server-generated, never client text, and the placement admit path
     rejects model ids outside `[A-Za-z0-9._-]` before any queue write —
     client text never becomes a durable prompt-injection channel. The
     hook renders item text with an untrusted-data disclaimer.
2. **A1 — the AFK auto-decider** (`sweepExpired`, same module; invoked by
   `uap attention sweep`, at session start, and on a 60s timer inside the
   dashboard server — gated by the same fleet-ownership env as the idle
   sweeper, because during a long unattended run, the exact case this rail
   exists for, session starts are rare and nothing else would fire):
   - an item whose grace window elapsed WITH a recorded safe default has
     the decider's resolution recorded **on the item only** — `status:
     "auto-decided"`, the adopted decision and rationale logged. The
     decider never mutates the underlying system: it adopts what the
     surface already promised would happen unattended (for placement,
     the expiry is the system's own TTL doing the work; the sweep just
     makes the record honest instead of leaving a stale pending row).
   - an item with NO safe default escalates (`status: "escalated"`) — the
     opposite failure mode of mtlynch's complaint is the one we refuse:
     never silently expire an ask that mattered.
   - **operator beats the decider**: any operator resolution (ack keeps
     the item alive but the grace clock keeps running — seen ≠ answered;
     decide closes it) wins over the sweep; sweeps are idempotent against
     already-resolved items; and a decision made through the asking
     surface itself (apply/dismiss) resolves the queue item by origin.
   - **standing consent stays the boundary**: a safe default is only as
     trustworthy as the surface that recorded it (cf. ADR 0007's
     allowlist discipline). The decider adds no authority of its own — it
     is a bookkeeper for promises surfaces already had the right to make.
3. **Grace window:** env `UAP_ATTENTION_GRACE_SECS` > config
   `attention.graceSecs` > 300s, capped at 86,400 (24h); `0` adopts
   immediately; a cleared/empty env value is treated as unset (fails safe
   to config). The grace window is the DEFAULT deadline — a site that knows
   its ask's real expiry pins it (see Decision §1). `UAP_ATTENTION_OFF=1`
   is the kill switch: no enqueue, no sweep, list returns nothing, and no
   session-start hint — the rail goes quiet end-to-end while the file is
   left alone.

## Consequences

- A parked placement now has three fates instead of two: answered
  (operator decides — through the queue OR through the placement surface,
  which closes the ask by origin), adopted (default the surface vouched
  for, logged, at the deadline the site pinned), or escalated (no safe
  default — visible, not silent). Never a quiet stall.
- The session-start hint makes the queue self-advertising: the operator
  does not need to know the command exists to encounter what is waiting —
  and a mid-session sweep in the dashboard keeps the decider alive during
  exactly the unattended runs it exists for.
- Bounded: open items are never pruned but content-dedupe collapses
  retry-floods to one ask per question; resolved history prunes past 250.
  Open items still only ever leave the queue via ack/decide/sweep — a
  surface that enqueues an ask with NO lifecycle of its own must provide
  its own resolution path or its asks linger by design (visible, not
  silent).
- **Accepted v1 debt — lost-update race:** writers are unlocked
  read-modify-write (last writer wins); a sweep racing an operator decide
  in the same millisecond window can drop the operator's record. The
  placement ledger solves this with `withLedger` advisory locking; the
  queue inherits it only if the race is ever observed in practice (both
  reviews rated it rideable for an advisory rail; the failure is a lost
  audit row, never a wrong system action).
- The decider is deliberately weak. Extending it to actually DO things
  (issue grants, trigger displacement) would move it from bookkeeping to
  agency and must be its own ADR with its own consent analysis.
- Blast radius: new module + new CLI file + command registration; the
  placement admit path gains one best-effort enqueue (with a charset gate
  on model ids); apply/dismiss close their asks; the session-start
  template gains a fail-open block; the dashboard server gains a 60s
  fail-open sweep timer; the settings registry gains four keys. No
  existing schema or contract changes; readers of `.uap/attention.json`
  are only the new surface.
