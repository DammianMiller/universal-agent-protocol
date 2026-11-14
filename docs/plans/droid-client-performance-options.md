# Droid client performance options — the local qwen3.8 UAP fleet

**Status:** Proposed (monitoring findings + a ranked option menu; nothing starts
without an explicit go, per the [proof-options house rule](model-performance-proof-options.md))
**Date:** 2026-11-14
**Monitored:** the live Droid qwen3.8 UAP clients (3 hooked repos, 4 droid
processes; the pay2u security-audit run live since 16:01) against
`~/.uap/telemetry/tool-calls.db` — 20,002 tool calls, 2026-10-11 → now.

## What the monitoring shows

**The failure mass is one class.** 20.6% of all tool calls fail (4,118), and
**83% of the failures are the write/edit family**:

| Tool | Calls | Failed | Fail rate |
|---|--:|--:|--:|
| edit_file | 3,677 | 1,557 | 42.3% |
| edit_range | 588 | 233 | 39.6% |
| write_file | 4,690 | 1,597 | 34.1% |
| run_bash | 2,251 | 600 | 26.7% |
| list_dir | 1,475 | 81 | 5.5% |
| read_file | 7,321 | 50 | **0.7%** |

Reads are essentially perfect. The model writes blind. Decomposing the
write/edit failures:

- **stub-refusal (1,097)** — UAP's gutting guard catches the model shrinking a
  real file into a stub (or writing N declared functions with empty bodies).
  Each refusal is a saved file but a wasted round-trip; the error text already
  says "use edit_file", and models re-send anyway.
- **no-op (758)** — writes/edits that produced no change (idempotent retries).
- **edit-miss (642)** — `old_string not found`: editing from memory instead of
  reading the file first.
- **path-not-found (502)** — plausible-but-wrong guessed paths
  (`apps/api/src/repositories/installments_repository.ts`-shaped).
- edit-ambiguous (180), truncated-write (22).
- run_bash's 600 = 447 deliver-sandbox refusals + 153 exit-1.

**Era trend (the arm is the biggest single factor):**

| Date | Era | Fail rate |
|---|---|---:|
| 11-02 | worst benchmark block | 46.5% |
| 11-11 | **v31 UD-IQ4_XS + Q8_0 engram live** | **8.7%** |
| 11-13 | v31/Q8_0 measured + swap round | 10.4% |
| 11-14 (today) | **abliterated-iq2_xs serving** (user-switched) | 17.3% |

The best measured live day is the v31 arm; today the client fleet is served by
**iq2_xs — the fleet's floor tier (2.86 bpw)**. That alone roughly doubles the
tool-call failure rate vs the v31 era.

**The frontier routes are dark.** The client's 25 frontier-named entries
(CC Opus 4.5/4.6, GPT-5.1/5.2, Gemini 3, AG variants) all point at
`localhost:8317` — **no listener is bound**. The only frontier-tagged outcomes
in the delivery corpus (opus-4.8) died at 0% of gates in ≤5 turns (early route
death, not model quality). So "Opus 5.5 / Fable 5.2 levels" currently has **no
valid measured baseline on this box** — the honest reading of the local gap is
the failure table above: frontier-class clients read before editing (~0
edit-miss), don't gut files (~0 stub-refusal), and don't guess paths (~0
path-not-found). Closing the write/edit class is closing the gap.

## The options, ranked by cost

### O-A — Serve the strongest arm for client sessions (free, today)

**Cost:** one panel switch · **Expected effect:** the 8.7%-era failure rate
instead of today's 17.3% (the arm is the largest single measured factor).

Droid client work runs on v31 (UD-IQ4_XS + the Q8_0 engram — the measured-best
long-prompt decode) until the **UD-Q3_K_XL arm** (staged 2026-11-14, registry
`strata-unsloth-ud-q3_k_xl`) is measured and A/B'd; iq2_xs stays for batch and
benchmark traffic where its throughput per GiB matters. The Q3_K_XL A/B is
already required before that arm can place (fail-closed `unmeasured`).

### O-B — Restore (or drop) the frontier route, then measure the real gap (free)

**Cost:** operator time · **Effect:** turns "frontier levels" from a vibe into
a number.

Either bring the `:8317` CC proxy back up or delete the 25 dead entries so the
client menu stops lying. Then ONE paired run (the
[paired discipline](../benchmarks/PAIRED_FINDINGS.md): same tasks, same
seeds, UAP layer identical, only the model route toggled) — local fleet vs one
frontier route — gives the actual per-task gap and the failure-table delta.
Without this, every "get to Opus/Fable levels" claim is unmeasurable.

### O-C — Kill the three big failure classes at the tool layer (days; the 83%)

**Cost:** small, contained proxy/tool-router changes · **Effect:** directly
targets 2,241 of the 2,687 tool failures (stub-refusal + no-op + edit-miss +
path-not-found + edit-ambiguous).

1. **edit-miss → auto-context**: on `old_string not found`, the error returns
   the target's actual content around the nearest match (or line numbers +
   first lines). The model currently guesses again; give it the truth. This is
   the single highest-yield fix (642 failures, and each one saved is also a
   saved retry turn).
2. **path-not-found → fuzzy-match hint**: return the nearest existing path(s)
   in the error (the 502 guessed paths are near-misses of real files).
3. **stub-refusal → forced-read gate**: after a gutting refusal, the next
   write_file to that path requires a fresh read of the target in the same
   turn context — make the correct path (edit_file) cheaper than re-sending.
   The refusal text alone demonstrably does not stop the 1,097 re-sends.
4. **no-op surfacing**: flag "this write produced zero change" at the tool
   layer (758 idempotent retries today pass silently).

These are LOCKSTEP-class fixes (the v2.33 known-fix-table family): each one
needs a paired before/after on the same benchmark suite, reported with the
house discrimination status.

### O-D — Proxy-side terse-prompt shim for the strata arms (days)

**Cost:** small proxy change · **Effect:** the Sharp-template gains
(terseness, 2.7× faster median upstream) approximated for the arms that
cannot take a serve-time template.

The strata engine has no serve-time template override (GGUF-embedded), so the
Sharp template round skipped all 4 strata arms. What the proxy CAN do is
inject the Sharp **system-prompt** text (the terseness directive) into the
wire when the client's system prompt is absent/overridable — the template's
mechanical wins (fewer filler tokens, earlier tool calls) without the
GGUF re-embed. Weaker than the real template; cheap to A/B.

### O-E — Aggregate the delivery-gate corpus (free; proof-plan O1)

**Cost:** hours · **Effect:** the model × technique × tier gate table that
directs every option above.

The `[deliver]` lessons already record best-%-of-gates per model per task;
aggregate them into the descriptive table the
[proof plan](model-performance-proof-options.md) O1 specified. This is also
what tells us whether the qwen35-a3b tier (67-83% best-gates) is client-viable
or benchmark-only.

## What NOT to do (the measured history says so)

- **More gates on the Droid path.** The paired data: against a self-verifying
  harness the gate loop is a wash (Δ 0.0pp [−5.5, +6.9]) at token cost. The
  frontier gap is not a gating problem; it is the failure table.
- **Chasing frontier models for the interactive client before O-B.** No valid
  baseline exists; the two opus-tagged runs died at 0% in ≤5 turns.
- **Full-pin any strata arm** (the 10-28 OOM doctrine) — throughput gains die
  with the box.

## Sequencing

O-A today (panel switch, zero risk) → O-C.1 (edit-miss auto-context — the
single best fix) in the next proxy round → O-B when the frontier route is
restored → O-C.2/3/4 + O-E as the following PR → O-D last (weakest
expected value per hour).

---

## O-B MEASURED — the frontier baseline via Droid + GLM-5.3 (2026-11-14)

The frontier route landed differently than planned: not Claude Code through
the `:8317` CLIProxyAPI OAuth (its refresh token is expired; re-login is
user-interactive), but **Droid itself on `glm-5.3` (Max plan)** — the user
switched the session default to glm-5.3 and directed the baseline there. This
is the same client shape the monitored local baseline used (a Droid session
doing real tool work), which makes it the honest pair.

**Method (paired discipline): same tasks, same seeds, same driver, same
gates — only the model route toggled.**

- **Driver:** `droid exec --auto high -o json`, identical flags and 8-minute
  per-task ceiling for both arms.
- **Frontier arm:** `-m glm-5.3` (Droid's own provider auth — no local key
  material involved).
- **Local arm:** `-m qwen3.8-flash-next-unsloth-ud-iq4_xs-v31` through the
  UAP proxy (`:4000`) → the fleet. During the run the fleet was serving
  **abliterated-iq2_xs** (a peer's live deliver run owned the box, so no arm
  switch was made) — the local arm is therefore labeled iq2_xs, the fleet's
  floor tier, NOT v31.
- **Suite:** 6 fresh-dir tasks exercising the monitored failure classes —
  create+verify (t1), precise-edit of a seeded bug (t2), path near-miss
  `.yaml` vs `.yml` (t3), add-to-existing without gutting (t4), multi-file
  rename (t5), ambiguous-match edit-one-of-two (t6). 16 deterministic gates
  evaluated identically for both arms.
- **Anatomy:** from each run's droid session transcript (per-tool-call
  results, same failure classes as the monitoring round, adapted to
  Droid-native result text).

### Results (2026-11-14, 19:34–20:22 AEDT)

**Gate outcomes — TIED 13/13.** On small, well-specified, gate-verifiable
tasks the floor-tier arm produces correct results too. The paired gap is
**not outcome quality on this suite — it is cost**:

| Arm | Gates | Exec completes | Tool calls | Turns (mean) | Wall time (total) |
|---|---:|---:|---:|---:|---:|
| **glm-5.3** (frontier, Max) | 13/13 | 6/6 | **59** | 7.3 | **4.7 min** |
| **abliterated-iq2_xs** (local fleet, floor tier, via shimmed UAP proxy) | 13/13 | 1/6 (5 hit the 480s ceiling after finishing the file work) | **1,394** | 45 on the one completed task | **47 min** |

The local arm needed **~24x the tool-call volume** and **~10x the wall
time** for identical gate outcomes, and it burned its ceiling on 5 of 6
tasks (the substantive file work was done when the ceiling killed the
session — the gates scored the artifacts, which is why the tie is real).
One completed local task (t6: a 3-line edit) took **45 turns**; the
frontier took 4 for the same task. The local arm also spawned 20 subagent
Task calls + 5 Skill calls where the frontier used none.

**Failure anatomy (per Droid-native tool results, both arms):**

| Tool | glm-5.3 (calls / fail / rate) | iq2_xs (calls / fail / rate) |
|---|---|---|
| Edit | 7 / **0** / 0.0% | 66 / **0** / 0.0% |
| Create (write) | 7 / **0** / 0.0% | 21 / **0** / 0.0% |
| Read | 19 / 2 / 10.5% | 270 / 5 / 1.9% |
| Execute (bash) | 14 / 2 / 14.3% | 866 / 16 / 1.8% |
| TaskOutput (bg polls) | — | 65 / 55 / 84.6% |
| Overall | 59 / 4 / **6.8%** | 1,394 / 76 / 5.5% (1.6% excl. killed-bg-polls) |

Classes: frontier = 2 bash-failures (both its own runs of the
resolver-broken t5 fixture — reproduced identically on the pristine
template, corrected in the gate), 1 path-not-found (the deliberate t3
`.yaml`→`.yml` near-miss — recovered within the task), 1 other. Local = 16
bash, 5 path-not-found, 55 killed-background-poll errors from the
ceiling kills.

### What the baseline actually establishes

1. **The frontier "levels" number on this stack, for this suite, is: same
   gates, 1/24th the tool activity, 1/10th the wall time, zero edit/write
   misses.** On well-scoped tasks the floor arm eventually converges too —
   frontier value here is throughput and turn economy, not correctness.
2. **The blind-write failure class did not fire on this suite** — neither
   arm missed an edit or gutted a file (all 73 edit/create calls across
   both arms succeeded). These are small tasks whose files fit in one
   read; the monitored corpus's 42%-edit-miss anatomy lives in long,
   context-heavy sessions where the model edits from memory. The suite
   bounds the claim: frontier ≠ better edit *accuracy* here; it is faster
   at the same accuracy. The 20.6% live-corpus failure anatomy remains
   the measure of the long-session problem — O-C's fixes target that
   instrument, not this one.
3. **The instrument caveat is load-bearing**: these anatomy numbers are
   Droid-native tool results; the monitoring corpus's 20.6% is the UAP
   tool layer. Same failure classes, different instruments — rates are not
   comparable across them, only within this paired table.

Raw artifacts: `benchmark-results/ob-paired-droid-exec-2026-11-14/`
(report.json in the corpus schema + the full run suite), regenerated by
the archived scripts in `artifacts/`. The O-E corpus aggregator picks the
report up as a paired row on its next run.

**Caveats (labeled, not hidden):** n=6 tasks per arm is directional, not
powered — treat per-task deltas as single observations and the aggregate as
descriptive. The local arm ran under concurrent fleet load (the live peer
deliver run), which inflates its latency but not its gate outcomes. The
frontier anatomy counts Droid-native tool results, not the UAP tool layer the
monitoring round measured — the classes are aligned but the instruments
differ; cross-comparison of rates between the two instruments is qualitative.

---

## Monitoring round 2 (2026-11-14 evening) — post-O-C/O-D/O-B state

Re-mined the live corpus after the day's merges (v2.46.0 O-C hints+readGate,
v2.47.0 O-D shim+O-E corpus, v2.48.0 turnpack ports; master `6dd4fc90`),
with the O-B GLM-5.3 baseline now available as the frontier reference.

### Finding 1 — THE CLIENT IS STALE (the round's headline)

The running Droid qwen3.8 UAP client executes the **globally-installed
`@miller-tech/uap` = v2.45.0** (NVM path, verified: the global dist lacks
`delivery/path-hints.js`; the npm registry's `latest` is also 2.45.0 while
master is 2.48.0). Every deliver/client session today therefore runs
**pre-fix code** — none of O-C's hints, the readGate, or the turnpack
listing-anchor ports are in any live client. The only fix that reached the
client is O-D's proxy-side shim (the proxy serves from the repo tree and was
restarted 19:14 and again 20:50 for v2.48.0). The npm-publish workflow
(manual-trigger) was fired 09:58 UTC; until it lands and the global install
is updated, **every measured "post-fix" window is actually shim-only.**

### Finding 2 — the shim-only window (era B, n=209, directional)

| Class | Era A (pre-shim, n=19,794) | Era B (shim live, n=209) |
|---|---:|---:|
| ok | 75.7% | **81.8%** |
| stub-refusal | 5.4% | 7.2% |
| edit-miss | 3.2% | **0** |
| path-not-found | 2.6% | **0** |
| no-op | 3.8% | 1.9% |

Zero edit-miss and zero path-not-found in era B is encouraging but
underpowered (one deliver run's task mix, n=209) — directional, not a
finding. stub-refusal persists at 7.2% (all write_file gutting re-sends) —
exactly the class the not-yet-client-live readGate targets, consistent with
Finding 1.

### The ranked levers now (against the measured O-B frontier reference)

- **R2-A — Update the global client (free, minutes, the biggest immediate
  lever):** once the npm publish lands, `npm i -g @miller-tech/uap@latest`
  puts O-C + turnpack in every new client session. The next monitoring
  window after that is the first true post-fix read; watch stub-refusal
  (readGate) and edit-miss (turnpack) first.
- **R2-B — Serve v31 for client sessions (free):** iq2_xs (floor tier) is
  STILL serving all client work. The O-B suite measured what that tier
  costs on identical tasks: same gates at ~24x tool volume and ~10x wall
  time. This is the original O-A, still unexecuted.
- **R2-C — Route frontier-class client sessions to glm-5.3 (one flag, now
  measured):** `droid -m glm-5.3` / the session default (already set).
  The O-B baseline quantifies the buy: same gates, 1/24 the tool activity,
  1/10 the wall time, zero edit/write misses. This is the concrete
  "Opus 5.5 / Fable 5.2 levels" lever on this box today.
- **R2-D — Re-measure after R2-A:** the post-client-update window is the
  honest post-fix read; era B's zeros become testable at population scale.

---

## Monitoring round 3 (2026-11-14 late) — the post-fix read at scale, and what the instrument was actually measuring

Post-state: client 2.48.2 global (O-C hints + readGate + turnpack live),
proxy 2.48.x with the O-D shim, baseModelId shipped (Droid treats the local
arm as the qwen3.8-max built-in class). The first window with BOTH layers
fixed: 916 calls, 09:50–11:15 UTC, 13 runs.

### The fixes hold at scale — the first true post-fix read

| Class | Era A (pre, n=19,794) | Era C (post, n=916) |
|---|---:|---:|
| ok | 75.5% | **80.2%** |
| edit-miss | 3.2% | **0** |
| path-not-found | 2.6% | **0** |
| stub-refusal | 5.4% | 7.6% (all write_file) |
| refused | 2.2% | 3.3% (all run_bash) |

**edit-miss and path-not-found — the two classes O-C and turnpack were
built for — are zero at n=916**, including adversarial fixtures designed
to trigger them. ok-rate +4.7 points. The lever that remains un-shrunk is
stub-refusal.

### The instrument finding: era B and era C are both mostly TEST traffic

The era-C stub-refusals all carry fixture paths (`src/big.ts`, `big.js`,
`js/player.js` — deliberate gutting attempts at turn=1 in deliver-gate
test tasks, i.e. the guard PASSING). Top era-C paths are fixtures
(`a.js` 380, `b.js`/`big.js` 70 each); the real-path remainder is small.
Era B's round-2 samples were the same fixtures. **The tool-calls DB pools
benchmark-harness traffic with live-client traffic**, so corpus-level
"class rates" blend a guard's self-tests with real client behavior —
future monitoring must segment first (the working recipe: filter on the
fixture path set + `.uap-deliver/verify.sh`, or segment by `task_id`).
Era-C's honest split: fixture traffic shows the fixed layer passing its
own adversarial tests; the live-client signal is thin (the kubectl
deliver contributed 24 kubectl/doctl-pathed calls).

### The live client cost evidence

The kubectl deliver (the live interactive client, floor arm via
local-auto, `--max-turns 20`) is **2h29m in** on a credential-permission
ops task. The O-B reference: 6 gate-verified tasks in 4.7 min on glm-5.3.
Arm + arm-tier remains the dominant cost factor.

### The levers now (R3)

- **R3-A — Frontier-class sessions route by tier (the literal ask):** the
  Factory catalog now carries `claude-opus-5-5` (1.6x) and
  `claude-fable-5.2` (3.2x) as built-ins — "Opus 5.5 / Fable 5.2 levels"
  is a MODEL ROUTING choice, one flag per session. Measured reference
  (glm-5.3 on the O-B suite): identical gates at 1/24 the tool volume and
  1/10 the wall time. Suggested split: glm-5.3 default (measured, cheap),
  opus-5-5/fable-5.2 for the hardest tier, local arm for
  cost-insensitive/background work.
- **R3-B — v31 arm switch (was O-A/R2-B, still unexecuted):** iq2_xs
  still serves all client work; the strata unit additionally sits in the
  panel-race latch state (failed+disabled with a live engine process
  holding :8080). Recovery + switch is the documented one-liner
  (`systemctl --user reset-failed` + `model-switch.sh strata`) — operator
  action (infra-protect).
- **R3-C — baseModelId seam (shipped, unmeasured):** local-arm Droid
  sessions now inherit qwen3.8-max-class prompts, tool conventions,
  reasoning levels, and Script-mode eligibility. The first local-arm
  Droid sessions post-change (a live three.js client was streaming
  through the proxy at 22:31) are the watch window.
- **R3-D — telemetry run-kind tagging:** the era-B/C misread argues for a
  `run_kind` tag (test vs live) at the classifier, or at minimum the
  fixture-path segmentation recipe documented here. Small change, next
  tools round.
- **R3-E — stub-refusal remains the top live class:** in live traffic it
  is the gutting guard + readGate doing their jobs; the open question is
  whether read-after-refusal recovery got FASTER (429 successful reads in
  era C vs the era-A re-send loops). Needs a live-session segment large
  enough to read.
