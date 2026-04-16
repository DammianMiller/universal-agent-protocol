# Taming Local Coding Agents: How We Made 35B-A3B Actually Usable

*A deep dive into hybrid speculative decoding, session-level loop protection, policy enforcement, and building a universal coding agent layer on top of llama.cpp.*

---

## The problem

Local LLMs have reached a point where a single RTX 3090 can run 27–35B parameter models fast enough for interactive coding agents. But "fast enough" isn't "usable."

We hit several walls building our universal coding agent stack (UAP) on top of llama.cpp:

1. Speculative decoding **silently corrupts** hybrid SSM+attention models (Qwen3.5-35B-A3B, Jamba)
2. Agent clients enter **runaway tool-use loops** that burn thousands of wasted tokens
3. Every client speaks a slightly different API shape and injects **volatile context** that breaks stateful guardrails
4. Models **ignore workflow requirements** in CLAUDE.md — they commit directly to main no matter what the prompt says
5. Context, memory, skill routing, and multi-agent coordination all need an **additional enforcement layer** above raw inference

This is what we built to fix all of it.

---

## Part 1: The hybrid speculative decoding bug

Qwen3.5-35B-A3B is a hybrid model: 16 of its 64 layers use attention KV cache, 48 use recurrent (SSM) state. When speculative decoding rolls back a partially-accepted batch, it calls `seq_rm(seq_id, p0, -1)` to discard tokens after position `p0`.

For attention layers this is trivial. For SSM layers it's **impossible** — recurrent state can't be positionally rewound. The upstream llama.cpp handled this with an exact-match checkpoint restore that **never fired** during real speculative decoding:

```cpp
checkpoint.pos == p0 - 1    // checkpoint at pre-speculation position K
                            // p0 - 1 = K + accepted_drafts
                            // K == K + m → false whenever m > 0
```

The fallback path silently updated `cell.pos` without restoring R/S tensor data. SSM state drifted every batch. After a few hundred spec cycles, the model was generating degenerate output that looked like "tool call looping" but was actually accumulated state corruption.

**Our fix (2 patches, ~280 lines):**

1. Added a CPU-side checkpoint system in `llama_memory_hybrid` — save R/S tensors before multi-token speculative batches via `ggml_backend_tensor_get`, restore via `ggml_backend_tensor_set`
2. Changed the restore condition from `checkpoint.pos == p0 - 1` to `checkpoint.pos <= p0 - 1`
3. Added **server-side activation replay**: after `seq_rm` restores an earlier checkpoint, re-decode the tokens from `(cache_pos + 1)` to the target position via `llama_decode`, bringing both caches back in sync

This is the "activation replay" technique from Snakes & Ladders (NeurIPS 2024). The result: Qwen3.5-35B-A3B speculative decoding went from "unusable — produces garbled tool calls that loop forever" to **stable 100+ tok/s with 88–98% draft acceptance**.

---

## Part 2: The ngram cache reset trap

llama.cpp's `ngram-mod` speculative type has a hardcoded "low acceptance streak" reset: if draft acceptance drops below 50% for 3 consecutive calls, the entire ngram table is wiped.

For models with naturally variable output (MoE, fine-tuned, uncensored), this fires constantly. The cache would build up to 100+ drafts/call, then get wiped, then rebuild, then get wiped again. We saw acceptance rates oscillate between 26% and 69% for hours.

**The fix:** single env var — `NGRAM_MOD_RESET_STREAK=16` (default 3 preserves upstream behavior, `0` disables the reset entirely). On 35B-A3B this moved average acceptance from ~50% to a stable 88%, with peak 98% warmed-up rates.

~10 lines of code. Bizarrely impactful.

---

## Part 3: Loop protection that actually works

Coding agents making rapid tool calls can fall into pathological loops. We saw three distinct patterns on local 27–35B models:

1. **Repeated same tool** — 58 req/min on `Read("/dev/null")`. Easy to catch with per-tool cycle detection.
2. **Distinct but unproductive** — model rotates through `Glob → Read → Bash → FetchUrl` making tiny calls that add no context. **Defeats** per-tool cycle detection because each call is technically different.
3. **Post-finalize ping-pong** — state machine forces a finalize turn, model emits text, but completion contract re-triggers the active loop on the next request.

Our proxy's state machine already had per-tool cycle detection, but it didn't catch patterns 2 and 3. We added:

- **Unproductive exhaustion streak**: counts consecutive `forced_budget_exhausted` events where no cycle was detected. After N in a row, force finalize.
- **Monotonic finalize hard cap**: session-level counter that survives state resets. After N total finalize events (default 6), stop injecting synthetic continuations and let the natural `end_turn` terminate the loop.
- **`finalize_fired` blocker suppression**: once a finalize has fired in the session, suppress `text_only_after_tool_results` blockers that would re-trigger the active loop.

But the actual fix for all of this turned out to be a **one-line session fingerprint bug**.

---

## Part 4: The session fingerprint bug that broke everything

For weeks, none of our loop protection worked reliably. The state machine would detect a cycle, force a finalize, inject a hint — and then the very next request, the `forced_budget` counter would be back at 11, the `review_cycles` at 0, all the state wiped.

We assumed it was a state machine bug and wrote more guardrails. Then we added session ID logging:

```
REQ: ... sess=fp:9c8f26a802f9f4739f18 msgs=79
REQ: ... sess=fp:b801857a9e49e21a6599 msgs=81  
REQ: ... sess=fp:aeef638954a390ef7aec msgs=83
```

**Every single request got a new session ID.** Every `SessionMonitor` was fresh. None of the counters were accumulating. Every guardrail we'd built was effectively stateless per-request.

The bug: session fingerprints included:

1. `tool_use_id` values from tool_result blocks (random UUIDs regenerated per turn)
2. The entire `system` prompt (clients inject timestamps, cwd, session markers)

**The fix:** hash only the first user message's **text content**. Exclude system prompts. Use stable content hashes for tool_result blocks.

After this fix, session stickiness went from 1 request/session to 170+ requests/session. Every prior loop protection mechanism suddenly started working. The unproductive exhaustion streak fired exactly when it should. The finalize hard cap terminated runaway sessions cleanly. Context accumulated correctly for prompt caching.

One bug — the wrong fingerprint inputs — had been silently defeating every stateful guardrail above it for the entire project. If you're building your own state machine on top of an LLM proxy: **check whether your session key is stable FIRST**.

---

## Part 5: UAP — the universal coding agent layer

llama.cpp is the engine. UAP is the layer that makes coding agents on top of it actually work.

### Session and state management
- **Sticky session fingerprinting** (Part 4)
- **Per-session conversation pruning** to stay under context limits
- **Automatic context window detection** from `/slots`
- **Memory system** with auto-save for user profile, feedback rules, project context, reference pointers — the agent learns across sessions without re-prompting
- **Automatic context insertion** at natural triggers (session start, fresh task detection)

### Universal client compatibility
- **Native Anthropic `/v1/messages`** endpoint
- **Full OpenAI `/v1/chat/completions`** endpoint with bidirectional conversion (all guardrails active on both paths)
- **Per-profile chat templates** — ChatML, Gemma-4's `peg-gemma4` DSL, or model-embedded
- **Per-profile grammar** — Qwen-style `<tool_call>` JSON grammar, or off (required for models that use different tool formats)

### Skill routing and tool management
- **Tool narrowing** — automatically reduces 35+ tool schemas down to top-N most relevant per request via query token similarity scoring
- **Tool cycling detection** with session-level bans for persistent offenders
- **Malformed tool-call retry** with token/temperature caps
- **Grammar-constrained tool output** (optional per profile)
- **Software pattern prefill** — agent skill registry with discovery and auto-invocation for known task patterns

### Loop protection (5-layer defense)
1. Per-tool fingerprint cycle detection
2. Stagnation tracking (message fingerprint doesn't change)
3. Unproductive exhaustion streak (distinct-but-useless calls)
4. Review cycle limit → forced finalize
5. Session hard cap on total finalize events → natural termination

### Speculative decoding tuning
- Per-profile spec decoding enable/disable
- Per-request `speculative.n_max=0` override for tool turns (optional per profile)
- Configurable ngram-mod reset threshold via env var (Part 2)
- Profile-specific draft parameters (`draft-max`, `draft-min`, `draft-p-min`)

### Multi-agent coordination
- **Git worktree enablement** for concurrent agent sessions with isolated filesystem state
- **CI/CD deploy bucketing** to match concurrent agent development cadence — each agent's deploys go to its own bucket
- **Shared memory layer** with conflict detection
- **Skill registry** with discovery

### Token optimization
- Pre-request token budget monitoring with estimation
- Automatic conversation pruning near context limits
- Tool schema caching
- Static ngram cache support for cold-start acceleration
- Tool narrowing (35 → 8 saves ~15k tokens per request on the 35-tool setup)

---

## Part 5b: The policy engine — enforcement, not suggestions

You can tell a local coding agent to use a git worktree. You can write it in CLAUDE.md. You can put it in the system prompt. You can make it the first rule in the instructions.

They will still commit directly to main.

We learned this the hard way. **The only reliable way to enforce a workflow requirement is to make it non-bypassable at the proxy layer — not at the prompt layer.**

So we built a **policy engine** that intercepts every tool call and completion check.

### What it enforces today

- **Worktree routing** — `Edit`, `Write`, `Bash` tool inputs get rewritten to reference the active worktree path. Operations targeting the main working tree are **rejected** with a policy blocker that the agent can't ignore because it can't produce a valid tool call.
- **Completion gates** — the proxy's completion contract is extended with policy-level blockers. An agent can't emit `end_turn` on a task unless:
  - Tests were actually run (not just mentioned)
  - Parallel reviewers (code-reviewer + security-auditor + architect-reviewer) were invoked before any commit
  - Memory was queried before any review/check/look operation
  - Session start protocol completed (bootstrap checks)
- **Commit discipline** — pre-commit policy invokes review agents, validates commit message format, checks for secrets, runs completion gates. Only then does the `commit` tool call pass through.
- **CI/CD deploy bucketing** — each agent session has a deploy bucket tied to its worktree. Multi-agent concurrent development doesn't collide at the pipeline layer because each bucket runs independently.
- **Per-profile rule sets** — the `build` profile has strict worktree + review + test requirements. `plan` mode blocks all `write`/`edit` tools. `memory` mode is read-only. `autoaccept` can skip some gates but not the security ones.

### How it works

Every tool call goes through a policy check chain before being forwarded to llama.cpp:

```
client → proxy → [guardrails] → [policy engine] → [tool rewriter] → llama.cpp
                                       ↓
                                  audit log
```

Each policy is a small declarative rule:

```python
@policy("worktree.enforce", profile=["build", "autoaccept"])
def enforce_worktree(request, session):
    if request.tool_name in MUTATING_TOOLS:
        if not session.worktree_active:
            return block("worktree_not_in_use",
                         hint="Create a worktree first: git worktree add ...")
        request.tool_input["path"] = rewrite_to_worktree(
            request.tool_input["path"], session.worktree
        )
    return allow()

@policy("commit.parallel_review", profile="build")
def enforce_parallel_review(request, session):
    if "git commit" in request.tool_input.get("command", ""):
        if not session.review_completed_this_turn:
            return block("parallel_review_required")
    return allow()
```

The rule either allows the call, rewrites it, or blocks it with a reason that becomes part of the agent's context on the next turn. **Agents can't route around a block** — the proxy doesn't give them a tool they can use to bypass the policy, so they have no tokens to emit that would reach the outside world.

### Why this matters for local models

Frontier models kind of follow instructions in CLAUDE.md. Local 27–35B models don't. The gap is large enough that policy-as-prompt is not an enforcement mechanism for local coding agents — it's a suggestion the model ignores when the compute pressure is on.

Moving enforcement from prompt layer to proxy layer turned our local coding agents from "unreliable hobby" to **"actually usable in a real delivery pipeline."**

---

## Part 6: Results

On a single RTX 3090 with Qwen3.5-35B-A3B-UD-IQ4_XS:

| Metric | Before | After |
|--------|--------|-------|
| Speculative decoding | Broken (garbled output) | **Stable** |
| Peak generation speed | 30–55 tok/s (unstable) | **100+ tok/s** |
| Draft acceptance | 26–69% (oscillating) | **88–98%** |
| Loop protection | Stateless (session bug) | Works end-to-end |
| Session stickiness | 1 req/session | 170+ req/session |
| Time to break runaway loop | Indefinite | ~30–60 seconds |
| Tool output corruption | Frequent | Rare (auto-retried cleanly) |
| Worktree compliance | ~20% (model ignored prompts) | **100% (policy-enforced)** |
| Pre-commit review compliance | ~10% | **100%** |
| Concurrent agent collisions | Common | None (bucketed) |

---

## Part 7: Where this is going

We're preparing upstream PRs:

- **llama.cpp** — three PRs:
  1. Configurable ngram-mod reset threshold
  2. Hybrid speculative rollback via CPU state checkpoints
  3. Server activation replay for partial speculative rollback
- **UAP proxy** — five PRs:
  1. Stable session fingerprinting (critical bug fix)
  2. Loop protection hardening
  3. Per-request speculative decoding control
  4. OpenAI-compatible `/v1/chat/completions` endpoint with guardrails
  5. Policy engine with worktree + CI/CD enforcement

The llama.cpp patches are at `github.com/DammianMiller/llama.cpp` on branch `upgrade-b8740`. UAP is at `github.com/miller-tech/universal-agent-protocol` (public release pending).

---

## The punchline

Local coding agents on consumer GPUs are actually viable today — if you fix the half-dozen subtle bugs that every path through the stack seems to land on.

Most of the fixes are small. Most of them would be invisible without the right logging. And most of them only matter once you stack them together: the speculative decoding fix makes generation fast enough to be interactive, the ngram reset fix makes it stable, the session fingerprint fix makes loop protection functional, the loop protection makes the agent stoppable, the OpenAI endpoint makes any client able to benefit from it all, and the **policy engine is what finally makes the output trustworthy enough to ship.**

We kept finding one more bug, one more missing piece, one more enforcement gap. When the last one cleared, we had a local coding agent stack that actually works.

Share your own findings — the local LLM tooling space is still wide open.
