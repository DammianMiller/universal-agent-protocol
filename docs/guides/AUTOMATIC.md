# What UAP Does For You — Automatically

> The whole point of UAP: **you install it once, and every feature applies itself
> as you code.** You don't call commands or remember protocols. UAP watches the
> coding agent's lifecycle (session start, every prompt, every tool call, every
> stop) and injects the right help or enforces the right guardrail *at the moment
> it's needed*.

```bash
npx @miller-tech/uap init       # one-time, per project
# …that's it. Open your coding agent and everything below is live.
```

`init`/`setup` wire UAP into whichever agent you use — Claude Code, Cursor,
OpenCode, Factory, VSCode, Codex — by installing lifecycle hooks and the MCP
router. After that the features are **on by default and apply themselves as
appropriate**. Nothing here needs to be invoked by hand.

---

## How to read this

Two kinds of automatic behaviour, and they're deliberately different:

- **Assist** (dynamic, *helps* you): surfaces the right context — experts,
  skills, patterns, memories — by *injecting* it where the model will see it.
  It's confidence-gated, so quiet on conversational turns and rich on real
  coding tasks. It never blocks; worst case it stays silent.
- **Enforce** (deterministic, *protects* you): hard guardrails that *block* a
  tool call when it would violate a rule (edit outside a worktree, skip
  delivery, run a dangerous command). Each has an escape hatch for the rare
  sanctioned exception.

For every feature below: **what it does for you**, and **when it kicks in**.

---

## Assist — the right help shows up on its own

| Feature | What it does for you | When it kicks in |
|---|---|---|
| **Reactor** (dynamic routing) | On every prompt, surfaces the expert droids, skills, and enforcement patterns relevant to *this* task, so the agent works like it already knows the domain. | Every substantive prompt (`UserPromptSubmit` / per-message). Confidence-gated — silent on "thanks"/"merge it", rich on "fix the auth race condition". |
| **Memory recall** | Pulls back the lessons, decisions, and gotchas you (or another agent) learned before, so mistakes aren't repeated and context survives across sessions. | Session start (recent + high-importance memories) and per-prompt semantic recall on the task text. |
| **Pattern RAG** | Injects battle-tested execution patterns (Output-Existence, Decoder-First, Round-Trip verify, …) mined from Terminal-Bench, so the agent uses the approach that actually passes. | Per-prompt, matched to the task; full set retrievable on demand via Qdrant. |
| **Expert droids** | Routes domain work (security, performance, data, testing, …) to a specialist persona instead of a generalist guess. | When the capability router matches the task's type/files — recommended automatically, with optional auto-spawn above a confidence threshold. |
| **Skills** | Surfaces the right *procedure* (git-forensics, compression, SQLite-WAL recovery, polyglot, …) for the task at hand. | Per-prompt match against the task; top-N surfaced. |
| **Model routing** | Picks the right model tier per step (plan with the strong model, execute with the fast one) instead of one model for everything. | On task classification, by complexity and role. |

You don't ask for any of this. It appears in the agent's context the moment the
task warrants it, and stays out of the way when it doesn't.

---

## Enforce — the guardrails that keep work safe and verified

| Feature | What it does for you | When it kicks in |
|---|---|---|
| **Delivery enforcement** (`uap deliver`, **block by default**) | Routes substantive coding through the **convergence loop** — which iterates a model against your real gates (build, type-check, tests) until the change is *verified*, not just plausible. This is what **uplifts small local models well above their weight**: a 3B-active model that would flail on one shot succeeds when driven to green against the gates. | The moment the agent tries to edit a **source** file directly. Docs/configs/scripts/tests are exempt — only real implementation work is gated. Escape: `UAP_DELIVER_BYPASS=1`, or relax with `UAP_ENFORCE_DELIVERY=advisory`. |
| **Worktree isolation** | Forces code changes into an isolated `.worktrees/NNN-slug/` branch so you never clobber your working tree and every change is a clean, reviewable branch with an auto-PR. | Any source edit outside a worktree is blocked (`PreToolUse`). |
| **Policy / compliance gates** | Block non-compliant tool calls before they run — dangerous shell (force-push, `terraform apply`), edits that skip a schema diff, plan-before-read violations, etc. | `PreToolUse` on every Edit/Write/Bash/Task call. |
| **Schema-diff gate** | Flags breaking API/contract changes so you diff-and-verify consumers before shipping them. | After editing a schema/contract file (`*.schema.ts`, `types.ts`, `.proto`, `.graphql`, …). |
| **Completion gates** | Won't let the agent declare "done" until build/type-check/tests actually pass and a version bump happened. | On `Stop` (end of turn). |
| **Coordination** | Detects when multiple agents would touch the same files and prevents them stepping on each other. | Session start (register) + work announcement before claiming a task. |
| **rtk token-optimization** | Rewrites heavy CLI output (git/docker/npm/…) into compact form so the agent burns far fewer tokens reading command output. | Every wrapped CLI command. |
| **Deploy batching** | Queues changes into conflict-free batched commits/deploys instead of racy one-off pushes. | On `uap deliver --deploy` success. |

Each enforce-gate has a sanctioned escape hatch (an env var) for the rare case
you genuinely need to bypass it — so the guardrail is firm, not a cage.

---

## Behind it all

| Feature | What it does for you | When it kicks in |
|---|---|---|
| **MCP router** | Exposes a tiny meta-tool surface (`discover_tools`/`execute_tool`/`deliver`/`react`) instead of 150+ tools, cutting tool-schema tokens by ~98%. | Wired at install; used whenever the agent discovers/runs a tool. |
| **HALO trace analysis** | Mines your execution traces for systemic failure modes (loops, stalls) so the harness gets better over time. | Session end / on demand (`uap harness analyze`). |
| **4-tier memory** | Short-term (recent), long-term (semantic Qdrant), coordination, and patterns — the substrate the recall/pattern features draw from. | Continuously; written on significant decisions, read on recall. |

---

## The one-liner

**Install UAP, then just code.** The assist layer makes your agent act like a
domain expert with perfect recall; the enforce layer makes sure whatever it
produces is isolated, verified, and safe — and it drives even small local models
to *verified* results they couldn't reach in one shot. You never invoke any of
it; it applies itself, in the right place, at the right time.

See also: [`uap deliver`](DELIVER.md) · [Local Models](LOCAL_MODELS.md) ·
[Droids & Skills](DROIDS_AND_SKILLS.md) · [Policies](POLICIES.md) ·
the [Reactor design](../design/UAP_REACTOR.md).
