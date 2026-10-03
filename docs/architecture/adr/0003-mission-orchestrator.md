# ADR 0003: The mission orchestrator — a durable goal layer above deliver runs

- Status: Accepted
- Date: 2026-10-03 (branch `feature/331-mission-orchestrator`, Choir-uplift PR 1 of 2)
- Guide: `docs/guides/MISSIONS.md` · Visual: `docs/visual/mission-orchestrator.html`

## Context

`uap deliver` runs converge against real gates and survive their tool call
(detached missions), but nothing owns the **goal** across process lifetimes:
a reboot, a crashed service, or a run that quietly died leaves the work
incomplete with nothing to resume it. The Choir protocol (Weber-GeoML,
Apache-2.0; arXiv 2609.31903) contributes the key insight: the loop clock and
the state must be durable and external to any agent process.

UAP already had every inner mechanism (durable run state, resume cursors, a
watch-don't-drive supervisor, convergence loops, an in-deliver blackboard
orchestrator, epic controller). What was missing was the outer loop and its
durable state: a mission ledger plus a poll daemon that keeps incomplete
missions moving until their frozen acceptance criteria are met.

## Decision

1. **A mission ledger, separate from the coordination DB.** Missions are
   operator-owned durable goals (months), coordination state is per-session
   agent registry (minutes). Different lifecycles, different owners; merging
   them would couple a long-lived artifact to session hygiene. Stored at
   `.uap/missions.db` (SQLite, WAL, `PRAGMA user_version = 1`, `foreign_keys ON`).
2. **Frozen acceptance criteria (statement immutability).** sha256 of the
   trimmed acceptance text at creation; every change is an explicit
   `uap mission replan` that records the prior text, hash, and reason in
   `acceptance_revisions`. A replan RESETS the run link and backoff counters:
   the prior run embeds the old criteria and must not deliver against
   superseded acceptance. The acceptance travels inside every run
   instruction with `--acceptance`, so the behavioral judge grades the frozen
   text. PR 2's merge gate will verify this same hash before any merge.
3. **The run marker embeds the acceptance hash.** `[mission:#N:<hash8>]` in
   the instruction links a deliver run back to its mission. Because the
   hash slice is replan-scoped, an old-criteria run can never be relinked
   after a replan, and goal text mentioning another mission's marker cannot
   collide. The marker prefix also pins the argv injection posture (the
   positional token can never begin with `-`).
4. **Linkage is provenance-checked.** Run-state files are untrusted input
   (the loader sanitizes format, not intent). A discovered run links only
   when its instruction carries the mission's marker AND its pid matches the
   pid the orchestrator itself spawned (recorded by `claimLaunch`/
   `setLaunchPid`). A planted state file cannot know a future child pid, so
   it can never steer the daemon into resuming it or closing the mission.
5. **A pure decision table + a seam-injected executor.** `decideMissionActions`
   (`poll-cycle.ts`) is PURE and unit-tested; `runPollCycle`
   (`poll-executor.ts`) applies its actions through injected seams
   (supervisor, spawner, board), matching the project's house style
   (`plan.ts`, `deliver.ts`). A cycle never throws — a bad state produces a
   report note, not a dead daemon.
6. **Launches are claimed atomically.** `claimLaunch` is a single-statement
   conditional UPDATE (60-second window), so the daemon poll and
   `uap mission create --launch` cannot both spawn the same mission.
7. **Backoff: first relaunch immediate, then exponential (15·2^n, cap 1 day).**
   A clean interruption is the healthy case; repeated failures back off.
   Struggle (failed/interrupted attempts per mission) is deduped per
   (mission, run, outcome, taskRef, observedAt) — identical re-observations
   dedupe, genuinely new failures accumulate — and 3+ struggle turns salvage
   proposals into escalation asks. Salvage is APPROVAL-GATED (the Choir
   overseer split): the orchestrator proposes, the human rules
   (`uap mission salvage approve|reject`).
8. **The daemon is systemd-owned.** `uap-orchestrator.service` runs
   `uap mission poll --loop --interval 300` (hidden alias: `uap orch poll` —
   deliberately distinct from `uap orchestrator on|off`, which toggles the
   in-deliver blackboard orchestrator). Node and the CLI entrypoint are
   captured absolute at install time; `uap doctor` probes the unit against
   its declared RSS budget in `config/capacity-policy.json`.

## Consequences

- A mission survives reboots, crashes, session teardown, and context
  exhaustion: the daemon re-decides every active mission every 300 s.
- The launch grace window (10 min) prevents double-launching before
  `uap deliver` registers its run state; discovery then links the run.
- fd hygiene matters in daemon mode (the parent closes the spawn log fd;
  the child holds a dup) and log files use 0600 like supervisor state.
- The attempt ledger is the struggle metric; whole-mission notes (no runId)
  are never deduped so launch-loops escalate instead of retrying silently.
- PR 2 (merge gate) consumes exactly: `verifyAcceptanceHash`,
  `hashAcceptance`, the revision history, and the mission↔run linkage — it
  must never parse acceptance text out of the instruction string.

## Alternatives considered

- **Fold missions into the coordination DB** — rejected: lifecycle mismatch
  (see Decision 1).
- **Let deliver own the goal loop** — rejected: deliver already owns
  in-run orchestration (blackboard, epics); the goal layer must survive the
  run process, so it lives above it.
- **Adopt Choir itself as the backend** — deferred: single-machine today;
  the protocol's distributed-worker surface (GitHub issues, forks) is a
  follow-up if distribution becomes a requirement.
- **Auto-execute approved escalations** — rejected: salvage and escalation
  are approval-gated by user decision (2026-10-03); the daemon proposes,
  never schedules.
