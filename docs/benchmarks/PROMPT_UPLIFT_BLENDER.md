# Prompt Uplift Field Study: a 2-bit Model Passes a Pixel Gate (2026-11)

**Date:** 2026-11-12, revised 2026-11-13 · **Subject:** `abliterated-iq2_xs` on a
frozen Blender build contract, driven by bespoke harness tooling (the repo's UAP
install is 2.39.1; UAP supplies the memory store and worktree workflow here, not the
harness — there is no uplift subsystem to attribute a result to)
**Scope:** one measured prompt-uplift run against a frozen multi-gate acceptance
contract, and the four transferable lessons it produced. This is a dated study, not
a feature doc: the harness lives in the experiment repo, not here. It is an
*uncontrolled field run* in the sense defined by
[benchmarks/README.md](README.md) — one model, no control arm, prompt changed at every
step — so it shows magnitude and mechanism, not causation; quote the paired harness for
causal claims. For the evergreen mechanism the study informs, see
[guides/DELIVER.md](../guides/DELIVER.md) (iterate against real completion gates) and
[guides/LOCAL_MODELS.md](../guides/LOCAL_MODELS.md).

The revision quarantines 15 of the 106 scored attempts: the `B-visual-v4` and
`B-visual-v5` window was served by a different model than the study recorded. See
"An arm switch went unnoticed for two stages".

## The experiment

Task: write a Blender Python script that builds a rigged, animated, game-ready
robot. Acceptance is two independent gates, and the model is asked to produce exactly
one artifact, its build script:

- **Structural gate** — 12 checks: exactly 19 bones, 4 clips, under 12k tris, feet
  on the floor, weapon grip at the palm, every mesh bound to the rig, FBX
  round-trip, and so on. Hash-pinned in `.uap/gate-lock.json` (`a519af41c595…`),
  along with the human-readable contract `gates.md`.
- **Visual gate** — 8 pixel-level checks over 36 rendered PNGs (4 clips × 3 keyframe
  positions × 3 ortho cameras). Pixels are classified by HSV hue, so the gate reads
  the render the way a reviewer would: is the weapon at the hand, are the feet on the
  floor line, is any part floating off in space. Added after the lock file was
  written, so it is pinned by recorded hash (`7672fece1d0e…`) rather than by
  `gate-lock.json` — see the caveat under lesson 1.

Model: `abliterated-iq2_xs` (a ~2-bit quantized small model), temp 0, **first attempt
only, no repair turns**. Each stage is one prompt revision, scored by `prompt_sha`, so
a score is attributable to an exact prompt.

`n` counts scored attempts — 106 of the 111 rows in `.uap/uplift/results.jsonl`; the
five `--dry-prompt` rows print the prompt and record no score. A build that crashes
is scored 0, not excluded. `12/12` is the structural gate; `both gates` means 12/12
*and* 8/8 on the same first attempt. The `arm` column is the model that actually
served the attempt, established after the fact (see the quarantine section); the
runner now records `served_model` and scores 0 on `arm_mismatch`.

| stage | prompt change | n | arm | 12/12 | both gates | `sys` crashes |
|-------|---------------|---|-----|-------|------------|---------------|
| bare | raw prompt | 5 | IQ2_XS | 0 | n/a (no visual gate) | 0 |
| A-acceptance | 12-check contract + API crib sheet | 38 | IQ2_XS | 23 | n/a (no visual gate) | 0 |
| B-visual | + render/visual gate | 3 | IQ2_XS | 3 | 0 (visual 3/8–4/8) | 0 |
| B-visual-v2 | visual rules rewritten | 3 | IQ2_XS | 0 (all three builds crashed) | 0 | 0 |
| B-visual-v3 | tightened geometry rules | 3 | IQ2_XS | 2 | 0 (visual 6/8 twice) | 0 |
| B-visual-v4 | vertical limb chains, blade inside hand | 9 | **IQ4_XS v31** | 1 | 1 | 4 |
| B-visual-v4 | *same prompt*, re-run on the restored IQ2_XS arm (`--tag arm-rerun`) | 9 | IQ2_XS | 8 | 3 | 0 |
| B-visual-v5 | verbatim import header + copied fix loop | 6 | **IQ4_XS v31** | 6 | 4 (67%) | 0 |
| B-visual-v5 | *same prompt*, re-run on IQ2_XS | 6 | IQ2_XS | 5 | 2 | 0 |
| B-visual-v6 | read back the keyed fcurves before saving | 9 | IQ2_XS | 0 (all nine died in the build) | 0 | 0 |
| B-visual-v6 | `channelbag(create=)` → positional `ensure` | 3 | IQ2_XS | 0 (all three died on that kwarg) | 0 | 0 |
| B-visual-v6 | pose tables keyed to the 19 `bone_defs` names, appended self-check block at column 0, animation-amplitude rungs | 6 | IQ2_XS | 5 | 5 (83%) | 0 |
| **B-visual-v6** | *same prompt*, plus one rule: every pose-table row has exactly three elements | 6 | IQ2_XS | **5** | **5 (83%)** | 0 |

First-attempt rate at *both* gates, measured on IQ2_XS alone, went 0/3 → 3/9 → 2/6 →
5/6 across the prompt revisions that survive the quarantine, and that 5/6 held across
two consecutive prompt revisions instead of resting on one window. v4's nine IQ4-arm
runs split four ways: 4 `sys` crashes, 3 reasoning truncations, 1 built-but-incomplete
(11/12, 6/8), 1 clean pass.

## An arm switch went unnoticed for two stages

`B-visual-v4` and `B-visual-v5` — 15 attempts, the two stages that produced every
recorded both-gates pass in the original write-up — were not served by the model the
stage rows say they were. Both arms declare port 8080, so only one could own the
endpoint, and the runner recorded the *configured* model (`MODEL`,
`abliterated-iq2_xs`) rather than the served one; `served_model` and the
`arm_mismatch` guard were added afterwards.

Prompt-token counts are a fingerprint, but a weak one inside this window: the same
prompt file produces the same prompt for either arm, so `13868` and `14828` appear in
both engine logs. The completion-token count is per-attempt and separates them
cleanly — each window's counts appear in one log, in attempt order, and not in the
other at all.

| window | prompt tokens | `usage.completion_tokens` | IQ2_XS log | IQ4_XS v31 log |
|--------|--------------:|---------------------------|-----------:|---------------:|
| B-visual (n=3) | 8851 | — | 3 lines | 0 |
| B-visual-v2 (n=3) | 10389 | — | 3 | 0 |
| B-visual-v3 (n=3) | 10075 | — | 3 | 0 |
| B-visual-v4 originals (n=9) | 13908 ×3, 13868 ×6 | 5798, 5706, 5680, 5356, 5945, 5597 (6 untruncated) | 2 unrelated lines\* | 3 × 13908 + 6 × 13868 |
| B-visual-v4 reruns (n=9) | 13868 | 7311, 6741, 6830, 7126, 6163, 7482, 7471, 6927, 7085 | 9 | 0 |
| B-visual-v5 originals (n=6) | 14828 | 6597, 6585, 6472, 5225, 5189, 6211 | 0 | 6 |
| B-visual-v5 reruns (n=6) | 14828 | 6858, 5932, 7096, 6064, 6102, 6490 | 6 | 0 |
| B-visual-v6 (n=24, four prompt revisions) | 15962 ×9, 16140 ×3, 16517 ×6, 16762 ×6 | 6496, 6208, 5844, 6397, 6791, 6385 (pose-table prompt); 7194, 6738, 6460, 6589, 6764, 6664 (pose-table + row-arity prompt) | 9, 3, 6\*, 6 | 0 |

\* Two `13868` lines and one `16517` line in the IQ2_XS log belong to unrelated work:
they generated 634, 178 and 110 tokens rather than any of the attempt counts above,
and one of them reused 16,512 of 16,517 tokens. Excluding them, every prompt-token
line in the window belongs to the arm the completion-token column says it does. The
last window's six completion counts appear only in the IQ2_XS log, in attempt order at
lines 272807–272924, every one of them at `prompt 16762 tokens`; its `6738` also shows
up once in that log at an unrelated 42,964-token prompt, and in the IQ4_XS log not at
all.

The same log lines carry generation speed, which corroborates: ~150–170 tok/s on
IQ2_XS against ~80 tok/s on IQ4_XS v31, and the reruns' recorded `gen_elapsed`
implies IQ2_XS speed. Port 8080 now declares `abliterated-iq2_xs`
(`GET /v1/models`), and every `B-visual-v6` row carries
`served_model=abliterated-iq2_xs` with no `arm_mismatch`.

Consequences:

- The published `0/3 → 1/9 → 4/6` headline spanned two arms and is replaced above.
- Every both-gates pass in the original table came from the IQ4_XS arm, and so did
  v4's four `sys` `NameError` crashes, its three reasoning truncations, and the
  17 px walk-cycle failure. Those are not 2-bit-model behaviour.
- Re-running the same two prompts on the restored IQ2_XS arm still clears the pixel
  gate: 3/9 at v4 and 2/6 at v5, so the claim survives — at a lower rate, and with
  the improvement continuing to 5/6 at v6's last two prompts, each of which cleared
  both gates five of six attempts.
- The mechanism is lesson 1 with the verifier swapped for the model: integrity
  established after the fact instead of enforced at run time. One line in the
  runner — compare `served_model` to `MODEL` before scoring — would have caught the
  switch on the first affected attempt.

## Four lessons

### 1. A gate the model can edit is not a gate

The lock file states the rule in its own header: the model "may NOT edit these files.
A hash mismatch fails the run." The runner copies the validator, the visual gate, the
render script and `gates.md` fresh into each attempt workspace before the build runs,
then executes the model's script there. That keeps the frozen originals in `tooling/`
out of the way, but nothing enforces the header's sentence at runtime: the model's
script runs as ordinary Blender Python with write access to its workspace, and the
workspace sits inside the same repo as the originals. Integrity was therefore
established *after* the fact: pinned hash matches live, and every workspace carried
byte-identical gate copies — one distinct hash across all 99 validator copies, all 60
visual-gate copies and all 99 `gates.md` copies, covering the 106 scored runs.

Be precise about the strength of that. The runner copies the gates but does not
re-verify the hashes *inside* the run, and the workspace copy is writable, so the
guarantee here is audit-after-the-fact rather than runtime enforcement. That is enough
to make the pass rate falsifiable — a tampered gate would show up as a hash mismatch
when checked — but it is not the same as a read-only mount or a pre-flight assertion.
Closing that gap is cheap: recompute the workspace gate hashes after the model's
script has written and before the gates execute, and score the attempt 0 on mismatch.
Four `hashlib` calls in the runner turn "no tampering was found afterwards" into
"tampering could not have helped". The transferable part stands either way: without a
pinned verifier, a pass rate is unfalsifiable, because the cheapest path to 12/12
is editing the checker. This is the
same `enforce, don't suggest` stance as everywhere else in UAP, applied to the verifier
rather than the producer.

### 2. Score the prompt, not the vibe

Every run records `prompt_sha` alongside its score, and prompt files compose with
`#extends <stage>` so a revision is a delta, not a rewrite. That is what made v4
diagnosable: the geometry rules demonstrably worked — attempt 5 hit both gates, and
its static numbers matched the offline geometry test that had been run before the
stage shipped: 842 tris, feet 0.0000 m, grip 0.0000 m, predicted island ratio 0.088
against a 0.30 limit and measured 0.087. Its clip diffs came out smaller than the
offline prediction (predicted 0.020/0.080/0.029/0.161, measured 0.021/0.068/0.027/
0.084) but every one cleared the movement threshold, so the pass was not a fluke.
Without per-revision attribution, "v4 is worse than v3" would have buried a working
fix under an unrelated crash.

That pass was an IQ4_XS-served attempt, so the attribution needed the arm column too:
the same prompt on IQ2_XS cleared both gates 3 of 9 times, which confirms the geometry
rules rather than the arm. The isolation came from the appended `sys` crash and the
reasoning truncations, both of which the quarantine section shows were IQ4-side.

The same attribution is what made the arm switch recoverable rather than fatal: the
rerun rows carry the identical `prompt_sha` as the originals and differ only by
`--tag`, so the two arms can be separated attempt by attempt instead of discarded.
It also paid for itself forward: v6's last two prompts are a demonstrable uplift step,
not a lucky streak. The three rungs that failed in the v4 and v5 IQ2_XS reruns — the
attack clip losing all its weapon pixels (`gap 999`, four times at v4, twice at v5),
a walk cycle lifting feet past the limit, and jump endpoints leaving the root off the
floor — each got a named rule, and the next six attempts cleared all eight rungs five
times. The revision after that, which added one rule and changed the prompt hash,
cleared them five times again in a second six-attempt window, so the step does not
rest on one prompt's luck.

### 3. A regression can be a missing word, not a wrong idea

4 of 9 v4 runs died identically:

```
NameError: name 'sys' is not defined. Did you forget to import 'sys'?
  argv = sys.argv
```

The composed prompt asks for an `argv` guard (`argv` appears 7 times) and never
contains the words `import sys` — 0 occurrences in 43,382 characters. So the import is
purely the model's own guess. Reading the generated headers confirms it: v3's three
runs each happened to write `import bpy, sys, os`, while v4's four crashing runs wrote
`import bpy` / `import math` / `from mathutils import …` and omitted `sys` — same
instruction, different coin flip. v5 states the header as four lines to copy verbatim,
`import sys` included, and the crash count went to 0/6 with the validator at 6/6.

State the arm caveat: those four crashes were IQ4_XS runs. On IQ2_XS the v4 rerun had
0 `sys` crashes and 8/9 at 12/12, so the crash lesson cannot be separated from the
arm switch by this log alone — but v5's IQ2_XS rerun also had 0 `sys` crashes, and
its one build failure was an `IndentationError`, a different mode. The instruction
that matters is the one the failure names: when a prompt asks for a construct, state
the import or declaration that construct needs, as text to copy rather than prose to
understand. Small models rewrite headers; they do not reliably infer them.

The same shape showed up twice more in v6, both as prompt-text defects rather than
model defects. The appended post-save self-check block sits indented 4 spaces in the
prompt file for display, and one v6 run pasted it verbatim into a top-level script and
died on `IndentationError: unexpected indent` — fixed by a rule that says to paste it
at column 0; an `IndentationError` also ended one v5 IQ2_XS rerun. And `Action.fcurves`
does not exist in Blender 5.2: seven v6 runs died on that `AttributeError` — four in
the original window, three in the arm probe — *after* printing correct self-check
values and *after* saving the file, so the build exited 0 while the attempt scored 0.
Every scored row in the log reports `build_rc` 0; a crash is caught from the build
tail, never from the return code. That is why the prompt
now ships a measured, verified read path (`act.layers → strips → channelbags → fcurves`)
and an explicit ban list instead of letting the model invent one.

### 4. Reasoning budget is a hard constraint, not a tuning knob

Three v4 runs left reasoning on: the model spent 17k–27k reasoning characters before
writing any code and hit `finish_reason=length` mid-table, at both 8k and 12k max
tokens, producing an unterminated tuple and a `SyntaxError`. All three scored 0. Those
three were IQ4_XS runs.

The pattern holds across the whole log, not just v4. Of 106 scored runs, 15 had
reasoning on and 91 had it off. Every one of the 91 reasoning-off runs finished with
`finish=stop` — none truncated. All 8 truncated runs in the log had reasoning on, and
all 8 scored 0. Reasoning on did not become safe at a bigger budget either: the 7
reasoning-on runs that were given 32k–64k tokens did finish, and their best score was
11/12 — no reasoning-on run in the log ever cleared the structural gate. 12 of the 15
reasoning-on runs are IQ2_XS-served, and the conclusion is unchanged on that subset
alone: 5 truncated, best score 11/12, no 12/12. Meanwhile v5, run with
`--reasoning-effort none --max-tokens 12000`, scored 12/12 six of six on the IQ4 arm
and five of six on IQ2_XS, and v6's last two prompts each scored 12/12 five of six on
IQ2_XS.
A truncated run is a budget misconfiguration, not a model failure, and the budget
must be pinned in the invocation for scores to stay comparable across stages.

## Where the remaining failures sit

On the IQ2_XS arm the pixel gate's two animation rungs were the last thing standing,
and both were amplitude, not geometry:

- **`vis-weapon-at-hand`** — 4 of 9 v4 reruns and 2 of 6 v5 reruns. Every failure
  reported `gaps {'attack.mid': 999}` or `{'attack.end': 999}`: `999` means *no
  weapon pixels found in that frame*, not "drifted a little". The attack pose rotated
  the blade edge-on out of the camera plane.
- **`vis-feet-on-floor`** — 1 v4 rerun (13 px at `jump.end`, limit 12) and 1 v5 rerun
  (26 px at `walk.end`).

The structural gate measures the rest pose, so both builds pass 12/12 and fail the
pixel gate. Its `feet-on-floor` rung measures the lowest world-Z of any `Foot*` mesh
vertex in the rest pose against a 0.005 m tolerance — a static measurement — while the
visual gate measures the lift in every rendered frame. That gap, a structural check
that never exercises the animated state, is the argument for the visual gate existing
at all.

For scale, the logged margins say the improvement was in headroom, not only in the
pass rate. All 31 runs that cleared the island rung measured 0.083–0.089 of the bbox
diagonal against a 0.30 limit except `rule-f` attempt 16 at 0.113, still well under the
limit, while the five runs that failed it measured 3.142–3.338
at `B-visual` and 4.504 and 6.393 at `B-visual-v3`. On the floor rung, eight of the
eleven IQ2_XS runs that cleared it at v4 or v5 reported a max lift of exactly 12 px —
the limit itself, at `jump.start` — so "cleared" there was a coin flip against the
next frame. v6's ten clearing runs reported 1–9 px, none at the limit. The rules
moved the margin.

v6's pose-table prompt is what closed the two rungs: the attack clip keys `upper_arm_R`
only (0 → −70° → 0, forearm and hand never keyed, so the blade stays face-on to the
camera), the walk cycle keys both thighs ±20° with shins capped at ±12°, and the jump
holds root-z 0 at both endpoints with endpoint thigh keys at 0. Its one remaining
failure is a new mode, not one of these: attempt 10 wrote a pose-table row with two
tuple elements where `build_clip` unpacked three
(`ValueError: not enough values to unpack (expected 3, got 2)`), and the prompt's
existing "one tuple shape for every row" rule covers the *parts* table, not the pose
tables. That rule shipped in the revision after it, which scored 5/6 again. Its one
failure is a third new mode: attempt 19 put a walrus target that is not a name inside a
pose-table row (`SyntaxError: cannot use assignment expressions with expression`, at
`(-d30 := math.radians(-30.0), d0, d0)`), so the arity rule fixed the shape of the row
without constraining the expressions inside it. The open target is a rule that pose
tables contain no assignment expressions.

## Reproduce

Harness, prompts, findings, and per-attempt workspaces live in the experiment repo
(`blender-test-1`): `tooling/uplift_runner.py`, `.uap/uplift/prompts/`,
`.uap/uplift/FINDINGS-B-visual-v{4,5,6}.md`,
`.uap/uplift/FINDINGS-arm-contamination.md`, `.uap/uplift/runs/`.

```
python3 tooling/uplift_runner.py --stage B-visual-v6 --attempt N \
    --reasoning-effort none --max-tokens 12000 --tag arm-rerun
```

Pin `--reasoning-effort none` and `--max-tokens 12000` (lesson 4), keep `--tag` so an
attempt served by a different arm stays separable in `results.jsonl` (the quarantine
section), and confirm the endpoint before scoring: `GET /v1/models` on port 8080 must
return `abliterated-iq2_xs`.
