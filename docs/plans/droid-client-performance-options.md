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
