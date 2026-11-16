# P43: Motion & Animation Design

**Category**: Creative Production
**Abbreviation**: Motion-Anim

**Provenance**: `~/.agents/skills/lottiefiles/` (LottieFiles `motion-design` —
universal principles), `~/.agents/skills/emilkowalski/` (18 design-engineering
animation skills), MengTo web-motion recipes, and the Blender animation suite.
Wired into the router 2026-11-15.

## Pattern

Start with principles: `motion-design` (timing, easing, choreography,
emotion-first — implementation-agnostic), `animation-vocabulary` and
`choreograph` for naming and staging, `find-animation-opportunities` to pick
what earns motion at all. Then the medium. UI motion → `improve-animations`,
`review-animations`, `remove-animations`, `gestures`, `animation-performance`,
plus the design family's `animate`/`delight` for feature polish. Web motion →
MengTo recipes (`gsap-*`, `scroll-*`, `staggered-*`, `reveal-*`,
`pointer-trail-emitter`). 3D character and scene motion → Blender `animation`,
`cloth-sim`, `physics-sim`. Scene animation → `threejs-animation`.

Performance is a first-class gate (`animation-performance`): respect
reduced-motion, avoid layout thrash, prefer compositor-only properties.
Never grade your own work — `review-animations` or a fresh critic verifies
the result before it ships.
