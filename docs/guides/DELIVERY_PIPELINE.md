# The UAP Delivery Pipeline

**A station-by-station tour of where agentic coding actually breaks — and what UAP puts in place to catch it.**

Think of shipping software with an AI agent like running a small factory floor. Raw intent comes in one end; working, verified, merged code should come out the other. In between there are stations — understand the job, set up a workbench, build the thing, check it actually works, ship it — and a break at any one of them quietly ruins everything downstream.

Left to their own devices, coding agents are talented but undisciplined line workers. They forget yesterday's shift, grab the wrong tool, build something that *looks* right, stamp it "done" without plugging it in, and trip over the other workers on the floor. None of that is a model-quality problem you can fix by swapping in a smarter model — it's a *process* problem. UAP is the process: a station at every point where the line usually jams.

Here's the whole floor at a glance, then a walk through each station.

| # | Station | Where a normal agent breaks | What UAP delivers |
|---|---|---|---|
| 1 | **Intake** | Starts every session cold; forgets past decisions; invents scope | The agent walks in already knowing your codebase, conventions, and history |
| 2 | **Prep / routing** | Picks the wrong approach or burns a frontier model on a trivial edit | The right job goes to the right station and the right-sized model |
| 3 | **Isolation** | Edits `main` directly; clobbers files; two agents overwrite each other | Every job gets its own bench; nothing lands in your working tree by surprise |
| 4 | **Build** | Produces plausible-but-wrong code, stubs, or (on local models) empty/looping output | Real code that compiles — not scaffolding theatre |
| 5 | **QC / verify** | Declares "done" on code that never ran, and grades its own homework | "Done" means *verified* done, checked by something other than the author |
| 6 | **Line coordination** | Parallel agents collide, duplicate work, or deadlock | Agents compound each other's progress instead of fighting over it |
| 7 | **Shipping** | Regresses on merge, breaks CI, skips the version bump, force-pushes over history | Clean PRs, correct versioning, CI-verified merges |
| 8 | **Feedback** | Makes the same mistake next session, and the one after | The floor gets a little better every run |

Two things run the length of the whole line: **policy gates** (the rules are *executable hooks that block*, not prose an agent can ignore) and the **MCP Router** (keeps the context window lean so the agent can think). And all of it works across [9 agent harnesses](../reference/PLATFORMS.md) — same line, whichever floor you're standing on.

---

## Station 1 — Intake: understand the work

**The break:** a fresh agent session is amnesiac. It doesn't remember the auth pattern you agreed on last week, the reason you *didn't* use library X, or the shape of your codebase. So it re-derives everything from scratch — and re-makes old mistakes.

**What UAP puts here:**
- **[4-tier memory](MEMORY.md)** — a daily log, a working cache, semantic recall (Qdrant vectors), and a long-term archive, with write-gates that keep junk and duplicates out. Ask *"how did we handle auth last time?"* and get a real answer.
- **The reactor** — per-prompt injection of the capabilities, skills, and patterns that match what you just asked for, so relevant context is on the bench before the agent starts.
- **[DESIGN.md](../../DESIGN.md)** — a design brief the agent interrogates and lints against, so UI work starts from your intent, not its guess.

**Delivered:** the agent shows up already onboarded.

## Station 2 — Prep / routing: the right job to the right station

**The break:** agents over-think a one-line fix and under-think a migration, and they'll happily spend a frontier model's budget rewriting a README.

**What UAP puts here:**
- **[Multi-model routing](MULTI_MODEL.md)** — cheap tasks go to cheap models, hard tasks get the firepower, across 7 profiles.
- **Pattern router + query-complexity** — the task is matched to a known [playbook](../reference/PATTERNS.md) and a difficulty tier before work starts.
- **[Expert droids & skills](DROIDS_AND_SKILLS.md)** — specialist stations (security, tests, performance) that a router recommends per task.

**Delivered:** effort and cost matched to the actual job.

## Station 3 — Isolation: each job gets its own bench

**The break:** an agent editing your working tree directly is one bad diff away from wrecking your afternoon — and two agents in the same repo will overwrite each other.

**What UAP puts here:**
- **[Worktree workflow](WORKTREE_WORKFLOW.md)** — branch-per-feature, auto-PR, safe cleanup, *enforced* so agents never edit the project root.
- **Always-on file coordination** — agents announce the files they're touching and same-file edits across agents are blocked live.
- **The delivery gate** — code changes route through the verified `deliver` path instead of raw edits.

**Delivered:** no more "the agent nuked my working tree."

## Station 4 — Build: actually make the thing

**The break:** this is where "looks right" bites. Agents emit plausible-but-wrong code, quietly replace real files with stubs, and — on cheap local models — spiral into empty or looping output.

**What UAP puts here:**
- **[`uap deliver`](DELIVER.md)** — a convergence loop that keeps iterating a model against your real gates until the work is actually built.
- **Your gates, including the ones you declare** — build/test/lint are discovered from `package.json`, and anything extra (a migration check, a codegen diff, a contract test) can be declared in `delivery.gates[]` in `.uap.json` and joins the same ladder.
- **A polyglot execution gate** — not everything is `node`: Python packages get a venv-aware import smoke test, native binaries are actually executed, and a binary that can't run on this host is an honest *skip*, never fabricated pass-evidence.
- **Serving-layer recipes** — Fusion / Confidence / Ratings / ReMoM run behind the proxy to raise output quality, *escalating to a stronger, distinct judge* when it counts. (A same-model judge — qwen grading qwen — was measured to add nothing, so recipes only spend that budget when a genuinely stronger judge is wired.)
- **[Local-model handling](LOCAL_MODELS.md)** — the proxy's guardrails (loop-breaker, recon-convergence, the no-tool empty-output guard, path normalization) keep a cheap local model on the rails so it produces real modules, not scaffolding.

**Delivered:** code that compiles, not a convincing mock-up of code that compiles.

## Station 5 — QC / verify: prove it actually works

**The break:** this is the station everyone skips, and it's the expensive one. The agent says "done" on code that doesn't compile, doesn't run, or doesn't do what you asked — and then *grades its own homework* and confirms its own success. A generator that is also its own evaluator will always pass itself.

**What UAP puts here:**
- **Completion gates** — build, tests, lint, type-check must be green before anything can claim "done."
- **Execution / runtime verify** (`uap verify`) — the generated code is actually *run* (headless browser, vm-dom, or child process) to prove it works, not just that it parses.
- **The quality-metrics gate** (`uap quality check`) — ten code-quality budgets (complexity, coverage, CRAP, surviving mutants, dead code, duplicates, `any` types…) enforced deterministically, with a ratchet baseline so existing debt is frozen but the floor can only rise. Reviewers adjudicate the numbers; they can't outvote them.
- **The acceptance judge** — an independent check that the behaviour matches the spec.
- **Generator ≠ evaluator** — the thing that grades the work is deliberately *not* the thing that wrote it.
- **Scoped rollback** — when a turn makes things worse, keep-best restores *only the files that run actually wrote* (tracked per-write plus a shell sweep), never the whole tree — so a rollback on a shared floor can't eat another agent's work.

**Delivered:** "done" you can trust, because a different checker signed off.

## Station 6 — Line coordination: many workers, one floor

**The break:** fan out to several agents and, without traffic control, they duplicate each other, stomp on shared files, exhaust the inference server's slots, or deadlock waiting on one another.

**What UAP puts here:**
- **[Coordination service](COORDINATION.md)** — a shared board of who's doing what, with findings, dead-ends, hand-offs, and challenge mode so agents build on each other.
- **Model-slot concurrency** — a budget + lease so fan-out doesn't exhaust the inference backend's real slot capacity.
- **[Deploy batching](DEPLOY_BATCHING.md)** — git/deploy actions are batched and de-conflicted.

**Delivered:** more agents make things *faster*, not messier.

## Station 7 — Shipping: out the door safely

**The break:** the last mile is where good work dies — a merge that regresses, a red CI that gets ignored, a skipped version bump, a force-push over someone's history.

**What UAP puts here:**
- **Worktree → PR flow** with completion and version gates, so merges are clean and versioned.
- **CI feedback watcher** — when CI goes red after a push, the loop re-converges instead of walking away.
- **Never-regress + git-safety** — destructive git operations are guarded; passing work stays passing.
- **Policy liveness + operator overrides** — the gates themselves are watched: a liveness registry tracks whether each liveness-declaring policy's compliant path (its tools, dirs, skills) is still satisfiable, and emergency bypasses live in a root-owned, expiring `.uap/operator-overrides.json` — so an agent can neither quietly let a gate rot nor mint its own exemption.

**Delivered:** changes reach `main` clean, versioned, and CI-verified.

## Station 8 — Feedback: the floor learns

**The break:** without a memory of what went wrong, an agent re-learns the same lesson every session — forever.

**What UAP puts here:**
- **Memory promotion** — significant learnings graduate from short-term to long-term memory.
- **Pattern reinforcement learning** — patterns that work get reinforced; ones that don't fade.
- **Session analysis** — each session records what got done, what stalled, and why.

**Delivered:** a line that's measurably better next week than it is today.

---

## Where to go next

- New here? Start with the **[Quickstart](../getting-started/QUICKSTART.md)** and let `uap setup` wire the whole line for you.
- Want the catalog of every station's machinery? See **[Features](../reference/FEATURES.md)**.
- Want the engineering view of how the stations fit together? See the **[Architecture Overview](../architecture/OVERVIEW.md)**.
- Care most about the QC station (the one that matters most)? Start with **[`uap deliver`](DELIVER.md)**.
