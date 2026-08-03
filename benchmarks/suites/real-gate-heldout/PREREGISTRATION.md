# Held-out set — pre-registration

**Registered 2026-08-03, before any measurement of these tasks against any model.**

## Why this file exists

The `real-gate-power` suite reached its `+14.8pp [5.9, 23.7]` estimate through a
loop that is fine for calibration and fatal for inference: run the suite, see
which tasks discriminated, drop the ones that did not, re-run. Five of its
fifteen tasks survived exactly that filter. The result is an **in-sample**
estimate, and no number of extra epochs can fix it, because the selection
happened at the task level rather than the draw level.

The only remedy is a task set fixed *before* seeing its results. This is that
set, and this file is the commitment.

## The commitment

1. The 15 task IDs listed below are the analysis set. They were authored and
   validated (reference solution passes, stub fails) **before** any of them was
   run against a model.
2. **Every one of them is reported**, including tasks that turn out to sit at
   ceiling or floor. Dropping a task after seeing its pass rate would recreate
   precisely the bias this set exists to avoid.
3. The headline number is the delta over all 15. Per-task rates may be shown for
   diagnosis, but the aggregate is not recomputed on a filtered subset.
4. If this set proves badly calibrated, the honest move is to report that and
   build a *new* pre-registered set — not to prune this one.

`test/bench/heldout-preregistration.test.ts` enforces 1 and 2 mechanically: the
suite directory must contain exactly these IDs, so a later deletion or a quiet
addition fails the build rather than passing unnoticed.

## The registered tasks

| # | task | tier | domain |
|---|---|---|---|
| 1 | `js-roman` | medium | canonical roman numerals, round-trip over 1..3999 |
| 2 | `js-word-wrap` | medium | greedy wrapping, hard breaks, unsplittable long words |
| 3 | `js-base64` | medium-hard | UTF-8 + base64 by hand (no Buffer/atob/btoa) |
| 4 | `js-cookie` | medium | Cookie header, quoting, first-wins, malformed escapes |
| 5 | `js-flatten` | medium-hard | dotted-path flatten/unflatten round-trip, dot escaping |
| 6 | `js-natural-sort` | medium-hard | numeric runs, leading zeros, case tie-break, stability |
| 7 | `js-shell-split` | medium-hard | POSIX-ish quoting and escapes |
| 8 | `js-range-header` | hard | RFC7233 Range: -1/-2 sentinels, clamping, suffix ranges |
| 9 | `py-rle` | medium | `count[char]` codec, round-trips any character |
| 10 | `py-slugify` | medium | slug + truncation at a word boundary |
| 11 | `py-iban` | medium-hard | ISO 7064 MOD-97-10 validation and check-digit generation |
| 12 | `py-interval-set` | medium-hard | half-open interval normalize/union/difference |
| 13 | `py-iso-duration` | medium-hard | ISO-8601 durations, `M` ambiguity, strict errors |
| 14 | `py-bencode` | hard | strict bencode decoding, sorted keys, no trailing data |
| 15 | `py-column-align` | hard | column padding, alignment, trailing-space rules |

Domains are deliberately disjoint from `real-gate-power`, so a task is not a
near-duplicate of one the estimate was already fitted to.

## Difficulty is a prediction, not a measurement

Tiers above are *predicted*. They span medium → hard on purpose: difficulty has
been mis-estimated in both directions already on this project — the first
`real-gate-power` set was designed as medium and landed at 86.7% baseline, and
its replacement was designed as hard and put two tasks on the floor. Spreading
the set across tiers is the hedge against being wrong again, and whatever the
spread turns out to be gets reported as measured.

## Excluded from the analysis set, on a structural criterion decided in advance

`js-clamp` and `py-word-count` predate this work and remain in the directory
because the self-harness held-out gate references them. They are **not** in the
analysis set, for a reason that is verifiable without running anything: both
have an **empty `gateCmd`**, and the raw adapter enables its gate loop only when
`condition.components.has('gates') && Boolean(task.gateCmd)`. With no gate
command both arms execute the identical single bare completion, so those cells
cannot express gate value under any outcome.

This exclusion is structural and pre-measurement, not a response to their
results.
