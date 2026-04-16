# UAP Upstream PR Plan

5 PRs covering the session stickiness bug, loop protection hardening, per-request spec control, OpenAI-compat endpoint, and the policy engine.

## Dependency graph

```
PR 1 (session fingerprinting)  ── CRITICAL ──► enables PR 2, PR 3, PR 5
PR 2 (loop protection)         ── depends on PR 1
PR 3 (spec decoding control)   ── independent
PR 4 (OpenAI /v1/chat/completions) ── depends on PR 2 (via guardrails)
PR 5 (policy engine)           ── depends on PR 1 + PR 2
```

---

## PR 1 — `proxy: stable session fingerprinting`

**Scope:** Critical bug fix
**Files:** `tools/agents/scripts/anthropic_proxy.py`
**Risk:** Low — pure fix, no new surface area
**Priority:** Highest — every stateful guardrail depends on this

### Problem

Session fingerprints were hashed from `remote | model | system | first_user_content`. Two inputs were volatile:

1. **`tool_use_id`** values in tool_result blocks — random UUIDs regenerated per turn. `_content_fingerprint` included `f"result:{block.get('tool_use_id', '')}"` in the hash.
2. **`system` prompt** — clients inject volatile context (timestamps, cwd, session markers) into system prompts.

Result: **every single request got a different session ID** → every request spawned a fresh `SessionMonitor` → every stateful guardrail (cycle detection, forced_budget, review_cycles, finalize_hard_stop, unproductive_exhaustion_streak) was effectively stateless per-request.

This silently broke every loop protection mechanism ever built on top of the session monitor.

### Diagnostic evidence

After adding session ID logging:

```
sess=fp:9c8f26a802f9f4739f18 msgs=79
sess=fp:b801857a9e49e21a6599 msgs=81
sess=fp:aeef638954a390ef7aec msgs=83
sess=fp:16f908db2e478f31cb91 msgs=85
```

Every request got a new session ID. `session_count: 35` after 35 requests on what should have been one session.

### Fix

1. `_content_fingerprint` uses stable content excerpt (`result:<first 64 chars>`) instead of `tool_use_id`
2. `resolve_session_id` hashes only the first user message's **text content**, excludes `system` prompt entirely

```python
def resolve_session_id(request: Request, anthropic_body: dict) -> str:
    # ... header-based lookup unchanged ...
    
    first_user = ""
    for msg in anthropic_body.get("messages", []):
        if msg.get("role") == "user":
            content = msg.get("content", "")
            if isinstance(content, str):
                first_user = content[:512]
            elif isinstance(content, list):
                text_parts = [
                    b.get("text", "") for b in content
                    if isinstance(b, dict) and b.get("type") == "text"
                ]
                first_user = "\n".join(text_parts)[:512]
            break
    
    # Deliberately exclude `system` from fingerprint — clients inject
    # volatile context (timestamps, cwd, session markers).
    digest = hashlib.sha256(
        f"{remote}|{model}|{first_user}".encode("utf-8", errors="ignore")
    ).hexdigest()[:20]
    return f"fp:{digest}"
```

### Impact

- Before: 1 request per session
- After: 170+ requests on the same session (verified with Claude Code + OpenCode + Forge clients)
- All downstream guardrails suddenly started working — no changes needed to them

### Add session ID logging

The REQ line now includes `sess=` for diagnosis:

```
REQ: client=remote:127.0.0.1 sess=fp:aa5169796b2c39c2a4a4 rate_60s=1 ...
```

### Tests

- [ ] Unit test: same message with changing tool_use_ids → stable fingerprint
- [ ] Unit test: same message with changing system timestamps → stable fingerprint
- [ ] Integration test: 3 sequential requests on same conversation → same session_id

---

## PR 2 — `proxy: loop protection hardening`

**Scope:** Medium — new counters + threshold gates
**Files:** `anthropic_proxy.py`
**Depends on:** PR 1 (counters only work with sticky sessions)

### Additions

1. **`tool_state_unproductive_exhaustion_streak`**
   - Tracks consecutive `forced_budget_exhausted` events where NEITHER cycling NOR stagnation was detected
   - After `PROXY_UNPRODUCTIVE_EXHAUSTION_LIMIT` (default 4), forces finalize
   - Catches "distinct-but-unproductive tool spam" that defeats per-tool cycle detection

2. **`finalize_hard_stop_count`** (monotonic session-level)
   - NOT reset by `fresh_user_text` / `inactive_loop` paths
   - Incremented in BOTH:
     - `_inject_synthetic_continuation` (synthetic continuation path)
     - `state_choice == "finalize"` handler (tool-stripping path)
   - When `>= PROXY_FINALIZE_SESSION_HARD_CAP` (default 6), synthetic continuation injection is blocked, natural end_turn passes through → client terminates loop cleanly

3. **`finalize_fired` flag in `_completion_blockers()`**
   - When `finalize_hard_stop_count > 0`, suppresses `text_only_after_tool_results` blocker
   - Prevents state machine from re-entering active loop after a finalize wraps up the work
   - Was causing `finalize → review → cycle_detected → finalize → review → ...` infinite ping-pong

### New env vars

```
PROXY_UNPRODUCTIVE_EXHAUSTION_LIMIT=4      # new
PROXY_FINALIZE_SESSION_HARD_CAP=6          # new
```

### Tuned thresholds (tighter defaults)

```
PROXY_LOOP_REPEAT_THRESHOLD=4              # was 10
PROXY_FORCED_THRESHOLD=12                  # was 18
PROXY_NO_PROGRESS_THRESHOLD=3              # was 5
PROXY_TOOL_STATE_STAGNATION_THRESHOLD=4    # was 8
PROXY_TOOL_STATE_FINALIZE_THRESHOLD=8      # was 18
PROXY_TOOL_STATE_REVIEW_CYCLE_LIMIT=5      # was 3 (relaxed from prior 3 after tuning)
PROXY_TOOL_NARROWING_EXPAND_ON_LOOP=off    # was on
PROXY_TOOL_NARROWING_KEEP=8                # was 12
```

### Verification

Real session that was previously looping indefinitely terminated cleanly:
```
TOOL STATE MACHINE: 4 consecutive unproductive budget exhaustions — forcing finalize
TOOL STATE MACHINE: phase review -> finalize reason=unproductive_exhaustion
FINALIZE CONTINUATION: session hard cap reached (6/6) — not injecting, allowing termination
```

Client received clean `end_turn`, started a fresh new task.

### Tests

- [ ] Simulated loop: distinct tool calls with no context growth → triggers unproductive exhaustion
- [ ] Simulated loop: same tool repeated → triggers per-tool cycle detection (existing)
- [ ] Finalize → synthetic continuation → reset → new active loop → hard cap at 6 → natural termination

---

## PR 3 — `proxy: per-request speculative decoding control`

**Scope:** Small, focused
**Files:** `anthropic_proxy.py`, README
**Risk:** Low

### Feature

New env var `PROXY_DISABLE_SPEC_ON_TOOL_TURNS` (default off). When on, the proxy sets `openai_body["speculative.n_max"] = 0` on tool-turn requests, telling llama.cpp to skip the draft/spec path for that request only.

### Why

Some models (observed: early Qwen3.5-35B-A3B Q4_K_M) produce garbled tool-call output under speculative decoding due to rejected-draft state leakage. Disabling spec on tool turns while keeping it on for plain chat gives the best of both worlds for unstable models. Stable models can leave this off and benefit from spec on every turn.

### Applied in two places

1. Main handler (`_build_openai_request` end)
2. Tool starvation breaker early-return path (so the flag is respected on both code paths)

```python
if PROXY_DISABLE_SPEC_ON_TOOL_TURNS:
    openai_body["speculative.n_max"] = 0
    logger.info("Spec decoding disabled for tool turn (PROXY_DISABLE_SPEC_ON_TOOL_TURNS=on)")
```

### Relies on llama.cpp upstream support

llama.cpp already supports per-request `speculative.n_max` in `server-task.cpp`:
```cpp
params.speculative.n_max = json_value(data, "speculative.n_max", defaults.speculative.n_max);
```

Setting it to 0 gates the entire draft path (`if (n_draft_max > 0)` in `server-context.cpp`).

### Tests

- [ ] Tool-turn request with flag on → `speculative.n_max=0` in forwarded body
- [ ] Non-tool request with flag on → no speculative field added
- [ ] Flag off → no speculative field added regardless

---

## PR 4 — `proxy: fully guarded OpenAI /v1/chat/completions endpoint`

**Scope:** Medium — new endpoint with full bidirectional conversion
**Files:** `anthropic_proxy.py`
**Depends on:** PR 2 (reuses the guardrail pipeline)

### Motivation

Clients like **OpenCode**, **Forge**, **Cline**, and many LangChain-based agents expect OpenAI's `/v1/chat/completions` shape. The proxy previously only exposed `/v1/messages` (Anthropic shape), so these clients either:
1. Bypassed the proxy and talked directly to llama.cpp (no guardrails), OR
2. Couldn't use the proxy at all

### Approach

Add `/v1/chat/completions` handler that:
1. Receives OpenAI-format request
2. Converts to Anthropic format (`openai_to_anthropic_request`)
3. Invokes the existing `messages()` handler via synthetic `Request` with Anthropic body
4. Converts the Anthropic response back to OpenAI format (`anthropic_to_openai_response`)
5. Returns to the client

**All guardrails from the `/v1/messages` path apply automatically** — loop detection, tool narrowing, cycle breaking, malformed tool retry, context pruning, profile overrides, activation replay (llama.cpp side).

### Streaming

Client stream requests are processed internally as non-stream through the Anthropic pipeline, then re-streamed as OpenAI SSE chunks:

```
data: {"id":"msg_...","delta":{"role":"assistant"},...}
data: {"id":"msg_...","delta":{"content":"..."},...}
data: {"id":"msg_...","delta":{"tool_calls":[...]},...}
data: {"id":"msg_...","delta":{},"finish_reason":"tool_calls"}
data: [DONE]
```

This sacrifices token-by-token streaming granularity in exchange for keeping all guardrails. The difference is invisible to most clients.

### Helper functions added

- **`openai_to_anthropic_request(openai_body)`** — full conversion (system prompt, messages, tool_calls, tool_responses, tools, tool_choice, sampling params)
- **`anthropic_to_openai_response(anthropic_resp)`** — content blocks → message, tool_use → tool_calls, stop_reason → finish_reason, usage mapping
- **`_parse_anthropic_sse_to_message(raw)`** — SSE fallback parser if inner pipeline returns a stream despite `stream=False`

### Verification

Tested against OpenCode, Forge, and synthetic curl requests:
- Plain chat: clean text response
- Tool use: proper `tool_calls` with JSON arguments
- Streaming: proper SSE chunks with finish_reason
- All guardrails active (verified via log `CHAT (guarded)` marker)

### Tests

- [ ] Round-trip: OpenAI request → Anthropic → OpenAI with matching content
- [ ] Tool call conversion (both directions)
- [ ] System prompt extraction from messages
- [ ] Streaming endpoint emits valid SSE sequence
- [ ] Profile overrides apply to chat/completions path

---

## PR 5 — `proxy: policy engine with worktree + CI/CD enforcement`

**Scope:** Large — new module + hook points
**Files:** `policies/engine.py`, `policies/rules/*.py`, `anthropic_proxy.py` (hook points), tests
**Depends on:** PR 1 (session continuity), PR 2 (guardrail infrastructure)
**Risk:** Medium — new subsystem

### Motivation

You can tell a local coding agent to use a git worktree. You can write it in CLAUDE.md, put it in the system prompt, make it the first rule. Local 27–35B models **still commit directly to main**.

Policy-as-prompt is not an enforcement mechanism for local coding agents — it's a suggestion. The only reliable way to enforce workflow requirements is to make them non-bypassable at the proxy layer.

### What it enforces

- **Worktree routing** — `Edit`, `Write`, `Bash` tool inputs get rewritten to reference the active worktree path. Operations targeting the main working tree are rejected.
- **Completion gates** — `end_turn` is blocked unless tests ran, memory was queried, parallel reviewers were invoked.
- **Pre-commit discipline** — commit tool calls blocked until code-reviewer + security-auditor + architect-reviewer were invoked.
- **CI/CD deploy bucketing** — each agent session has a deploy bucket tied to its worktree. Concurrent agents don't collide at the pipeline layer.
- **Per-profile rule sets** — `build` / `plan` / `memory` / `autoaccept` each get a different policy set.
- **Session start protocol** — mandatory bootstrap checks (memory query, session context load)
- **Auditable trail** — every policy decision logged with rule ID, context, outcome

### Architecture

```
client → proxy → [guardrails] → [policy engine] → [tool rewriter] → llama.cpp
                                       ↓
                                  audit log
```

Every tool call goes through a policy check chain before being forwarded to llama.cpp. Rules can allow, rewrite, or block.

### Rule DSL

```python
from uap.policies import policy, block, allow, MUTATING_TOOLS

@policy("worktree.enforce", profile=["build", "autoaccept"])
def enforce_worktree(request, session):
    if request.tool_name in MUTATING_TOOLS:
        if not session.worktree_active:
            return block("worktree_not_in_use", 
                         hint="Create a worktree first with `git worktree add`")
        request.tool_input["path"] = rewrite_to_worktree(
            request.tool_input["path"], session.worktree
        )
    return allow()

@policy("commit.parallel_review", profile="build")
def enforce_parallel_review(request, session):
    if request.tool_name == "Bash" and "git commit" in request.tool_input.get("command", ""):
        if not session.review_completed_this_turn:
            return block("parallel_review_required",
                         hint="Invoke code-reviewer + security-auditor + architect-reviewer in parallel before committing")
    return allow()

@policy("completion.gates", profile="build")
def enforce_completion_gates(request, session):
    if request.is_end_turn:
        blockers = []
        if not session.tests_ran:
            blockers.append("tests_not_run")
        if not session.memory_queried:
            blockers.append("memory_not_queried")
        if blockers:
            return block(f"completion_gates_failed: {','.join(blockers)}")
    return allow()
```

### Integration with existing `_completion_blockers()`

Policy blockers extend the existing completion contract:

```python
def _completion_blockers(anthropic_body, has_tool_results, phase="", finalize_fired=False):
    blockers = []
    # ... existing checks ...
    
    # NEW: policy-level blockers
    policy_blockers = policy_engine.evaluate_completion(anthropic_body, session)
    blockers.extend(policy_blockers)
    
    return blockers
```

### Per-profile rule sets

```python
# policies/profiles.py
BUILD_PROFILE_RULES = [
    "worktree.enforce",
    "commit.parallel_review",
    "commit.message_format",
    "commit.no_secrets",
    "completion.gates",
    "session.bootstrap",
]

PLAN_PROFILE_RULES = [
    "tools.read_only",            # blocks write/edit/bash tools
    "session.bootstrap",
]

MEMORY_PROFILE_RULES = [
    "tools.memory_only",          # only memory read/write tools allowed
]

AUTOACCEPT_PROFILE_RULES = [
    "worktree.enforce",           # same worktree rule
    "commit.no_secrets",          # security still enforced
    # no parallel review required (autoaccept is explicit trade-off)
]
```

### Audit trail

Every policy decision is logged with session, rule ID, tool name, decision, and blocker reason:

```
POLICY: sess=fp:aa51... rule=worktree.enforce tool=Edit decision=rewrite old_path=/home/cogtek/dev/main/app.py new_path=/home/cogtek/dev/.worktrees/feat-x/app.py
POLICY: sess=fp:aa51... rule=commit.parallel_review tool=Bash decision=block reason=parallel_review_required
```

### Tests

- [ ] Unit tests for each rule in isolation
- [ ] Integration: build profile session → attempt commit without review → blocked → invoke review → commit succeeds
- [ ] Integration: plan profile session → attempt Write → blocked
- [ ] Multi-agent: two sessions with different worktrees → no collision
- [ ] Audit log format validation

### Migration path

- PR introduces the policy engine as **opt-in** per profile (default profile has no policies — fully backward-compatible)
- Users can enable rules one at a time via profile env vars
- Existing CLAUDE.md prose instructions can reference policies for context, but policies are now enforced independent of prose

---

## Submission order

1. **PR 1 (session fingerprinting)** — critical bug fix, low risk, unblocks everything else
2. **PR 2 (loop protection hardening)** — depends on PR 1, reviewers can verify that PR 1's fix makes these counters functional
3. **PR 3 (spec decoding control)** — independent, small, easy to review
4. **PR 4 (OpenAI endpoint)** — depends on PR 2 (reuses guardrails), adds major new functionality
5. **PR 5 (policy engine)** — depends on PR 1 + PR 2, new subsystem, needs the most review

## Pre-submission checklist (all PRs)

- [ ] Unit tests added
- [ ] Integration tests with real llama.cpp upstream
- [ ] README / docs updated
- [ ] Env var reference updated
- [ ] No breaking changes to existing endpoints (or clearly flagged)
- [ ] Config migration notes for existing deployments
- [ ] Diff against current production (`anthropic-proxy.env.*` profiles)
