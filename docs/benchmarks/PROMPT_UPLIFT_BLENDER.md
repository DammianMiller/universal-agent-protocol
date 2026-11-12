# Prompt Uplift Field Study: a 2-bit Model Passes a Pixel Gate (2026-11)

**Date:** 2026-11-12 · **Subject:** `abliterated-iq2_xs` on a frozen Blender build
contract, driven by bespoke harness tooling (the repo's UAP install is 2.39.1; UAP
supplies the memory store and worktree workflow here, not the harness — there is no
uplift subsystem to attribute a result to)
**Scope:** one measured prompt-uplift run against a frozen multi-gate acceptance
contract, and the four transferable lessons it produced. This is a dated study, not
a feature doc: the harness lives in the experiment repo, not here. It is an
*uncontrolled field run* in the sense defined by
[benchmarks/README.md](README.md) — one model, no control arm, prompt changed at every
step — so it shows magnitude and mechanism, not causation; quote the paired harness for
causal claims. For the evergreen mechanism the study informs, see
[guides/DELIVER.md](../guides/DELIVER.md) (iterate against real completion gates) and
[guides/LOCAL_MODELS.md](../guides/LOCAL_MODELS.md).

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

`n` counts scored attempts — every row in `.uap/uplift/results.jsonl` except the three
`--dry-prompt` rows, which print the prompt and record no score. A build that crashes is
scored 0, not excluded. `12/12` is the structural gate; `both gates` means 12/12 *and*
8/8 on the same first attempt.

| stage | prompt change | n | 12/12 | both gates | `sys` crashes |
|-------|---------------|---|-------|------------|---------------|
| bare | raw prompt | 5 | 0 | n/a (no visual gate) | 0 |
| A-acceptance | 12-check contract + API crib sheet | 38 | 23 | n/a (no visual gate) | 0 |
| B-visual | + render/visual gate | 3 | 3 | 0 (visual 3/8–4/8) | 0 |
| B-visual-v2 | visual rules rewritten | 3 | 0 (all three builds crashed) | 0 | 0 |
| B-visual-v3 | tightened geometry rules | 3 | 2 | **0** (visual 6/8 twice) | 0 |
| B-visual-v4 | vertical limb chains, blade inside hand | 9 | 1 | **1** | 4 |
| B-visual-v5 | verbatim import header + copied fix loop | 6 | **6** | **4 (67%)** | 0 |

First-attempt rate at *both* gates went 0/3 → 1/9 → 4/6 across three prompt
revisions, with no change to the model, the gates, or the temperature. v4's nine runs
split four ways: 4 `sys` crashes, 3 reasoning truncations, 1 built-but-incomplete
(11/12, 6/8), 1 clean pass.

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
byte-identical gate copies (one distinct hash across all 63 validator and 24
visual-gate copies).

Be precise about the strength of that. The runner copies the gates but does not
re-verify the hashes *inside* the run, and the workspace copy is writable, so the
guarantee here is audit-after-the-fact rather than runtime enforcement. That is enough
to make the pass rate falsifiable — a tampered gate would show up as a hash mismatch
when checked — but it is not the same as a read-only mount or a pre-flight assertion.
The transferable part stands either way: without a pinned verifier, a 67% pass rate is
unfalsifiable, because the cheapest path to 12/12 is editing the checker. This is the
same `enforce, don't suggest` stance as everywhere else in UAP, applied to the verifier
rather than the producer.

### 2. Score the prompt, not the vibe

Every run records `prompt_sha` alongside its score, and prompt files compose with
`#extends <stage>` so a revision is a delta, not a rewrite. That is what made v4
diagnosable: the geometry rules demonstrably worked (attempt 5 hit both gates,
matching the offline geometry test that had been run before the stage shipped) while
the stage as a whole regressed. Without per-revision attribution, "v4 is worse than
v3" would have buried a working fix under an unrelated crash.

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

The transferable part: when a prompt asks for a construct, state the import or
declaration that construct needs, as text to copy rather than prose to understand.
Small models rewrite headers; they do not reliably infer them.

### 4. Reasoning budget is a hard constraint, not a tuning knob

Three v4 runs left reasoning on: the model spent 17k–27k reasoning characters before
writing any code and hit `finish_reason=length` mid-table, at both 8k and 12k max
tokens, producing an unterminated tuple and a `SyntaxError`. All three scored 0.

The pattern holds across the whole log, not just v4. Of 67 scored runs, 15 had
reasoning on and 52 had it off. Every one of the 52 reasoning-off runs finished with
`finish=stop` — none truncated. All 8 truncated runs in the log had reasoning on, and
all 8 scored 0. Reasoning on did not become safe at a bigger budget either: the 7
reasoning-on runs that were given 32k–64k tokens did finish, and their best score was
11/12 — no reasoning-on run in the log ever cleared the structural gate. Meanwhile v5,
run with `--reasoning-effort none --max-tokens 12000`, scored 12/12 six times out of
six. A truncated run is a budget misconfiguration, not a model failure, and the budget
must be pinned in the invocation for scores to stay comparable across stages.

## Where the last two failures sit

Both remaining failures are single-rung and both are animation amplitude, not
geometry. A walk cycle lifted the feet 17 px where the limit is 12; an attack pose
rotated the blade edge-on so its pixels left the camera plane entirely (gap 999 means
"no weapon pixels found in that frame", not "drifted a little").

The structural gate measures the rest pose, so both builds pass 12/12 and fail the
pixel gate. Its `feet-on-floor` rung reads the lowest world-Z of any `Foot*` vertex at
`|z| <= 0.005` m — a static measurement — while the visual gate measures the lift in
every rendered frame. That gap, a structural check that never exercises the animated
state, is the argument for the visual gate existing at all.

For scale, re-rendering the offline reference build (the hand-written geometry proof
that shipped the v4/v5 rules) through the same pixel gate puts its peak foot lift at
7 px and its island ratio at 0.088 of the bbox diagonal (limit 0.30); the four passing
v5 runs land at 3–9 px. The failing walk cycle at 17 px is not marginally off — it is
over twice the reference and 5 px past the limit, on the one rung it misses.

## Reproduce

Harness, prompts, findings, and per-attempt workspaces live in the experiment repo
(`blender-test-1`): `tooling/uplift_runner.py`, `.uap/uplift/prompts/`,
`.uap/uplift/FINDINGS-B-visual-v{4,5}.md`, `.uap/uplift/runs/`.

```
python3 tooling/uplift_runner.py --stage B-visual-v5 --attempt N \
    --reasoning-effort none --max-tokens 12000
```
