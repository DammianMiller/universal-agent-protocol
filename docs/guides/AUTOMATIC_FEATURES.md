# UAP Automatic Features — What Fires When

> **🏭 Where this fits:** CROSS-CUTTING — this is what breaks in a normal
> agentic workflow: every safeguard is a manual step, so the one you forget is
> the one that bites you. **What it delivers:** every station on your [delivery
> pipeline](./DELIVERY_PIPELINE.md) fires automatically at the right moment —
> the line runs itself, no flags to set, no config to remember.

Install UAP (`npm i -g universal-agent-protocol`) and every feature below activates automatically. There are no flags to set, no config to edit. UAP observes your workflow and injects the right capability at the right time — the right station on the line kicking in for each task, without you routing work by hand.

---

## Per-Prompt Auto-Injection

### Reactor — Expert Skills, Patterns & Droids
**What it does:** Every time you submit a coding prompt, the Reactor evaluates the request against a router of 25+ droids (experts), skill libraries, and implementation patterns. Relevant ones are injected into the agent's context automatically.

**When it kicks in:**
- You ask to "fix the auth flow" → AuthDroid + relevant skill templates load
- You need a migration → MigrationDroid + schema-diff pattern activate
- You're refactoring → RefactorDroid + pattern-RAG suggestions appear

**Why it matters:** Your model gets domain-specific expertise injected per-prompt without you having to prompt for it. Confidence-gated: low-confidence matches are suggested; high-confidence matches (≥0.80) auto-spawn as subagents.

### Pattern RAG
**What it does:** Retrieves proven implementation patterns from the UAP pattern library based on your prompt's intent.

**When it kicks in:** Alongside Reactor evaluation — if your prompt matches a stored pattern (e.g., "add pagination", "implement rate limiting"), the pattern is injected as context.

**Why it matters:** Consistent, battle-tested implementations across every coding session. No reinventing the wheel.

---

## Policy Gates (Block-by-Default)

### Delivery Enforcement
**What it does:** Prevents direct source-code edits by the model. Instead, routes changes through `uap deliver` — a convergence loop where the model iterates until real gates (build, typecheck, tests) pass.

**When it kicks in:** Any tool-use that touches source files (`.ts`, `.js`, `.py`, etc.). Docs, configs, scripts, tests, and `.worktrees/` are exempt (they don't need delivery).

**Why it matters:** Small models (Qwen3.6, Llama, etc.) frequently produce code that looks correct but doesn't compile. `uap deliver` catches this early — the model self-corrects through real compiler/test feedback until it actually works. Without it, broken code silently lands.

**Escape hatches:** `UAP_DELIVER_BYPASS=1` (one-shot), `UAP_DELIVER_ACTIVE=1` (session), `UAP_ENFORCE_DELIVERY=advisory` (warn-only).

### Schema-Diff Gate
**What it does:** Before any schema or API contract change is applied, generates and validates a diff to ensure backward compatibility.

**When it kicks in:** When the model proposes changes to TypeScript interfaces, OpenAPI specs, database schemas, or any contract file.

**Why it matters:** Prevents silent API breakage that would crash downstream consumers.

### Completion Gates
**What it does:** Before the model claims a task is "done," it must pass: build succeeds, tests pass, type-check clean, version bumped, self-reviewed.

**When it kicks in:** Automatically when the model attempts to mark a task complete.

**Why it matters:** Eliminates "it works on my machine" — every change is verified against the full test + build pipeline before being considered done.

### Worktree Enforcement
**What it does:** Requires all source edits to happen inside isolated worktrees. Prevents accidental commits to the wrong branch.

**When it kicks in:** Any attempt to edit source files outside a worktree.

**Why it matters:** Clean git history, isolated feature branches, no accidental merges of incomplete work.

---

## Model Uplift

### `uap deliver` — Convergence Loop
**What it does:** When delivery-enforcement routes a task to `uap deliver`, the tool runs a loop: the model produces code → real gates (build, typecheck, tests) validate → if anything fails, the error is fed back to the model → repeat until all gates pass.

**When it kicks in:** Automatically when delivery-enforcement blocks a direct source edit and the model needs to make actual code changes.

**Why it matters:** This is the single biggest uplift for small local models. A Qwen3.6-35B-A3B running locally with ~18GB VRAM will produce broken code on first try — but after 2-3 convergence iterations through real compiler feedback, it produces working code that matches what opus-4.8 would produce. The model learns from its mistakes in real-time.

### `uap deliver` — Tiered Gates & CI/Deploy Feedback
**What it does:** Gates are grouped into cheap-first tiers — `fast` (build/typecheck/test/lint) → `integration` (test:integration/e2e, pytest markers) → `deploy-dev` (local compose-up + smoke + teardown) — and only promote to the next, more expensive tier once the prior one is green. With `--watch-ci`/`--until-deployed`, once local tiers pass the loop commits + pushes the worktree branch, watches the CI run, and re-converges on CI/staging/prod deploy failure using the sanitized failure logs.

**When it kicks in:** The integration tier auto-enables when a suite is detected; `--optimize` also turns on `deploy-dev`. The CI watch boundary is opt-in (`--watch-ci`/`--until-deployed`) since it pushes.

**Why it matters:** "Delivered" comes to mean *integrates and deploys*, not just "unit tests pass locally" — and the loop gets real dev/staging/prod feedback to converge on, while never paying for expensive tiers until the cheap ones are green.

### Model Presets
**What it does:** Pre-configured model profiles in `src/models/types.ts` that set optimal parameters (temperature, max tokens, reasoning effort) per model.

**When it kicks in:** Automatically when you select a model. The `qwen35-a3b` preset is the default for local models.

**Why it matters:** No manual tuning. The right parameters are applied automatically for each model family.

### Real-Time Adaptation (self-tuning) ✨

**What it does:** During a session the reactor watches live signals — tool-failure rate, per-turn quality, context-window pressure, and RECON no-write streaks — and, when one breaches a threshold, emits a per-session adjustment the proxy honors mid-flight: escalate the turn to the judge model (fusion), converge sooner (lower the recon threshold), or force synthesis to break an exploration loop.

**When it kicks in:** Auto-on. It is conservative — a signal is emitted only on a real threshold breach, so a nominal session is unchanged. Opt out with `uap config set realtimeAdapt.enabled false` (or `UAP_REALTIME_ADAPT=0`).

**Why it matters:** The static per-model config (`uap tune`) can't foresee everything; this catches the failures that only show up live, escalating a small model exactly when it starts to struggle. See [LLM Self-Tuning](SELF_TUNING.md).

---

## Memory & Context

### Semantic Memory Recall
**What it does:** 4-tier memory system (short-term, long-term, episodic, semantic) with vector-based semantic search. Relevant memories are auto-recalled based on prompt context.

**When it kicks in:** Every prompt — the system searches memory for relevant past sessions, decisions, and patterns.

**Why it matters:** The agent remembers your project conventions, past decisions, and architectural choices across sessions. No re-explaining context.

### MCP Router
**What it does:** Routes model tool calls through a centralized MCP (Model Context Protocol) router, reducing token usage by ~98% by batching and caching tool responses.

**When it kicks in:** Automatically for every tool call the model makes.

**Why it matters:** Massive token savings on repeated tool calls (file reads, git operations, etc.). Also enables consistent tool behavior across different models.

---

## Coordination & Multi-Agent

### Coordination Layer
**What it does:** Orchestrates multi-agent workflows with deterministic control flow — fan-out, pipeline, barrier, and synthesis phases.

**When it kicks in:** When tasks are complex enough to warrant parallel subagents (e.g., "audit these 50 files" or "review changes across dimensions").

**Why it matters:** Parallel execution of independent tasks. A 10-file audit that would take 10 minutes sequentially completes in ~1 minute with 10 parallel agents.

### Deploy Batching
**What it does:** Batches multiple changes into a single deploy operation, reducing deploy overhead and ensuring atomicity.

**When it kicks in:** When multiple independent changes are ready for deployment.

**Why it matters:** Fewer deploys, faster delivery, atomic rollouts.

---

## Long-Task Autonomy (Hands-Free) ✨

*The Fable-parity layer: any model runs a huge build to 100% without a human in
the loop. Full guide: [The Orchestrator & Hands-Free Persistence](ORCHESTRATOR.md).*

### Orchestrator (blackboard, minimal context)
**What it does:** Decomposes a complex mission into a task DAG and runs each task
in a **fresh, minimal context** — its own goal + the verified interface
contracts of its direct dependencies + a small memory pull — instead of one
giant prompt. Publishes each task's contract back for dependents and future
sessions; can adaptively add discovered tasks (`NEW_TASKS`).

**When it kicks in:** Automatically for any decomposed mission (auto-on). Turn
off with `uap orchestrator off` / `--no-orchestrate`.

**Why it matters:** A small-context local model (Qwen3.6) can multi-step through
a build far larger than its window, because it never has to hold the whole thing.

### Epic Controller (loop epics as fresh sessions)
**What it does:** For a *massive* mission (design → build → operational
readiness), runs it as a **sequence of epics**, each a fresh mission that sees
only prior epics' summaries. An epic that fails its gates is retried with a
fresh session fed the last failure — looped until accepted.

**When it kicks in:** Auto for genuinely epic-scale missions (complex *and*
≥ 1200 chars); force with `--epics`.

**Why it matters:** "Start a new session per task, inject only what's needed,
loop until complete" — without you orchestrating it by hand.

### Hands-Free Persistence (can't stop until done)
**What it does:** A **completion ledger** (`.uap/completion-ledger.json`) is the
objective definition of done for the whole build. The Stop hook **blocks
session-end** while any item remains, handing the model a *"NOT DONE —
REMAINING: …"* message; the reactor injects a *"keep going"* directive each
turn. Intensity is model-aware (trust Fable, nudge Opus/GPT, firmly drive
local models), and it's bounded so it can never wedge.

**When it kicks in:** Auto-on whenever an active ledger has remaining items.
Casual sessions with no build in progress are untouched. Disable with
`uap handsfree off` / `UAP_HANDSFREE=0`.

**Why it matters:** Every model behaves like Fable on long tasks — persisting to
objective completion instead of stopping at the first plausible finish.

### Plan Auto-Seed & Auto-Resume
**What it does:** When the model writes a plan (Claude Code `TodoWrite`), a hook
**mirrors it into the ledger automatically** — no manual `init`. On session
start, an unfinished build is **auto-resumed** (*"Resuming a build in progress —
N/M done, REMAINING: …"*).

**When it kicks in:** Any interactive session with a real multi-step plan
(≥ 3 todos). `uap deliver` epic mode seeds the ledger directly.

**Why it matters:** The whole loop is zero-touch — the model's own plan becomes
the definition of done, and work resumes across sessions without being asked.

---

## Developer Experience

### RTK (Rust Token Killer)
**What it does:** CLI proxy that intercepts common commands (`git status`, `npm install`, etc.) and rewrites them for token efficiency — 60-90% token savings on dev operations.

**When it kicks in:** Automatically for every shell command you run. No flags needed.

**Why it matters:** Token costs add up fast. RTK transparently optimizes every command without you thinking about it.

### Dashboard — Savings & Orchestration Visibility
**What it does:** `uap dash serve` shows **Token Savings by Influence** (real
tokens/cost saved per mechanism — RTK, model routing, context compression — with
honest *measured/estimated* labels) and an **Orchestrations & Hierarchy** tree
(the live mission → epic → task tree with the agents on each node and the active
build ledger's progress).

**When it kicks in:** Whenever you run `uap dash serve` (open `http://localhost:3847`).

**Why it matters:** See exactly where UAP is saving you tokens and how a
long-running build is progressing — no guesswork.

### HALO (High-Level Agent Orchestrator)
**What it does:** Provides a high-level orchestration layer for complex multi-step tasks, automatically decomposing them into subtasks and managing dependencies.

**When it kicks in:** When prompts are complex enough to warrant decomposition (substantial coding prompts, architectural changes, multi-file refactors).

**Why it matters:** You describe the goal, not the steps. HALO figures out the plan and executes it.

### CLI Self-Update on Setup
**What it does:** `uap setup` checks npm and auto-updates the globally-installed `uap` CLI to the latest published version before configuring a project.

**When it kicks in:** At the start of every `uap setup`. Only a real global install is updated (source checkouts and local/monorepo deps are left alone), it is downgrade-proof, and it is skipped in CI for reproducibility (`UAP_SELF_UPDATE=1` forces). Opt out with `--no-self-update` / `UAP_NO_SELF_UPDATE=1`.

**Why it matters:** Install once; every subsequent setup self-applies the latest behaviour without a manual `npm install -g`. The update takes effect on the next `uap` invocation.

### Guided Setup Wizard
**What it does:** `uap setup` is an arrow-key wizard (by default) that walks you through harnesses, memory tiers, coordination, patterns, policies, model provider/profile, and hooks, then persists the choices to `.uap.json`.

**When it kicks in:** Any interactive `uap setup`. On CI / non-TTY (or with `--non-interactive`/`-y`) it runs the same flow non-interactively with smart defaults, so pipelines never hang. Defaults are inferred from the environment (Docker → offer Qdrant; a detected local model endpoint → preselect local provider/profile).

**Why it matters:** One guided command lands an optimal configuration instead of remembering a dozen flags — and the same code path runs headless in CI.

### Instruction-File Backup on Setup
**What it does:** Before any merge/rewrite, setup copies your agent instruction files (`CLAUDE.md`, `AGENTS.md`, `.cursorrules`, …, `.uap.json`) to `.uap-backups/<date>/`.

**When it kicks in:** First thing in every `uap setup` (and `uap init`). Idempotent and gitignored. Opt out with `--no-backup`.

**Why it matters:** A setup run is always reversible — your hand-written instructions are never silently overwritten.

### Custom-Content Extraction → Policies & Skills
**What it does:** Setup detects non-standard sections in your instruction files and promotes them into reusable UAP artifacts — imperative rules/gates become **policies** (`policies/<slug>.md`), workflows become **skills** (`skills/<name>/SKILL.md`).

**When it kicks in:** Interactively in the wizard (confirm/redirect each); report-only in scripted mode unless `--extract-auto`. Deterministic (no model calls), idempotent, never overwrites. Opt out with `--no-extract`.

**Why it matters:** Your project's bespoke rules and how-tos become first-class, enforceable/loadable UAP artifacts instead of free-text buried in CLAUDE.md.

---

## Local Model Setup

### llama.cpp + Qwen3.6-35B-A3B
**What it does:** Continuity server script (`scripts/run-llama-server-continuity.sh`) launches llama.cpp with optimal settings for the Qwen3.6-35B-A3B MoE model.

**When it kicks in:** When you need a local model for `uap deliver` convergence or as a coding agent backend.

**Why it matters:** See [Local Models](./LOCAL_MODELS.md) for VRAM-tiered setup instructions (8GB through 32GB). Key insight: `uap deliver` uplifts small models to punch well above their weight — a 35B-A3B running locally with real compiler feedback produces code quality comparable to much larger models.

---

## Summary Table

| Feature | Auto? | Triggers On | Benefit |
|---------|-------|-------------|---------|
| Reactor (experts/skills/patterns) | ✅ | Every prompt | Domain expertise injected per-request |
| Delivery enforcement | ✅ | Source edits | Small models self-correct through real gates |
| `uap deliver` convergence | ✅ | When delivery routes | Broken code fixed before landing |
| Schema-diff gate | ✅ | Contract changes | No silent API breakage |
| Completion gates | ✅ | Task completion | Verified before "done" |
| Worktree enforcement | ✅ | Source edits | Clean git history |
| Semantic memory | ✅ | Every prompt | Context remembered across sessions |
| MCP router | ✅ | Every tool call | ~98% token reduction |
| Pattern RAG | ✅ | Every prompt | Battle-tested implementations |
| Coordination | ✅ | Complex tasks | Parallel subagent execution |
| Deploy batching | ✅ | Multiple changes | Atomic, efficient deploys |
| RTK | ✅ | Every command | 60-90% token savings |
| HALO | ✅ | Substantial prompts | Automatic task decomposition |
| Model presets | ✅ | Model selection | Optimal params per model |

**Bottom line:** Install UAP, point it at your model (Claude Opus, Qwen3.6, Llama — any), and everything just works. No configuration required.