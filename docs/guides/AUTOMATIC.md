# What UAP Does Automatically

> **Install once. Every feature kicks in automatically.**

UAP is not a set of manual steps you orchestrate. It is a **policy-and-resolver
layer** that sits between your coding agent (Claude Code, Opencode, Cursor,
Windsurf, Codex, etc.) and the model you use. Every feature below activates
**automatically** based on what the agent is doing — no config changes, no
manual triggers, no prompts to remember.

---

## How it works

When you start a coding session, UAP's hooks (installed by `uap setup`)
intercept every prompt the agent sends to the model. The **Reactor**
([`CapabilityRouter`][cr] + [`PatternRouter`][pr]) evaluates the prompt in
real-time and, when appropriate, **injects** context, skills, or tool calls
into the agent's next turn. You never notice it happening — the agent just
produces better results.

```
You → hook → UAP Reactor (auto-inject) → model → agent → better output
```

The confidence gate controls injection:

| Confidence | Behavior |
|-----------|----------|
| **≥ 0.80** | Auto-spawn subagents, run tools, apply fixes — no human needed |
| **≥ 0.30** | Inject context (experts, skills, patterns) into the agent's prompt |
| **< 0.30** | No injection — the agent proceeds without UAP augmentation |

You can tune these thresholds via `UAP_INJECT_CONFIDENCE` and
`UAP_AUTO_SPAWN_CONFIDENCE` env vars, but the defaults are right for most
projects.

---

## Every feature, automatic

### Reactor — expert/skill/pattern injection

**What it does:** Evaluates every coding prompt and automatically injects
relevant droid context, skills, and design patterns into the agent's next turn.

**Why it matters:** Your agent gets domain-specific expertise on every prompt
without you having to describe the problem twice. It reads the prompt, matches
it against known patterns, and injects the right context — automatically.

**When it kicks in:** On every `UserPromptSubmit` event. If the prompt looks
like it involves Docker, CI, git operations, or API changes, the Reactor fires
and injects the matching droid context.

**Result:** A single coding agent, equipped with the collective knowledge of
your entire team, on every single prompt.

### Delivery Enforcement — verified changes only

**What it does:** Blocks direct source edits from the agent and routes them
through `uap deliver` — a convergence loop that iterates the model against
real build/test/typecheck gates until the change is verified green.

**Why it matters:** Small models (and even large ones) make mistakes. A
one-shot edit might compile but break a test, or pass tests but corrupt a
schema. `uap deliver` keeps iterating until the change is *actually correct*,
not just *plausible*.

**When it kicks in:** The moment the agent tries to edit a source file. The
gate fires, blocks the direct edit, and triggers `uap deliver` automatically.
Docs, configs, scripts, and tests are exempt (they don't need convergence).

**Escape hatches:** `UAP_DELIVER_ACTIVE=1` (allow direct edits),
`UAP_DELIVER_BYPASS=1` (skip delivery for this prompt),
`UAP_ENFORCE_DELIVERY=advisory` (warn but allow).

**Result:** Every source change is verified before it lands. No more "it
compiled but broke everything."

### Memory — four-tier auto-recall

**What it does:** Maintains a persistent, semantic-searchable memory of your
project, past sessions, bugs, fixes, and decisions. Four tiers:

| Tier | Scope | Example |
|------|-------|---------|
| **Session** | Current conversation | "We decided to use Redis for caching" |
| **Short-term** | Last N sessions | "The Docker build failed on arm64" |
| **Long-term** | Persistent store | "The payment schema migration broke on v2.1" |
| **Semantic** | Vector search | "Find all sessions about rate limiting" |

**Why it matters:** Your agent forgets between sessions. UAP's memory doesn't.
It recalls past bugs, fixes, and decisions automatically — so the agent doesn't
re-make the same mistakes.

**When it kicks in:** On every prompt. The memory system queries all four tiers
and injects relevant recall into the agent's context. If a prompt matches a
past bug, the agent sees the old fix and avoids repeating the error.

**Result:** Your agent gets smarter with every session, not amnesic.

### Patterns RAG — design patterns on demand

**What it does:** Maintains a library of proven design patterns (MVP,
defensive coding, retry-with-backoff, etc.) and automatically injects the
relevant one when the agent's prompt matches.

**Why it matters:** Instead of the agent guessing the best pattern for a
problem, UAP recognizes the problem shape and injects the proven solution.

**When it kicks in:** When the agent encounters a problem that matches a stored
pattern. The PatternRouter fires and injects the pattern context.

**Result:** Consistent, proven solutions across every agent and every session.

### Worktree Enforcement — isolated changes

**What it does:** Ensures all source edits happen inside a git worktree,
preventing accidental commits to the main branch.

**Why it matters:** Even experienced developers accidentally edit on `main`.
Worktree enforcement makes it physically impossible — the policy gate blocks
any direct source edit outside a worktree.

**When it kicks in:** On every source edit. If you're not in a worktree, the
gate fires and requires `uap worktree create` first.

**Result:** Zero accidental main-branch edits. Every change is isolated and
trackable.

### Policy Gates — infrastructure safety

**What it does:** Intercepts dangerous CLI commands (kubectl, helm, aws, gcloud)
and enforces safety policies: schema diffs before deployments, approval gates
for destructive operations, and IaC parity checks.

**Why it matters:** One wrong `kubectl delete` or `aws s3 rm --recursive` can
destroy production. Policy gates catch these before they execute.

**When it kicks in:** On every CLI command that matches a policy rule. The gate
evaluates the command against your project's policies and blocks or allows
automatically.

**Result:** Production safety without manual review of every command.

### Droids & Skills — specialized expertise

**What it does:** Provides specialized "droid" agents (Docker expert, CI expert,
Git expert, etc.) with domain-specific skills that get injected into the main
agent's context automatically.

**Why it matters:** You don't need a Docker specialist on staff — the Docker
expert droid injects its knowledge into whatever agent you're using, when
Docker-related work is detected.

**When it kicks in:** When the Reactor detects work matching a droid's domain.
The droid's context and skills are injected into the agent's next turn.

**Result:** Every agent has access to every specialist's knowledge, automatically.

### Skills — reusable action sequences

**What it does:** Encodes multi-step workflows (deploy, rollback, benchmark)
as reusable skills that the agent can invoke automatically.

**Why it matters:** Instead of remembering the exact sequence of commands for a
deploy, the agent looks up the Deploy skill and executes it correctly every time.

**When it kicks in:** When the agent encounters a situation that matches a
stored skill. The skill context is injected and the agent follows the proven
sequence.

**Result:** Consistent execution of complex workflows, every time.

### Coordination — multi-agent orchestration

**What it does:** Orchestrates parallel subagent work with dependency resolution,
error handling, and result synthesis.

**Why it matters:** Complex tasks (full-stack changes, migrations, audits) benefit
from parallel execution. Coordination manages the fan-out, waits for results,
and synthesizes them.

**When it kicks in:** When a task is complex enough to benefit from parallelism.
The Coordinator automatically splits the work, spawns subagents, and merges
results.

**Result:** Complex tasks complete faster through parallel execution, with
correct results synthesized from all subagent outputs.

### MCP Router — 98% token reduction

**What it does:** Caches and routes Model Context Protocol calls, reducing
redundant token consumption by ~98%.

**Why it matters:** MCP calls (schema lookups, tool definitions, config reads)
are repeated across sessions. Caching them saves massive amounts of tokens and
latency.

**When it kicks in:** On every MCP call. Cached results are served instantly;
only cache misses hit the model.

**Result:** Faster responses, lower costs, less token waste.

### Schema-diff gate — safe API changes

**What it does:** Requires a diff before and after any schema or API contract
change, ensuring changes are intentional and documented.

**Why it matters:** Schema changes are breaking changes. The diff gate ensures
every schema modification is reviewed and documented before landing.

**When it kicks in:** When the agent edits a schema file or API contract. The
gate triggers a diff and requires confirmation.

**Result:** No accidental breaking changes. Every schema modification is
documented.

### Completion gates — "done" means verified

**What it does:** Before claiming a task is "done," the agent must pass build,
test, lint, and typecheck gates. No more "it works on my machine."

**Why it matters:** Developers (and agents) often claim completion before
verifying. Completion gates enforce a real definition of done.

**When it kicks in:** When the agent says "done" or "complete." The gates run
automatically and block if any check fails.

**Result:** A task is only done when it actually passes all checks.

### Deploy batching — efficient deploys

**What it does:** Batches multiple changes into a single deploy, reducing deploy
frequency and ensuring atomicity.

**Why it matters:** Every deploy is a risk. Batching minimizes deploy frequency
and ensures related changes land together.

**When it kicks in:** When multiple changes are ready for deploy. They're
batched into a single deploy operation.

**Result:** Fewer deploys, lower risk, atomic changes.

### rtk — 60–90% token savings

**What it does:** Rewrites CLI commands to use a token-optimized proxy that
caches results and eliminates redundant output.

**Why it matters:** CLI output (`git status`, `npm test`, `kubectl get pods`)
consumes tokens. rtk caches and compresses this output, saving 60–90% of tokens
on dev operations.

**When it kicks in:** On every CLI command. The hook transparently routes
commands through rtk without any config changes.

**Result:** Massive token savings on everyday development commands.

### HALO — human oversight

**What it does:** Provides a human-in-the-loop gate for high-impact changes
(production deploys, schema migrations, data modifications).

**Why it matters:** Some changes are too important to be fully automatic. HALO
pauses and asks for human confirmation before proceeding.

**When it kicks in:** When the agent attempts a change classified as high-impact.
The HALO gate fires and waits for human approval.

**Result:** Critical changes always have human oversight, without slowing down
routine work.

---

## Install once, everything works

```bash
npm install -g universal-agent-protocol
uap setup          # installs hooks into your coding agent
# That's it.
```

Every feature below activates automatically:

| Feature | Benefit | Token savings |
|---------|---------|--------------|
| Reactor | Expert context on every prompt | Indirect (better output) |
| Delivery Enforcement | Verified changes, no broken merges | Indirect (no rework) |
| Memory | Never forgets past bugs/fixes | Indirect (no repeated mistakes) |
| Patterns RAG | Proven solutions, not guesswork | Indirect |
| Worktree Enforcement | Zero main-branch accidents | Indirect |
| Policy Gates | Production safety | Indirect |
| Droids & Skills | Specialist knowledge, auto-injected | Indirect |
| Coordination | Parallel execution for complex tasks | Indirect |
| MCP Router | 98% token reduction on MCP calls | ~98% on MCP |
| Schema-diff gate | Safe API changes | Indirect |
| Completion gates | Real definition of "done" | Indirect |
| Deploy batching | Fewer, safer deploys | Indirect |
| rtk | 60–90% token savings on CLI | 60–90% on CLI |
| HALO | Human oversight for critical changes | Indirect |

**Install UAP. Use your coding agent normally. Everything else is automatic.**

[cr]: ../../src/coordination/reactor.ts
[pr]: ../../src/policies/router/pattern_router.ts