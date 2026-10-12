# ADR 0012: Operator legibility surfaces — measured pace, local diff view, bench report reader

- Status: Accepted
- Date: 2026-10-11
- Spec: the operator's own legibility (S3 local diff view, S1b ETA
  surfaces + paired bench delta report).
- Supersedes: none — these are read-only surfaces over telemetry that
  already existed (the ETA sample stream, git, the paired-bench
  reports); no schema or authority changes.

## Context

The agent-facing surfaces made the *agent* legible — to
itself (the self-knowledge card), to the plan, to the operator's consent
(grants, attention). What never got a surface was the operator's own three
questions, asked every day on a busy checkout:

1. **"What did the agent actually change around here?"** The answer lives
   in git, but the honest answer spans three views at once — uncommitted
   rows with per-file deltas, untracked files, and unpushed commits against
   a base — and assembling it by hand is exactly the kind of repetitive
   synthesis operators skip, then regret.
2. **"How long does this model actually take on this project?"** The ETA
   sample stream (`delivery/eta.ts` → `model_analytics.db`, keyed
   model × taskType × complexity) was recorded but nothing *read* it — so the
   operator (and the agent) kept guessing pace from vibes, which is the
   failure mode the whole program exists to end.
3. **"Did the measured delta hold?"** `uap bench paired` writes a full
   AnalysisReport under `benchmark-results/paired-*/` and nobody ever looks
   at it again; run-to-run drift (a delta that narrowed, a verdict that
   flipped) was invisible unless someone diffed JSON by hand.

The bar (unchanged from the reliability ladder): **a number without its
provenance is noise.** Every surface below is built so it *cannot* print a
confident guess — thin data says so, unusable runs say so, unknown deltas
render as `±`, never as `0`.

## Decision

### S1b — the EWMA estimator (`src/delivery/eta-estimate.ts`) and its four surfaces

`ewmaEstimate(samples)` is pure math over a plain array — no store, no
fs, no clock — so the estimator is unit-testable and deterministic. It
folds the sample stream **oldest→newest** with a half-life **in samples**
(default 10, from `1 − 2^(−1/h)`), because the model, the harness, and the
task mix all drift; recency is the point. The honesty rules are load-bearing
and pinned by tests:

- **Thin data is not an estimate.** Fewer than 3 successful attempts in the
  window yields `null` — surfaces show nothing rather than a number
  invented from noise. 3–5 is `thin` (shown *with a caveat*, never
  silently); ≥6 is `solid`.
- **The spread is part of the number.** min/max of the folded successes
  travel with the estimate; a surface printing "~2 min" without the spread
  is lying by omission.
- **Failures are visible.** The fold is over SUCCESS durations (that is
  what "how long does a completing attempt take" means), but the estimate
  also carries `attemptsPerSuccess` — and every wall-clock projection
  (`remainingWallMs`, the handsfree line) scales by it, so a 50%-failure
  key never presents its successes as its pace.

`estimatePace` is the fail-soft store wrapper (a broken store costs one
try/catch, never a crash in a surface — same contract as the S1a
recorder). The four surfaces:

- **`uap eta [--model|--taskType|--complexity|--all|--limit|--half-life|--json]`**
  (`src/cli/eta.ts`) — one key, or `--all` for every key with history.
  `--all` *names the too-thin keys* instead of silently omitting them, so
  the operator knows why a key they expect is missing and what would fill
  it.
- **handsfree status** — a remaining-work wall clock for the open ledger
  items (`pending + failed`), scaled by attempts-per-success, shown only
  when an estimate exists.
- **Dashboard models view** — a "Measured Pace" section (top 8 keys by
  attempts): per-task EWMA, spread, n, success rate.
- **Reactor injection** (`src/coordination/eta-inject.ts`, keyed
  `eta:pace`) — the agent's OWN pace as calibrated planning context: fires
  only on solid estimates, because a thin-data guess would inject exactly
  the confident noise the block exists to replace.

### S3 — the local diff view (`src/cli/diff.ts`, `uap diff`)

`gatherDiffFacts` is the only impure part: safe-git with `execFileSync`
**argument arrays** (no shell, no injection surface), a 5s timeout,
`core.fsmonitor=false -c core.untrackedCache=false` (defeat the stateful
caches that make status flaky on big repos), and **degrade-never-throw** —
a non-repo or an unusable git yields `gitError: "git unavailable or not a
repository"` and the renderer says exactly that, not a stack trace. One
numstat pass vs HEAD covers staged + unstaged; `git status --porcelain`
folds status codes onto the rows (worktree code preferred over index code
— the file's state on disk is what the operator sees) and collects
untracked paths; renames are normalized before matching because porcelain
prints `old -> new` while numstat prints `{old => new}`. `renderDiffView`
is pure and pinned by tests: rows sorted by additions, per-section caps
with honest "… and N more" counts, honest totals, binary files render `±`
(unknown — never `0`), ahead/behind against the merge-base, and an
`inspect:` footer with the follow-up commands.

### The bench report reader (`uap bench report`)

Reports accumulate under `benchmark-results/paired-*/`; the reader answers
"what did the latest run measure" (`uap bench report`, newest by
`report.json` mtime with a dirname tiebreak for bulk-copied trees) and
"did the delta hold" (`--compare`, the two newest runs). It unwraps the
harness's `{ ablation, report }` on-disk shape. Two rules carried over
from the reliability ladder, now enforced at the surface:

- **A delta is never printed without its CI, verdict, and McNemar
  discordant count.**
- **An unusable run is NO MEASUREMENT.** `discrimination.usable === false`
  prints the reason and the explicit warning line; the drift view warns
  when *either* compared run could not measure. `--full` reprints the
  stored report.md; `--json` emits the raw report.

## Consequences

- The operator's three daily questions each got a one-command answer whose
  numbers all carry provenance — the same standard the ladder demands of
  the agent.
- The S1a sample stream finally has a consumer, which retroactively
  justifies its deliberate inclusion of synthetic zero-token rows in
  `recentDurations` (duration/success data is real even when the
  convergence-loop token totals are not visible at that seam).
- The estimator is pure and the renderers are pure, so the honesty rules
  are pinned by fast unit tests rather than by CLI scraping.
- Test seams are documented as such: `--db` (`uap eta`), the `root`/`cwd`
  options (`bench report` / `uap diff`) — they exist because vitest
  workers cannot `process.chdir`, the lesson P4's sandbox-cli tests paid
  for. No new env vars, no settings-registry entries, no schema changes.
- Known open surface (named, not hidden): the dashboard's Measured Pace
  section is exercised through the estimator's tests rather than a
  dashboard-level test — the dashboard command is environment-heavy and
  the section is a thin formatting shell over the pinned estimator.

## Review round (all three reviewers' findings fixed in-branch)

The 3-parallel-reviewer pass (code-quality, security, architecture)
surfaced one design rule and several contract completions, all fixed
before merge:

- **Absence of data is not a claim of cleanliness.** `uap diff` records
  which git reads succeeded (`numstatOk`/`statusOk` travel in the facts
  and the JSON); a failed or timed-out read renders
  `working tree: UNKNOWN`, never `clean`. Same rule in `bench report`:
  one dangling symlink in `benchmark-results/` skips that entry, not the
  whole listing. An unborn repo (fresh `git init`, no commits) is a repo —
  probed with `--is-inside-work-tree`, not with a HEAD rev-parse, and its
  branch reads via `symbolic-ref` (which works before the first commit).
- **`--full` degrades, never throws**: a run dir with `report.json` but
  no `report.md` (interrupted write) prints the reason, falls back to the
  delta summary, exits non-zero.
- **The read surfaces do not materialize what they read.** `estimatePace`
  gained `requireExisting` — the reactor injection (per-prompt) and the
  handsfree status line will not create an empty analytics store on a
  checkout that has no history. The explicit `uap eta` command keeps the
  store's established open semantics.
- **One open, not N**: key enumeration moved into the estimator layer as
  fail-soft `listPaceKeys` (the `--all` path and the enumeration share a
  single store open; the 50-key cap is named, not silent). The bench
  reader split into `bench-report.ts` (one command per file, per the
  repo's own pattern).
- **Terminal/prompt hygiene at one choke point** (`utils/terminal-safe.ts`):
  every rendered foreign string (report fields, commit subjects, model
  ids) is stripped of C0/C1/DEL control bytes; strings that become prompt
  text are additionally flattened to one line and bounded — a hostile
  model id cannot carry line-break structure into a block that presents
  itself as measured data. The raw id still keys the store query.
- **Loud flags**: garbage `--limit`/`--half-life`/`--max` is refused with a
  clean error (NaN never reaches the render math), and a `--base` that
  would reach git as an *option* (refnames cannot start with `-`) is
  refused rather than passed to argv. `--no-ext-diff` keeps repo-configured
  diff drivers out of the reads.
- The prepass's four `execSync` template-literal findings in
  `src/bin/cli.ts` are pre-existing debt outside this diff, verified
  untouched by all three reviewers — they belong in a separate cleanup PR.
