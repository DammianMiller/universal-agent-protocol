# P41: Three.js / WebGL Production

**Category**: Creative Production
**Abbreviation**: Threejs-WebGL

## When to use

Building or debugging 3D in the browser: a three.js scene, a WebGL or WebGPU
app, shaders, camera controls, lighting, post-processing, GLTF loading, a
React Three Fiber component, or a playable three.js game.

## Pattern

Pick the suite by target. Raw Three.js → `threejs-scenes`, `threejs-camera`,
`threejs-lights`, `threejs-materials`, `threejs-geometries`, `threejs-textures`,
`threejs-postprocessing`, `threejs-renderers`, `threejs-controls`,
`threejs-loaders`, `threejs-animation`, `threejs-math`, `threejs-node-tsl`,
`threejs-webxr`, `threejs-audio`, `threejs-helpers`, `threejs-dev-setup`.
React → `threejs-r3f` (`three-best-practices`, `r3f-best-practices`).
Games → `threejs-game-director`, `threejs-gameplay-systems`,
`threejs-aaa-graphics-builder`, `threejs-game-ui-designer`,
`threejs-debug-profiler`, `threejs-qa-release`.

P39 budgets apply (60 fps, <12 ms/frame, no shader compiles in play, <40 MB
download); `threejs-debug-profiler` finds the misses; ship through
`threejs-qa-release`. Activate by exact name (Skill tool / slash command);
elsewhere read the SKILL.md under the namespaces above.

**Provenance**: three.js suites installed 2026-11-15 —
`~/.agents/skills/threejs/` (18 API skills), `~/.agents/skills/threejs-r3f/`
(three.js + React Three Fiber best practices), `~/.agents/skills/threejs-games/`
(playable browser games), plus MengTo 3d recipes. Methodology stays P39.
