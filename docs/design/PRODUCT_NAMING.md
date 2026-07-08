# Product Naming Analysis — UAP Rename Candidates

**Date:** 2026-07-08
**Status:** Analysis complete, no decision committed
**Method:** Brainstorm → live availability sweep (npm registry, PyPI, DNS/RDAP on `.dev`/`.io`/`.sh`) → web search for AI-space positioning collisions.

## Goal

Find a replacement name for "UAP (Universal Agent Protocol)" that is catchy,
easy to remember, implies the product's purpose (supervising AI coding agents:
gates, verification, coordination, memory, routing), and is actually
securable (npm + domain + no competitor squatting the positioning).

## Key finding: the category is colonized

The "supervise your AI agents" metaphor space is nearly fully claimed as of
mid-2026. Every *obvious* supervision/herding/governing metaphor already
belongs to a shipping product — several with UAP's exact positioning. Any
naming decision should assume descriptive metaphors are gone and move fast on
whatever is chosen: two of our candidate spaces closed **within this cycle**
(`bosun` npm claimed May 2026, `keel` npm claimed July 2026).

## Round 1 — supervision/herding metaphors (all dead or marginal)

| Name | Why it fit | Why it died |
|---|---|---|
| Ratchet | only moves forward = never-regress | getratchet.dev ("accountability layer for AI agents") **and** ratchetcli.com ("AI writes code. Ratchet makes it production-ready") — UAP's pitch, twice |
| Governor | mechanical regulator = concurrency/budget caps | Microsoft agent-governance-toolkit, governor.studio, several agent-cost "governors" |
| Foreman | supervises the crew, signs off work | theforeman.org (Red Hat), Ruby `foreman` |
| Corral | keep agents inside the fence | getcorral.ai (enterprise agent platform) |
| Warden | nothing broken gets out | Warden Protocol (2.1k★ AI-agent chain) |
| Muster | round up + "pass muster" | themuster.dev — "Governed Agent Harness for Production AI Agents" (same category) |
| Heeler | cattle dog herds by nipping heels | heeler.com — agentic development security, PR guardrails |
| Kelpie | Aussie sheepdog | kelpieai.co.uk, kelpie-ai.ai (AI agencies; weak overlap — marginal, not dead) |
| Keel | keeps the ship stable | active npm product (published 2026-07) |

## Round 2 — safety/verification metaphors

| Name | Why it fit | Verdict |
|---|---|---|
| Belay | holds the rope so the climber can't fall | ☠️ Belay agent-aware terminal (backspinlabs), onbelay.ai, belay.ai, BELAY Solutions |
| Bosun | ship's officer who supervises the crew | ☠️ active npm 2026-05: "manages AI agent executors" |
| Sheriff | law in the Wild West of agents | ☠️ sheriff.dev (AI-powered software development) |
| **Shakedown** | shakedown cruise proves the vessel seaworthy before service — exactly `uap verify` | ✅ **Survivor.** No AI collision found; npm squat is empty/2016 (disputable); `shakedown.sh` unregistered |
| **Jackaroo** | outback station energy | ✅ **Cleanest sweep**: npm free, `jackaroo.dev`/`.sh` free, no AI collision. Wrinkle: a jackaroo is the *apprentice* stockman (arguably the agents, not the supervisor) |
| Tightship | "run a tight ship" | ✅ npm free, `tightship.sh` free; 9 chars is long for a daily CLI |

## Round 3 — Fat Controller / railway operations theme

The Fat Controller (Thomas the Tank Engine) is a near-perfect brand metaphor:
engines = eager but chaotic agents; the Controller demands they be "really
useful" and tolerates no "confusion and delay."

**IP line:** "Fat Controller", "Sir Topham Hatt", and "Sodor" are Mattel-owned
character trademarks — usable as internal codenames or blog color, dangerous
as product names. Generic railway-*operations* vocabulary is free, and the
brand voice ("right track, green signals, no confusion, no delay") can run
through docs without naming the character.

| Name | npm | .dev / .io / .sh | Collisions | Verdict |
|---|---|---|---|---|
| **Pointsman** | ✅ free | ✅ ✅ ✅ all free | none found | 🏆 total clean sweep |
| **Brakevan** | ✅ free | ✅ ✅ ✅ all free | none found | 🏆 total clean sweep |
| Yardmaster | ✅ free | ✅ ✅ ✅ all free | YardMasterAI (CCTV); Bourque **YardMaster®** — registered mark on *rail software* | risky despite clean registry |
| Stationmaster | dead squat (2015) | ✅ / taken / ✅ | none in AI space | viable; 13 chars, a bit municipal |
| Fatcontroller | ✅ free | ✅ ✅ ✅ all free | dead SourceForge cron tool; **Mattel IP** | codename only |
| Topham / Sodor | dead squats (2014) | ✅ all free | Mattel IP orbit | codename material |
| Branchline | ✅ free | taken / taken / ✅ | none found | backup (git-branch double meaning) |
| Signalbox / Shunter / Roundhouse | squats | mostly taken | UK rail-tech co / BBC npm lib / DB-migration tool | pass |

*Archaeology note: the abandoned npm squats for `topham`, `hatt`, and `sodor`
are all controller libraries from ~2014 — this joke has been made before and
abandoned every time; the space is open.*

## Recommendation

1. **Pointsman** — the railway worker who throws the points and decides which
   track every engine takes. Maps 1:1 to UAP: model routing (which track),
   gates (signals), coordination (keeping engines off each other's track).
   Only candidate across all three rounds with a *total* clean sweep.
2. **Brakevan** — the van whose whole job is stopping runaway trains; maps to
   runaway-agent war stories. Also a total clean sweep. Reads "safety layer"
   more than "orchestrator."
3. **Shakedown** — best standalone meaning (trial run that proves
   seaworthiness); clean in AI space; npm squat disputable.

## Next steps (whichever name is chosen)

- Register `.dev`/`.io`/`.sh` domains immediately (cheap insurance; spaces close fast).
- Publish a placeholder npm package (scoped `@miller-tech/<name>` is safe regardless).
- Trademark search: IP Australia + USPTO, classes 9 and 42.
- The `uap` CLI command can be retained during any transition; brand and binary
  need not change simultaneously.
