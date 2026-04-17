# X Thread: Taming Local Coding Agents

Publish as a thread on x.com. Each section is one tweet (≤280 chars where noted).

---

**1/ 🧵**

Taming local coding agents on a single RTX 3090.

Qwen3.5-35B-A3B @ ~100 tok/s with working spec decoding, clean tool calls, loop protection that actually works, and policy-enforced worktrees.

A deep dive into the llama.cpp + UAP stack we built.

---

**2/**

Five walls you hit building local coding agents:

1. Spec decoding silently corrupts hybrid SSM+attention models
2. Agents enter runaway tool loops
3. Each client injects volatile context that breaks stateful guardrails
4. Models ignore workflow rules in CLAUDE.md
5. Multi-agent concurrency collides at the pipeline

---

**3/**

Wall 1: Hybrid spec decoding.

Qwen3.5-35B-A3B has 16 attention + 48 recurrent layers. When spec decoding partially accepts drafts, it needs to roll back. Attention = trivial. Recurrent SSM state = can't positionally rewind.

---

**4/**

Upstream llama.cpp had an exact-match checkpoint restore:
`checkpoint.pos == p0 - 1`

But during real spec decoding, `checkpoint.pos = K` while `p0-1 = K + accepted_drafts`. The match never fired. The fallback silently updated position counters without restoring R/S tensors.

---

**5/**

State drifted every batch. After a few hundred cycles, the model produced degenerate output.

Symptom: "looping tool calls."
Root cause: accumulated SSM state corruption.

The two diagnoses look identical from the outside. They're completely different problems.

---

**6/**

Fix: CPU-side checkpoint system that saves R/S tensors before multi-token batches, plus activation replay (Snakes & Ladders, NeurIPS 2024).

After `seq_rm` restores a checkpoint, re-decode tokens from (cache_pos+1) → target via `llama_decode` to resync both caches.

---

**7/**

Result: 35B-A3B spec decoding went from "unusable — produces garbled tool calls that loop forever" to stable **100+ tok/s with 88–98% draft acceptance**.

~280 lines of llama.cpp patches. Upstream PRs incoming.

---

**8/**

Wall 2: Loop protection that doesn't work.

Agent clients on local models loop. We built per-tool cycle detection, stagnation tracking, forced finalize, synthetic continuation injection. None of it worked reliably.

---

**9/**

Added session ID logging and saw this:

```
REQ ... sess=fp:9c8f... msgs=79
REQ ... sess=fp:b801... msgs=81
REQ ... sess=fp:aeef... msgs=83
```

Every request got a NEW session ID. Every counter was fresh. Every guardrail was stateless.

---

**10/**

Cause: Session fingerprints hashed `tool_use_id` (random UUIDs per turn) + `system` prompt (clients inject timestamps/cwd/sessions).

Fix: hash ONLY the first user message's text content.

---

**11/**

One-line fix. Every upstream guardrail suddenly started working. Loop protection went from 0% to >95% effective.

Lesson: if your state machine isn't working, check whether the session key is stable FIRST. Every other "fix" is noise until that's right.

---

**12/**

Wall 3: ngram-mod cache reset.

llama.cpp's `ngram-mod` spec type has a hardcoded reset: if acceptance dips below 50% for 3 calls, wipe the cache.

For 35B MoE models with naturally variable output, this fires constantly. Cache never stabilizes.

---

**13/**

Fix: one env var, `NGRAM_MOD_RESET_STREAK=16`. Default 3 (upstream behavior preserved). On 35B-A3B, moved avg acceptance from ~50% to stable 88%+.

~10 lines, tiny PR.

---

**14/**

Wall 4: Model ignores CLAUDE.md.

You can tell a local 27–35B coding agent "always use a git worktree, run parallel reviews before committing, query memory first."

It will ignore all of that and commit directly to main. Every time.

---

**15/**

So we built a **policy engine** that enforces workflow rules at the proxy layer.

The only reliable enforcement is non-bypassable at the tool-call layer, not at the prompt layer.

---

**16/**

Policy engine intercepts every tool call BEFORE it reaches llama.cpp:

- Rewrites file paths to route through active worktree
- Blocks commits until reviewers run in parallel
- Enforces completion gates (tests ran, memory queried, security checked)
- Per-profile rule sets (build / plan / memory / autoaccept)

---

**17/**

Rules are tiny declarative policies:

```python
@policy("worktree.enforce")
def enforce(req, session):
    if req.tool in MUTATING_TOOLS:
        if not session.worktree_active:
            return block("worktree_not_in_use")
        req.input.path = to_worktree(req.input.path)
    return allow()
```

---

**18/**

The agent can't route around a block because the proxy never gives it a tool to bypass with. It has no tokens to emit that would reach the outside world without going through the policy chain.

This is the difference between "coding agent suggestion" and "coding agent enforcement."

---

**19/**

Part of UAP: a universal coding agent layer on top of llama.cpp.

Features:
- Skill routing + tool narrowing (35 → 8 per request)
- Universal client shim: /v1/messages AND /v1/chat/completions, both guarded
- Memory with auto-save for user / feedback / project context
- Sticky sessions with monotonic loop counters

---

**20/**

And at the dev workflow layer:

- Git worktree enablement for concurrent agents
- CI/CD deploy bucketing per-worktree
- Token budget monitoring with pre-request estimation
- Software pattern prefill via skill registry
- Multi-agent coordination with shared memory + conflict detection

---

**21/**

Results on RTX 3090 + Qwen3.5-35B-A3B-UD-IQ4_XS:

| | Before | After |
|---|---|---|
| Spec decode | Broken | Stable |
| Peak tok/s | 30–55 | **100+** |
| Draft accept | 26–69% | **88–98%** |
| Loop protect | 0% | >95% |
| Worktree compliance | ~20% | **100%** |
| Pre-commit review | ~10% | **100%** |

---

**22/**

Patches: `github.com/DammianMiller/llama.cpp` branch `upgrade-b8740`

UAP: `github.com/miller-tech/universal-agent-protocol` (public release pending)

Upstream PRs coming:
- llama.cpp: hybrid spec rollback, activation replay, configurable ngram reset
- UAP: session fingerprinting, loop protection, policy engine

---

**23/**

The punchline:

Local coding agents on consumer GPUs are actually viable today. You just have to fix the half-dozen subtle bugs that every path through the stack seems to land on.

Most of them are one-line fixes you only find by adding the right logging.

---

**24/**

The kicker: none of these fixes matter alone.

- Fast spec decoding is useless if the model loops
- Loop protection is useless if sessions are stateless
- Stateless protection is useless if workflow isn't enforced
- Enforcement is useless if tool output is corrupted

Stack them all, and it works.

/end
