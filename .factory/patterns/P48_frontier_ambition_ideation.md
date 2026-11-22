# P48: Frontier Ambition & Ideation (Reference-Free)

**Category**: Creative Production
**Abbreviation**: Frontier-AI

**Provenance**: digitized 2026-11-22 from a dual-panel frontier comparison
(video `889410aa`, same prompt rendered by Kimi 3.1 Pro and Opus 5.5) plus
the run-3 local-tier failure analysis
(`docs/plans/quality-tier-uplift-2026-11-16.md`). The reference material was
consumed ONCE at harvest; everything below is task-agnostic and needs no
reference file, exemplar, or comparison media at runtime. The router injects
this pattern for creative/build tasks — 3D scenes, UIs, animations, games,
visual or aesthetic deliverables — where "flagship quality" is the bar but no
anchor exists to point at.

## The two gaps this closes

Local models on creative builds fail in two separable ways:

1. **Ambition gap** — the deliverable is a minimum viable toy: half the tonal
   vocabulary, a third of the structure density, named elements present but
   thin, implied elements absent.
2. **Ideation gap** — no chosen art direction: mixed stances (restrained
   palette with theatrical bloom), no composition hierarchy, no depth
   layering, lighting that contradicts itself.

Frontier work shows both directions of ideation winning (restrained-premium
and theatrical-premium both measured inside the frontier envelope) — the
failure is never "wrong stance", it is **no stance**, and **too little
ambition**.

## Ambition floor (coverage calculus)

Parse the task language before building:

- Every NOUN becomes a subsystem with an instance-count budget. Density
  intensifiers ("detailed", "intricate", "every", "at each", "zoom level")
  multiply the budget — they are quantity words, not decoration.
- Every ADJECTIVE becomes a measurable property with a numeric regime
  ("bright" → high mean value AND lifted shadows; "soft" → no crushed blacks;
  "subtle glow" → small but NONZERO emissive coverage; "warm" → coherent hue
  ramp).
- Every VERB becomes an animation with a named period and amplitude.
- IMPLIED requirements get explicit subsystems: a floating island implies a
  detailed underside; a scene implies a camera story and negative space; a
  night theme implies motivated light sources.

## Ideation codex (choose once, apply everywhere)

1. **One named stance** — e.g. restrained-premium (suppressed selective
   accents, soft palette, generous negative space, faint distant elements) or
   theatrical-premium (bold emissives, saturated palette, dramatic focal
   glow). Name it before the first line of code; never mix.
2. **Composition hierarchy** — one focal mass on-axis, negative space as its
   counterweight, secondary elements visibly subordinate.
3. **Depth layering** — near / mid / far bands with atmospheric desaturation
   toward the far band.
4. **One light story** — key, fill, and practicals all motivated by the same
   scene logic; shadows agree with the key.
5. **Motion hierarchy** — slow ambient motion, quicker focal motion, nothing
   competing with the focal point.
6. **Detail gradient** — dense at the focus, sparse at the periphery.
7. **Palette discipline** — one dominant ramp plus a bounded accent budget.

## Self-measured regimes (no reference media)

Declare 3-6 numeric quality axes the artifact measures on ITSELF, and iterate
until every axis is in regime. For rendered visuals the harvested frontier
class prior is already baked in: `uap quality gap <capture>
visual-scene/frontier-prior` reports per-axis pass/fail with worst-first fix
directives (structure density, palette vocabulary, emissive presence, crushed
blacks, tonal balance, exposure, chroma). Fix the WORST axis first, one pass
per axis; geometry failures before shading failures — if the same fault
recurs after a shader/post fix, change the geometry.

## Completion rule

The build is not DONE while any declared regime measures out of band, any
named element is missing or thin, or any two parts of the artifact visibly
belong to different art directions. Measure, don't vibe: every claim of
quality carries the number that backs it.
