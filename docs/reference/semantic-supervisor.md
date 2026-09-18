# Semantic Supervisor (`uap supervise`)

A watchdog loop for `uap deliver` missions. It observes a run, assesses nine
dimensions, and applies a deterministic, reviewed policy. Models may only
**assess** — the decision is never made by a model.

```
uap supervise [runId|latest] [--once] [--json] [--interval-ms N] [-d projectDir]
```

- **Watch mode** (default): reassesses at most every `debounceMs` (5s,
  state-change triggered) and at least every `intervalMs` (30s, heartbeat).
  STOP and FINISH end the watch; ESCALATE **keeps watching** — a paged human
  may take a while — until the mission ends or 20 consecutive suppressed
  ESCALATE repeats go unanswered, at which point the watcher writes a final
  `escalation unanswered` event and detaches. Ctrl-C detaches the watcher at
  any time; the mission is unaffected. Watch mode exits 2 when the final
  decision is STOP or ESCALATE, 0 otherwise.
- **`--once`**: one observe → assess → decide → persist cycle, prints the
  decision, exits. Exit code 0, or 2 when the action is STOP/ESCALATE (or the
  supervisor refused to run).
- **`--json`**: machine-readable decision; errors are emitted as JSON too.

## What it observes

Bounded snapshots only: the sanitized run state from
`.uap/deliver-runs/<runId>/state.json` (via the same loader `uap deliver
--resume` uses), the last 8KB of the newest matching `.uap/deliver-logs/*.log`
(fd seek, never a whole-file read), `git status --porcelain` line count, and a
capped `git diff --stat` (both via arg-array `execFileSync` with
`core.fsmonitor`/`core.untrackedCache` disabled, 5s timeout, fail-soft).
Nothing unbounded is ever read.

**Path discipline.** Log reads lstat first and silently skip anything that is
not a plain regular file (symlinks, FIFOs). Every directory the supervisor
writes through — `.uap/supervise/<runId>` and, for the STOP file,
`.uap/deliver-runs/<runId>` — is lstat'd and realpath-checked before use; a
symlinked or non-directory path throws `SupervisorError` instead of writing
outside the project.

## Dimensions

Nine per cycle: `progress-stalled`, `off-track`, `human-needed`,
`stuck-loop`, `completion-signaled`, `verification-pending` (flags), and
`error-density`, `iteration-pressure`, `risk` (1–5 scores). Heuristics always
answer. The human-needed matcher is interrogative-only: credential prompts
and approve/confirm questions fire; declaratives like "Permission denied" or
"approved the change" do not. Healthy summary lines like "0 failed" never
count as error evidence.

An optional classifier (SYS1 contract, injected structurally — see Decisions)
is asked only the built-in questions (`escalation-risk` noul, `action-class`
choice). `escalation-risk=true` at probability ≥ `classifierTau` and
confidence ≥ `classifierConfidenceMin` raises `off-track`; `action-class`
`escalate` raises `stuck-loop`, `stop` raises `off-track`. The classifier may
**raise** a flag, never clear one, and a throwing or absent classifier leaves
the heuristics fully in charge. That is the fail-closed posture: model
failure degrades to reviewed heuristics, never to looser supervision.

## Actions

Priority is fixed and safety-first: **terminal status → FINISH (delivered) /
CONTINUE · iteration bounds → STOP · human-needed → ESCALATE ·
off-track/stuck → RETRY (else ESCALATE when retries are spent) ·
verification-pending → VERIFY · else CONTINUE.**

| Action | Effect |
| --- | --- |
| `CONTINUE` | none — mission is within bounds |
| `STOP` | writes the run's cooperative **STOP file** (`requestStop`). The deliver loop checkpoints and exits at its next turn boundary. **Never a signal, never a kill.** Outranks even human-need: an over-budget mission that is also waiting on a human is stopped, with the human-need recorded as `alsoEscalate` evidence. |
| `RETRY` | consumes one retry from the budget (recorded; persists across processes) |
| `VERIFY` | recorded prompt to verify; advisory. Never twice consecutively, and bounded by `maxVerify` — an unanswered verification falls into the stuck path (RETRY/ESCALATE) |
| `FINISH` | records completion. Requires the authoritative `status: delivered`; a log tail claiming "mission complete" on a still-running mission never detaches supervision |
| `ESCALATE` | event + console warning only; once per streak |

The supervisor cannot kill, signal, or restart a mission. The only mutation it
ever performs on a run is the cooperative STOP file. A run that is no longer
running (`delivered`/`failed`/`interrupted`) is never STOPped or ESCALATEd,
whatever its log tail contains.

## Oscillation guards

- `VERIFY` can never fire twice consecutively — an intervening non-VERIFY
  action must re-arm it (policy-level, unit-tested).
- `VERIFY` is budgeted: after `maxVerify` unanswered requests the mission is
  treated as stuck.
- `ESCALATE` and `FINISH` warn/act once per streak; repeats are recorded with
  `suppressed: true` instead of re-firing. After 20 consecutive suppressed
  ESCALATEs the watcher writes `escalation unanswered` and detaches.

## State and ledger

Per supervised run under `.uap/supervise/<runId>/`:

- `state.json` — assessments count, retry/verify budgets spent, last action
  (atomic tmp+rename writes, mode 0600). This is what makes the retry budget
  survive across separate `--once` invocations.
- `events.jsonl` — one v-stamped record per cycle: action, reason, evidence,
  and every dimension's value **with its source** (`heuristic` |
  `classifier`). File mode 0600.

## Policy config

Thresholds ship reviewed in `config/supervise-policy.json`:

```json
{ "version": 1, "stallMinutes": 10, "maxMinutes": 120, "maxTurns": 50,
  "maxRetries": 2, "maxFailures": 3, "debounceMs": 5000, "intervalMs": 30000,
  "classifierConfidenceMin": 0.7, "classifierTau": 0.6, "maxVerify": 3 }
```

Loading is strict: a missing, corrupt, mis-versioned, or out-of-range file
throws `SupervisorError` and the supervisor refuses to run — it never
invents defaults. `UAP_SUPERVISE_POLICY` points at an alternate policy file (tests,
staged rollouts).

## Decisions

- **Budget authority is `max(policy, deliver budget)`.** The STOP threshold
  for elapsed time is `max(maxMinutes, runBudgetMinutes(projectRoot))` — an
  operator who raised a mission's budget (`UAP_DELIVER_MAX_MINUTES` or
  `.uap.json delivery.maxRunMinutes`) must not be overruled by the
  supervisor's static 120. A *lower* operator budget needs no supervisor
  support: the deliver loop stops itself first.
- **Classifier is a structural contract, not an import.** The SYS1 classifier
  lands in PR #807; importing unmerged code would break the build the moment
  either branch moves. Until #807 merges, `ClassifierLike` mirrors its shape,
  only the built-in question names are ever sent (the #807 baseline throws on
  custom names), and `recordShadow` wiring is deferred — the per-dimension
  `source` field in `events.jsonl` is the seam it will write through. When
  #807 lands: replace the interface with the real import, reconcile the
  `noul`/`choice` kind vocabulary, and wire shadow recording.
- **STOP outranks ESCALATE.** A mission past its iteration budget stops even
  when it is also blocked on a human — stopping is the safer default and the
  human-need survives as `alsoEscalate` evidence in the ledger.
- **FINISH requires authoritative state.** Only `status: delivered` ends
  supervision; success-shaped log lines are evidence, never proof.
- **Escalations are bounded.** Twenty unanswered ESCALATE repeats detach the
  watcher with a final ledger event — supervision that nobody reads must not
  run forever.
