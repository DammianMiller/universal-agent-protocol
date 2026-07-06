# The Orchestrator & Hands-Free Persistence

> **🏭 Where this fits:** BUILD — the station that turns *"build this whole
> thing"* into finished, verified work without a human babysitting the loop.
> **What it delivers:** any model — local or frontier — runs a huge multi-epic
> build hands-free, in fresh minimal context per task, and **cannot stop until
> the whole thing is 100% done**. Install once; it self-applies. Automagic. ✨

This is UAP's answer to the question *"why can Fable grind on a huge task for
hours while other models stop after ten minutes?"* Fable's persistence is
trained into the weights. UAP puts the same persistence in the **harness** —
so **every** model gets it.

- **[The orchestrator](#the-orchestrator)** runs a decomposed build as a task
  DAG, each task in a fresh, minimal context.
- **[The epic controller](#the-epic-controller)** loops whole epics as fresh
  sessions, retrying until each is accepted.
- **[Hands-free persistence](#hands-free-persistence)** is the outer loop: a
  completion ledger defines "done", and the Stop hook + reactor refuse to let
  the model stop until the ledger reads 100%.

All of it is **auto-on**. You don't pass a flag. You describe a big build, and
the machinery engages.

---

## TL;DR — install & go

```bash
npm install -g @miller-tech/uap
uap setup                       # wires the hooks into your harness
```

That's it. From then on:

- Ask for a big, multi-part build (in Claude Code, `uap deliver`, opencode, …).
- The model writes a plan (a todo list, or `uap deliver` decomposes it).
- UAP captures that plan as a **completion ledger** and drives the model
  through it — fresh context per task, keep-going injected each turn, and the
  session **blocked from ending** until every item is done.
- A new session **auto-resumes** an unfinished build.

Nothing to configure. To *turn things off* or tune them, see
[Controls](#controls-toggles--env).

---

## The orchestrator

When `uap deliver` (or an interactive session routed through it) gets a
genuinely complex, multi-part mission, it **decomposes** the work into a task
DAG and runs it on a **blackboard orchestrator** instead of one giant
convergence loop.

The key idea is **minimal fresh context per task**. Each leaf task runs in its
own convergence loop that sees only:

- a one-line orientation snippet of the overall mission,
- its own goal, acceptance criteria, and the files it owns,
- the **verified interface contracts** of its *direct* dependencies (a few
  hundred tokens — "what already exists"), and
- a small, relevant pull from memory.

Not the full spec. Not every prior summary. This is what lets a small-context
local model (e.g. Qwen3.6-35B-A3B) multi-step through a build far larger than
its window.

**What it does automatically:**

| Capability | Behavior |
|---|---|
| **Auto-decompose** | Complex, long missions split into 2–8 phases along the `plan → design → implement → review → release` lifecycle. |
| **Minimal context** | Each task's prompt is hard-capped by a context governor (default 6000 chars); furthest dependencies are elided first. |
| **Memory in/out** | Each task pulls relevant design decisions from memory (`retrieveDesign`) and publishes its verified contract back (`publish`) for dependents and future sessions. |
| **Adaptive re-planning** | A task that discovers missing work can emit `NEW_TASKS:[…]`; they're validated, de-duped, and folded into the DAG. |
| **Dependency-correct** | A task runs only after every dependency has *succeeded*; a failed dependency blocks (never builds on a broken base). |

It is **auto-on** for any decomposed mission — minimal-context orchestration is
strictly better than a full-mission prompt for small models.

---

## The epic controller

One `deliver` run drives one task DAG. A **massive** mission — *design → build
→ operational readiness* — is more than one DAG: it's a **sequence of epics**,
each itself a full mission. The epic controller is the loop above the
orchestrator:

```
for each epic (dependency-ordered):
    run it as a FRESH mission            ← fresh context; only prior epics'
                                            compact summaries are injected
    check acceptance (gates + judge)
    if not accepted:
        RETRY with a fresh session       ← fed the previous attempt's failure
        …until accepted or the attempt budget is spent
```

- **Fresh session per epic/attempt** — exactly the "start new sessions per
  task, inject only what's needed, loop until complete" pattern.
- **Generator ≠ Evaluator** — an epic that "delivered" but fails the acceptance
  judge is retried; a delivered-and-accepted epic is marked done.
- **Never spins forever** — bounded per-epic attempts; stagnation gives up
  gracefully.

It **auto-engages** for genuinely epic-scale missions (complex *and* ≥ 1200
characters). Smaller work uses the orchestrator or the plain loop.

---

## Hands-free persistence

The orchestrator and epic controller run inside `uap deliver`. But most huge
builds are driven **interactively** (Claude Code, opencode) where the model
decides when it's "done". Hands-free persistence makes *that* Fable-like too —
for any model — using four pieces that all ship **auto-on**.

### B · The completion ledger — the objective definition of done

`.uap/completion-ledger.json` is the persistent, whole-build checklist: the
epic/task DAG with a status per item. Completion is judged against **this**,
not the model's self-assessment, and it survives across turns *and* sessions.

The ledger is populated automatically:

- `uap deliver` epic mode writes it from the planned epics and marks items done
  as epics are accepted.
- **Interactive sessions**: whenever the model writes a plan with the built-in
  todo tool (Claude Code `TodoWrite`), a PostToolUse hook **mirrors that plan
  into the ledger** — statuses follow (`completed → done`, `in_progress`,
  `pending`). No manual step. (Only a real multi-step plan seeds it — ≥ 3 todos
  by default.)

### A · The Stop-hook block — you can't stop early

When the model tries to end its turn, the Stop hook checks the ledger. If the
build is incomplete it **blocks the stop** and hands the model a
*"NOT DONE — REMAINING: …"* message, so it keeps working. Fully guarded so it
can never wedge:

- honors the harness `stop_hook_active` flag (never re-blocks in a loop),
- only blocks when there's an **active ledger with remaining items**,
- bounded by per-build **block + stagnation counters** — progress resets the
  counter; a genuine stall gives up. *"Never stop early"* and *"never spin
  forever"* are the same feature.

### C · Model-aware intensity — trust Fable, drive the local model

The forcing scales **inversely** with a model's intrinsic persistence:

| Family | Intensity | Behavior |
|---|---|---|
| **Fable** | light | Trust it; minimal safety net. |
| **Opus / Sonnet / GPT** | moderate | Nudge past premature "done". |
| **Qwen / local** | aggressive | Firmly drive; more blocks tolerated. |

### D · Reactor injection — the standing "keep going" directive

While a build is in progress, every prompt gets a
*"keep going until 100% — REMAINING: …"* directive injected (via the reactor
hook you already have). Casual sessions with no active build see nothing.

### Auto-resume — pick up where you left off

On session start, if a build was left unfinished, a resume banner surfaces it
(*"Resuming a build in progress — N/M done, REMAINING: …"*) so a fresh session
continues it **without being asked**.

**The full loop, all automatic:**

```
model plans (todos)  →  ledger auto-seeds  →  reactor injects "keep going" each turn
        →  Stop hook blocks until 100%  →  new session auto-resumes the remainder
        →  done when every ledger item is complete
```

---

## Seeing it: the dashboard

`uap dash serve` (open `http://localhost:3847`) now includes two panels for
this machinery:

- **Orchestrations & Hierarchy** — the live `mission → epic → task` tree with
  per-node status and the agents working each node, plus the active build
  ledger's progress.
- **Token Savings by Influence** — real tokens/cost saved, attributed per
  mechanism (RTK, model routing, context compression), with honest
  *measured / estimated* labels.

---

## Controls (toggles & env)

Everything is on by default. These are for turning it **off** or tuning it.

### Orchestrator

```bash
uap orchestrator status            # show effective setting
uap orchestrator off               # sequential phase runner instead of the blackboard
uap orchestrator on | auto         # re-enable (auto = default)
uap deliver "…" --no-orchestrate   # disable for one run
```

| Knob | Effect |
|---|---|
| `UAP_DELIVER_ORCHESTRATE=0` | Disable the orchestrator. |
| `.uap.json` `deliver.orchestrate: "off"` | Persistent disable. |
| `UAP_DELIVER_CONTEXT_BUDGET` | Per-task context char cap (default 6000). |
| `UAP_DELIVER_MAX_PHASES` | Phase ceiling (default 8, hard max 20). |
| `UAP_DELIVER_MAX_TASKS` | Re-planning task cap (default 40). |

### Epic controller

```bash
uap deliver "…" --epics            # force the epic controller
uap deliver "…" --no-epics         # disable it for this run
```

| Knob | Effect |
|---|---|
| `UAP_DELIVER_EPICS=1` | Force epic mode. |
| `UAP_DELIVER_EPIC_ATTEMPTS` | Fresh-session attempts per epic (default 2). |

### Hands-free persistence

```bash
uap handsfree status               # master switch, model profile, ledger progress
uap handsfree on | off             # toggle (persisted to .uap.json)
uap handsfree remaining            # what's left in the current build
uap handsfree init --mission "…" --items '[{"id":"e1","title":"…"}]'   # seed manually
uap handsfree complete <id> | fail <id>                                # update an item
```

*(alias: `uap hf …`)*

| Knob | Effect |
|---|---|
| `UAP_HANDSFREE=0` | Disable hands-free entirely. |
| `.uap.json` `handsfree.enabled: false` | Persistent disable. |
| `UAP_HANDSFREE_INTENSITY` | Force `light` / `moderate` / `aggressive`. |
| `UAP_HANDSFREE_MIN_TODOS` | Min todos before a plan auto-seeds a ledger (default 3). |

### Model routing

```bash
uap model routing status           # is routing on? which table + complexity tiers?
uap model routing on | off         # toggle the whole multi-model table
uap model routing use <preset>     # apply a preset (e.g. fable-local-opus)
```

---

## How it maps to the code

| Piece | Source |
|---|---|
| Blackboard orchestrator | `src/delivery/task-orchestrator.ts` |
| Epic controller | `src/delivery/epic-controller.ts` |
| Deliver wiring | `src/cli/deliver.ts` (`runOrchestratedMission`, `runEpicMission`) |
| Completion ledger | `src/delivery/completion-ledger.ts` → `.uap/completion-ledger.json` |
| Persistence profile | `src/delivery/persistence-profile.ts` |
| Stop-hook block | `.factory/hooks/stop.sh` → `uap handsfree stop-check` |
| Auto-seed / auto-resume | `templates/hooks/uap-todo-ledger.sh`, `session-start.sh` |
| Reactor injection | `src/coordination/persistence-inject.ts` |

---

**See also:** [`uap deliver`](DELIVER.md) · [Multi-Model Routing](MULTI_MODEL.md)
· [What UAP Does Automatically](AUTOMATIC_FEATURES.md) ·
[Local Models](LOCAL_MODELS.md)
