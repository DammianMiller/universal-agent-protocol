# P40: Blender 3D Production

**Category**: Creative Production
**Abbreviation**: Blender-3D

**Provenance**: the arjun988/blender-skills collection (94 skills, installed
user-level at `~/.agents/skills/blender/`, pinned in its UPSTREAM.json), wired
into the router 2026-11-15. Applies to any Blender / 3D-asset task: modeling,
sculpting, characters, environments, rigging, animation, lookdev, export.

## Pattern

Enter through `blender-director` ("use when starting any Blender asset task"):
it analyzes the request, picks the pipeline, writes a short brief, then routes
to specialists. In Droid, activate skills by exact name with the Skill tool
(`/blender-director` also works); in other harnesses read the SKILL.md at
`~/.agents/skills/blender/<skill>/SKILL.md`.

Specialists: `blender-modeler` (general geometry, non-destructive modifier
stacks), `hard-surface`, `prop-artist`, `vehicle-artist`, `character-artist`,
`creature-artist`, `environment-artist`, `vegetation-artist`, `sculpting`,
`retopology`, `uv-workflow`, `materials`, `texture-workflow`, `lookdev`,
`lighting`, `rendering`, `compositing`, `rigging`, `animation`, `cloth-sim`,
`physics-sim`, `geometry-nodes`, `procedural-modeling`, `asset-optimization`,
`lod-pipeline`, `collision-proxy`, then engine export: `export-pipeline`,
`unity-export`, `unreal-export`, `godot-export`.

Rules that travel with every Blender task: MCP-first — when a Blender MCP
server is connected, execute through it (viewport screenshots,
`execute_blender_code`) instead of describing UI steps; non-destructive by
default; style and mood domains (lowpoly, anime, archviz, horror, …) have
their own skills; `qa-review` is the ship gate (screenshots + checklists)
before any export; reference images go through blender-director's
reference-match loop (analysis template, camera match, screenshot comparison).
