# Quality-Tier Uplift Plan, 2026-11-16

Status: PROPOSED (plan PR first, implementation PRs after; merge order: plan first)
Scope proposed for immediate implementation: Wave 0 (all five items). Wave 1 and
Wave 2 are recorded for approval after Wave 0 measurements exist.
Reference implementation: the voxel-pagoda-speedy scene measured against the
Claude Fable 5.2 High exemplar from LuminaBench.

## 1. Source analysis

### 1.1 The two artifacts

**Reference (the bar).** LuminaBench's voxel pagoda test
(https://luminabench.com/tests/voxel-pagoda/) records the frontier on this exact
prompt. Claude Fable 5.2 High: USD 10.54, 20m 0s, 558,000 tokens, 46 tool calls.
Its front and rear standard evaluation views are the visual bar
(`media/fable52-voxel/high-front.webp`, `high-rear.webp`).

**Local (the current tier).** `~/dev/voxel-pagoda-speedy`, built on the local
fleet (proxy-routed Qwen 3.8 class arm; the deliver log carries a legacy A3B
label): a self-contained 703 KB single-file Three.js scene, 22,928 solid + 143
glow voxels. Five-story pagoda, torii, arched bridge, koi pond with stream and
waterfall, zen garden, sakura, maple, pine, willow, bamboo, five stone lanterns,
650 falling petals, 70 fireflies, 4 koi, golden-hour sun plus hemisphere plus two
lamp point lights, ACES tone mapping, exponential fog, UnrealBloom, sky and
water shaders, Canvas2D fallback. Gates: 8/8 tests, visual verdict passed (max
mode), interaction 6/8, capability baseline 1.2 fps and 34 draws per frame in
the capture environment.

### 1.2 The measured gap

Six axes, deterministic extraction (PIL/numpy: k-means dominant colors, edge
fraction at a 0.06 luminance step threshold, 12-bit distinct color count, glow =
value above 0.93 with saturation above 0.25, dark = value below 0.2). Local
captures: `index-t{0,1,2}.png` under the project's `.uap/visual/` (1280x720,
includes the title overlay). Reference: the two Fable stills (1200x750, curated
standard views).

| Axis | Fable front | Fable rear | Local t0..t2 | Reading |
| --- | --- | --- | --- | --- |
| Distinct 12-bit colors | 1004 | 979 | 484 to 486 | half the tonal vocabulary |
| Edge fraction | 0.0839 | 0.066 | 0.0236 | about 3x less structure per frame |
| Glow fraction | 0.0365 | 0.0250 | 0.0023 | 11 to 16x less emissive presence |
| Dark fraction | 0.054 | 0.053 | 0.244 | crushed blacks dominate the frame |
| Luminance contrast | 0.214 | 0.213 | 0.350 | bimodal wash and crush vs balanced midtones |
| Mean value / saturation | 0.66 / 0.306 | 0.669 / 0.304 | 0.571 / 0.331 | darker overall, similar chroma |

Caveat, stated plainly: the local captures are gate captures at the default
wide framing with a UI overlay; the reference stills are curated three-quarter
views. Framing inflates the edge and glow deltas. The direction of the gap is
unambiguous on every axis, and the canonical capture spec in 0.1 (pin 1200x750,
device pixel ratio 1, fixed camera presets through the scene's existing `#cam=`
hash) removes the framing variable so the numbers become directly comparable.

### 1.3 The process gap

How each output was produced:

- Fable High: 46 tool calls, 558k tokens, 20 minutes. An iterative build with
  screenshot-driven refinement, fresh critics, and capped fault loops. These
  are exactly the P39 economics.
- Local: a deliver mission. Executor proxy-routed on the local arm, max 3
  turns, **self-verified** (the run log records `exec=qwen35-a3b
  judge=qwen35-a3b distinct=NO(self-verify)`), escalation configured to nothing
  (`no stronger model configured`), and a large share of turns burned on
  read-only rounds, write nudges, and protected-oracle refusals. The aesthetic
  target was never present as a number the loop could act on. Every gate that
  converged was functional (build, tests, probes).

### 1.4 Existing mechanisms to build on

- **P39 Fable-3D** (`.factory/patterns/P39_fable_threejs.md`): the codified
  process behind this output class. "Find the real thing first and turn it into
  numbers. The numbers are the bar." Fresh critic, never self-grade, capped
  rounds, blind A/B, fixed-form faults, and "if the next critic names the same
  fault after a shader fix, change the GEOMETRY."
- `src/delivery/visual-gate.ts`: entry discovery, browser driver, captures,
  "renders and moves" proof, external-resource failure reporting.
- `src/delivery/visual-baseline.ts`: dHash and grid drift against approved
  baselines (regression policing, not tier measurement), plus
  `approveVisualBaseline`, the anchor-harvesting precedent.
- `src/delivery/vision-judge.ts`: fail-soft vision scoring with
  `autodetectLocalVision` (mmproj probe via `/props`). Advisory by contract;
  unconfigured today because no local arm ships a projector.
- `src/delivery/capability-profile.ts`: fps, draws, and program counts policed
  baseline-vs-current with thresholds. The in-repo precedent for "measure a
  profile, gate on thresholds."
- `uap quality` (init, check, baseline, report, mutate) plus
  `.uap/quality-baseline.json`: the deterministic tier-policing ratchet for
  code metrics. This plan generalizes that pattern to non-code outcomes.
- `src/delivery/convergence-loop.ts`: the loop the tier gate plugs into.
- The fleet: proxy placement and arms. The verified quality arm (Qwen 3.8 27B,
  13/13 verify) already exists as the stronger critic; deliver simply could not
  see it.

## 2. Root cause

The model gap is real, but it is not the binding constraint. Three layers were
missing, all fixable in policy and process:

1. **The bar was never digitized.** No anchor profile, no thresholds, no
   canonical views. P39's first rule, "turn the real thing into numbers", was
   never executed.
2. **The loop had no critic.** The builder graded its own work, the vision judge
   was unconfigured, and no escalation model existed.
3. **No gate could see quality.** The visual gate proves rendering and motion;
   nothing measured tier distance. Aesthetic quality was unverifiable, so it
   could not converge.

## 3. Design principles (inherit System-1)

- **Deterministic policy owns the gate.** Metrics, thresholds, and gate logic
  live in reviewed code. Critics and vision models only assess.
- **Fail closed, with an escape hatch.** A missing anchor or an extractor
  failure yields an "unmeasured" verdict, never a silent pass. The escape hatch
  (`UAP_TIER_GATE_OFF=1`) is documented, same discipline as the quality gate.
- **Reference-anchored.** A tier is derived from measured exemplars (median plus
  reviewed tolerance), never from vibes.
- **Evidence-bound.** Feature vectors carry artifact SHA, anchor SHA, and
  extractor version; stale or mismatched evidence is rejected.
- **Equal contract, unequal cost.** Forcing all models to this tier means: every
  model receives the same target contract, the same deterministic gate, and the
  same loop budget. Weaker models close the gap through more iterations,
  routing, and selection. What cannot reach the bar after its rounds is cut or
  designed around, with the residual gap reported (P39's honesty rule), never
  silently shipped.
- **Measured.** Every wave lands with before/after numbers. The voxel pagoda is
  the reference implementation and its delta table is the acceptance evidence.

## 4. The mechanism: the Tier Enforcement Layer

One pipeline under the existing `uap quality` namespace:

    anchors -> feature extraction -> tier profile (policy) -> canonical capture
    -> gap report -> tier gate in deliver -> gap-directed iteration
    -> best-of-N selection -> escalation ladder -> telemetry

CLI surface:

    uap quality anchor add <class> <artifact...>   # measure and store an anchor profile
    uap quality profile <artifact>                # deterministic feature vector (JSON)
    uap quality tier derive <class>               # anchors -> thresholds (reviewed policy file)
    uap quality gap <artifact> --tier <name>       # deltas plus directional edit directives

How the pieces behave:

- **Anchors** are exemplar outputs per outcome class, stored under
  `.uap/quality/anchors/` (project-local, gitignored). References for measuring
  only, never shipped or committed, per P39. Operator-approved local outputs can
  be harvested as anchors later (2.2).
- **Extractors** are deterministic per class. Visual v1: the six axes of 1.2
  plus dominant palette and hue histogram, computed on canonical captures
  (1200x750, DPR 1, camera preset via the scene's `#cam=` hash; PNG decoding
  reused from visual-baseline.ts; pure TS, no new dependencies).
- **Tier profiles** are threshold sets derived from anchor medians with reviewed
  tolerance, stored as reviewed policy. The gate compares vectors to thresholds;
  nothing else.
- **The gap report** is both verdict and critique: a JSON vector, the per-axis
  deltas, and one directional directive per failing axis. Example from the
  current pagoda: glow 0.0023 against 0.030 means expand the emissive voxel set
  roughly tenfold and raise bloom strength; dark 0.244 against 0.054 means lift
  hemisphere fill and lighten the blacks before touching exposure (P39's light
  rule). The convergence loop orders passes by normalized severity and fixes one
  axis per pass: the critic names the single biggest gap, the builder fixes only
  that.
- **The tier gate** becomes a first-class deliver gate beside build, tests, and
  visual. DONE below tier requires all three: the attempt cap was reached, the
  best-of-N candidate was selected, and the residual gap is documented in the
  report. Shadow mode first (assess, do not block; promotion to blocking only
  after a measured false-positive budget), the System-1 promotion rule.
- **Fresh-critic contract.** The builder never grades its own work: exec and
  judge distinct becomes a hard requirement for tier-relevant classes (the
  reference run's `distinct=NO(self-verify)` is the failure this closes).
  Critic output follows P39's fixed form: yes or no, at most five ranked faults,
  each with a number and a blocking-or-minor mark. The verified 27B arm is wired
  as the default critic and escalation target through the existing
  `UAP_ESCALATE_MODEL` seam. The deterministic tier gate remains the floor; the
  critic is advisory above it.
- **Best-of-N.** Seeded variants, deterministically ranked by tier distance.
  N is bounded (default 3) because the fleet is one GPU.
- **Escalation ladder**, all reviewed policy: inject the matching scaffold or
  pattern; route the plateaued axis to the quality arm; decompose the axis into
  an independent pass; then cut or design around (P39) with the gap documented.
- **Proxy target contract.** At mission start the proxy injects the tier summary
  and an anchor digest into executor context, so the model builds toward the
  tier from turn one, and selects the per-class sampling profile (creative
  builds get the creative profile).

## 5. Waves

### Wave 0, the reference implementation (each lands as its own PR)

**0.1 Anchor registry + visual extractor v1.** Canonical capture spec;
deterministic, versioned feature vectors; `uap quality anchor` and
`uap quality profile`. Acceptance: the two Fable anchors profiled and stored; a
determinism test (same input, identical vector hash); synthetic-image unit
tests (flat, gradient, noise with known values); the pagoda captures profiled
and matching 1.2 within tolerance.

**0.2 Tier derivation + gap compiler.** `uap quality tier derive` and
`uap quality gap`. Acceptance: the gap report on the current pagoda captures
reproduces table 1.2; every failing axis carries a directive an executor can act
on without ever seeing the reference.

**0.3 Fresh-critic wiring.** The 27B quality arm wired as critic and escalation
model (config plus placement discipline; the switch doctrine is respected);
exec and judge distinct enforced for tier-relevant classes; the fixed-form
critic prompt. Acceptance: a deliver run reports distinct=YES with a critic
report in the P39 form.

**0.4 Reference run: uplift the voxel pagoda to the Fable-High tier.**
Gap-directed passes ordered by severity, one axis per pass, a critic round per
pass, and the existing gates (8 tests, capability floor, visual gate) kept
green. Acceptance targets on canonical views: distinct colors >= 850, glow >=
0.02, dark <= 0.08, edge >= 0.05, contrast within 0.19 to 0.26, and no
capability regression. The PR carries the before/after vector table. First
directives, in severity order: palette ramps and wider per-voxel tone variation
for vocabulary; the emissive set from 143 glow voxels toward roughly tenfold
plus bloom tuning for glow; hemisphere lift and black lightening for dark;
mid-ground props, foreground silhouettes, and the hero three-quarter camera
preset for edge; one exposure and tone-map pass for contrast.

**0.5 Deliver tier gate.** First-class gate, shadow mode first, promotion to
blocking after the measured false-positive budget. Acceptance: a seeded
below-tier artifact is refused DONE with the gap report attached; a
tier-passing artifact is unaffected; the escape hatch is tested.

### Wave 1, generalization to all outcome classes

**1.1 Extractor classes beyond visual.** api-behavior: golden request and
response pairs; schema conformance, field coverage, semantic diff distance, and
latency envelope. doc-style: the shipped prose-style gates as anchors; the
v2.51.1 rewrite corpus is the harvest. bench-score: terminal-bench and swebench
as tiers, on the existing bench:ladder seam. Acceptance: one non-visual class
end-to-end, API first (examples/workflows provides the fixtures).

**1.2 Best-of-N plus the escalation ladder.** Acceptance: N=3 seeded variants
ranked deterministically on a fixture; the ladder fires on a measured plateau
and cuts with a documented gap when its rounds are exhausted.

**1.3 Proxy target-contract injection plus per-class sampling profiles.**
Acceptance: the executor prompt carries the contract; the sampling profile
switches by class.

**1.4 Tier-aware quality-model placement.** When an uplift loop needs the 27B
arm, placement follows the existing switch doctrine; this item makes the need
explicit and scheduled rather than ad hoc. Owner: the fleet operator.

### Wave 2, measured fleet economics (recorded, not yet approved)

- 2.1 Convergence telemetry per model per class (iterations-to-tier, escalation
  frequency, cut rate, best-of-N win rate) published in docs/performance/.
- 2.2 Anchor harvesting from operator-approved outputs, on the
  approveVisualBaseline precedent.
- 2.3 Vision-judge promotion path: advisory now, corroborating once an mmproj
  arm exists; blind A/B per P39. The deterministic gate stays the floor.

## 6. Sequencing and PR plan

1. This plan (docs PR, plus the INDEX row).
2. 0.1 extractor and anchors.
3. 0.2 tier and gap compiler.
4. 0.3 critic wiring.
5. 0.4 the pagoda reference run, the measured proof.
6. 0.5 the deliver gate, shadow first, then blocking.
7. Wave 1 in order 1.1, 1.2, 1.3; 1.4 with the operator.
8. Wave 2 once Wave 0 and Wave 1 measurements exist.

## 7. Risks and open questions

- **Goodhart.** Any single metric saturates without real quality. Mitigation:
  a multi-axis gate, a fresh critic above the floor, blind A/B once vision
  lands, operator sign-off on anchors and tier derivation, and every
  tier-reached claim carries the full vector.
- **Anchor licensing.** The Fable stills are third-party benchmark media.
  Anchors are measuring references only: project-local, gitignored, never
  shipped (P39: references for measuring only, never shipped).
- **Capture-environment noise.** The capture box renders 1 to 2 fps on software
  WebGL (capability baseline 1.2 fps, 34 draws per frame). Tier metrics are
  computed on static canonical frames; motion stays with the visual gate.
- **Framing mismatch.** Until the canonical capture spec lands, edge and glow
  deltas carry a framing component; 1.2 states this.
- **Attempt-farm cost.** One GPU serves the whole fleet; N is bounded and
  farming engages only on a measured plateau.
- **Extractor drift.** Vectors carry the extractor version; tier profiles
  re-derive on version change; old evidence fails closed.
- **Gate fatigue.** Shadow mode first, a measured false-positive budget before
  blocking, and a documented escape hatch (the System-1 lesson).
- Open questions: who signs off tier derivation (project owner or fleet policy);
  whether tier defaults live fleet-wide in config with per-project overrides;
  whether an mmproj vision arm is on the fleet roadmap (it enables blind A/B);
  whether the 27B critic arm runs on demand only (roughly a 365 s load on a
  single GPU) or the ladder owns its switch windows.
