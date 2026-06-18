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
(`CapabilityRouter` + `PatternRouter`) evaluates the prompt in
real-time and, when appropriate, **injects** context, skills, or tool calls
into the agent's next turn. You never notice it happening — the agent just
produces better results.

```
You → hook → UAP Reactor (auto-inject) → model → agent → better output
```

The confidence gate controls injection:

| Confidence | Behavior |
|---|---|
| ≥ 0.30 | Inject context/skills/experts into the prompt |
| ≥ 0.80 | Auto-spawn subagent with `uap deliver` for heavy lifting |
| < 0.30 | Pass through unchanged — zero overhead |

---

## Every feature, when it kicks in

### Reactor — Expert, Skill & Pattern Injection

**Benefit:** Your model gets expert-level context for every prompt without you
having to craft the perfect system prompt.

**When it kicks in:** On every prompt the agent sends. The `CapabilityRouter`
matches the prompt against known droids (docker, infra, security, etc.) and
skills. The `PatternRouter` matches against a RAG-indexed library of proven
patterns. When confidence is ≥ 0.30, the relevant context is injected
automatically. When confidence is ≥ 0.80, a subagent is spawned to handle it
via `uap deliver`.

**You get:** Better code from any model — even small local models — because
they receive expert context they wouldn't otherwise have.

---

### Delivery Enforcement — `uap deliver` for Verified Output

**Benefit:** Your agent's output is actually correct before it touches your
code. No more "it compiled but the tests fail" or "it broke the build."

**When it kicks in:** Block-by-default. When the agent tries to edit source
files directly, the `delivery_enforcement` gate intercepts and routes the work
to `uap deliver` instead. The delivery harness runs a convergence loop: the
model iterates against real gates (build, typecheck, test) until everything
passes. Source-scoped: docs, configs, scripts, and tests are exempt (they
don't need delivery verification).

**Escape hatches:** `UAP_DELIVER_ACTIVE=1` to activate delivery for the
current session, `UAP_DELIVER_BYPASS=1` to skip enforcement,
`UAP_ENFORCE_DELIVERY=advisory` to downgrade from block to warning.

**You get:** Verified, working code from any model — including small local
models that would otherwise make mistakes.

---

### Memory — 4-Tier Auto-Recall

**Benefit:** Your coding agent remembers everything across sessions, projects,
and even different models. No more repeating yourself.

**When it kicks in:** On every prompt. The memory system has four tiers:

| Tier | What | How |
|---|---|---|
| L1 — Semantic | Long-term project context | Nomic 768-dim embeddings, recalled via cosine similarity |
| L2 — Episodic | Past conversations & decisions | Stored as episodes, recalled by semantic similarity |
| L3 — Procedural | Commands, workflows, patterns | Stored as procedures, recalled when similar tasks arise |
| L4 — Declarative | Facts, configs, references | Direct key-value store, recalled by key lookup |

**You get:** Context-aware coding that improves over time. The agent remembers
your conventions, past decisions, and project architecture without you
re-explaining.

---

### Patterns RAG — Proven Solutions on Demand

**Benefit:** Your agent applies battle-tested patterns instead of reinventing
solutions. Every pattern is indexed and retrieved automatically.

**When it kicks in:** When the agent encounters a problem that matches a stored
pattern. The PatternRouter uses semantic search to find the best-matching
pattern from the library and injects it into the prompt.

**You get:** Consistent, proven solutions across all agents and sessions.

---

### Worktree Enforcement

**Benefit:** Your main branch stays clean. Every change happens in an isolated
worktree with proper version bumps and merge commits.

**When it kicks in:** On every file edit. The worktree gate verifies you're
working inside a valid worktree before allowing source file edits. Docs,
configs, and scripts are exempt from this gate.

**You get:** Clean git history, proper versioning, and no accidental commits
to main.

---

### Policy Gates — Automated Safety

**Benefit:** Security, infrastructure parity, and delivery enforcement happen
automatically on every operation. No manual code reviews for common issues.

**When it kicks in:** On every tool use and CLI command:

| Gate | What it checks | When it fires |
|---|---|---|
| rtk_wrap | Token optimization | Every CLI command |
| iac_parity | Infrastructure-as-Code safety | kubectl, helm, aws, gcloud, doctl |
| delivery_enforcement | Verified output | Every source file edit |

**You get:** Security and safety without manual intervention.

---

### Droids & Skills — Specialized Expertise

**Benefit:** Your agent has access to specialized experts (docker, infra,
security, etc.) without you having to prompt for them.

**When it kicks in:** When the agent encounters work that matches a droid's
domain. The CapabilityRouter detects the match and injects the droid's context
automatically.

**You get:** Expert-level output in specialized domains from any model.

---

### Skills — Dynamic Capability Injection

**Benefit:** New capabilities are injected on-demand based on the prompt
content. No configuration needed.

**When it kicks in:** When the prompt matches a registered skill. Skills are
matched semantically and injected automatically.

**You get:** A coding agent that grows smarter over time as new skills are
added.

---

### Coordination — Multi-Agent Orchestration

**Benefit:** Complex tasks are decomposed and executed automatically across
multiple agents with proper coordination.

**When it kicks in:** On complex prompts that benefit from multi-agent
parallelism. The coordinator decomposes the task, spawns parallel agents,
and merges results.

**You get:** Faster completion of complex tasks through parallel execution.

---

### MCP Router — 98% Token Reduction

**Benefit:** Massive token savings on Model Context Protocol calls. Instead of
sending full tool schemas on every turn, the router caches and compresses them.

**When it kicks in:** On every MCP tool call. The router intercepts the call,
looks up the cached schema, and sends only the minimal necessary context.

**You get:** 98% fewer tokens on MCP operations — dramatic cost and latency
reduction.

---

### Schema-Diff Gate — API Contract Validation

**Benefit:** Schema changes are validated automatically. No more breaking API
contracts silently.

**When it kicks in:** When the agent edits schema files or API contract
definitions. The gate diffs the before/after and validates compatibility.

**You get:** Safe API evolution without manual review of every schema change.

---

### Completion Gates — Verify "Done" is Actually Done

**Benefit:** When the agent claims it's done, the gates verify: tests pass,
build succeeds, lint is clean, version is bumped.

**When it kicks in:** When the agent claims a task is complete. The gates run
automated verification before accepting the result.

**You get:** Confidence that "done" means actually done.

---

### Deploy Batching — Atomic Multi-Change Deploys

**Benefit:** Multiple related changes are deployed atomically. No partial
deploys that leave the system in an inconsistent state.

**When it kicks in:** When the agent prepares deployable changes. Related
changes are batched together and deployed as a single atomic unit.

**You get:** Reliable deploys with zero downtime.

---

### rtk — 60–90% Token Savings

**Benefit:** Massive token savings on every CLI command. rtk intercepts commands,
optimizes them, and proxies through a token-efficient layer.

**When it kicks in:** On every CLI command. rtk rewrites commands to use
optimized paths and caches results.

**You get:** Dramatically lower API costs and faster command execution.

---

### HALO — Human Oversight

**Benefit:** Critical operations require human approval before execution.
Automatic escalation when confidence is low.

**When it kicks in:** On critical operations (deployments, schema changes,
security-sensitive actions). HALO escalates to a human for approval.

**You get:** Safety for operations that matter, without slowing down routine
work.

---

## Local Models — Punching Above Their Weight

**Benefit:** Small local models (like Qwen3.6-35B-A3B running on consumer
hardware) produce code quality that rivals much larger models.

**How:** UAP's `uap deliver` convergence loop, expert injection, and pattern
RAG compensate for the smaller model's limitations. The model iterates against
real gates (build, test, typecheck) until everything passes.

**See:** [Local Models Guide](./LOCAL_MODELS.md) for setup instructions and
VRAM-tiered configurations.

---

## Quick Reference

| Feature | Benefit | Trigger |
|---|---|---|
| Reactor | Expert context for every prompt | Every prompt |
| Delivery Enforcement | Verified, working code | Every source edit |
| Memory | Remembers everything | Every prompt |
| Patterns RAG | Proven solutions | Pattern match |
| Worktree Enforcement | Clean git history | Every file edit |
| Policy Gates | Security & safety | Every tool/CLI |
| Droids & Skills | Specialized expertise | Domain match |
| Coordination | Parallel task execution | Complex tasks |
| MCP Router | 98% token reduction | Every MCP call |
| Schema-diff | API contract safety | Schema edits |
| Completion gates | Verify "done" is done | Agent claims done |
| Deploy batching | Atomic multi-change deploys | Deployable changes |
| rtk | 60–90% token savings | Every CLI command |
| HALO | Human oversight for critical ops | Critical actions |

**Install UAP. Use your coding agent normally. Everything else is automatic.**