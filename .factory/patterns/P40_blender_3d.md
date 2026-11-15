# P40: Blender 3D Production

**Category**: Creative Production
**Abbreviation**: Blender-3D

## When to use

Any Blender or 3D asset request: modeling something in Blender, sculpting a
character or creature, making an asset game-ready, retopology and UV work,
rigging and animation, lighting and rendering a scene, building an
environment, geometry nodes, lookdev, matching a reference image, or
exporting to Unity, Unreal or Godot.

## Pattern

Enter through `blender-director` (the "starting any Blender asset task"
orchestrator): it analyzes the request, picks the pipeline, writes a short
brief, then routes to specialists. In Droid activate skills by exact name via
the Skill tool (`/blender-director` works too); elsewhere read the SKILL.md
under `~/.agents/skills/blender/<skill>/`.

Specialists: `blender-modeler` (non-destructive modifier stacks),
`hard-surface`, `prop-artist`, `vehicle-artist`, `character-artist`,
`creature-artist`, `environment-artist`, `vegetation-artist`, `sculpting`,
`retopology`, `uv-workflow`, `materials`, `texture-workflow`, `lookdev`,
`lighting`, `rendering`, `compositing`, `rigging`, `animation`, `cloth-sim`,
`physics-sim`, `geometry-nodes`, `procedural-modeling`, `asset-optimization`,
`lod-pipeline`, `collision-proxy`, and engine export via `export-pipeline`,
`unity-export`, `unreal-export`, `godot-export`.

Standing rules: MCP-first when a Blender MCP server is connected (viewport
screenshots, `execute_blender_code`); non-destructive by default; style and
mood domains (lowpoly, anime, archviz, horror) have their own skills;
`qa-review` is the ship gate before any export; reference images go through
blender-director's reference-match loop.

**Provenance**: arjun988/blender-skills (94 skills) at
`~/.agents/skills/blender/` (see its UPSTREAM.json); router-wired 2026-11-15.
