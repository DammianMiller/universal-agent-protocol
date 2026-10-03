# Missions & the Orchestrator Poll Daemon

> **🏭 Where this fits:** BUILD — the durable layer *above* `uap deliver`.
> **What it delivers:** a prompt — small or large — becomes a mission the
> system owns until its acceptance criteria are verified met. It survives
> reboots, crashes, session teardown, and context exhaustion. No babysitting.

**Visual explainer:** [docs/visual/mission-orchestrator.html](../visual/mission-orchestrator.html) —
the architecture, poll cycle, decision table, backoff, and salvage flow as a
self-contained page (open in a browser; no build, no dependencies).

**Architecture record:** [ADR-0003](../architecture/adr/0003-mission-orchestrator.md)
— why the goal layer lives above deliver, the frozen-hash policy,
provenance-checked linkage, and the claim/backoff semantics.

[The task orchestrator](./ORCHESTRATOR.md) makes a single *run* converge, and
the epic controller loops epics *within a run*. What neither owns is the goal
itself across process lifetimes: a detached deliver run survives its tool
call, but nothing resumes it after a reboot, relaunches it after a crash, or
notices it quietly died. That is the mission layer's job — the same insight
as Choir (Harvard/Weber's multi-agent autoformalization protocol): **the loop
clock and the state must be durable and external to any agent process.**

## The model

```
uap mission create ──▶ missions.db (frozen acceptance, attempt ledger)
        │                        ▲
        │ --launch (or wait)     │ discovery (mission:#N marker)
        ▼                        │
  uap deliver run ──run state──▶ uap mission poll (every 300s, systemd)
                                 │ decide per mission:
                                 │   live run        → one supervisor cycle
                                 │   pid dead        → record interrupted, salvage, relaunch
                                 │   interrupted     → salvage, resume (backoff after repeats)
                                 │   failed         → salvage, relaunch (backoff)
                                 │   delivered      → close the mission
                                 └ board notes on delivery + struggle
```

## Creating a mission

```bash
uap mission create "Harden the policy gate for admin-protected routes" \
  --acceptance "npm test and tsc --noEmit pass; no new quality-metric violations" \
  --launch
```

- The acceptance criteria are **frozen** (sha256) at creation — the
  statement-immutability analog. Changing them is an explicit replan that
  records the prior text, hash, and reason:
  `uap mission replan <id> --acceptance "<new>" --reason "<why>"`.
- `--launch` starts the first run immediately; without it the daemon launches
  it on the next poll. The criteria travel inside the run instruction and
  `--acceptance` turns on the behavioral acceptance judge.
- `uap mission list|show|pause|resume` manage the ledger. Paused missions are
  invisible to the daemon.

## The poll daemon

`uap mission poll` is the loop clock (Choir's `orch poll`; hidden alias
`uap orch poll` — NOT the same as `uap orchestrator on|off`, which toggles
the in-deliver blackboard orchestrator). One cycle:

1. **Discover** — link a fresh launch's run to its mission. Linkage is
   provenance-checked: the run's instruction must carry the mission's
   `[mission:#N:<hash8>]` marker (the hash slice makes it replan-scoped, so
   an old-criteria run can never be relinked) AND its pid must match the pid
   the orchestrator itself spawned. A planted run-state file cannot know a
   future child pid, so it can never steer the daemon. Any status links: a
   short mission can deliver inside one interval and must still close.
2. **Sync** — terminal run states become attempt rows; a `running` state whose
   pid is gone is recorded as interrupted (a crash that never marked itself).
   Rows dedupe per (run, outcome, observedAt): identical re-observations
   collapse, genuinely new failures of the same run accumulate.
3. **Decide** — the pure decision table in `src/mission/poll-cycle.ts`:
   live → supervise (one `runSupervisor` cycle: it watches and acts on
   reviewed policy — STOP/RETRY/ESCALATE — never signals); terminal →
   salvage + relaunch; delivered → close.
4. **Act + backoff** — launches and relaunches go through an ATOMIC CLAIM
   (a 60-second window), so the daemon poll and `uap mission create --launch`
   can never both spawn the same mission. The first relaunch is immediate (a
   clean interruption is the healthy case, not a crash loop); each further
   relaunch doubles the wait (15, 30, 60 min … capped at a day).

A cycle never throws — a broken ledger produces a report note, not a dead
daemon — and systemd `Restart=always` covers the rest.

### The service

`uap-orchestrator.service` (installed by `installSystemdUserServices`) runs
`uap mission poll --loop --interval 300`. Node and the CLI entrypoint are
captured absolute at install time — a systemd user unit's PATH has no nvm.
`uap doctor` probes it against its declared RSS budget in
`config/capacity-policy.json` (512 MiB; restart budget 3).

```bash
systemctl --user enable --now uap-orchestrator.service
journalctl --user -u uap-orchestrator.service -f
```

## Struggle & salvage (approval-gated)

Every failed/interrupted attempt seeds a **salvage proposal**: what happened,
what partial work exists, and — once a task has struggled past 3 failures — a
recommendation to escalate the preset or decompose before the next relaunch.
Proposals never auto-schedule:

```bash
uap mission salvage list
uap mission salvage approve <id>   # or: reject <id>
```

Struggling missions also post a board note (`uap coord board`), so an
operator — or an overseer agent — sees the escalation ask without watching
the daemon. This is the Choir split: the orchestrator proposes; the overseer
rules.

## Merge gate (evidence, not testimony)

A delivered run's DONE report is a claim. The merge gate is the last check
between that claim and master — it recomputes the verdict from recorded
evidence, deterministically, before work becomes irreversible:

| Check | What it verifies |
| --- | --- |
| **provenance** | The PR's `[mission:#N:<hash8>]` marker matches the mission's CURRENT frozen acceptance (a replan after the PR was cut supersedes its criteria) — and the ledger itself still hashes intact |
| **green-recompute** | The gate-evidence artifact for the exact sha being landed (all gates exited 0, no env hatches) — or, failing that, a fresh run-state read showing `delivered` with a passing final recorded iteration — and the run pid matches the launch; no salvage proposal awaits a ruling |
| **sorry-delta** | No stub markers (`todo!()`, `NotImplementedError`, TODO/FIXME) in ADDED lines of production files, no apology phrasing in the run's summaries |
| **axiom-honesty** | The diff does not touch gate infrastructure (hooks, CI, enforcers, baselines, this gate itself) without acknowledgment |

```bash
uap merge gate 7                 # run the gate for mission #7 (exit 1 on fail)
uap merge gate 7 --json          # machine-readable findings
uap merge gate 7 --allow-gate-infra   # only when the PR deliberately IS gate work
```

The merge queue runs this automatically before landing any PR whose title or
body carries the mission marker; a gate failure skips the PR and lists every
failed check. `--force` skips stale CI checks but never the gate, and there is
no environment escape hatch. Deliberate gate-infrastructure changes are
acknowledged with a `gate-infra` PR label, in plain sight of reviewers.

Details and rationale: [ADR-0004](../architecture/adr/0004-deterministic-merge-gate.md).

## Where state lives

| Store | Path |
| --- | --- |
| Mission ledger (SQLite, WAL) | `.uap/missions.db` |
| Durable run state (per run) | `.uap/deliver-runs/<runId>/state.json` |
| Supervisor state/events | `.uap/supervise/<runId>/` |
| Orch-spawned run logs | `.uap/orch-logs/orch-<stamp>.log` |
| Stop latch | `.uap/deliver-runs/STOP` (cooperative; the supervisor uses it too) |

## Design notes

- **Frozen acceptance** is what makes "complete" checkable — the merge gate
  (see above) verifies a PR's criteria against the frozen hash before any
  merge.
- **Attempt dedupe** is per (mission, run, outcome, taskRef, observedAt), so
  re-observing the same terminal state cannot inflate the struggle metric —
  while a run that keeps failing after each resume accumulates and reaches
  the escalation threshold.
- **Salvage dedupe**: one open proposal per failed attempt — a mission
  waiting out a backoff window never duplicates proposals or board notes.
- The daemon never *drives* a live run — it supervises. Launching and
  resuming are the only writes it makes to a mission's fate, and both go
  through deliver's own detached-run discipline (own session, stdio to a
  file, checkpointed state).
