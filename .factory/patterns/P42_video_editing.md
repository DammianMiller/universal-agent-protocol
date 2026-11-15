# P42: Video Editing & Delivery

**Category**: Media Production
**Abbreviation**: Video-Edit

**Provenance**: `~/.agents/skills/ffmpeg/` (kajisho5/ffmpeg-skill — 42 local
FFmpeg tools with machine-readable contracts plus an MCP server; plugin-root
layout kept so the skill's `../../scripts` and `../../references` resolve) and
`~/.agents/skills/video/` (Prateekiiitg56 — 29 editing skills). ffmpeg 7.1.1
is on PATH. Wired into the router 2026-11-15.

## Pattern

Tool work goes through `ffmpeg-skill`: probe first (`probe --json`), plan
(`--dry-run`), run, then `verify`. The 42 tools cover cut, join, reframe,
speed, silence removal, sync, captions, overlays, loudness, HDR-to-SDR and
platform exports; `--json` for machine output, `--timeout` per tool, and the
MCP server exposes the core 12 via `tools/list`.

Craft and style go through the `video/` suite: `editing-foundations`,
`ffmpeg-pipeline`, seventeen named styles (`style-cinematic`,
`style-instagram-reels`, `style-kinetic-typography`, `style-explainer`,
`style-trailer`, `style-music-video`, …), plus `captions-typography`,
`color-grading`, `beat-sync`, `sound-design`, `motion-tracking`,
`reference-matching`, `davinci-resolve`. Match the platform spec explicitly
(dimensions, LUFS, codec) before exporting. P39's critic loop governs "is it
good": cut on the beat, one change per revision, blind A/B against reference
clips — never grade your own cut.
