# P41: Three.js / WebGL Production

**Category**: Creative Production
**Abbreviation**: Threejs-WebGL

**Provenance**: three.js skill suites installed user-level 2026-11-15:
`~/.agents/skills/threejs/` (full-stack-skills, 18 API skills),
`~/.agents/skills/threejs-r3f/` (three.js + React Three Fiber best
practices), `~/.agents/skills/threejs-games/` (playable browser games), plus
MengTo's web-design 3d recipes. Methodology stays P39 (the Fable loop); this
pattern adds the API and build layer.

## Pattern

Pick the suite by target. Raw Three.js → `threejs-scenes`, `threejs-camera`,
`threejs-lights`, `threejs-materials`, `threejs-geometries`,
`threejs-textures`, `threejs-postprocessing`, `threejs-renderers`,
`threejs-controls`, `threejs-loaders`, `threejs-animation`, `threejs-math`,
`threejs-node-tsl`, `threejs-webxr`, `threejs-audio`, `threejs-helpers`,
`threejs-dev-setup`. React apps → `threejs-r3f` skills
`three-best-practices` and `r3f-best-practices`. Playable games →
`threejs-game-director`, `threejs-gameplay-systems`,
`threejs-aaa-graphics-builder`, `threejs-game-ui-designer`,
`threejs-debug-profiler`, `threejs-qa-release`.

P39 budgets apply (60 fps, <12 ms per frame, zero shader compiles during
play, <40 MB download); `threejs-debug-profiler` finds the misses; ship
through `threejs-qa-release`. Activate by exact name (Skill tool / slash
command); read the SKILL.md under the namespaces above in other harnesses.
