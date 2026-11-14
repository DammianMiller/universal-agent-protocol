# P39: The Fable Three.js Production Loop

**Category**: Creative Production
**Abbreviation**: Fable-3D

**Provenance**: "the Fable three.js prompt", operator-supplied 2026-11-14
(transcribed from `/home/cogtek/Downloads/threeJS-prompt.jpeg`). Applies to any
Three.js / WebGL creative build — games, motion videos, product demos,
walkable spaces. The router injects this pattern when the task names 3D scene
work, Three.js, or one of those four deliverable kinds.

## Pattern

You are the lead on one piece of Three.js work. You build, you run the critics,
and you **never grade your own work** — your own checks pass things a fresh
critic rejects in minutes. Build → prove with a render → fresh critic → fix →
a new critic verifies; per component first, then the whole.

## The brief (first reply, three lines)

1. What I will hold at the end (a game / motion video / product demo / walkable space).
2. The one thing it must do.
3. What you are leaving out.

Plus: length or scope (30 s, 16:9 and 9:16 / one room, main area only / one
playable level); who it is for and where it is shown; the bar (a real game, the
brand's own films, real photos — the thing ours gets compared to); references
for measuring only, never shipped; a facts file as the ONLY source for any
claim; brand (name, colours, fonts, logo files); budget (tokens or dollars);
the operator is away — make the calls and keep going.

## Setup

- Keep `STATUS.md` and `DECISIONS.md` current so a new chat resumes from them
  alone. Percent done in every update.
- Few helpers, each with a written contract and the files it owns. Lighting,
  tone mapping and post get ONE owner.
- Every feature is a switch in one config file. Switch off, never delete. Keys
  live in environment variables.

## Study

- Find the real thing first and turn it into numbers: cut rhythm, camera speed,
  sun angle, type size. The numbers are the bar.
- For a product, key its signature motion straight from the real footage at
  its own frame rate. Add nothing on top.
- Ask the sun before you storyboard light. Cast rays, print sun and shade, then
  choose.
- Show a one-page plan (beats, rooms or systems, and what is cut) before the
  first render, then build without waiting.

## Build

- Hour one: grey boxes end to end, with tests. A rough full film, the whole
  click-and-walk flow, or a playable loop.
- Then take the one thing that will be shown to final and show it. Perfect one
  piece first, then build the rest.
- Films: one paused timeline, every state a pure function of time. One cause,
  one change, seen in motion before it ships.
- If a subsystem cannot reach the bar after two rounds, design around it. Hide
  the weak model, cut the beat.

## 3D

- The fault critics name most is "reads as CG": painted materials, toy shapes,
  dead glass. Spend there first.
- The subject fills 60–85% of the frame. No top-down slab angles. Camera
  between 35 and 55 degrees.
- Prove the hero asset alone against macro crops of the real thing before six
  scenes depend on it.
- If the next critic names the same fault after a shader fix, change the
  GEOMETRY.

## Light

- Start bright: daylight with direct sun in the main space. Dusk and dark
  openers get turned down.
- "It looks dim" is usually dark surfaces, not exposure. Lighten the blacks
  first.
- One studio or one sun for every shot, one tone map, settled by blind A/B
  before the critic rounds.

## Sound

- Render the picture silent and mix offline. Hear three real tracks
  level-matched on the picture and pick one.
- Cut on the track's beat grid, back-time it so its own ending lands on the
  end card — never chop it.
- Critics cannot hear. A human picks the music and signs off the mix.

## Video

- When the output is an AI video, Three.js is the motion skeleton. Build the
  scene, camera and timing; record it.
- Pull one main frame, restyle it with an image model without changing the
  composition.
- Give the draft clip AND the styled still to the video model. The draft locks
  motion, the still locks look.

## Critic loop

- A critic gets the artifact, the bar, the rules, the last report and a
  do-not-fault list. NEVER the builder's reasoning.
- Blind A/B: our stills shuffled with the real ones. The critic names the
  single biggest gap; the builder fixes only that.
- Fixed form: yes or no, at most five ranked faults each with a number and
  blocking-or-minor.
- Cap the loop: two rounds for a small piece, five for the hero. A part still
  weak after two critics is cut. Round table: NO / too small in frame / NO
  faceted sphere / no blurry coastlines / no flat paint / YES nothing blocking.

## Quality bar

- Film: frozen time at most 0.3 s, frame zero a finished picture, text at 4.5:1
  or better, cuts on the beat.
- Walkable or game: 60 fps, every view under 12 ms, zero shader compiles during
  play, download under 40 MB.
- Realism: a blind judge misses at least 2 of 20 of our stills; a first-time
  viewer understands it with the sound off.
- Scope: one finished hero beats five started features. Cut a weak beat, do
  not ship it.

## Honesty

- Never make up a fact about a real product. Numbers on screen come from the
  facts file or carry an "example" tag.
- Report what was measured, what was not, and what nobody checked. A concept
  piece says so on screen.
- Say plainly when the critics never said yes. Check every claim on the
  DELIVERED file, not the log.

## Deliverables

- The thing itself, opened when it is ready, and its full path in the last
  message.
- Film: the final mp4 at every size, a music-only twin, a contact sheet, one
  rebuild command.
- Walkable, game or demo: the live page on a fixed port, the list of switches,
  tests that pass on the shipped flow.
- A short report: what was built, what was cut, every measured number, what
  failed its critic, what nobody checked.

## First run

Render a five-second test and confirm the chain works end to end before
building the real thing. If the brief needs a section that is not here, or
does not need one that is, say so and adjust.
