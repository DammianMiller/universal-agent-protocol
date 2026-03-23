#!/usr/bin/env python3
"""
UAP Anthropic-to-OpenAI Proxy
==============================

A lightweight, production-ready proxy that translates Anthropic Messages API
requests into OpenAI Chat Completions API requests. Designed for use with
local LLM servers (llama.cpp, vLLM, Ollama, etc.) that expose an OpenAI-
compatible endpoint but need to be accessed from clients that speak the
Anthropic protocol (e.g., Claude Code, Forge Code).

Architecture
------------
    Claude Code  --(Anthropic API)-->  This Proxy  --(OpenAI API)-->  llama.cpp
       :4000                                                             :8080

Key Features
- Full streaming support (SSE translation between protocols)
- Tool/function calling translation (both streaming and non-streaming)
- Module-level httpx.AsyncClient with connection pooling and keep-alive
- Granular timeouts (short connect, long read for LLM generation)
- Graceful error recovery on upstream connection drops
- Proper upstream cleanup on client disconnect
- Context window overflow protection with conversation pruning
- Smart max_tokens capping to prevent next-turn overflow
- Session-level token monitoring with warnings

Configuration (Environment Variables)
--------------------------------------
    LLAMA_CPP_BASE     Base URL of the OpenAI-compatible server
                       Default: http://192.168.1.165:8080/v1

    PROXY_PORT         Port for this proxy to listen on
                       Default: 4000

    PROXY_HOST         Host/IP to bind to
                       Default: 0.0.0.0

    PROXY_LOG_LEVEL    Logging level (DEBUG, INFO, WARNING, ERROR)
                       Default: INFO

    PROXY_READ_TIMEOUT   Read timeout in seconds for upstream LLM streaming
                         Default: 600 (10 minutes)

    PROXY_MAX_CONNECTIONS   Max concurrent connections to upstream
                            Default: 20

    PROXY_CONTEXT_WINDOW   Override context window size (auto-detected from
                           upstream /slots endpoint if not set)
                           Default: 0 (auto-detect)

    PROXY_CONTEXT_PRUNE_THRESHOLD   Fraction of context window at which
                                    conversation pruning activates (0.0-1.0)
                                    Default: 0.75

Usage
-----
    # Basic usage (connects to llama.cpp on default port):
    python anthropic_proxy.py

    # Custom upstream server:
    LLAMA_CPP_BASE=http://localhost:8080/v1 python anthropic_proxy.py

    # Custom proxy port:
    PROXY_PORT=5000 python anthropic_proxy.py

    # Via npx (after npm install):
    npx uap-anthropic-proxy

Dependencies
------------
    pip install fastapi uvicorn httpx

    Or from the project root:
    pip install -r tools/agents/scripts/requirements-proxy.txt
"""

import asyncio
import hashlib
import json
import logging
import os
import re
import sys
import time
import uuid
from dataclasses import dataclass, field

import httpx
from contextlib import asynccontextmanager
from fastapi import FastAPI, Request, Response
from fastapi.responses import StreamingResponse
import uvicorn

# ---------------------------------------------------------------------------
# Configuration (all configurable via environment variables)
# ---------------------------------------------------------------------------
LLAMA_CPP_BASE = os.environ.get("LLAMA_CPP_BASE", "http://192.168.1.165:8080/v1")
PROXY_PORT = int(os.environ.get("PROXY_PORT", "4000"))
PROXY_HOST = os.environ.get("PROXY_HOST", "0.0.0.0")
PROXY_LOG_LEVEL = os.environ.get("PROXY_LOG_LEVEL", "INFO").upper()
PROXY_READ_TIMEOUT = float(os.environ.get("PROXY_READ_TIMEOUT", "600"))
PROXY_MAX_CONNECTIONS = int(os.environ.get("PROXY_MAX_CONNECTIONS", "20"))
PROXY_CONTEXT_WINDOW = int(os.environ.get("PROXY_CONTEXT_WINDOW", "0"))
PROXY_CONTEXT_PRUNE_THRESHOLD = float(
    os.environ.get("PROXY_CONTEXT_PRUNE_THRESHOLD", "0.75")
)
PROXY_CONTEXT_PRUNE_TARGET_FRACTION = float(
    os.environ.get("PROXY_CONTEXT_PRUNE_TARGET_FRACTION", "0.65")
)
PROXY_LOOP_BREAKER = os.environ.get("PROXY_LOOP_BREAKER", "on").lower() not in {
    "0",
    "false",
    "off",
    "no",
}
PROXY_LOOP_WINDOW = int(os.environ.get("PROXY_LOOP_WINDOW", "6"))
PROXY_LOOP_REPEAT_THRESHOLD = int(os.environ.get("PROXY_LOOP_REPEAT_THRESHOLD", "8"))
PROXY_FORCED_THRESHOLD = int(os.environ.get("PROXY_FORCED_THRESHOLD", "15"))
PROXY_NO_PROGRESS_THRESHOLD = int(os.environ.get("PROXY_NO_PROGRESS_THRESHOLD", "4"))
PROXY_CONTEXT_RELEASE_THRESHOLD = float(
    os.environ.get("PROXY_CONTEXT_RELEASE_THRESHOLD", "0.90")
)
PROXY_GUARDRAIL_RETRY = os.environ.get("PROXY_GUARDRAIL_RETRY", "on").lower() not in {
    "0",
    "false",
    "off",
    "no",
}
PROXY_SESSION_TTL_SECS = int(os.environ.get("PROXY_SESSION_TTL_SECS", "7200"))
PROXY_STREAM_REASONING_FALLBACK = (
    os.environ.get("PROXY_STREAM_REASONING_FALLBACK", "off").strip().lower()
)
PROXY_STREAM_REASONING_MAX_CHARS = int(
    os.environ.get("PROXY_STREAM_REASONING_MAX_CHARS", "240")
)
PROXY_MAX_TOKENS_FLOOR = int(os.environ.get("PROXY_MAX_TOKENS_FLOOR", "16384"))
PROXY_TOOL_NARROWING = os.environ.get("PROXY_TOOL_NARROWING", "off").lower() not in {
    "0",
    "false",
    "off",
    "no",
}
PROXY_TOOL_NARROWING_KEEP = int(os.environ.get("PROXY_TOOL_NARROWING_KEEP", "8"))
PROXY_TOOL_NARROWING_MIN_TOOLS = int(
    os.environ.get("PROXY_TOOL_NARROWING_MIN_TOOLS", "12")
)
PROXY_DISABLE_THINKING_ON_TOOL_TURNS = os.environ.get(
    "PROXY_DISABLE_THINKING_ON_TOOL_TURNS", "off"
).lower() not in {
    "0",
    "false",
    "off",
    "no",
}
PROXY_MALFORMED_TOOL_GUARDRAIL = os.environ.get(
    "PROXY_MALFORMED_TOOL_GUARDRAIL", "on"
).lower() not in {
    "0",
    "false",
    "off",
    "no",
}
PROXY_MALFORMED_TOOL_RETRY_MAX = int(
    os.environ.get("PROXY_MALFORMED_TOOL_RETRY_MAX", "1")
)
PROXY_MALFORMED_TOOL_RETRY_MAX_TOKENS = int(
    os.environ.get("PROXY_MALFORMED_TOOL_RETRY_MAX_TOKENS", "2048")
)
PROXY_MALFORMED_TOOL_RETRY_TEMPERATURE = float(
    os.environ.get("PROXY_MALFORMED_TOOL_RETRY_TEMPERATURE", "0")
)
PROXY_MALFORMED_TOOL_STREAM_STRICT = os.environ.get(
    "PROXY_MALFORMED_TOOL_STREAM_STRICT", "off"
).lower() not in {
    "0",
    "false",
    "off",
    "no",
}
PROXY_SESSION_CONTAMINATION_BREAKER = os.environ.get(
    "PROXY_SESSION_CONTAMINATION_BREAKER", "on"
).lower() not in {
    "0",
    "false",
    "off",
    "no",
}
PROXY_SESSION_CONTAMINATION_THRESHOLD = int(
    os.environ.get("PROXY_SESSION_CONTAMINATION_THRESHOLD", "3")
)
PROXY_SESSION_CONTAMINATION_KEEP_LAST = int(
    os.environ.get("PROXY_SESSION_CONTAMINATION_KEEP_LAST", "8")
)
PROXY_AGENTIC_SUPPLEMENT_MODE = (
    os.environ.get("PROXY_AGENTIC_SUPPLEMENT_MODE", "clean").strip().lower()
)

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=getattr(logging, PROXY_LOG_LEVEL, logging.INFO),
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("uap.anthropic_proxy")


# ---------------------------------------------------------------------------
# Option F: Session-level Context Window Monitor
# ---------------------------------------------------------------------------
@dataclass
class SessionMonitor:
    """Tracks token usage across the session to provide early warnings
    and enable proactive context management before overflow occurs."""

    context_window: int = 0  # Auto-detected or configured
    total_requests: int = 0
    last_input_tokens: int = 0  # Estimated input tokens of last request
    last_output_tokens: int = 0  # Actual output tokens of last response
    peak_input_tokens: int = 0  # High-water mark
    prune_count: int = 0  # How many times pruning was triggered
    overflow_count: int = 0  # How many context overflow errors caught
    context_history: list = field(default_factory=list)  # Recent token counts

    # --- Token Loop Protection ---
    tool_call_history: list = field(
        default_factory=list
    )  # Recent tool call fingerprints
    consecutive_forced_count: int = (
        0  # How many times tool_choice was forced consecutively
    )
    loop_warnings_emitted: int = 0  # How many loop warnings sent to the model
    no_progress_streak: int = 0  # Forced tool turns without new tool_result
    unexpected_end_turn_count: int = 0  # end_turn without tool_use in active loop
    malformed_tool_streak: int = 0  # consecutive malformed pseudo tool payloads
    contamination_resets: int = 0  # how many contamination resets were applied
    last_seen_ts: float = 0.0

    def record_request(self, estimated_tokens: int):
        """Record an outgoing request's estimated token count."""
        self.total_requests += 1
        self.last_input_tokens = estimated_tokens
        if estimated_tokens > self.peak_input_tokens:
            self.peak_input_tokens = estimated_tokens
        self.context_history.append(estimated_tokens)
        # Keep last 50 entries
        if len(self.context_history) > 50:
            self.context_history = self.context_history[-50:]

    def record_response(self, output_tokens: int):
        """Record a response's output token count."""
        self.last_output_tokens = output_tokens

    def touch(self):
        self.last_seen_ts = time.time()

    def get_utilization(self) -> float:
        """Get current context utilization as a fraction (0.0 - 1.0)."""
        if self.context_window <= 0:
            return 0.0
        return self.last_input_tokens / self.context_window

    def get_warning_level(self) -> str | None:
        """Return warning level based on context utilization.
        Returns None if no warning needed."""
        util = self.get_utilization()
        if util >= 0.95:
            return "CRITICAL"
        elif util >= 0.85:
            return "HIGH"
        elif util >= 0.75:
            return "ELEVATED"
        return None

    def estimate_turns_remaining(self) -> int | None:
        """Estimate how many more agentic turns can fit before overflow."""
        if self.context_window <= 0 or len(self.context_history) < 2:
            return None
        # Average growth per turn from recent history
        deltas = [
            self.context_history[i] - self.context_history[i - 1]
            for i in range(1, len(self.context_history))
            if self.context_history[i] > self.context_history[i - 1]
        ]
        if not deltas:
            return None
        avg_growth = sum(deltas) / len(deltas)
        if avg_growth <= 0:
            return None
        remaining_tokens = self.context_window - self.last_input_tokens
        return max(0, int(remaining_tokens / avg_growth))

    def log_status(self):
        """Log current session status."""
        util = self.get_utilization()
        warning = self.get_warning_level()
        turns = self.estimate_turns_remaining()
        turns_str = f"~{turns} turns remaining" if turns is not None else "unknown"

        if warning == "CRITICAL":
            logger.error(
                "CONTEXT CRITICAL: %d/%d tokens (%.1f%%), %s, pruned=%d, overflows=%d",
                self.last_input_tokens,
                self.context_window,
                util * 100,
                turns_str,
                self.prune_count,
                self.overflow_count,
            )
        elif warning == "HIGH":
            logger.warning(
                "CONTEXT HIGH: %d/%d tokens (%.1f%%), %s, pruned=%d",
                self.last_input_tokens,
                self.context_window,
                util * 100,
                turns_str,
                self.prune_count,
            )
        elif warning == "ELEVATED":
            logger.warning(
                "CONTEXT ELEVATED: %d/%d tokens (%.1f%%), %s",
                self.last_input_tokens,
                self.context_window,
                util * 100,
                turns_str,
            )
        else:
            logger.info(
                "CONTEXT: %d/%d tokens (%.1f%%), %s",
                self.last_input_tokens,
                self.context_window,
                util * 100,
                turns_str,
            )

    # --- Token Loop Protection Methods ---

    def record_tool_calls(self, tool_names: list[str]):
        """Record tool call names for loop detection."""
        fingerprint = "|".join(sorted(tool_names)) if tool_names else ""
        self.tool_call_history.append(fingerprint)
        # Keep last 30 entries
        if len(self.tool_call_history) > 30:
            self.tool_call_history = self.tool_call_history[-30:]

    def detect_tool_loop(self, window: int = 6) -> tuple[bool, int]:
        """Detect if the model is stuck in a tool call loop.

        Checks if the last `window` tool call fingerprints are identical.
        Returns (is_looping, repeat_count).
        """
        if len(self.tool_call_history) < window:
            return False, 0

        recent = self.tool_call_history[-window:]
        if not recent[0]:
            return False, 0

        # Check if all recent entries are the same fingerprint
        if all(fp == recent[0] for fp in recent):
            # Count total consecutive repeats from the end
            count = 0
            target = recent[0]
            for fp in reversed(self.tool_call_history):
                if fp == target:
                    count += 1
                else:
                    break
            return True, count

        return False, 0

    def should_release_tool_choice(self) -> bool:
        """Determine if tool_choice should be relaxed to 'auto' to break a loop.

        Returns True if the model appears stuck and forcing tool_choice=required
        is making it worse. Thresholds:
          - 8+ consecutive forced requests with same tool pattern -> release
          - 15+ consecutive forced requests regardless -> release
          - Context utilization > 90% -> release (let model wrap up)
        """
        if not PROXY_LOOP_BREAKER:
            return False

        is_looping, repeat_count = self.detect_tool_loop(window=PROXY_LOOP_WINDOW)

        # Pattern 1: Detected tool call loop
        if (
            is_looping
            and repeat_count >= PROXY_LOOP_REPEAT_THRESHOLD
            and self.no_progress_streak >= PROXY_NO_PROGRESS_THRESHOLD
        ):
            logger.warning(
                "LOOP BREAKER: Same tool pattern repeated %d times with no progress streak=%d. "
                "Releasing tool_choice to 'auto'.",
                repeat_count,
                self.no_progress_streak,
            )
            self.loop_warnings_emitted += 1
            return True

        # Pattern 2: Too many consecutive forced requests
        if (
            self.consecutive_forced_count >= PROXY_FORCED_THRESHOLD
            and self.no_progress_streak >= PROXY_NO_PROGRESS_THRESHOLD
        ):
            logger.warning(
                "LOOP BREAKER: %d consecutive forced tool_choice requests with no progress streak=%d. "
                "Releasing to 'auto'.",
                self.consecutive_forced_count,
                self.no_progress_streak,
            )
            self.loop_warnings_emitted += 1
            return True

        # Pattern 3: Context almost full -- let model wrap up naturally
        if self.get_utilization() >= PROXY_CONTEXT_RELEASE_THRESHOLD:
            logger.warning(
                "LOOP BREAKER: Context utilization %.1f%% -- releasing "
                "tool_choice to let model wrap up.",
                self.get_utilization() * 100,
            )
            return True

        return False


session_monitors: dict[str, SessionMonitor] = {}
default_context_window = 0
last_session_id = ""


def _cleanup_stale_monitors(now_ts: float) -> None:
    stale = [
        sid
        for sid, mon in session_monitors.items()
        if mon.last_seen_ts > 0 and now_ts - mon.last_seen_ts > PROXY_SESSION_TTL_SECS
    ]
    for sid in stale:
        session_monitors.pop(sid, None)


def get_session_monitor(session_id: str) -> SessionMonitor:
    now_ts = time.time()
    _cleanup_stale_monitors(now_ts)

    monitor = session_monitors.get(session_id)
    if monitor is None:
        monitor = SessionMonitor(context_window=default_context_window)
        session_monitors[session_id] = monitor

    monitor.touch()
    if monitor.context_window <= 0:
        monitor.context_window = default_context_window

    return monitor


# ---------------------------------------------------------------------------
# Context Window Detection
# ---------------------------------------------------------------------------
async def detect_context_window(client: httpx.AsyncClient) -> int:
    """Auto-detect the upstream server's per-slot context window size.

    Queries the /slots endpoint (llama.cpp) to get the actual n_ctx value.
    Falls back to PROXY_CONTEXT_WINDOW env var, then to a safe default.
    """
    if PROXY_CONTEXT_WINDOW > 0:
        logger.info("Using configured context window: %d tokens", PROXY_CONTEXT_WINDOW)
        return PROXY_CONTEXT_WINDOW

    try:
        slots_url = LLAMA_CPP_BASE.replace("/v1", "/slots")
        resp = await client.get(slots_url, timeout=5.0)
        if resp.status_code == 200:
            slots = resp.json()
            if slots and isinstance(slots, list):
                n_ctx = slots[0].get("n_ctx", 0)
                if n_ctx > 0:
                    logger.info(
                        "Auto-detected context window from upstream: %d tokens (%d slots)",
                        n_ctx,
                        len(slots),
                    )
                    return n_ctx
    except Exception as exc:
        logger.warning("Failed to auto-detect context window: %s", exc)

    # Safe default: 128K (common for modern models)
    default = 131072
    logger.warning("Using default context window: %d tokens", default)
    return default


# ---------------------------------------------------------------------------
# Option C: Conversation Pruning
# ---------------------------------------------------------------------------
# Characters-per-token ratio for estimation. English text averages ~4 chars/token,
# but tool call JSON and code tend to be denser (~3.2 chars/token).
CHARS_PER_TOKEN = 3.5


def estimate_tokens(text: str) -> int:
    """Estimate token count from text length using chars-per-token heuristic."""
    return max(1, int(len(text) / CHARS_PER_TOKEN))


def estimate_message_tokens(msg: dict) -> int:
    """Estimate token count for a single Anthropic message."""
    tokens = 4  # Message overhead (role, separators)
    content = msg.get("content", "")
    if isinstance(content, str):
        tokens += estimate_tokens(content)
    elif isinstance(content, list):
        for block in content:
            if isinstance(block, str):
                tokens += estimate_tokens(block)
            elif isinstance(block, dict):
                if block.get("type") == "text":
                    tokens += estimate_tokens(block.get("text", ""))
                elif block.get("type") == "tool_use":
                    tokens += estimate_tokens(block.get("name", ""))
                    tokens += estimate_tokens(json.dumps(block.get("input", {})))
                elif block.get("type") == "tool_result":
                    tokens += estimate_tokens(_extract_text(block.get("content", "")))
    return tokens


def estimate_total_tokens(anthropic_body: dict) -> int:
    """Estimate total token count for an Anthropic Messages API request."""
    tokens = 0

    # System prompt
    system = anthropic_body.get("system", "")
    if isinstance(system, str):
        tokens += estimate_tokens(system)
    elif isinstance(system, list):
        for block in system:
            if isinstance(block, dict) and block.get("type") == "text":
                tokens += estimate_tokens(block.get("text", ""))

    # Agentic supplement tokens (always injected)
    tokens += estimate_tokens(_AGENTIC_SYSTEM_SUPPLEMENT)

    # Messages
    for msg in anthropic_body.get("messages", []):
        tokens += estimate_message_tokens(msg)

    # Tool definitions
    tools = anthropic_body.get("tools", [])
    if tools:
        tokens += estimate_tokens(json.dumps(tools))

    return tokens


def prune_conversation(
    anthropic_body: dict, context_window: int, target_fraction: float = 0.65
) -> dict:
    """Prune the conversation to fit within the context window.

    Strategy:
    - Always keep: system prompt, first user message, last N messages
    - Remove from the middle: oldest tool_result messages first (they're
      the largest -- file contents, command output, etc.), then oldest
      assistant messages, then oldest user messages.
    - Inject a [CONTEXT PRUNED] marker so the model knows history was trimmed.

    Args:
        anthropic_body: The full Anthropic request body
        context_window: Maximum context window in tokens
        target_fraction: Target utilization after pruning (0.0-1.0)

    Returns:
        Modified anthropic_body with pruned messages
    """
    messages = anthropic_body.get("messages", [])
    if len(messages) <= 4:
        # Too few messages to prune meaningfully
        return anthropic_body

    target_tokens = int(context_window * target_fraction)

    # Estimate non-message tokens (system, tools, agentic supplement)
    overhead_tokens = 0
    system = anthropic_body.get("system", "")
    if isinstance(system, str):
        overhead_tokens += estimate_tokens(system)
    elif isinstance(system, list):
        for block in system:
            if isinstance(block, dict) and block.get("type") == "text":
                overhead_tokens += estimate_tokens(block.get("text", ""))
    overhead_tokens += estimate_tokens(_AGENTIC_SYSTEM_SUPPLEMENT)
    tools = anthropic_body.get("tools", [])
    if tools:
        overhead_tokens += estimate_tokens(json.dumps(tools))

    # Budget for messages
    message_budget = target_tokens - overhead_tokens
    if message_budget <= 0:
        logger.error("System prompt + tools alone exceed target budget!")
        return anthropic_body

    # Always keep the first user message and the last N messages
    KEEP_LAST = 8  # Keep the last 8 messages (recent context)
    protected_head = messages[:1]  # First user message
    protected_tail = (
        messages[-KEEP_LAST:] if len(messages) > KEEP_LAST else messages[1:]
    )
    middle = messages[1:-KEEP_LAST] if len(messages) > KEEP_LAST + 1 else []

    # Calculate tokens for protected messages
    protected_tokens = sum(
        estimate_message_tokens(m) for m in protected_head + protected_tail
    )

    if protected_tokens >= message_budget:
        # Even protected messages exceed budget -- truncate tool_result content
        # in the tail to fit
        logger.warning(
            "Protected messages (%d tokens) exceed budget (%d) -- truncating tool results",
            protected_tokens,
            message_budget,
        )
        for msg in protected_tail:
            content = msg.get("content", [])
            if isinstance(content, list):
                for block in content:
                    if isinstance(block, dict) and block.get("type") == "tool_result":
                        result_text = _extract_text(block.get("content", ""))
                        if len(result_text) > 2000:
                            block["content"] = (
                                result_text[:1000]
                                + "\n...[TRUNCATED]...\n"
                                + result_text[-500:]
                            )
        anthropic_body["messages"] = protected_head + protected_tail
        return anthropic_body

    remaining_budget = message_budget - protected_tokens

    # Score middle messages for removal priority:
    # - tool_result messages: remove first (biggest, least important historically)
    # - assistant text-only: remove second
    # - user messages: remove last (provide context for the model's actions)
    # Within each category, remove oldest first.
    scored_middle = []
    for i, msg in enumerate(middle):
        content = msg.get("content", [])
        tokens = estimate_message_tokens(msg)
        is_tool_result = False
        is_assistant = msg.get("role") == "assistant"

        if isinstance(content, list):
            is_tool_result = any(
                isinstance(b, dict) and b.get("type") == "tool_result" for b in content
            )

        # Lower priority = removed first
        if is_tool_result:
            priority = 0  # Remove first
        elif is_assistant:
            priority = 1  # Remove second
        else:
            priority = 2  # Remove last (user messages)

        scored_middle.append((priority, i, tokens, msg))

    # Sort by priority (ascending = remove first), then by index (oldest first)
    scored_middle.sort(key=lambda x: (x[0], x[1]))

    # Greedily keep messages from highest priority (keep last) until budget fills
    kept_middle = []
    used_tokens = 0
    # Process in reverse priority order (keep high-priority messages first)
    for priority, idx, tokens, msg in reversed(scored_middle):
        if used_tokens + tokens <= remaining_budget:
            kept_middle.append((idx, msg))
            used_tokens += tokens

    # Sort kept messages back into original order
    kept_middle.sort(key=lambda x: x[0])
    kept_msgs = [m for _, m in kept_middle]

    removed_count = len(middle) - len(kept_msgs)
    removed_tokens = sum(t for _, _, t, _ in scored_middle) - used_tokens

    if removed_count > 0:
        # Insert a context-pruned marker
        prune_marker = {
            "role": "user",
            "content": (
                f"[CONTEXT PRUNED: {removed_count} older messages (~{removed_tokens} tokens) "
                f"were removed to fit within the context window. "
                f"The conversation continues from recent context below.]"
            ),
        }
        anthropic_body["messages"] = (
            protected_head + [prune_marker] + kept_msgs + protected_tail
        )
        logger.warning(
            "PRUNED: removed %d messages (~%d tokens), kept %d messages, "
            "target=%.0f%% of %d ctx",
            removed_count,
            removed_tokens,
            len(anthropic_body["messages"]),
            target_fraction * 100,
            context_window,
        )
    else:
        anthropic_body["messages"] = protected_head + kept_msgs + protected_tail

    return anthropic_body


# ---------------------------------------------------------------------------
# HTTP Client Lifecycle
# ---------------------------------------------------------------------------
# Module-level httpx.AsyncClient for connection reuse + keep-alive.
# Granular timeouts: short connect, long read for streaming LLM output.
http_client: httpx.AsyncClient | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Manage the httpx client lifecycle with the FastAPI app."""
    global http_client
    global default_context_window
    http_client = httpx.AsyncClient(
        timeout=httpx.Timeout(
            connect=10.0,  # 10s to establish connection
            read=PROXY_READ_TIMEOUT,  # configurable (default 10 min)
            write=30.0,  # 30s to send the request body
            pool=10.0,  # 10s to acquire a pool connection
        ),
        limits=httpx.Limits(
            max_connections=PROXY_MAX_CONNECTIONS,
            max_keepalive_connections=PROXY_MAX_CONNECTIONS // 2,
            keepalive_expiry=120,
        ),
    )
    logger.info(
        "Proxy started: listening on %s:%d -> upstream %s",
        PROXY_HOST,
        PROXY_PORT,
        LLAMA_CPP_BASE,
    )

    # Auto-detect context window from upstream server
    default_context_window = await detect_context_window(http_client)
    for mon in session_monitors.values():
        if mon.context_window <= 0:
            mon.context_window = default_context_window
    logger.info(
        "Context window: %d tokens, prune threshold: %.0f%%, prune target: %.0f%%",
        default_context_window,
        PROXY_CONTEXT_PRUNE_THRESHOLD * 100,
        _resolve_prune_target_fraction() * 100,
    )
    logger.info(
        "Guardrails: malformed=%s stream_strict=%s tool_narrowing=%s thinking_off_on_tools=%s contamination_breaker=%s(%d)",
        PROXY_MALFORMED_TOOL_GUARDRAIL,
        PROXY_MALFORMED_TOOL_STREAM_STRICT,
        PROXY_TOOL_NARROWING,
        PROXY_DISABLE_THINKING_ON_TOOL_TURNS,
        PROXY_SESSION_CONTAMINATION_BREAKER,
        PROXY_SESSION_CONTAMINATION_THRESHOLD,
    )

    yield
    await http_client.aclose()
    http_client = None
    logger.info("Proxy shut down")


app = FastAPI(
    title="UAP Anthropic Proxy",
    description="Translates Anthropic Messages API to OpenAI Chat Completions API",
    version="1.0.0",
    lifespan=lifespan,
)


# ===========================================================================
# Request Translation: Anthropic -> OpenAI
# ===========================================================================


def anthropic_to_openai_messages(anthropic_body: dict) -> list[dict]:
    """Convert Anthropic message format to OpenAI message format.

    Handles:
    - System prompt (string or content block array)
    - Text content blocks
    - Tool use blocks (-> OpenAI function calls)
    - Tool result blocks (-> OpenAI tool messages)
    """
    messages = []

    # Anthropic has system as a top-level param
    system = anthropic_body.get("system")
    if system:
        if isinstance(system, str):
            messages.append({"role": "system", "content": system})
        elif isinstance(system, list):
            text = "\n".join(
                b.get("text", "") for b in system if b.get("type") == "text"
            )
            if text:
                messages.append({"role": "system", "content": text})

    for msg in anthropic_body.get("messages", []):
        role = msg["role"]
        content = msg.get("content")

        if isinstance(content, str):
            messages.append({"role": role, "content": content})
        elif isinstance(content, list):
            parts = []
            for block in content:
                if isinstance(block, str):
                    parts.append(block)
                elif block.get("type") == "text":
                    parts.append(block.get("text", ""))
                elif block.get("type") == "tool_use":
                    messages.append(
                        {
                            "role": "assistant",
                            "content": None,
                            "tool_calls": [
                                {
                                    "id": block.get(
                                        "id", f"call_{uuid.uuid4().hex[:8]}"
                                    ),
                                    "type": "function",
                                    "function": {
                                        "name": block["name"],
                                        "arguments": json.dumps(block.get("input", {})),
                                    },
                                }
                            ],
                        }
                    )
                    continue
                elif block.get("type") == "tool_result":
                    messages.append(
                        {
                            "role": "tool",
                            "tool_call_id": block.get("tool_use_id", ""),
                            "content": _extract_text(block.get("content", "")),
                        }
                    )
                    continue
            if parts:
                messages.append({"role": role, "content": "\n".join(parts)})

    return messages


def _extract_text(content) -> str:
    """Extract plain text from Anthropic content (string, list, or other)."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(
            b.get("text", "") if isinstance(b, dict) else str(b) for b in content
        )
    return str(content)


_AGENTIC_SYSTEM_SUPPLEMENT_LEGACY = (
    "\n\n<agentic-protocol>\n"
    "You are operating in an agentic coding loop with tool access. Follow these rules:\n"
    "1. ALWAYS use tools to read, edit, write, and test code. Never just describe or explain what should be done.\n"
    "2. After reading files and identifying an issue, proceed IMMEDIATELY to make the fix using Edit/Write tools. Do NOT stop after explaining the problem.\n"
    "3. After making changes, run the relevant tests or build commands to verify your fix.\n"
    "4. Only produce a final text response WITHOUT tool calls when the ENTIRE task is fully complete, verified, and you have nothing left to do.\n"
    "5. If you have identified a problem but have not yet fixed it, you MUST call a tool to make the fix. Do NOT summarize the issue and stop.\n"
    "6. When the user asks you to do something, DO it with tools. Do not ask for permission or confirmation.\n"
    "7. If a tool call fails, analyze the error and try a different approach. Do not give up after one failure.\n"
    "</agentic-protocol>"
)

_AGENTIC_SYSTEM_SUPPLEMENT_CLEAN = (
    "\n\n<agentic-protocol>\n"
    "You are operating in an agentic coding loop with tool access. Follow these rules:\n"
    "1. Use tools for concrete work (read, edit, write, test) instead of stopping at analysis.\n"
    "2. When a fix is identified, take the next tool action immediately.\n"
    "3. Return final text only when the task is complete and verified.\n"
    "4. Never output protocol fragments or raw tool schema in assistant text.\n"
    "5. Never emit literal tag artifacts such as </parameter>, <tool_call>, or <function=...>.\n"
    "6. When a tool is needed, emit a valid tool call object instead of prose about tool-call formatting.\n"
    "7. If a tool call fails, adapt and try another approach.\n"
    "</agentic-protocol>"
)

if PROXY_AGENTIC_SUPPLEMENT_MODE == "legacy":
    _AGENTIC_SYSTEM_SUPPLEMENT = _AGENTIC_SYSTEM_SUPPLEMENT_LEGACY
elif PROXY_AGENTIC_SUPPLEMENT_MODE == "clean":
    _AGENTIC_SYSTEM_SUPPLEMENT = _AGENTIC_SYSTEM_SUPPLEMENT_CLEAN
else:
    logger.warning(
        "Unknown PROXY_AGENTIC_SUPPLEMENT_MODE=%r; using clean supplement",
        PROXY_AGENTIC_SUPPLEMENT_MODE,
    )
    _AGENTIC_SYSTEM_SUPPLEMENT = _AGENTIC_SYSTEM_SUPPLEMENT_CLEAN


def _content_fingerprint(content) -> str:
    if isinstance(content, str):
        return content[:512]
    if isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, str):
                parts.append(block)
            elif isinstance(block, dict):
                btype = block.get("type", "")
                if btype == "text":
                    parts.append(block.get("text", ""))
                elif btype == "tool_use":
                    parts.append(f"tool:{block.get('name', '')}")
                elif btype == "tool_result":
                    parts.append(f"result:{block.get('tool_use_id', '')}")
        return "\n".join(parts)[:1024]
    return str(content)[:512]


def resolve_session_id(request: Request, anthropic_body: dict) -> str:
    header_keys = (
        "x-uap-session-id",
        "x-claude-session-id",
        "anthropic-session-id",
        "x-session-id",
    )
    for key in header_keys:
        value = request.headers.get(key)
        if value:
            return f"hdr:{value}"

    metadata = anthropic_body.get("metadata", {})
    if isinstance(metadata, dict):
        for key in ("session_id", "conversation_id", "thread_id"):
            value = metadata.get(key)
            if value:
                return f"meta:{value}"

    first_user = ""
    for msg in anthropic_body.get("messages", []):
        if msg.get("role") == "user":
            first_user = _content_fingerprint(msg.get("content", ""))
            break

    system_fingerprint = _content_fingerprint(anthropic_body.get("system", ""))
    model = anthropic_body.get("model", "default")
    remote = request.client.host if request.client else "unknown"
    digest = hashlib.sha256(
        f"{remote}|{model}|{system_fingerprint}|{first_user}".encode(
            "utf-8", errors="ignore"
        )
    ).hexdigest()[:20]
    return f"fp:{digest}"


def _last_user_has_tool_result(anthropic_body: dict) -> bool:
    messages = anthropic_body.get("messages", [])
    for msg in reversed(messages):
        if msg.get("role") != "user":
            continue
        content = msg.get("content")
        if not isinstance(content, list):
            return False
        return any(
            isinstance(b, dict) and b.get("type") == "tool_result" for b in content
        )
    return False


def _convert_anthropic_tools_to_openai(anthropic_tools: list[dict]) -> list[dict]:
    converted = []
    for tool in anthropic_tools:
        converted.append(
            {
                "type": "function",
                "function": {
                    "name": tool.get("name", ""),
                    "description": tool.get("description", ""),
                    "parameters": tool.get("input_schema", {}),
                },
            }
        )
    return converted


def _latest_user_text(anthropic_body: dict) -> str:
    for msg in reversed(anthropic_body.get("messages", [])):
        if msg.get("role") != "user":
            continue
        return _extract_text(msg.get("content", ""))
    return ""


def _tokenize_for_tool_ranking(text: str) -> set[str]:
    return {m.group(0).lower() for m in re.finditer(r"[a-zA-Z0-9_]{2,}", text)}


def _narrow_tools_for_request(
    anthropic_body: dict, openai_tools: list[dict]
) -> list[dict]:
    if not PROXY_TOOL_NARROWING:
        return openai_tools

    if len(openai_tools) < max(1, PROXY_TOOL_NARROWING_MIN_TOOLS):
        return openai_tools

    keep = max(1, PROXY_TOOL_NARROWING_KEEP)
    if keep >= len(openai_tools):
        return openai_tools

    query_text = _latest_user_text(anthropic_body).lower()
    query_tokens = _tokenize_for_tool_ranking(query_text)
    if not query_tokens:
        narrowed = openai_tools[:keep]
        logger.info(
            "TOOL NARROWING: %d -> %d tools (no query tokens)",
            len(openai_tools),
            len(narrowed),
        )
        return narrowed

    scored: list[tuple[int, int, dict]] = []
    for idx, tool in enumerate(openai_tools):
        fn = tool.get("function", {})
        name = fn.get("name", "")
        desc = fn.get("description", "")
        hay = f"{name} {desc}".lower()
        tool_tokens = _tokenize_for_tool_ranking(hay)
        overlap = len(query_tokens & tool_tokens)
        score = overlap * 3
        if name and name.lower() in query_text:
            score += 4
        if name and any(tok in name.lower() for tok in query_tokens):
            score += 1
        scored.append((score, -idx, tool))

    scored.sort(reverse=True)
    selected = {id(tool) for _, _, tool in scored[:keep]}
    narrowed = [tool for tool in openai_tools if id(tool) in selected]

    top_names = [t.get("function", {}).get("name", "") for t in narrowed[:4]]
    logger.info(
        "TOOL NARROWING: %d -> %d tools (top=%s)",
        len(openai_tools),
        len(narrowed),
        top_names,
    )
    return narrowed


def build_openai_request(anthropic_body: dict, monitor: SessionMonitor) -> dict:
    """Build an OpenAI Chat Completions request from an Anthropic Messages request."""
    openai_body = {
        "model": anthropic_body.get("model", "default"),
        "messages": anthropic_to_openai_messages(anthropic_body),
        "stream": anthropic_body.get("stream", False),
    }

    # Inject agentic protocol instructions into the system message so
    # the model knows it must use tools to complete work, not just explain.
    if openai_body["messages"] and openai_body["messages"][0].get("role") == "system":
        openai_body["messages"][0]["content"] += _AGENTIC_SYSTEM_SUPPLEMENT
    else:
        # No system message from the client; inject one.
        openai_body["messages"].insert(
            0,
            {
                "role": "system",
                "content": _AGENTIC_SYSTEM_SUPPLEMENT.strip(),
            },
        )

    if "max_tokens" in anthropic_body:
        # Enforce configurable minimum floor for thinking mode: model needs
        # tokens for reasoning (<think>...</think>) plus actual response/tool
        # calls. Set PROXY_MAX_TOKENS_FLOOR=0 to disable this floor.
        requested_max = _resolve_max_tokens_request(anthropic_body["max_tokens"])

        # Option E: Smart max_tokens capping — prevent the response from
        # consuming so many tokens that the NEXT turn's input won't fit.
        # Formula: max_tokens = min(requested, context_window - input_tokens - safety_margin)
        # This ensures the model's output + current input stays within bounds,
        # leaving room for the next turn's incremental growth.
        ctx_window = monitor.context_window
        if ctx_window > 0:
            estimated_input = estimate_total_tokens(anthropic_body)
            # Reserve 15% of context for next-turn growth (tool results, etc.)
            safety_margin = int(ctx_window * 0.15)
            available_for_output = ctx_window - estimated_input - safety_margin
            if available_for_output < requested_max and available_for_output > 1024:
                logger.info(
                    "MAX_TOKENS capped: %d -> %d (ctx=%d, input~%d, margin=%d)",
                    requested_max,
                    available_for_output,
                    ctx_window,
                    estimated_input,
                    safety_margin,
                )
                requested_max = available_for_output
            elif available_for_output <= 1024:
                # Very tight on space -- allow minimum but warn
                logger.warning(
                    "MAX_TOKENS: only %d tokens available for output (ctx=%d, input~%d). "
                    "Response may be truncated.",
                    available_for_output,
                    ctx_window,
                    estimated_input,
                )
                requested_max = max(1024, available_for_output)

        openai_body["max_tokens"] = requested_max
    if "temperature" in anthropic_body:
        openai_body["temperature"] = anthropic_body["temperature"]
    if "top_p" in anthropic_body:
        openai_body["top_p"] = anthropic_body["top_p"]
    if "stop_sequences" in anthropic_body:
        openai_body["stop"] = anthropic_body["stop_sequences"]

    # Convert Anthropic tools to OpenAI function-calling tools
    if "tools" in anthropic_body:
        openai_body["tools"] = _convert_anthropic_tools_to_openai(
            anthropic_body.get("tools", [])
        )
        openai_body["tools"] = _narrow_tools_for_request(
            anthropic_body, openai_body["tools"]
        )

        # Smart tool_choice: force tool calls during the agentic loop to
        # prevent the model from producing text-only end_turn responses that
        # prematurely stop the loop. The model can still produce text alongside
        # tool calls when tool_choice="required".
        #
        # Force "required" when:
        #   - More than 1 message (conversation is in progress)
        #   - Last assistant was text-only (would cause premature stop)
        #   - OR conversation has tool_result messages (active agentic loop)
        #
        # LOOP PROTECTION: Release to "auto" if the session monitor detects
        # a tool call loop (same tools called repeatedly), to prevent
        # runaway token consumption.
        n_msgs = len(anthropic_body.get("messages", []))
        has_tool_results = any(
            isinstance(m.get("content"), list)
            and any(
                isinstance(b, dict) and b.get("type") == "tool_result"
                for b in m.get("content", [])
            )
            for m in anthropic_body.get("messages", [])
        )

        # Record tool calls from the last assistant message for loop detection
        _record_last_assistant_tool_calls(anthropic_body, monitor)
        last_user_has_tool_result = _last_user_has_tool_result(anthropic_body)

        # Check if loop breaker should override tool_choice
        if monitor.should_release_tool_choice():
            openai_body["tool_choice"] = "auto"
            monitor.consecutive_forced_count = 0
            monitor.no_progress_streak = 0
            logger.warning("tool_choice set to 'auto' by LOOP BREAKER")
        elif _last_assistant_was_text_only(anthropic_body):
            openai_body["tool_choice"] = "required"
            monitor.consecutive_forced_count += 1
            monitor.no_progress_streak = (
                0 if last_user_has_tool_result else monitor.no_progress_streak + 1
            )
            logger.info(
                "tool_choice forced to 'required' (last assistant was text-only)"
            )
        elif has_tool_results and n_msgs > 2:
            openai_body["tool_choice"] = "required"
            monitor.consecutive_forced_count += 1
            monitor.no_progress_streak = (
                0 if last_user_has_tool_result else monitor.no_progress_streak + 1
            )
            logger.info(
                "tool_choice forced to 'required' (active agentic loop with tool results)"
            )
        else:
            monitor.consecutive_forced_count = 0
            monitor.no_progress_streak = 0

        if PROXY_DISABLE_THINKING_ON_TOOL_TURNS:
            openai_body["enable_thinking"] = False
            logger.info(
                "Thinking disabled for tool turn (PROXY_DISABLE_THINKING_ON_TOOL_TURNS=on)"
            )

    return openai_body


def _record_last_assistant_tool_calls(anthropic_body: dict, monitor: SessionMonitor):
    """Extract tool call names from the last assistant message and record
    them in the session monitor for loop detection."""
    messages = anthropic_body.get("messages", [])
    tool_names = []
    for msg in reversed(messages):
        if msg.get("role") != "assistant":
            continue
        content = msg.get("content")
        if isinstance(content, list):
            for block in content:
                if isinstance(block, dict) and block.get("type") == "tool_use":
                    tool_names.append(block.get("name", "unknown"))
        break
    if tool_names:
        monitor.record_tool_calls(tool_names)


def _is_unexpected_end_turn(openai_resp: dict, anthropic_body: dict) -> bool:
    choices = openai_resp.get("choices") or []
    if not choices:
        return False

    choice = choices[0]
    finish = choice.get("finish_reason")
    if finish not in {"stop", "end_turn"}:
        return False

    msg = choice.get("message", {})
    if msg.get("tool_calls"):
        return False

    if "tools" not in anthropic_body:
        return False

    has_tool_results = any(
        isinstance(m.get("content"), list)
        and any(
            isinstance(b, dict) and b.get("type") == "tool_result"
            for b in m.get("content", [])
        )
        for m in anthropic_body.get("messages", [])
    )

    return has_tool_results or _last_assistant_was_text_only(anthropic_body)


def _resolve_max_tokens_request(requested_max_tokens: int) -> int:
    requested = max(1, int(requested_max_tokens))
    floor = max(0, PROXY_MAX_TOKENS_FLOOR)
    if floor == 0:
        return requested
    return max(requested, floor)


def _resolve_prune_target_fraction() -> float:
    if 0.0 < PROXY_CONTEXT_PRUNE_TARGET_FRACTION < 1.0:
        return PROXY_CONTEXT_PRUNE_TARGET_FRACTION
    logger.warning(
        "Invalid PROXY_CONTEXT_PRUNE_TARGET_FRACTION=%s; using default 0.65",
        PROXY_CONTEXT_PRUNE_TARGET_FRACTION,
    )
    return 0.65


def _sanitize_reasoning_fallback_text(reasoning_text: str) -> str:
    cleaned = re.sub(r"</?think>", "", reasoning_text, flags=re.IGNORECASE)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    if not cleaned:
        return ""
    if len(cleaned) > PROXY_STREAM_REASONING_MAX_CHARS:
        return cleaned[:PROXY_STREAM_REASONING_MAX_CHARS].rstrip() + "..."
    return cleaned


def _build_reasoning_fallback_text(
    reasoning_chunks: list[str], mode: str | None = None
) -> str | None:
    fallback_mode = (mode or PROXY_STREAM_REASONING_FALLBACK).strip().lower()
    if fallback_mode == "off":
        return None

    raw_text = "".join(reasoning_chunks).strip()
    if not raw_text:
        return None

    if fallback_mode == "visible":
        return raw_text
    if fallback_mode == "sanitized":
        sanitized = _sanitize_reasoning_fallback_text(raw_text)
        return sanitized or None

    logger.warning(
        "Unknown PROXY_STREAM_REASONING_FALLBACK=%r; disabling reasoning fallback",
        fallback_mode,
    )
    return None


def _last_assistant_was_text_only(anthropic_body: dict) -> bool:
    """Check if the last assistant message in the conversation was text-only
    (no tool_use blocks). This indicates the model may be prematurely ending
    the agentic loop by explaining instead of acting."""
    messages = anthropic_body.get("messages", [])
    # Walk backwards to find the last assistant message
    for msg in reversed(messages):
        if msg.get("role") != "assistant":
            continue
        content = msg.get("content")
        if isinstance(content, str):
            # Pure text assistant message -- text-only
            return bool(content.strip())
        if isinstance(content, list):
            has_tool_use = any(
                isinstance(b, dict) and b.get("type") == "tool_use" for b in content
            )
            has_text = any(
                (
                    isinstance(b, dict)
                    and b.get("type") == "text"
                    and b.get("text", "").strip()
                )
                or isinstance(b, str)
                for b in content
            )
            # Text-only if there's text but no tool_use
            return has_text and not has_tool_use
        return False
    return False


def _extract_openai_choice(openai_resp: dict) -> tuple[dict, dict]:
    choice = (openai_resp.get("choices") or [{}])[0]
    message = choice.get("message") or {}
    return choice, message


def _openai_message_text(openai_resp: dict) -> str:
    _, message = _extract_openai_choice(openai_resp)
    content = message.get("content", "")
    return content if isinstance(content, str) else str(content)


def _openai_has_tool_calls(openai_resp: dict) -> bool:
    _, message = _extract_openai_choice(openai_resp)
    tool_calls = message.get("tool_calls") or []
    return bool(tool_calls)


def _looks_malformed_tool_payload(text: str) -> bool:
    if not text:
        return False

    lowered = text.lower()
    primary_markers = ("</parameter", "<parameter", "<tool_call", "<function=")
    if any(marker in lowered for marker in primary_markers):
        return True

    structural_markers = (
        '=\n{"description"',
        "</think>",
    )
    marker_hits = sum(1 for marker in structural_markers if marker in lowered)
    repeated_description = lowered.count('{"description"') >= 2
    repeated_must_call = lowered.count("you must call a tool") >= 2
    has_unicode_marker = "⎿" in text
    policy_echo_loop = repeated_must_call and (
        "do not summarize the issue and stop" in lowered
        or "must call a tool to make the fix" in lowered
    )
    policy_snippets = (
        "do not summarize the issue and stop",
        "if you have identified a problem",
        "you must call a tool to make the fix",
        "</agentic-protocol>",
    )
    policy_hits = sum(1 for snippet in policy_snippets if snippet in lowered)

    if marker_hits >= 2:
        return True
    if marker_hits >= 1 and (
        repeated_description or repeated_must_call or has_unicode_marker
    ):
        return True
    if policy_echo_loop:
        return True
    if policy_hits >= 2:
        return True
    if lowered.count("</parameter") >= 1 and lowered.count('{"description"') >= 1:
        return True
    return False


def _is_malformed_tool_response(openai_resp: dict, anthropic_body: dict) -> bool:
    if "tools" not in anthropic_body:
        return False
    if _openai_has_tool_calls(openai_resp):
        return False
    return _looks_malformed_tool_payload(_openai_message_text(openai_resp))


def _build_malformed_retry_body(openai_body: dict, anthropic_body: dict) -> dict:
    retry_body = dict(openai_body)
    retry_body["stream"] = False
    retry_body["tool_choice"] = "required"
    retry_body["temperature"] = PROXY_MALFORMED_TOOL_RETRY_TEMPERATURE

    if PROXY_MALFORMED_TOOL_RETRY_MAX_TOKENS > 0:
        current_max = int(
            retry_body.get("max_tokens", PROXY_MALFORMED_TOOL_RETRY_MAX_TOKENS)
        )
        retry_body["max_tokens"] = min(
            current_max, PROXY_MALFORMED_TOOL_RETRY_MAX_TOKENS
        )

    # On malformed retry, restore full tool list to avoid starving selection.
    if anthropic_body.get("tools"):
        retry_body["tools"] = _convert_anthropic_tools_to_openai(
            anthropic_body.get("tools", [])
        )

    if PROXY_DISABLE_THINKING_ON_TOOL_TURNS:
        retry_body["enable_thinking"] = False

    return retry_body


def _build_clean_guardrail_openai_response(openai_resp: dict) -> dict:
    return {
        "id": openai_resp.get("id", f"chatcmpl_{uuid.uuid4().hex[:12]}"),
        "object": openai_resp.get("object", "chat.completion"),
        "created": openai_resp.get("created", int(time.time())),
        "model": openai_resp.get("model", "unknown"),
        "choices": [
            {
                "index": 0,
                "finish_reason": "stop",
                "message": {
                    "role": "assistant",
                    "content": (
                        "I could not produce a valid tool-call format in this turn. "
                        "Please continue; I will issue exactly one valid tool call next."
                    ),
                },
            }
        ],
        "usage": openai_resp.get("usage", {}),
    }


async def _apply_unexpected_end_turn_guardrail(
    client: httpx.AsyncClient,
    openai_resp: dict,
    openai_body: dict,
    anthropic_body: dict,
    monitor: SessionMonitor,
    session_id: str,
) -> dict:
    if not PROXY_GUARDRAIL_RETRY:
        return openai_resp

    if not _is_unexpected_end_turn(openai_resp, anthropic_body):
        return openai_resp

    monitor.unexpected_end_turn_count += 1
    logger.warning(
        "GUARDRAIL: unexpected end_turn without tool_use in active loop (session=%s), retrying once with tool_choice=required",
        session_id,
    )

    retry_body = dict(openai_body)
    retry_body["tool_choice"] = "required"
    retry_body["stream"] = False

    retry_resp = await client.post(
        f"{LLAMA_CPP_BASE}/chat/completions",
        json=retry_body,
        headers={"Content-Type": "application/json"},
    )
    if retry_resp.status_code == 200:
        retry_json = retry_resp.json()
        retry_choice, retry_message = _extract_openai_choice(retry_json)
        if retry_message.get("tool_calls"):
            logger.info("GUARDRAIL: retry produced tool_use; using retried response")
            return retry_json
        logger.info(
            "GUARDRAIL: retry returned finish_reason=%s without tool_use",
            retry_choice.get("finish_reason"),
        )
    else:
        logger.warning(
            "GUARDRAIL retry upstream status=%d; keeping original response",
            retry_resp.status_code,
        )

    return openai_resp


async def _apply_malformed_tool_guardrail(
    client: httpx.AsyncClient,
    openai_resp: dict,
    openai_body: dict,
    anthropic_body: dict,
    monitor: SessionMonitor,
    session_id: str,
) -> dict:
    if not PROXY_MALFORMED_TOOL_GUARDRAIL:
        return openai_resp

    if not _is_malformed_tool_response(openai_resp, anthropic_body):
        if _openai_has_tool_calls(openai_resp):
            monitor.malformed_tool_streak = 0
        return openai_resp

    monitor.malformed_tool_streak += 1
    excerpt = _openai_message_text(openai_resp)[:220].replace("\n", " ")
    logger.warning(
        "MALFORMED TOOL PAYLOAD: session=%s streak=%d excerpt=%.220s",
        session_id,
        monitor.malformed_tool_streak,
        excerpt,
    )

    attempts = max(0, PROXY_MALFORMED_TOOL_RETRY_MAX)
    for attempt in range(attempts):
        retry_body = _build_malformed_retry_body(openai_body, anthropic_body)
        retry_resp = await client.post(
            f"{LLAMA_CPP_BASE}/chat/completions",
            json=retry_body,
            headers={"Content-Type": "application/json"},
        )
        if retry_resp.status_code != 200:
            logger.warning(
                "MALFORMED RETRY failed (attempt %d/%d): HTTP %d",
                attempt + 1,
                attempts,
                retry_resp.status_code,
            )
            continue

        retry_json = retry_resp.json()
        if _openai_has_tool_calls(retry_json):
            monitor.malformed_tool_streak = 0
            logger.info(
                "MALFORMED RETRY success: produced tool_use (attempt %d/%d)",
                attempt + 1,
                attempts,
            )
            return retry_json

        if not _is_malformed_tool_response(retry_json, anthropic_body):
            monitor.malformed_tool_streak = 0
            logger.info(
                "MALFORMED RETRY produced clean text response (attempt %d/%d)",
                attempt + 1,
                attempts,
            )
            return retry_json

        monitor.malformed_tool_streak += 1

    logger.error(
        "MALFORMED TOOL PAYLOAD persisted after retries (session=%s); returning clean guardrail response",
        session_id,
    )
    return _build_clean_guardrail_openai_response(openai_resp)


def _maybe_apply_session_contamination_breaker(
    anthropic_body: dict, monitor: SessionMonitor, session_id: str
) -> dict:
    if not PROXY_SESSION_CONTAMINATION_BREAKER:
        return anthropic_body

    threshold = max(1, PROXY_SESSION_CONTAMINATION_THRESHOLD)
    if monitor.malformed_tool_streak < threshold:
        return anthropic_body

    messages = anthropic_body.get("messages", [])
    keep_last = max(2, PROXY_SESSION_CONTAMINATION_KEEP_LAST)
    if len(messages) <= keep_last + 1:
        monitor.malformed_tool_streak = 0
        return anthropic_body

    head = messages[:1]
    tail = messages[-keep_last:]
    reset_marker = {
        "role": "user",
        "content": (
            "[SESSION RESET: previous turns contained malformed tool-call formatting "
            "artifacts. Continue from the recent context below and emit valid tool calls only.]"
        ),
    }

    updated_body = dict(anthropic_body)
    updated_body["messages"] = head + [reset_marker] + tail

    monitor.contamination_resets += 1
    monitor.malformed_tool_streak = 0
    monitor.no_progress_streak = 0
    monitor.consecutive_forced_count = 0
    logger.warning(
        "SESSION CONTAMINATION BREAKER: session=%s reset applied, kept=%d messages",
        session_id,
        len(updated_body["messages"]),
    )

    return updated_body


# ===========================================================================
# Response Translation: OpenAI -> Anthropic
# ===========================================================================


def openai_to_anthropic_response(openai_resp: dict, model: str) -> dict:
    """Convert an OpenAI Chat Completions response to Anthropic Messages format."""
    choice = openai_resp.get("choices", [{}])[0]
    message = choice.get("message", {})
    finish = choice.get("finish_reason", "stop")

    content = []
    if message.get("content"):
        content.append({"type": "text", "text": message["content"]})

    # Convert tool calls
    for tc in message.get("tool_calls", []):
        fn = tc.get("function", {})
        try:
            args = json.loads(fn.get("arguments", "{}"))
        except json.JSONDecodeError:
            args = {}
        content.append(
            {
                "type": "tool_use",
                "id": tc.get("id", f"toolu_{uuid.uuid4().hex[:12]}"),
                "name": fn.get("name", ""),
                "input": args,
            }
        )

    stop_reason_map = {
        "stop": "end_turn",
        "length": "max_tokens",
        "tool_calls": "tool_use",
        "function_call": "tool_use",
    }

    usage = openai_resp.get("usage", {})

    return {
        "id": f"msg_{uuid.uuid4().hex[:24]}",
        "type": "message",
        "role": "assistant",
        "content": content if content else [{"type": "text", "text": ""}],
        "model": model,
        "stop_reason": stop_reason_map.get(finish, "end_turn"),
        "stop_sequence": None,
        "usage": {
            "input_tokens": usage.get("prompt_tokens", 0),
            "output_tokens": usage.get("completion_tokens", 0),
        },
    }


async def stream_anthropic_message(anthropic_resp: dict):
    """Stream a finalized Anthropic message as SSE events."""
    message = {
        "id": anthropic_resp.get("id", f"msg_{uuid.uuid4().hex[:24]}"),
        "type": "message",
        "role": "assistant",
        "content": [],
        "model": anthropic_resp.get("model", "unknown"),
        "stop_reason": None,
        "stop_sequence": None,
        "usage": {"input_tokens": 0, "output_tokens": 0},
    }
    yield f"event: message_start\ndata: {json.dumps({'type': 'message_start', 'message': message})}\n\n"

    content_blocks = anthropic_resp.get("content", []) or [{"type": "text", "text": ""}]
    block_index = 0
    for block in content_blocks:
        btype = block.get("type", "text")
        if btype == "tool_use":
            tool_id = block.get("id", f"toolu_{uuid.uuid4().hex[:12]}")
            tool_name = block.get("name", "")
            tool_input = json.dumps(block.get("input", {}), separators=(",", ":"))
            yield (
                "event: content_block_start\n"
                f"data: {json.dumps({'type': 'content_block_start', 'index': block_index, 'content_block': {'type': 'tool_use', 'id': tool_id, 'name': tool_name}})}\n\n"
            )
            if tool_input:
                yield (
                    "event: content_block_delta\n"
                    f"data: {json.dumps({'type': 'content_block_delta', 'index': block_index, 'delta': {'type': 'input_json_delta', 'partial_json': tool_input}})}\n\n"
                )
            yield (
                "event: content_block_stop\n"
                f"data: {json.dumps({'type': 'content_block_stop', 'index': block_index})}\n\n"
            )
        else:
            text = block.get("text", "")
            yield (
                "event: content_block_start\n"
                f"data: {json.dumps({'type': 'content_block_start', 'index': block_index, 'content_block': {'type': 'text', 'text': ''}})}\n\n"
            )
            if text:
                yield (
                    "event: content_block_delta\n"
                    f"data: {json.dumps({'type': 'content_block_delta', 'index': block_index, 'delta': {'type': 'text_delta', 'text': text}})}\n\n"
                )
            yield (
                "event: content_block_stop\n"
                f"data: {json.dumps({'type': 'content_block_stop', 'index': block_index})}\n\n"
            )
        block_index += 1

    output_tokens = anthropic_resp.get("usage", {}).get("output_tokens", 0)
    stop_reason = anthropic_resp.get("stop_reason", "end_turn")
    yield (
        "event: message_delta\n"
        f"data: {json.dumps({'type': 'message_delta', 'delta': {'stop_reason': stop_reason, 'stop_sequence': None}, 'usage': {'output_tokens': output_tokens}})}\n\n"
    )
    yield f"event: message_stop\ndata: {json.dumps({'type': 'message_stop'})}\n\n"


# ===========================================================================
# Streaming Translation: OpenAI SSE -> Anthropic SSE
# ===========================================================================


async def stream_anthropic_response(
    openai_stream: httpx.Response,
    model: str,
    monitor: SessionMonitor,
    anthropic_body: dict,
):
    """Convert an OpenAI streaming response to Anthropic SSE stream format.

    Handles:
    - Text content deltas -> content_block_delta (text_delta)
    - Tool call deltas -> content_block_start (tool_use) + input_json_delta
    - Graceful error recovery on upstream connection drops
    - Proper upstream response closure on client disconnect
    """
    msg_id = f"msg_{uuid.uuid4().hex[:24]}"

    # message_start
    yield (
        f"event: message_start\n"
        f"data: {json.dumps({'type': 'message_start', 'message': {'id': msg_id, 'type': 'message', 'role': 'assistant', 'content': [], 'model': model, 'stop_reason': None, 'stop_sequence': None, 'usage': {'input_tokens': 0, 'output_tokens': 0}}})}\n\n"
    )

    # content_block_start for text (index 0)
    yield (
        f"event: content_block_start\n"
        f"data: {json.dumps({'type': 'content_block_start', 'index': 0, 'content_block': {'type': 'text', 'text': ''}})}\n\n"
    )

    yield 'event: ping\ndata: {"type": "ping"}\n\n'

    output_tokens = 0
    finish_reason = "end_turn"

    # Track tool call state for streaming tool_calls
    tool_calls_by_index: dict[int, dict] = {}
    tool_block_index = 1  # anthropic block index (0 = text)
    text_chunks: list[str] = []  # accumulate text for logging
    reasoning_chunks: list[str] = []  # accumulate reasoning for fallback

    try:
        async for line in openai_stream.aiter_lines():
            if not line.startswith("data: "):
                continue
            data = line[6:].strip()
            if data == "[DONE]":
                break
            try:
                chunk = json.loads(data)
            except json.JSONDecodeError:
                continue

            choice = (chunk.get("choices") or [{}])[0]
            delta = choice.get("delta", {})

            # Collect reasoning_content (normally stripped; used as fallback
            # if the model produces only reasoning with no visible output)
            reasoning = delta.get("reasoning_content", "")
            if reasoning:
                reasoning_chunks.append(reasoning)

            # Handle text content deltas
            if delta.get("content"):
                output_tokens += 1  # rough token estimate
                text_chunks.append(delta["content"])
                yield (
                    f"event: content_block_delta\n"
                    f"data: {json.dumps({'type': 'content_block_delta', 'index': 0, 'delta': {'type': 'text_delta', 'text': delta['content']}})}\n\n"
                )

            # Handle tool_calls deltas
            if delta.get("tool_calls"):
                for tc_delta in delta["tool_calls"]:
                    tc_idx = tc_delta.get("index", 0)

                    if tc_idx not in tool_calls_by_index:
                        # New tool call starting
                        tc_id = tc_delta.get("id", f"toolu_{uuid.uuid4().hex[:12]}")
                        fn = tc_delta.get("function", {})
                        initial_args = fn.get("arguments", "")
                        tool_calls_by_index[tc_idx] = {
                            "id": tc_id,
                            "name": fn.get("name", ""),
                            "arguments": initial_args,
                            "block_index": tool_block_index,
                        }

                        # Close text block before first tool block
                        if tool_block_index == 1:
                            yield (
                                f"event: content_block_stop\n"
                                f"data: {json.dumps({'type': 'content_block_stop', 'index': 0})}\n\n"
                            )

                        # Emit content_block_start for this tool_use
                        yield (
                            f"event: content_block_start\n"
                            f"data: {json.dumps({'type': 'content_block_start', 'index': tool_block_index, 'content_block': {'type': 'tool_use', 'id': tc_id, 'name': fn.get('name', '')}})}\n\n"
                        )

                        # Emit initial arguments fragment (e.g. "{") that
                        # arrives with the first tool_call chunk.  Without
                        # this the opening brace is swallowed and the client
                        # receives invalid JSON like  "command":"ls"} instead
                        # of {"command":"ls"}.
                        if initial_args:
                            yield (
                                f"event: content_block_delta\n"
                                f"data: {json.dumps({'type': 'content_block_delta', 'index': tool_block_index, 'delta': {'type': 'input_json_delta', 'partial_json': initial_args}})}\n\n"
                            )

                        tool_block_index += 1
                    else:
                        # Continuation: argument chunks
                        fn = tc_delta.get("function", {})
                        arg_chunk = fn.get("arguments", "")
                        if arg_chunk:
                            tool_calls_by_index[tc_idx]["arguments"] += arg_chunk
                            bidx = tool_calls_by_index[tc_idx]["block_index"]
                            yield (
                                f"event: content_block_delta\n"
                                f"data: {json.dumps({'type': 'content_block_delta', 'index': bidx, 'delta': {'type': 'input_json_delta', 'partial_json': arg_chunk}})}\n\n"
                            )

            if choice.get("finish_reason"):
                fr = choice["finish_reason"]
                if fr == "length":
                    logger.warning(
                        "Response truncated by token limit (finish_reason=length). "
                        "Consider increasing --n-predict or max_tokens."
                    )
                finish_reason = {
                    "stop": "end_turn",
                    "length": "max_tokens",
                    "tool_calls": "tool_use",
                }.get(fr, "end_turn")

    except (httpx.ReadError, httpx.RemoteProtocolError, httpx.StreamClosed) as exc:
        logger.warning("Upstream stream error: %s: %s", type(exc).__name__, exc)
        finish_reason = "end_turn"
    except asyncio.CancelledError:
        logger.info("Client disconnected, closing upstream stream")
        raise
    except Exception as exc:
        logger.error("Unexpected stream error: %s: %s", type(exc).__name__, exc)
        finish_reason = "end_turn"
    finally:
        # Always close the upstream response to stop LLM generation
        await openai_stream.aclose()

    # Close any open tool call blocks
    if tool_calls_by_index:
        for tc in tool_calls_by_index.values():
            yield (
                f"event: content_block_stop\n"
                f"data: {json.dumps({'type': 'content_block_stop', 'index': tc['block_index']})}\n\n"
            )
    else:
        # If the response has no text and no tool calls, optionally emit a
        # reasoning fallback (configurable) to avoid leaking malformed
        # internal chain-of-thought content by default.
        accumulated_text = "".join(text_chunks)
        if not accumulated_text and reasoning_chunks:
            fallback_text = _build_reasoning_fallback_text(reasoning_chunks)
            if fallback_text:
                logger.warning(
                    "Empty response with %d reasoning chunks – emitting fallback text (mode=%s)",
                    len(reasoning_chunks),
                    PROXY_STREAM_REASONING_FALLBACK,
                )
                text_chunks.append(fallback_text)
                yield (
                    f"event: content_block_delta\n"
                    f"data: {json.dumps({'type': 'content_block_delta', 'index': 0, 'delta': {'type': 'text_delta', 'text': fallback_text}})}\n\n"
                )
            else:
                logger.warning(
                    "Empty response with %d reasoning chunks – fallback suppressed (mode=%s)",
                    len(reasoning_chunks),
                    PROXY_STREAM_REASONING_FALLBACK,
                )

        yield (
            f"event: content_block_stop\n"
            f"data: {json.dumps({'type': 'content_block_stop', 'index': 0})}\n\n"
        )

    # Log response summary
    accumulated_text = "".join(text_chunks)
    tc_names = (
        [tc["name"] for tc in tool_calls_by_index.values()]
        if tool_calls_by_index
        else []
    )
    tc_args = (
        [tc.get("arguments", "") for tc in tool_calls_by_index.values()]
        if tool_calls_by_index
        else []
    )
    logger.info(
        "RESP: finish=%s output_tokens=%d text_len=%d text=%.300s tool_calls=%s args=%s",
        finish_reason,
        output_tokens,
        len(accumulated_text),
        accumulated_text[:300],
        tc_names,
        [a[:200] for a in tc_args],
    )

    synthetic_openai_resp = {
        "choices": [
            {
                "finish_reason": "stop"
                if finish_reason == "end_turn"
                else finish_reason,
                "message": {
                    "content": accumulated_text,
                    "tool_calls": [
                        {
                            "function": {
                                "name": tc["name"],
                                "arguments": tc.get("arguments", ""),
                            }
                        }
                        for tc in tool_calls_by_index.values()
                    ],
                },
            }
        ]
    }

    if _is_malformed_tool_response(synthetic_openai_resp, anthropic_body):
        monitor.malformed_tool_streak += 1
    elif (
        "tools" in anthropic_body
        and not tool_calls_by_index
        and (
            finish_reason == "max_tokens"
            or (finish_reason == "end_turn" and len(accumulated_text) > 512)
        )
    ):
        monitor.malformed_tool_streak += 1
    elif tool_calls_by_index:
        monitor.malformed_tool_streak = 0

    if _is_unexpected_end_turn(synthetic_openai_resp, anthropic_body):
        monitor.unexpected_end_turn_count += 1

    # message_delta with final stop reason
    yield (
        f"event: message_delta\n"
        f"data: {json.dumps({'type': 'message_delta', 'delta': {'stop_reason': finish_reason, 'stop_sequence': None}, 'usage': {'output_tokens': output_tokens}})}\n\n"
    )

    # message_stop
    yield f"event: message_stop\ndata: {json.dumps({'type': 'message_stop'})}\n\n"


# ===========================================================================
# API Endpoints
# ===========================================================================


@app.post("/v1/messages")
async def messages(request: Request):
    """Handle Anthropic Messages API requests (streaming and non-streaming).

    Integrates context management:
    - Option B: HTTP error handling for upstream 4xx/5xx responses
    - Option C: Conversation pruning when approaching context limits
    - Option E: Smart max_tokens capping (in build_openai_request)
    - Option F: Session-level token monitoring with warnings
    """
    global last_session_id

    body = await request.json()
    model = body.get("model", "default")
    is_stream = body.get("stream", False)
    session_id = resolve_session_id(request, body)
    monitor = get_session_monitor(session_id)
    last_session_id = session_id

    body = _maybe_apply_session_contamination_breaker(body, monitor, session_id)

    # Debug: log request summary
    n_messages = len(body.get("messages", []))
    n_tools = len(body.get("tools", []))
    max_tokens = body.get("max_tokens", "unset")
    last_msg = body.get("messages", [{}])[-1]
    last_role = last_msg.get("role", "?")
    last_content = last_msg.get("content", "")
    if isinstance(last_content, list):
        last_text = next(
            (b.get("text", "") for b in last_content if b.get("type") == "text"), ""
        )[:200]
    elif isinstance(last_content, str):
        last_text = last_content[:200]
    else:
        last_text = str(last_content)[:200]
    logger.info(
        "REQ: stream=%s msgs=%d tools=%d max_tokens=%s last_role=%s last_content=%.200s",
        is_stream,
        n_messages,
        n_tools,
        max_tokens,
        last_role,
        last_text,
    )

    # --- Option F: Estimate tokens and record in session monitor ---
    estimated_tokens = estimate_total_tokens(body)
    monitor.record_request(estimated_tokens)
    monitor.log_status()

    # --- Option C: Prune conversation if approaching context limit ---
    ctx_window = monitor.context_window
    if ctx_window > 0:
        utilization = estimated_tokens / ctx_window
        if utilization >= PROXY_CONTEXT_PRUNE_THRESHOLD:
            logger.warning(
                "Context utilization %.1f%% exceeds threshold %.1f%% -- pruning conversation",
                utilization * 100,
                PROXY_CONTEXT_PRUNE_THRESHOLD * 100,
            )
            body = prune_conversation(
                body, ctx_window, target_fraction=_resolve_prune_target_fraction()
            )
            monitor.prune_count += 1
            # Re-estimate after pruning
            estimated_tokens = estimate_total_tokens(body)
            monitor.record_request(estimated_tokens)
            n_messages = len(body.get("messages", []))
            logger.info(
                "After pruning: ~%d tokens, %d messages",
                estimated_tokens,
                n_messages,
            )

    openai_body = build_openai_request(body, monitor)

    client = http_client
    if client is None:
        return Response(
            content=json.dumps({"error": "Proxy not initialized"}),
            status_code=503,
            media_type="application/json",
        )

    if is_stream and PROXY_MALFORMED_TOOL_STREAM_STRICT and "tools" in body:
        strict_body = dict(openai_body)
        strict_body["stream"] = False

        strict_resp = await client.post(
            f"{LLAMA_CPP_BASE}/chat/completions",
            json=strict_body,
            headers={"Content-Type": "application/json"},
        )

        if strict_resp.status_code != 200:
            error_text = strict_resp.text[:1000]
            logger.error(
                "Upstream HTTP %d (strict-stream): %s",
                strict_resp.status_code,
                error_text,
            )
            return Response(
                content=json.dumps(
                    {
                        "type": "error",
                        "error": {
                            "type": "overloaded_error",
                            "message": f"Upstream error (HTTP {strict_resp.status_code}): {error_text[:500]}",
                        },
                    }
                ),
                status_code=529,
                media_type="application/json",
            )

        openai_resp = strict_resp.json()
        openai_resp = await _apply_unexpected_end_turn_guardrail(
            client,
            openai_resp,
            strict_body,
            body,
            monitor,
            session_id,
        )
        openai_resp = await _apply_malformed_tool_guardrail(
            client,
            openai_resp,
            strict_body,
            body,
            monitor,
            session_id,
        )

        anthropic_resp = openai_to_anthropic_response(openai_resp, model)
        monitor.record_response(anthropic_resp.get("usage", {}).get("output_tokens", 0))
        logger.info(
            "STRICT STREAM GUARDRAIL: served stream response via guarded non-stream path"
        )

        return StreamingResponse(
            stream_anthropic_message(anthropic_resp),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
            },
        )

    if is_stream:
        openai_body["stream"] = True

        # Retry upstream connection with backoff to handle
        # llama-server restarts gracefully instead of 500-ing to the client.
        MAX_UPSTREAM_RETRIES = 3
        RETRY_DELAY_SECS = 5.0
        last_exc: Exception | None = None
        resp: httpx.Response | None = None

        for attempt in range(MAX_UPSTREAM_RETRIES):
            try:
                resp = await client.send(
                    client.build_request(
                        "POST",
                        f"{LLAMA_CPP_BASE}/chat/completions",
                        json=openai_body,
                        headers={"Content-Type": "application/json"},
                    ),
                    stream=True,
                )
                # Connection succeeded – break out of retry loop
                last_exc = None
                break
            except (httpx.ConnectError, httpx.RemoteProtocolError) as exc:
                last_exc = exc
                if attempt < MAX_UPSTREAM_RETRIES - 1:
                    logger.warning(
                        "Upstream connect failed (attempt %d/%d): %s – retrying in %.0fs",
                        attempt + 1,
                        MAX_UPSTREAM_RETRIES,
                        type(exc).__name__,
                        RETRY_DELAY_SECS,
                    )
                    await asyncio.sleep(RETRY_DELAY_SECS)
                else:
                    logger.error(
                        "Upstream connect failed after %d attempts: %s: %s",
                        MAX_UPSTREAM_RETRIES,
                        type(exc).__name__,
                        exc,
                    )

        if last_exc is not None:
            return Response(
                content=json.dumps(
                    {
                        "type": "error",
                        "error": {
                            "type": "overloaded_error",
                            "message": f"Upstream server unavailable after {MAX_UPSTREAM_RETRIES} retries: {last_exc}",
                        },
                    }
                ),
                status_code=529,
                media_type="application/json",
            )

        if resp is None:
            return Response(
                content=json.dumps(
                    {
                        "type": "error",
                        "error": {
                            "type": "overloaded_error",
                            "message": "Upstream response unavailable",
                        },
                    }
                ),
                status_code=529,
                media_type="application/json",
            )

        # --- Option B: Check HTTP status before streaming ---
        # llama-server returns 400 for context overflow, 500 for internal errors, etc.
        # Without this check, the proxy would try to stream-translate an error body,
        # producing an empty response that silently kills the agentic loop.
        if resp.status_code != 200:
            error_body = await resp.aread()
            await resp.aclose()
            error_text = error_body.decode("utf-8", errors="replace")[:1000]
            logger.error("Upstream HTTP %d: %s", resp.status_code, error_text)

            # Parse the error for a user-friendly message
            error_message = f"Upstream server error (HTTP {resp.status_code})"
            try:
                error_json = json.loads(error_body)
                if "error" in error_json:
                    upstream_error = error_json["error"]
                    if isinstance(upstream_error, dict):
                        error_message = upstream_error.get("message", error_message)
                    else:
                        error_message = str(upstream_error)
            except (json.JSONDecodeError, KeyError):
                error_message = error_text[:500] if error_text else error_message

            # Detect context overflow specifically
            is_context_overflow = (
                resp.status_code == 400
                and "exceeds" in error_message.lower()
                and "context" in error_message.lower()
            )

            if is_context_overflow:
                monitor.overflow_count += 1
                logger.error(
                    "CONTEXT OVERFLOW detected (count=%d). "
                    "Estimated input: %d tokens, context window: %d tokens. "
                    "Conversation needs pruning or context window increase.",
                    monitor.overflow_count,
                    estimated_tokens,
                    ctx_window,
                )
                # Return Anthropic-format error that Claude Code can handle
                return Response(
                    content=json.dumps(
                        {
                            "type": "error",
                            "error": {
                                "type": "overloaded_error",
                                "message": (
                                    f"Context window exceeded: request requires ~{estimated_tokens} tokens "
                                    f"but only {ctx_window} are available. "
                                    f"The conversation is too long. Please start a new session or "
                                    f"reduce conversation length."
                                ),
                            },
                        }
                    ),
                    status_code=529,
                    media_type="application/json",
                )

            # Generic upstream error -- return as Anthropic error format
            error_type = (
                "overloaded_error"
                if resp.status_code >= 500
                else "invalid_request_error"
            )
            return Response(
                content=json.dumps(
                    {
                        "type": "error",
                        "error": {
                            "type": error_type,
                            "message": error_message,
                        },
                    }
                ),
                status_code=529 if resp.status_code >= 500 else 400,
                media_type="application/json",
            )

        return StreamingResponse(
            stream_anthropic_response(resp, model, monitor, body),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
            },
        )
    else:
        resp = await client.post(
            f"{LLAMA_CPP_BASE}/chat/completions",
            json=openai_body,
            headers={"Content-Type": "application/json"},
        )

        # Option B: Handle non-streaming errors too
        if resp.status_code != 200:
            error_text = resp.text[:1000]
            logger.error(
                "Upstream HTTP %d (non-stream): %s", resp.status_code, error_text
            )
            return Response(
                content=json.dumps(
                    {
                        "type": "error",
                        "error": {
                            "type": "overloaded_error",
                            "message": f"Upstream error (HTTP {resp.status_code}): {error_text[:500]}",
                        },
                    }
                ),
                status_code=529,
                media_type="application/json",
            )

        openai_resp = resp.json()
        openai_resp = await _apply_unexpected_end_turn_guardrail(
            client,
            openai_resp,
            openai_body,
            body,
            monitor,
            session_id,
        )
        openai_resp = await _apply_malformed_tool_guardrail(
            client,
            openai_resp,
            openai_body,
            body,
            monitor,
            session_id,
        )

        choice, _ = _extract_openai_choice(openai_resp)
        finish_reason = choice.get("finish_reason", "")
        if (
            "tools" in body
            and not _openai_has_tool_calls(openai_resp)
            and (
                finish_reason in {"length", "max_tokens"}
                or (
                    finish_reason in {"stop", "end_turn"}
                    and len(_openai_message_text(openai_resp)) > 512
                )
            )
        ):
            monitor.malformed_tool_streak += 1
        elif _openai_has_tool_calls(openai_resp):
            monitor.malformed_tool_streak = 0

        anthropic_resp = openai_to_anthropic_response(openai_resp, model)

        # Track output tokens in session monitor
        output_tokens = anthropic_resp.get("usage", {}).get("output_tokens", 0)
        monitor.record_response(output_tokens)

        return anthropic_resp


@app.post("/anthropic/v1/messages")
async def messages_anthropic(request: Request):
    """Alternative endpoint path used by some Claude Code configurations."""
    return await messages(request)


@app.get("/v1/models")
async def models():
    """Return available model list (spoofs Anthropic model IDs for client compatibility)."""
    return {
        "data": [
            {"id": "claude-sonnet-4-20250514", "object": "model"},
            {"id": "claude-3-5-sonnet-20241022", "object": "model"},
        ]
    }


@app.get("/health")
async def health():
    """Health check endpoint for monitoring and load balancers."""
    upstream_ok = False
    try:
        if http_client:
            resp = await http_client.get(
                LLAMA_CPP_BASE.replace("/v1", "/health"),
                timeout=5.0,
            )
            upstream_ok = resp.status_code == 200
    except Exception:
        pass

    return {
        "status": "ok" if upstream_ok else "degraded",
        "proxy": "ok",
        "upstream": "ok" if upstream_ok else "unreachable",
        "upstream_url": LLAMA_CPP_BASE,
    }


@app.get("/v1/context")
async def context_status(request: Request):
    """Option F: Context window monitoring endpoint.

    Returns current session token usage, utilization, warnings, and
    estimated remaining turns. Useful for dashboards and debugging.
    """
    requested_session = request.query_params.get("session_id", "")
    session_id = requested_session or last_session_id
    monitor = session_monitors.get(session_id) if session_id else None

    if monitor is None:
        monitor = SessionMonitor(context_window=default_context_window)

    warning = monitor.get_warning_level()
    turns = monitor.estimate_turns_remaining()

    return {
        "active_session_id": session_id,
        "session_count": len(session_monitors),
        "context_window": monitor.context_window,
        "last_input_tokens": monitor.last_input_tokens,
        "last_output_tokens": monitor.last_output_tokens,
        "peak_input_tokens": monitor.peak_input_tokens,
        "utilization": round(monitor.get_utilization(), 4),
        "utilization_pct": f"{monitor.get_utilization() * 100:.1f}%",
        "warning_level": warning,
        "estimated_turns_remaining": turns,
        "total_requests": monitor.total_requests,
        "prune_count": monitor.prune_count,
        "overflow_count": monitor.overflow_count,
        "prune_threshold": PROXY_CONTEXT_PRUNE_THRESHOLD,
        "recent_history": monitor.context_history[-10:],
        # Loop protection stats
        "loop_protection": {
            "enabled": PROXY_LOOP_BREAKER,
            "consecutive_forced_count": monitor.consecutive_forced_count,
            "no_progress_streak": monitor.no_progress_streak,
            "loop_warnings_emitted": monitor.loop_warnings_emitted,
            "unexpected_end_turn_count": monitor.unexpected_end_turn_count,
            "malformed_tool_streak": monitor.malformed_tool_streak,
            "contamination_resets": monitor.contamination_resets,
            "tool_call_history_len": len(monitor.tool_call_history),
            "is_looping": monitor.detect_tool_loop(window=PROXY_LOOP_WINDOW)[0],
            "loop_repeat_count": monitor.detect_tool_loop(window=PROXY_LOOP_WINDOW)[1],
            "recent_tool_patterns": monitor.tool_call_history[-5:],
        },
    }


# ===========================================================================
# Entry Point
# ===========================================================================

if __name__ == "__main__":
    uvicorn.run(
        app,
        host=PROXY_HOST,
        port=PROXY_PORT,
        log_level=PROXY_LOG_LEVEL.lower(),
    )
