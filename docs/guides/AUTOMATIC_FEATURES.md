# UAP Automatic Features — What Fires When

Install UAP (`npm i -g universal-agent-protocol`) and every feature below activates automatically. There are no flags to set, no config to edit. UAP observes your workflow and injects the right capability at the right time.

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

### Model Presets
**What it does:** Pre-configured model profiles in `src/models/types.ts` that set optimal parameters (temperature, max tokens, reasoning effort) per model.

**When it kicks in:** Automatically when you select a model. The `qwen35-a3b` preset is the default for local models.

**Why it matters:** No manual tuning. The right parameters are applied automatically for each model family.

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

## Developer Experience

### RTK (Rust Token Killer)
**What it does:** CLI proxy that intercepts common commands (`git status`, `npm install`, etc.) and rewrites them for token efficiency — 60-90% token savings on dev operations.

**When it kicks in:** Automatically for every shell command you run. No flags needed.

**Why it matters:** Token costs add up fast. RTK transparently optimizes every command without you thinking about it.

### HALO (High-Level Agent Orchestrator)
**What it does:** Provides a high-level orchestration layer for complex multi-step tasks, automatically decomposing them into subtasks and managing dependencies.

**When it kicks in:** When prompts are complex enough to warrant decomposition (substantial coding prompts, architectural changes, multi-file refactors).

**Why it matters:** You describe the goal, not the steps. HALO figures out the plan and executes it.

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