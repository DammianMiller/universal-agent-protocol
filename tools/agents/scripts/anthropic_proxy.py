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

    PROXY_TOOL_TURN_MAX_TOKENS   Max tokens for tool-call turns (0 to disable)
                                Default: 8192

    PROXY_TOOL_TURN_MAX_TOKENS_GARBLED   Max tokens after garbled/malformed output
                                         Default: 4096

    PROXY_MAX_CONNECTIONS   Max concurrent connections to upstream
                            Default: 20

    PROXY_CONTEXT_WINDOW   Override context window size (auto-detected from
                           upstream /slots endpoint if not set)
                           Default: 0 (auto-detect)

    PROXY_CONTEXT_PRUNE_THRESHOLD   Fraction of context window at which
                                    conversation pruning activates (0.0-1.0)
                                    Default: 0.85

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
import copy
import hashlib
import json
import logging
import os
import re
import sys
import time
import uuid
from collections import defaultdict, deque
from dataclasses import dataclass, field
from pathlib import Path

import httpx
from contextlib import asynccontextmanager
from fastapi import FastAPI, Request, Response
from fastapi.responses import StreamingResponse
import uvicorn

# ---------------------------------------------------------------------------
# Configuration (all configurable via environment variables)
# ---------------------------------------------------------------------------
LLAMA_CPP_BASE = os.environ.get("LLAMA_CPP_BASE", "http://192.168.1.165:8080/v1")
ANTHROPIC_API_BASE = os.environ.get(
    "ANTHROPIC_API_BASE", "https://api.anthropic.com"
)
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")
ANTHROPIC_PASSTHROUGH_MODELS = os.environ.get("ANTHROPIC_PASSTHROUGH_MODELS", "")
PROXY_PORT = int(os.environ.get("PROXY_PORT", "4000"))
PROXY_HOST = os.environ.get("PROXY_HOST", "0.0.0.0")
PROXY_LOG_LEVEL = os.environ.get("PROXY_LOG_LEVEL", "INFO").upper()
PROXY_READ_TIMEOUT = float(os.environ.get("PROXY_READ_TIMEOUT", "180"))
PROXY_GENERATION_TIMEOUT = float(os.environ.get("PROXY_GENERATION_TIMEOUT", "300"))
PROXY_SLOT_HANG_TIMEOUT = float(os.environ.get("PROXY_SLOT_HANG_TIMEOUT", "120"))
PROXY_UPSTREAM_RETRY_MAX = int(os.environ.get("PROXY_UPSTREAM_RETRY_MAX", "3"))
PROXY_UPSTREAM_RETRY_DELAY_SECS = float(os.environ.get("PROXY_UPSTREAM_RETRY_DELAY_SECS", "5"))
PROXY_MAX_CONNECTIONS = int(os.environ.get("PROXY_MAX_CONNECTIONS", "20"))
PROXY_CONTEXT_WINDOW = int(os.environ.get("PROXY_CONTEXT_WINDOW", "0"))
PROXY_CONTEXT_PRUNE_THRESHOLD = float(
    os.environ.get("PROXY_CONTEXT_PRUNE_THRESHOLD", "0.85")
)
PROXY_CONTEXT_PRUNE_TARGET_FRACTION = float(
    os.environ.get("PROXY_CONTEXT_PRUNE_TARGET_FRACTION", "0.50")
)
PROXY_LOOP_BREAKER = os.environ.get("PROXY_LOOP_BREAKER", "on").lower() not in {
    "0",
    "false",
    "off",
    "no",
}
PROXY_LOOP_WINDOW = int(os.environ.get("PROXY_LOOP_WINDOW", "6"))
PROXY_LOOP_REPEAT_THRESHOLD = int(os.environ.get("PROXY_LOOP_REPEAT_THRESHOLD", "6"))
PROXY_FORCED_THRESHOLD = int(os.environ.get("PROXY_FORCED_THRESHOLD", "15"))
PROXY_NO_PROGRESS_THRESHOLD = int(os.environ.get("PROXY_NO_PROGRESS_THRESHOLD", "3"))
PROXY_CONTEXT_RELEASE_THRESHOLD = float(
    os.environ.get("PROXY_CONTEXT_RELEASE_THRESHOLD", "0.90")
)
PROXY_TOOL_STATE_MACHINE = os.environ.get(
    "PROXY_TOOL_STATE_MACHINE", "on"
).lower() not in {
    "0",
    "false",
    "off",
    "no",
}
PROXY_TOOL_STATE_MIN_MESSAGES = int(
    os.environ.get("PROXY_TOOL_STATE_MIN_MESSAGES", "6")
)
PROXY_TOOL_STATE_FORCED_BUDGET = int(
    os.environ.get("PROXY_TOOL_STATE_FORCED_BUDGET", "12")
)
PROXY_TOOL_STATE_AUTO_BUDGET = int(os.environ.get("PROXY_TOOL_STATE_AUTO_BUDGET", "2"))
PROXY_TOOL_STATE_STAGNATION_THRESHOLD = int(
    os.environ.get("PROXY_TOOL_STATE_STAGNATION_THRESHOLD", "8")
)
PROXY_TOOL_STATE_CYCLE_WINDOW = int(
    os.environ.get("PROXY_TOOL_STATE_CYCLE_WINDOW", "3")
)
PROXY_TOOL_STATE_FINALIZE_THRESHOLD = int(
    os.environ.get("PROXY_TOOL_STATE_FINALIZE_THRESHOLD", "18")
)
PROXY_TOOL_STATE_REVIEW_CYCLE_LIMIT = int(
    os.environ.get("PROXY_TOOL_STATE_REVIEW_CYCLE_LIMIT", "3")
)
# Force finalize after N consecutive forced_budget_exhausted events where
# neither cycling nor stagnation was detected — catches "distinct but
# unproductive" tool spam that defeats per-tool cycle detection.
PROXY_UNPRODUCTIVE_EXHAUSTION_LIMIT = int(
    os.environ.get("PROXY_UNPRODUCTIVE_EXHAUSTION_LIMIT", "2")
)
PROXY_COMPLETION_RECOVERY_MAX = int(
    os.environ.get("PROXY_COMPLETION_RECOVERY_MAX", "3")
)
PROXY_CLIENT_RATE_WINDOW_SECS = int(
    os.environ.get("PROXY_CLIENT_RATE_WINDOW_SECS", "60")
)
PROXY_CLIENT_RATE_LOG_MIN_SECS = float(
    os.environ.get("PROXY_CLIENT_RATE_LOG_MIN_SECS", "15")
)
PROXY_OPUS46_CTX_THRESHOLD = float(
    os.environ.get("PROXY_OPUS46_CTX_THRESHOLD", "0.8")
)
PROXY_OPUS46_MAX_TOKENS_HIGH_CTX = int(
    os.environ.get("PROXY_OPUS46_MAX_TOKENS_HIGH_CTX", "4096")
)
PROXY_TOOL_NARROWING_EXPAND_ON_LOOP = os.environ.get(
    "PROXY_TOOL_NARROWING_EXPAND_ON_LOOP", "on"
).lower() not in {
    "0",
    "false",
    "off",
    "no",
}
# Read-only tools that should be excluded as a class when any one cycles
_READ_ONLY_TOOL_CLASS = frozenset({
    "read", "glob", "grep", "Read", "Glob", "Grep",
    "search", "Search", "list_files", "ListFiles",
})

PROXY_GUARDRAIL_RETRY = os.environ.get("PROXY_GUARDRAIL_RETRY", "on").lower() not in {
    "0",
    "false",
    "off",
    "no",
}
PROXY_SESSION_TTL_SECS = int(os.environ.get("PROXY_SESSION_TTL_SECS", "7200"))
PROXY_FINALIZE_CONTINUATION_MAX = int(
    os.environ.get("PROXY_FINALIZE_CONTINUATION_MAX", "3")
)
# Session-level cap: after N total finalize continuations in a session (even
# across "fresh user text" state resets), stop injecting synthetic tools and
# let the response terminate naturally. Catches runaway loops that dodge the
# per-cycle cap by triggering state resets.
PROXY_FINALIZE_SESSION_HARD_CAP = int(
    os.environ.get("PROXY_FINALIZE_SESSION_HARD_CAP", "3")
)
PROXY_STREAM_REASONING_FALLBACK = (
    os.environ.get("PROXY_STREAM_REASONING_FALLBACK", "off").strip().lower()
)
PROXY_STREAM_REASONING_MAX_CHARS = int(
    os.environ.get("PROXY_STREAM_REASONING_MAX_CHARS", "240")
)
PROXY_MAX_TOKENS_FLOOR = int(os.environ.get("PROXY_MAX_TOKENS_FLOOR", "16384"))
PROXY_TOOL_TURN_MAX_TOKENS = int(os.environ.get("PROXY_TOOL_TURN_MAX_TOKENS", "8192"))
PROXY_TOOL_TURN_MAX_TOKENS_GARBLED = int(
    os.environ.get("PROXY_TOOL_TURN_MAX_TOKENS_GARBLED", "4096")
)
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
# Disable thinking on EVERY turn (not just tool turns). NOTE: setting to
# 'on' for Gemma 4 produces empty content with stop_reason=length — the
# Gemma 4 chat template requires the thinking channel to be active to
# emit any answer at all. Default 'off'; safe for Qwen-family models.
PROXY_DISABLE_THINKING_ALWAYS = os.environ.get(
    "PROXY_DISABLE_THINKING_ALWAYS", "off"
).lower() not in {"0", "false", "off", "no"}
# Force tool_choice='required' on the first turn of a fresh session.
# Originally Qwen-tuned to break out of cold-start "tries to chat instead
# of calling a tool" behaviour. Gemma 4 doesn't need this — it routes
# 'auto' correctly and the force triggers malformed-JSON emissions when
# it would rather speak. Default 'off'; set 'on' to restore the legacy
# Qwen-style behaviour.
PROXY_FORCE_TOOL_CHOICE_ON_COLD_START = os.environ.get(
    "PROXY_FORCE_TOOL_CHOICE_ON_COLD_START", "off"
).lower() not in {"0", "false", "off", "no"}
PROXY_DISABLE_SPEC_ON_TOOL_TURNS = os.environ.get(
    "PROXY_DISABLE_SPEC_ON_TOOL_TURNS", "off"
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
    os.environ.get("PROXY_MALFORMED_TOOL_RETRY_MAX", "3")
)
PROXY_MALFORMED_TOOL_RETRY_MAX_TOKENS = int(
    os.environ.get("PROXY_MALFORMED_TOOL_RETRY_MAX_TOKENS", "2048")
)
PROXY_MALFORMED_TOOL_RETRY_TEMPERATURE = float(
    os.environ.get("PROXY_MALFORMED_TOOL_RETRY_TEMPERATURE", "0")
)
PROXY_TOOL_TURN_TEMPERATURE = float(
    os.environ.get("PROXY_TOOL_TURN_TEMPERATURE", "0.3")
)
PROXY_MALFORMED_TOOL_STREAM_STRICT = os.environ.get(
    "PROXY_MALFORMED_TOOL_STREAM_STRICT", "off"
).lower() not in {
    "0",
    "false",
    "off",
    "no",
}
PROXY_TOOL_ARGS_PREFLIGHT = os.environ.get(
    "PROXY_TOOL_ARGS_PREFLIGHT", "on"
).lower() not in {
    "0",
    "false",
    "off",
    "no",
}
PROXY_FORCE_NON_STREAM = os.environ.get(
    "PROXY_FORCE_NON_STREAM", "off"
).lower() not in {
    "0",
    "false",
    "off",
    "no",
}
PROXY_FORCED_TOOL_DAMPENER = os.environ.get(
    "PROXY_FORCED_TOOL_DAMPENER", "on"
).lower() not in {
    "0",
    "false",
    "off",
    "no",
}
PROXY_FORCED_TOOL_DAMPENER_MIN_FORCED = int(
    os.environ.get("PROXY_FORCED_TOOL_DAMPENER_MIN_FORCED", "4")
)
PROXY_FORCED_TOOL_DAMPENER_BAD_STREAK = int(
    os.environ.get("PROXY_FORCED_TOOL_DAMPENER_BAD_STREAK", "1")
)
PROXY_FORCED_TOOL_DAMPENER_EMPTY_STREAK = int(
    os.environ.get("PROXY_FORCED_TOOL_DAMPENER_EMPTY_STREAK", "2")
)
PROXY_FORCED_TOOL_DAMPENER_AUTO_TURNS = int(
    os.environ.get("PROXY_FORCED_TOOL_DAMPENER_AUTO_TURNS", "2")
)
PROXY_FORCED_TOOL_DAMPENER_REJECTIONS = int(
    os.environ.get("PROXY_FORCED_TOOL_DAMPENER_REJECTIONS", "2")
)
PROXY_TOOL_STARVATION_THRESHOLD = int(
    os.environ.get("PROXY_TOOL_STARVATION_THRESHOLD", "5")
)
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
PROXY_SESSION_CONTAMINATION_FORCED_THRESHOLD = int(
    os.environ.get("PROXY_SESSION_CONTAMINATION_FORCED_THRESHOLD", "8")
)
PROXY_SESSION_CONTAMINATION_REQUIRED_MISS_THRESHOLD = int(
    os.environ.get("PROXY_SESSION_CONTAMINATION_REQUIRED_MISS_THRESHOLD", "2")
)
PROXY_AGENTIC_SUPPLEMENT_MODE = (
    os.environ.get("PROXY_AGENTIC_SUPPLEMENT_MODE", "clean").strip().lower()
)
PROXY_ANALYSIS_ONLY_ROUTE = os.environ.get(
    "PROXY_ANALYSIS_ONLY_ROUTE", "off"
).lower() not in {
    "0",
    "false",
    "off",
    "no",
}
PROXY_ANALYSIS_ONLY_MIN_TOOLS = int(
    os.environ.get("PROXY_ANALYSIS_ONLY_MIN_TOOLS", "12")
)
PROXY_ANALYSIS_ONLY_MAX_MESSAGES = int(
    os.environ.get("PROXY_ANALYSIS_ONLY_MAX_MESSAGES", "2")
)
PROXY_TOOL_CALL_GRAMMAR = os.environ.get(
    "PROXY_TOOL_CALL_GRAMMAR", "on"
).lower() not in {
    "0",
    "false",
    "off",
    "no",
}
PROXY_TOOL_CALL_GRAMMAR_REQUIRED_ONLY = os.environ.get(
    "PROXY_TOOL_CALL_GRAMMAR_REQUIRED_ONLY", "on"
).lower() not in {
    "0",
    "false",
    "off",
    "no",
}
PROXY_TOOL_CALL_GRAMMAR_PATH = os.path.abspath(
    os.environ.get(
        "PROXY_TOOL_CALL_GRAMMAR_PATH",
        os.path.join(os.path.dirname(__file__), "..", "config", "tool-call.gbnf"),
    )
)
PROXY_MODEL_PROFILE_HEADER = os.environ.get(
    "PROXY_MODEL_PROFILE_HEADER", "x-uap-model-profile"
)
PROXY_MODEL_PROFILE_PARAM = os.environ.get(
    "PROXY_MODEL_PROFILE_PARAM", "uap_model_profile"
)

DEFAULT_PASSTHROUGH_MODEL_PATTERNS = (
    re.compile(r"^claude-opus-4-6", re.IGNORECASE),
    re.compile(r"^claude-sonnet-4-6", re.IGNORECASE),
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
PROJECT_ROOT = Path(__file__).resolve().parents[3]
PROFILE_DIR = PROJECT_ROOT / "config" / "model-profiles"
PROFILE_CACHE: dict[str, dict | None] = {}
PROFILE_WARNED: set[str] = set()

_client_request_times: dict[str, deque[float]] = defaultdict(deque)
_client_rate_last_log: dict[str, float] = defaultdict(float)


def resolve_client_id(request: Request) -> str:
    header_keys = ("x-uap-client-id", "x-forwarded-for", "x-real-ip")
    for key in header_keys:
        value = request.headers.get(key)
        if value:
            return f"{key}:{value.split(',')[0].strip()}"
    if request.client:
        return f"remote:{request.client.host}"
    return "remote:unknown"


def log_client_rate(client_id: str) -> int:
    if PROXY_CLIENT_RATE_WINDOW_SECS <= 0:
        return 0
    now = time.time()
    window = PROXY_CLIENT_RATE_WINDOW_SECS
    request_times = _client_request_times[client_id]
    request_times.append(now)
    cutoff = now - window
    while request_times and request_times[0] < cutoff:
        request_times.popleft()
    count = len(request_times)
    if PROXY_CLIENT_RATE_LOG_MIN_SECS <= 0:
        logger.info(
            "CLIENT_RATE: id=%s window=%ss count=%d",
            client_id,
            window,
            count,
        )
        return count
    last_log = _client_rate_last_log.get(client_id, 0.0)
    if now - last_log >= PROXY_CLIENT_RATE_LOG_MIN_SECS:
        _client_rate_last_log[client_id] = now
        logger.info(
            "CLIENT_RATE: id=%s window=%ss count=%d",
            client_id,
            window,
            count,
        )
    return count


def _load_tool_call_grammar(path: str) -> str:
    if not PROXY_TOOL_CALL_GRAMMAR:
        return ""

    try:
        with open(path, "r", encoding="utf-8") as fh:
            return fh.read().strip()
    except OSError as exc:
        logger.warning(
            "Tool-call grammar disabled: failed to read %s (%s)",
            path,
            exc,
        )
        return ""


TOOL_CALL_GBNF = _load_tool_call_grammar(PROXY_TOOL_CALL_GRAMMAR_PATH)
TOOL_CALL_GRAMMAR_TOOLS_COMPATIBLE = True

def _resolve_passthrough_models() -> list[str]:
    raw = ANTHROPIC_PASSTHROUGH_MODELS.strip()
    if not raw:
        return []
    return [m.strip() for m in raw.split(",") if m.strip()]


def _should_passthrough_model(model: str) -> bool:
    if not model:
        return False
    overrides = _resolve_passthrough_models()
    if overrides:
        return model in overrides
    return any(pattern.match(model) for pattern in DEFAULT_PASSTHROUGH_MODEL_PATTERNS)


def _load_profile_config(profile_name: str) -> dict | None:
    if not profile_name:
        return None

    cache_key = profile_name.strip().lower()
    if cache_key in PROFILE_CACHE:
        return PROFILE_CACHE[cache_key]

    profile_path = PROFILE_DIR / f"{profile_name}.json"
    legacy_path = PROJECT_ROOT / "config" / f"{profile_name}-settings.json"
    for path in (profile_path, legacy_path):
        if not path.exists():
            continue
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            PROFILE_CACHE[cache_key] = data
            return data
        except json.JSONDecodeError as exc:
            logger.warning("Failed to parse profile %s (%s)", path.name, exc)
            break

    PROFILE_CACHE[cache_key] = None
    return None


def _resolve_profile_name(headers: dict, body: dict) -> str | None:
    header_key = PROXY_MODEL_PROFILE_HEADER.lower()
    header_value = None
    for key, value in headers.items():
        if key.lower() == header_key:
            header_value = value
            break

    body_value = body.get(PROXY_MODEL_PROFILE_PARAM)
    candidate = header_value or body_value
    if not candidate:
        return None
    return str(candidate).strip()


def _apply_profile_overrides(
    body: dict, profile: dict
) -> tuple[dict, str | None, str | None]:
    updated = dict(body)
    updated.pop(PROXY_MODEL_PROFILE_PARAM, None)

    if profile.get("model"):
        updated["model"] = profile["model"]
    if "max_tokens" in profile:
        updated["max_tokens"] = profile["max_tokens"]
    if "temperature" in profile:
        updated["temperature"] = profile["temperature"]
    if "top_p" in profile:
        updated["top_p"] = profile["top_p"]
    if "stop_sequences" in profile:
        updated["stop_sequences"] = profile["stop_sequences"]
    if "enable_thinking" in profile:
        updated["enable_thinking"] = profile["enable_thinking"]

    tool_call_batching = profile.get("tool_call_batching") or {}
    prompt_suffix = None
    if isinstance(tool_call_batching, dict) and tool_call_batching.get("enabled"):
        prompt_suffix = tool_call_batching.get("system_prompt_suffix")

    structured_output = profile.get("structured_output") or {}
    grammar_text = None
    grammar_path = None
    if isinstance(structured_output, dict):
        grammar_path = structured_output.get("grammar_file")
    if grammar_path:
        resolved = Path(grammar_path)
        if not resolved.is_absolute():
            resolved = PROJECT_ROOT / resolved
        grammar_text = _load_tool_call_grammar(str(resolved))

    return updated, prompt_suffix, grammar_text


def _is_grammar_tools_incompatibility(status_code: int, error_text: str) -> bool:
    if status_code != 400:
        return False
    lowered = (error_text or "").lower()
    return "custom grammar constraints" in lowered and "with tools" in lowered


def _maybe_disable_grammar_for_tools_error(
    request_body: dict,
    status_code: int,
    error_text: str,
    source: str,
) -> bool:
    global TOOL_CALL_GRAMMAR_TOOLS_COMPATIBLE

    if "grammar" not in request_body or not request_body.get("tools"):
        return False
    if not _is_grammar_tools_incompatibility(status_code, error_text):
        return False

    request_body.pop("grammar", None)
    if TOOL_CALL_GRAMMAR_TOOLS_COMPATIBLE:
        TOOL_CALL_GRAMMAR_TOOLS_COMPATIBLE = False
        logger.warning(
            "Tool-call grammar rejected by upstream for tool turns; "
            "disabling grammar-on-tools for this proxy process (%s)",
            source,
        )
    else:
        logger.warning(
            "Tool-call grammar already disabled for tool turns; retrying %s without grammar",
            source,
        )

    return True


def _apply_tool_call_grammar(
    request_body: dict, tool_choice: str | None = None, grammar_override: str | None = None
) -> None:
    existing_grammar = request_body.pop("grammar", None)

    grammar_text = grammar_override or existing_grammar or TOOL_CALL_GBNF
    if not PROXY_TOOL_CALL_GRAMMAR or not grammar_text:
        return

    if not request_body.get("tools"):
        return

    if not TOOL_CALL_GRAMMAR_TOOLS_COMPATIBLE:
        return

    effective_tool_choice = (
        tool_choice if tool_choice is not None else request_body.get("tool_choice")
    )
    if PROXY_TOOL_CALL_GRAMMAR_REQUIRED_ONLY and effective_tool_choice != "required":
        return

    request_body["grammar"] = grammar_text


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
    tool_target_history: dict = field(
        default_factory=dict
    )  # {tool_name: {target: count}} for read-only dedup
    consecutive_forced_count: int = (
        0  # How many times tool_choice was forced consecutively
    )
    loop_warnings_emitted: int = 0  # How many loop warnings sent to the model
    no_progress_streak: int = 0  # Forced tool turns without new tool_result
    unexpected_end_turn_count: int = 0  # end_turn without tool_use in active loop
    tool_starvation_streak: int = 0  # Consecutive forced turns with no tool_calls produced
    malformed_tool_streak: int = 0  # consecutive malformed pseudo tool payloads
    invalid_tool_call_streak: int = 0  # consecutive invalid tool arg payloads
    required_tool_miss_streak: int = 0  # required tool turns with no tool call
    contamination_resets: int = 0  # how many contamination resets were applied
    forced_auto_cooldown_turns: int = 0  # temporary auto override turns remaining
    forced_dampener_triggers: int = 0  # number of dampener activations
    arg_preflight_rejections: int = 0  # rejected tool calls from arg preflight
    arg_preflight_repairs: int = 0  # sanitized tool call args accepted
    tool_turn_phase: str = "bootstrap"  # bootstrap -> act -> review
    tool_state_forced_budget_remaining: int = 0
    tool_state_auto_budget_remaining: int = 0
    tool_state_stagnation_streak: int = 0
    tool_state_transitions: int = 0
    tool_state_review_cycles: int = 0
    tool_state_unproductive_exhaustion_streak: int = 0
    last_tool_fingerprint: str = ""
    cycling_tool_names: list = field(default_factory=list)
    session_banned_tools: set = field(default_factory=set)  # tools banned for entire session after repeated cycling
    tool_cycle_counts: dict = field(default_factory=dict)  # {tool_name: cycle_count} across resets
    last_response_garbled: bool = False  # previous turn had garbled/malformed output
    finalize_turn_active: bool = False
    finalize_continuation_count: int = 0
    finalize_hard_stop_count: int = 0  # monotonic, not reset by fresh user text
    finalize_synthetic_tool_id: str = ""
    completion_required: bool = False
    completion_pending: bool = False
    completion_verified: bool = False
    completion_blockers: list = field(default_factory=list)
    completion_progress_signals: int = 0
    completion_recovery_attempts: int = 0
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

    def record_tool_calls(
        self,
        tool_names: list[str],
        tool_targets: dict[str, str] | None = None,
        fingerprint: str = "",
    ):
        """Record tool call names for loop detection.

        tool_targets: optional {tool_name: target_key} for read-only dedup.
        e.g. {"read": "/path/to/file", "glob": "**/*.ts"}
        If a pre-computed fingerprint (with argument hashes) is provided,
        use it directly.  Otherwise fall back to name-only fingerprint.
        """
        fp = fingerprint or ("|".join(sorted(tool_names)) if tool_names else "")
        self.tool_call_history.append(fp)
        # Keep last 30 entries
        if len(self.tool_call_history) > 30:
            self.tool_call_history = self.tool_call_history[-30:]

        # Track read-only tool targets for dedup (Option 3)
        if tool_targets:
            for name, target in tool_targets.items():
                if name.lower() in {n.lower() for n in _READ_ONLY_TOOL_CLASS} and target:
                    by_tool = self.tool_target_history.setdefault(name, {})
                    by_tool[target] = by_tool.get(target, 0) + 1

    def has_duplicate_read_target(self, threshold: int = 2) -> tuple[bool, str]:
        """Check if any read-only tool has re-read the same target >= threshold times.

        Returns (is_duplicate, tool_name) for the first offending tool.
        """
        for tool_name, targets in self.tool_target_history.items():
            for target, count in targets.items():
                if count >= threshold:
                    return True, tool_name
        return False, ""

    def reset_tool_targets(self):
        """Clear target history (on phase reset or fresh user text)."""
        self.tool_target_history = {}

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

    def detect_tool_cycle(self, window: int = 8) -> tuple[bool, int]:
        """Detect low-entropy tool cycles (A/B oscillation style loops)."""
        if len(self.tool_call_history) < window:
            return False, 0

        recent = [fp for fp in self.tool_call_history[-window:] if fp]
        if len(recent) < window:
            return False, 0

        unique = list(dict.fromkeys(recent))
        if len(unique) == 1:
            target = unique[0]
            count = 0
            for fp in reversed(self.tool_call_history):
                if fp == target:
                    count += 1
                else:
                    break
            return True, count

        if len(unique) > 2:
            return False, 0

        counts: dict[str, int] = {}
        for fp in recent:
            counts[fp] = counts.get(fp, 0) + 1
        if counts and min(counts.values()) < 2:
            return False, 0

        transitions = sum(1 for a, b in zip(recent, recent[1:]) if a != b)
        if transitions < window // 2:
            return False, 0

        allowed = set(counts.keys())
        count = 0
        for fp in reversed(self.tool_call_history):
            if fp in allowed:
                count += 1
            else:
                break
        return True, count

    def set_tool_turn_phase(self, phase: str, reason: str = ""):
        if phase == self.tool_turn_phase:
            return
        old_phase = self.tool_turn_phase
        self.tool_turn_phase = phase
        self.tool_state_transitions += 1
        logger.info(
            "TOOL STATE MACHINE: phase %s -> %s%s",
            old_phase,
            phase,
            f" reason={reason}" if reason else "",
        )

    def reset_tool_turn_state(self, reason: str = ""):
        self.set_tool_turn_phase("bootstrap", reason=reason)
        self.tool_state_forced_budget_remaining = 0
        self.tool_state_auto_budget_remaining = 0
        self.tool_state_stagnation_streak = 0
        self.tool_state_review_cycles = 0
        self.tool_state_unproductive_exhaustion_streak = 0
        self.cycling_tool_names = []
        self.last_tool_fingerprint = ""
        self.reset_tool_targets()

    def update_completion_state(self, anthropic_body: dict, has_tool_results: bool):
        self.completion_required = _should_enforce_completion_contract(anthropic_body)
        self.completion_progress_signals = _count_completion_progress_signals(anthropic_body)
        blockers = _completion_blockers(
            anthropic_body,
            has_tool_results,
            phase=self.tool_turn_phase,
            finalize_fired=(self.finalize_hard_stop_count > 0),
        )
        self.completion_blockers = blockers
        self.completion_pending = self.completion_required and bool(blockers)
        self.completion_verified = self.completion_required and not blockers
        if not self.completion_required:
            self.completion_pending = False
            self.completion_verified = False
            self.completion_blockers = []

    def note_completion_recovery(self):
        self.completion_recovery_attempts += 1

    def reset_completion_recovery(self):
        self.completion_recovery_attempts = 0

    def guardrail_streak(self) -> int:
        """Highest current streak among malformed/invalid tool outputs."""
        return max(self.malformed_tool_streak, self.invalid_tool_call_streak)

    def consume_forced_auto_turn(self) -> bool:
        """Consume one dampener turn that temporarily sets tool_choice=auto."""
        if self.forced_auto_cooldown_turns <= 0:
            return False
        self.forced_auto_cooldown_turns -= 1
        return True

    def maybe_activate_forced_tool_dampener(self, reason: str) -> bool:
        """Temporarily release forced tool choice when quality collapses."""
        if not PROXY_FORCED_TOOL_DAMPENER:
            return False
        if self.forced_auto_cooldown_turns > 0:
            return False

        min_forced = max(1, PROXY_FORCED_TOOL_DAMPENER_MIN_FORCED)
        if self.consecutive_forced_count < min_forced:
            return False

        bad_streak = self.guardrail_streak()
        bad_threshold = max(1, PROXY_FORCED_TOOL_DAMPENER_BAD_STREAK)
        empty_threshold = max(1, PROXY_FORCED_TOOL_DAMPENER_EMPTY_STREAK)
        rejection_threshold = max(1, PROXY_FORCED_TOOL_DAMPENER_REJECTIONS)
        rejection_pressure = self.arg_preflight_rejections >= rejection_threshold
        if (
            bad_streak < bad_threshold
            and self.required_tool_miss_streak < empty_threshold
            and not rejection_pressure
        ):
            return False

        self.forced_auto_cooldown_turns = max(1, PROXY_FORCED_TOOL_DAMPENER_AUTO_TURNS)
        self.forced_dampener_triggers += 1
        if rejection_pressure:
            self.arg_preflight_rejections = 0
        logger.warning(
            "FORCED-TOOL DAMPENER: activated reason=%s forced=%d bad_streak=%d required_miss=%d rejection_pressure=%s auto_turns=%d",
            reason,
            self.consecutive_forced_count,
            bad_streak,
            self.required_tool_miss_streak,
            rejection_pressure,
            self.forced_auto_cooldown_turns,
        )
        return True

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
        cycle_looping, cycle_repeat = self.detect_tool_cycle(
            window=max(PROXY_LOOP_WINDOW, PROXY_TOOL_STATE_CYCLE_WINDOW)
        )

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

        if (
            cycle_looping
            and cycle_repeat >= PROXY_LOOP_REPEAT_THRESHOLD
            and self.tool_state_stagnation_streak >= max(1, PROXY_NO_PROGRESS_THRESHOLD)
        ):
            logger.warning(
                "LOOP BREAKER: low-entropy tool cycle repeated %d turns with stagnation=%d. "
                "Releasing tool_choice to 'auto'.",
                cycle_repeat,
                self.tool_state_stagnation_streak,
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
_last_ctx_recheck_ts: float = 0.0
_CTX_RECHECK_INTERVAL: float = 60.0  # Re-detect context window every 60s


def _cleanup_stale_monitors(now_ts: float) -> None:
    stale = [
        sid
        for sid, mon in session_monitors.items()
        if mon.last_seen_ts > 0 and now_ts - mon.last_seen_ts > PROXY_SESSION_TTL_SECS
    ]
    for sid in stale:
        session_monitors.pop(sid, None)


async def _maybe_recheck_context_window() -> None:
    """Periodically re-query the upstream server's context window.

    Handles server restarts with different --ctx-size mid-session.
    Non-blocking: skips if the check interval hasn't elapsed.
    """
    global default_context_window, _last_ctx_recheck_ts
    now = time.time()
    if now - _last_ctx_recheck_ts < _CTX_RECHECK_INTERVAL:
        return
    _last_ctx_recheck_ts = now
    if http_client is None:
        return
    try:
        slots_url = LLAMA_CPP_BASE.replace("/v1", "/slots")
        resp = await http_client.get(slots_url, timeout=2.0)
        if resp.status_code == 200:
            slots = resp.json()
            if slots and isinstance(slots, list):
                n_ctx = slots[0].get("n_ctx", 0)
                if n_ctx > 0 and n_ctx != default_context_window:
                    old = default_context_window
                    default_context_window = n_ctx
                    for mon in session_monitors.values():
                        mon.context_window = n_ctx
                    logger.warning(
                        "Context window changed: %d → %d (upstream server restarted?)",
                        old, n_ctx,
                    )
    except Exception:
        pass  # Non-critical, will retry next interval


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

    # Agentic supplement tokens (only when tool mode is active)
    if _has_tool_definitions(anthropic_body):
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
    anthropic_body: dict,
    context_window: int,
    target_fraction: float = 0.65,
    keep_last: int = 8,
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
        keep_last: Number of recent messages to always keep (default 8)

    Returns:
        Modified anthropic_body with pruned messages
    """
    messages = anthropic_body.get("messages", [])
    if len(messages) <= 4:
        # Too few messages to prune meaningfully
        return anthropic_body

    target_tokens = int(context_window * target_fraction)

    # Estimate non-message tokens (system, tools, agentic supplement)
    # Apply a 1.5x safety factor to account for chat template overhead
    # and tokenization differences between local estimate and upstream
    overhead_tokens = 0
    system = anthropic_body.get("system", "")
    if isinstance(system, str):
        overhead_tokens += estimate_tokens(system)
    elif isinstance(system, list):
        for block in system:
            if isinstance(block, dict) and block.get("type") == "text":
                overhead_tokens += estimate_tokens(block.get("text", ""))
    if _has_tool_definitions(anthropic_body):
        overhead_tokens += estimate_tokens(_AGENTIC_SYSTEM_SUPPLEMENT)
    tools = anthropic_body.get("tools", [])
    if tools:
        overhead_tokens += estimate_tokens(json.dumps(tools))
    overhead_tokens = int(overhead_tokens * 1.5)  # Safety factor for template overhead

    # Budget for messages
    message_budget = target_tokens - overhead_tokens
    if message_budget <= 0:
        logger.error("System prompt + tools alone exceed target budget!")
        return anthropic_body

    # Always keep the first user message and the last N messages
    KEEP_LAST = keep_last
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


def _is_loading_model_503(resp: httpx.Response) -> bool:
    """Check if response is a 503 'Loading model' from llama.cpp."""
    if resp.status_code != 503:
        return False
    try:
        return "loading model" in resp.text.lower()
    except Exception:
        return False


async def _wait_for_upstream_health(
    client: httpx.AsyncClient,
    max_wait: float = 60.0,
    poll_interval: float = 5.0,
) -> bool:
    """Poll upstream /health until ready or timeout. Returns True if healthy."""
    health_url = LLAMA_CPP_BASE.replace("/v1", "/health")
    elapsed = 0.0
    while elapsed < max_wait:
        try:
            resp = await client.get(health_url, timeout=5.0)
            if resp.status_code == 200:
                data = resp.json() if resp.headers.get("content-type", "").startswith("application/json") else {}
                if data.get("status") == "ok" or resp.status_code == 200:
                    if elapsed > 0:
                        logger.info(
                            "UPSTREAM HEALTH: recovered after %.0fs wait", elapsed
                        )
                    return True
        except Exception:
            pass
        await asyncio.sleep(poll_interval)
        elapsed += poll_interval
    logger.error("UPSTREAM HEALTH: not ready after %.0fs", max_wait)
    return False


async def _post_with_retry(
    client: httpx.AsyncClient,
    url: str,
    payload: dict,
    headers: dict,
) -> httpx.Response:
    last_exc: Exception | None = None
    for attempt in range(PROXY_UPSTREAM_RETRY_MAX):
        try:
            resp = await client.post(url, json=payload, headers=headers)
            # Cycle 19 Option 1: if 503 "Loading model", wait for health then retry
            if _is_loading_model_503(resp):
                logger.warning(
                    "Upstream 503 Loading model (attempt %d/%d) – waiting for health",
                    attempt + 1,
                    PROXY_UPSTREAM_RETRY_MAX,
                )
                healthy = await _wait_for_upstream_health(client, max_wait=60.0)
                if healthy and attempt < PROXY_UPSTREAM_RETRY_MAX - 1:
                    continue  # retry the request now that upstream is healthy
                return resp  # return the 503 if health wait timed out
            return resp
        except (httpx.ConnectError, httpx.RemoteProtocolError, httpx.ReadTimeout) as exc:
            last_exc = exc
            if attempt < PROXY_UPSTREAM_RETRY_MAX - 1:
                logger.warning(
                    "Upstream connect failed (attempt %d/%d): %s – retrying in %.0fs",
                    attempt + 1,
                    PROXY_UPSTREAM_RETRY_MAX,
                    type(exc).__name__,
                    PROXY_UPSTREAM_RETRY_DELAY_SECS,
                )
                await asyncio.sleep(PROXY_UPSTREAM_RETRY_DELAY_SECS)
            else:
                logger.error(
                    "Upstream connect failed after %d attempts: %s: %s",
                    PROXY_UPSTREAM_RETRY_MAX,
                    type(exc).__name__,
                    exc,
                )
    raise last_exc if last_exc else RuntimeError("upstream retry failed")


async def _post_with_generation_timeout(
    client: httpx.AsyncClient,
    url: str,
    payload: dict,
    headers: dict,
) -> httpx.Response:
    """Wrap _post_with_retry with an explicit asyncio generation timeout.

    The httpx read timeout may not fire for hung connections where the server
    keeps the socket open but produces no data (observed with llama.cpp server
    hanging after prompt processing). This wrapper uses asyncio.wait_for to
    enforce a hard deadline.
    """
    timeout = PROXY_GENERATION_TIMEOUT
    if timeout <= 0:
        return await _post_with_retry(client, url, payload, headers)
    try:
        return await asyncio.wait_for(
            _post_with_retry(client, url, payload, headers),
            timeout=timeout,
        )
    except asyncio.TimeoutError:
        logger.error(
            "GENERATION TIMEOUT: request to %s exceeded %ds hard deadline",
            url,
            int(timeout),
        )
        raise httpx.ReadTimeout(
            f"Generation timeout after {int(timeout)}s (PROXY_GENERATION_TIMEOUT)"
        )


async def _check_slot_hang(slot_url: str) -> bool:
    """Check if any upstream slot is hung (processing but n_decoded=0).

    Returns True if a hung slot was detected and the server was restarted.
    """
    if PROXY_SLOT_HANG_TIMEOUT <= 0:
        return False
    try:
        async with httpx.AsyncClient() as check_client:
            resp = await check_client.get(slot_url, timeout=5.0)
            if resp.status_code != 200:
                return False
            slots = resp.json()
            for slot in slots:
                if (
                    slot.get("is_processing", False)
                    and slot.get("n_decoded", -1) == 0
                ):
                    # Slot is processing but hasn't decoded any tokens —
                    # check how long by looking at the task start time.
                    # Since we can't easily get the start time from the slot,
                    # we'll just log a warning. The generation timeout will
                    # handle the actual cancellation.
                    logger.warning(
                        "SLOT HANG DETECTED: slot %d is_processing=True n_decoded=0 task=%s",
                        slot.get("id", -1),
                        slot.get("id_task", "?"),
                    )
                    return True
    except Exception as exc:
        logger.debug("Slot hang check failed: %s", exc)
    return False


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
        "Guardrails: malformed=%s stream_strict=%s force_non_stream=%s args_preflight=%s tool_narrowing=%s expand_on_loop=%s thinking_off_on_tools=%s state_machine=%s(min_msgs=%d forced=%d auto=%d stagnation=%d cycle=%d finalize=%d review_cycles=%d) dampener=%s(%d/%d/%d/%d->%d) contamination_breaker=%s(%d forced=%d required_miss=%d) analysis_only_route=%s(min_tools=%d,max_msgs=%d) grammar=%s(required_only=%s loaded=%s tools_compatible=%s path=%s)",
        PROXY_MALFORMED_TOOL_GUARDRAIL,
        PROXY_MALFORMED_TOOL_STREAM_STRICT,
        PROXY_FORCE_NON_STREAM,
        PROXY_TOOL_ARGS_PREFLIGHT,
        PROXY_TOOL_NARROWING,
        PROXY_TOOL_NARROWING_EXPAND_ON_LOOP,
        PROXY_DISABLE_THINKING_ON_TOOL_TURNS,
        PROXY_TOOL_STATE_MACHINE,
        PROXY_TOOL_STATE_MIN_MESSAGES,
        PROXY_TOOL_STATE_FORCED_BUDGET,
        PROXY_TOOL_STATE_AUTO_BUDGET,
        PROXY_TOOL_STATE_STAGNATION_THRESHOLD,
        PROXY_TOOL_STATE_CYCLE_WINDOW,
        PROXY_TOOL_STATE_FINALIZE_THRESHOLD,
        PROXY_TOOL_STATE_REVIEW_CYCLE_LIMIT,
        PROXY_FORCED_TOOL_DAMPENER,
        PROXY_FORCED_TOOL_DAMPENER_MIN_FORCED,
        PROXY_FORCED_TOOL_DAMPENER_BAD_STREAK,
        PROXY_FORCED_TOOL_DAMPENER_EMPTY_STREAK,
        PROXY_FORCED_TOOL_DAMPENER_REJECTIONS,
        PROXY_FORCED_TOOL_DAMPENER_AUTO_TURNS,
        PROXY_SESSION_CONTAMINATION_BREAKER,
        PROXY_SESSION_CONTAMINATION_THRESHOLD,
        PROXY_SESSION_CONTAMINATION_FORCED_THRESHOLD,
        PROXY_SESSION_CONTAMINATION_REQUIRED_MISS_THRESHOLD,
        PROXY_ANALYSIS_ONLY_ROUTE,
        PROXY_ANALYSIS_ONLY_MIN_TOOLS,
        PROXY_ANALYSIS_ONLY_MAX_MESSAGES,
        PROXY_TOOL_CALL_GRAMMAR,
        PROXY_TOOL_CALL_GRAMMAR_REQUIRED_ONLY,
        bool(TOOL_CALL_GBNF),
        TOOL_CALL_GRAMMAR_TOOLS_COMPATIBLE,
        PROXY_TOOL_CALL_GRAMMAR_PATH,
    )
    logger.info(
        "Timeouts: read=%ds generation=%ds slot_hang=%ds",
        int(PROXY_READ_TIMEOUT),
        int(PROXY_GENERATION_TIMEOUT),
        int(PROXY_SLOT_HANG_TIMEOUT),
    )
    logger.info(
        "Tool turn max_tokens: cap=%d garbled_cap=%d",
        PROXY_TOOL_TURN_MAX_TOKENS,
        PROXY_TOOL_TURN_MAX_TOKENS_GARBLED,
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


_TOOL_CALL_APOLOGY_MARKERS = (
    "i could not produce a valid tool-call format in this turn",
    "i will issue exactly one valid tool call next",
)

_TOOL_CALL_RETRY_MESSAGE = (
    "Tool-call formatting failed after automatic retries. "
    "Please retry the same request."
)


def _contains_tool_call_apology(text: str) -> bool:
    if not text:
        return False
    lowered = text.lower()
    return any(marker in lowered for marker in _TOOL_CALL_APOLOGY_MARKERS)


def _sanitize_tool_call_apology_text(text: str) -> str:
    return _TOOL_CALL_RETRY_MESSAGE if _contains_tool_call_apology(text) else text


def _has_tool_definitions(anthropic_body: dict) -> bool:
    tools = anthropic_body.get("tools")
    return isinstance(tools, list) and len(tools) > 0


def _should_use_guarded_non_stream(
    is_stream: bool,
    anthropic_body: dict,
    openai_body: dict,
) -> bool:
    if not is_stream:
        return False

    if PROXY_FORCE_NON_STREAM:
        return True

    has_tools = _has_tool_definitions(anthropic_body)
    if PROXY_MALFORMED_TOOL_STREAM_STRICT and has_tools:
        return True

    return (
        has_tools
        and openai_body.get("tool_choice") == "required"
        and (PROXY_MALFORMED_TOOL_GUARDRAIL or PROXY_GUARDRAIL_RETRY)
    )


def _message_has_tool_result(content) -> bool:
    return isinstance(content, list) and any(
        isinstance(block, dict) and block.get("type") == "tool_result"
        for block in content
    )


def _last_user_text(anthropic_body: dict) -> str:
    for msg in reversed(anthropic_body.get("messages", [])):
        if msg.get("role") == "user":
            return _extract_text(msg.get("content", "")).strip().lower()
    return ""


def _is_analysis_only_prompt(text: str) -> bool:
    if not text:
        return False

    normalized = text.lower()
    has_analysis = bool(
        re.search(
            r"\b(?:analy(?:ze|zing|sis)?|review|audit|summar(?:y|ize|ized|ise)|explain|plan|recommend|assess|compare|investigate|diagnos(?:e|is))\b",
            normalized,
        )
    )
    has_action = bool(
        re.search(
            r"\b(?:fix|edit|write|create|implement|patch|change|update|run|execute|apply|commit|push|merge|publish|deploy|test|build|refactor|rename|delete|install)\b",
            normalized,
        )
    ) or any(
        phrase in normalized
        for phrase in (
            "use tool",
            "call tool",
            "run command",
            "execute command",
        )
    )
    return has_analysis and not has_action


def _should_route_analysis_without_tools(anthropic_body: dict) -> bool:
    if not PROXY_ANALYSIS_ONLY_ROUTE:
        return False

    tools = anthropic_body.get("tools")
    if not isinstance(tools, list) or len(tools) < max(
        1, PROXY_ANALYSIS_ONLY_MIN_TOOLS
    ):
        return False

    messages = anthropic_body.get("messages", [])
    if not isinstance(messages, list) or not messages:
        return False

    if len(messages) > max(1, PROXY_ANALYSIS_ONLY_MAX_MESSAGES):
        return False

    if any(msg.get("role") == "assistant" for msg in messages):
        return False

    if any(_message_has_tool_result(msg.get("content")) for msg in messages):
        return False

    return _is_analysis_only_prompt(_last_user_text(anthropic_body))


def _maybe_route_analysis_without_tools(anthropic_body: dict) -> tuple[dict, int]:
    if not _should_route_analysis_without_tools(anthropic_body):
        return anthropic_body, 0

    tools = anthropic_body.get("tools")
    removed = len(tools) if isinstance(tools, list) else 0
    updated = dict(anthropic_body)
    updated.pop("tools", None)
    return updated, removed


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

_AGENTIC_SYSTEM_SUPPLEMENT_MINIMAL = (
    "\n\nUse tools for all actions. Respond with tool calls, not descriptions of what to do."
)

if PROXY_AGENTIC_SUPPLEMENT_MODE == "legacy":
    _AGENTIC_SYSTEM_SUPPLEMENT = _AGENTIC_SYSTEM_SUPPLEMENT_LEGACY
elif PROXY_AGENTIC_SUPPLEMENT_MODE == "minimal":
    _AGENTIC_SYSTEM_SUPPLEMENT = _AGENTIC_SYSTEM_SUPPLEMENT_MINIMAL
elif PROXY_AGENTIC_SUPPLEMENT_MODE == "clean":
    _AGENTIC_SYSTEM_SUPPLEMENT = _AGENTIC_SYSTEM_SUPPLEMENT_CLEAN
else:
    logger.warning(
        "Unknown PROXY_AGENTIC_SUPPLEMENT_MODE=%r; using clean supplement",
        PROXY_AGENTIC_SUPPLEMENT_MODE,
    )
    _AGENTIC_SYSTEM_SUPPLEMENT = _AGENTIC_SYSTEM_SUPPLEMENT_CLEAN


def _content_fingerprint(content) -> str:
    """Return a STABLE fingerprint for content. Must not include volatile
    identifiers (tool_use_ids change per-turn), otherwise session stickiness
    breaks in agentic loops with stateful guardrails."""
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
                    # Stable: use tool name + first 64 chars of content, not tool_use_id
                    inner = block.get("content", "")
                    inner_text = _extract_text(inner) if not isinstance(inner, str) else inner
                    parts.append(f"result:{inner_text[:64]}")
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
            # Only hash TEXT content of first user message, not tool_result blocks
            # (which may appear in /anthropic/v1/messages passthrough scenarios)
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

    # Deliberately exclude `system` from fingerprint — clients often inject
    # volatile context (timestamps, cwd, session markers) into system prompts
    # which would break session stickiness for ongoing conversations.
    model = anthropic_body.get("model", "default")
    remote = request.client.host if request.client else "unknown"
    digest = hashlib.sha256(
        f"{remote}|{model}|{first_user}".encode(
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


def _conversation_has_tool_results(anthropic_body: dict) -> bool:
    return any(
        _message_has_tool_result(msg.get("content"))
        for msg in anthropic_body.get("messages", [])
        if isinstance(msg, dict)
    )


def _count_completion_progress_signals(anthropic_body: dict) -> int:
    messages = anthropic_body.get("messages", [])
    tool_result_count = 0
    for msg in messages:
        if not isinstance(msg, dict):
            continue
        content = msg.get("content")
        if _message_has_tool_result(content):
            tool_result_count += 1

    user_turns = sum(
        1
        for msg in messages
        if isinstance(msg, dict)
        and msg.get("role") == "user"
        and not _message_has_tool_result(msg.get("content"))
        and _extract_text(msg.get("content", "")).strip()
    )
    return max(0, tool_result_count - user_turns)


def _should_enforce_completion_contract(anthropic_body: dict) -> bool:
    if not _has_tool_definitions(anthropic_body):
        return False
    latest_text = _latest_user_text(anthropic_body).strip()
    if latest_text and _is_analysis_only_prompt(latest_text):
        return False

    messages = anthropic_body.get("messages", [])
    if len(messages) < 2:
        return False

    return _conversation_has_tool_results(anthropic_body) or _count_completion_progress_signals(anthropic_body) > 0


def _completion_blockers(
    anthropic_body: dict,
    has_tool_results: bool,
    phase: str = "",
    finalize_fired: bool = False,
) -> list[str]:
    blockers: list[str] = []
    progress = _count_completion_progress_signals(anthropic_body)
    if progress <= 0:
        blockers.append("no_progress_evidence")

    if has_tool_results:
        last_user_has_result = _last_user_has_tool_result(anthropic_body)
        if last_user_has_result:
            blockers.append("awaiting_post_tool_followup")
        elif _last_assistant_was_text_only(anthropic_body):
            # Suppress in two cases:
            # 1. Currently in finalize phase — text-only is expected
            # 2. A finalize fired earlier this session — means the state machine
            #    already wrapped up the loop, don't re-trigger it (was causing
            #    finalize -> review -> cycle -> finalize -> review... infinite loop)
            if phase != "finalize" and not finalize_fired:
                blockers.append("text_only_after_tool_results")

    return blockers


def _sanitize_tool_schema_for_llama(schema):
    """Remove JSON Schema keywords that generate unsupported regex grammar.

    llama.cpp's tool grammar generator can fail on regex-heavy schema fields
    such as "pattern" and "patternProperties" (for example "\\w").
    """

    removed = 0
    property_map_keys = {"properties", "definitions", "$defs", "dependentSchemas"}

    def _walk(node, parent_key=None):
        nonlocal removed
        if isinstance(node, dict):
            cleaned = {}
            for key, value in node.items():
                key_is_property_name = parent_key in property_map_keys
                if (
                    key == "pattern"
                    and isinstance(value, str)
                    and not key_is_property_name
                ):
                    removed += 1
                    continue
                if key == "patternProperties" and not key_is_property_name:
                    removed += 1
                    continue
                cleaned[key] = _walk(value, key)
            return cleaned
        if isinstance(node, list):
            return [_walk(item, parent_key) for item in node]
        return node

    return _walk(schema), removed


def openai_to_anthropic_request(openai_body: dict) -> dict:
    """Convert an OpenAI Chat Completions request to an Anthropic Messages request.

    Inverse of anthropic_to_openai_messages. Used by /v1/chat/completions passthrough
    to let OpenAI-shaped clients (Forge, etc.) benefit from the Anthropic-path
    guardrails (loop detection, tool narrowing, cycle breaking, etc.).
    """
    anthropic_messages: list[dict] = []
    system_text_parts: list[str] = []

    for msg in openai_body.get("messages", []):
        role = msg.get("role", "")
        content = msg.get("content")

        if role == "system":
            if isinstance(content, str):
                system_text_parts.append(content)
            elif isinstance(content, list):
                for block in content:
                    if isinstance(block, dict) and block.get("type") == "text":
                        system_text_parts.append(block.get("text", ""))
                    elif isinstance(block, str):
                        system_text_parts.append(block)
            continue

        if role == "tool":
            # OpenAI tool response -> Anthropic user message with tool_result block
            tool_call_id = msg.get("tool_call_id", "")
            tool_text = content if isinstance(content, str) else _extract_text(content)
            anthropic_messages.append(
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "tool_result",
                            "tool_use_id": tool_call_id,
                            "content": tool_text,
                        }
                    ],
                }
            )
            continue

        if role == "assistant":
            blocks: list[dict] = []
            if isinstance(content, str) and content:
                blocks.append({"type": "text", "text": content})
            elif isinstance(content, list):
                for block in content:
                    if isinstance(block, dict) and block.get("type") == "text":
                        blocks.append({"type": "text", "text": block.get("text", "")})
                    elif isinstance(block, str):
                        blocks.append({"type": "text", "text": block})

            for tc in msg.get("tool_calls", []) or []:
                fn = tc.get("function", {})
                try:
                    args = json.loads(fn.get("arguments", "{}") or "{}")
                except (ValueError, TypeError):
                    args = {}
                blocks.append(
                    {
                        "type": "tool_use",
                        "id": tc.get("id", f"toolu_{uuid.uuid4().hex[:12]}"),
                        "name": fn.get("name", ""),
                        "input": args,
                    }
                )

            anthropic_messages.append(
                {"role": "assistant", "content": blocks if blocks else ""}
            )
            continue

        # role == "user" (or unknown -> treat as user)
        if isinstance(content, str):
            anthropic_messages.append({"role": "user", "content": content})
        elif isinstance(content, list):
            blocks = []
            for block in content:
                if isinstance(block, dict) and block.get("type") == "text":
                    blocks.append({"type": "text", "text": block.get("text", "")})
                elif isinstance(block, str):
                    blocks.append({"type": "text", "text": block})
            anthropic_messages.append(
                {"role": "user", "content": blocks if blocks else ""}
            )
        else:
            anthropic_messages.append({"role": "user", "content": ""})

    anthropic_body: dict = {
        "model": openai_body.get("model", "default"),
        "messages": anthropic_messages,
        "max_tokens": int(openai_body.get("max_tokens", 4096) or 4096),
    }
    if system_text_parts:
        anthropic_body["system"] = "\n\n".join(p for p in system_text_parts if p)

    for key_o, key_a in (
        ("temperature", "temperature"),
        ("top_p", "top_p"),
        ("top_k", "top_k"),
        ("stop", "stop_sequences"),
        ("stream", "stream"),
    ):
        if key_o in openai_body:
            val = openai_body[key_o]
            if key_a == "stop_sequences" and isinstance(val, str):
                val = [val]
            anthropic_body[key_a] = val

    # Convert OpenAI tools -> Anthropic tools
    openai_tools = openai_body.get("tools") or []
    if openai_tools:
        anthropic_tools = []
        for tool in openai_tools:
            fn = tool.get("function", {}) if isinstance(tool, dict) else {}
            if not fn.get("name"):
                continue
            anthropic_tools.append(
                {
                    "name": fn.get("name", ""),
                    "description": fn.get("description", ""),
                    "input_schema": fn.get("parameters", {"type": "object", "properties": {}}),
                }
            )
        if anthropic_tools:
            anthropic_body["tools"] = anthropic_tools

    tool_choice = openai_body.get("tool_choice")
    if tool_choice == "none":
        anthropic_body.pop("tools", None)
    elif tool_choice == "required":
        anthropic_body["tool_choice"] = {"type": "any"}
    elif isinstance(tool_choice, dict) and tool_choice.get("type") == "function":
        anthropic_body["tool_choice"] = {
            "type": "tool",
            "name": tool_choice.get("function", {}).get("name", ""),
        }

    return anthropic_body


def anthropic_to_openai_response(anthropic_resp: dict) -> dict:
    """Convert an Anthropic Messages response to OpenAI Chat Completions format."""
    content_blocks = anthropic_resp.get("content", []) or []
    text_parts: list[str] = []
    tool_calls: list[dict] = []

    for block in content_blocks:
        if not isinstance(block, dict):
            continue
        btype = block.get("type")
        if btype == "text":
            text_parts.append(block.get("text", ""))
        elif btype == "tool_use":
            tool_calls.append(
                {
                    "id": block.get("id", f"call_{uuid.uuid4().hex[:12]}"),
                    "type": "function",
                    "function": {
                        "name": block.get("name", ""),
                        "arguments": json.dumps(block.get("input", {}) or {}),
                    },
                }
            )

    stop_reason = anthropic_resp.get("stop_reason", "end_turn")
    finish_map = {
        "end_turn": "stop",
        "stop_sequence": "stop",
        "max_tokens": "length",
        "tool_use": "tool_calls",
    }
    finish_reason = finish_map.get(stop_reason, "stop")

    message: dict = {"role": "assistant"}
    if text_parts:
        message["content"] = "".join(text_parts)
    else:
        message["content"] = None
    if tool_calls:
        message["tool_calls"] = tool_calls

    usage = anthropic_resp.get("usage", {}) or {}

    return {
        "id": anthropic_resp.get("id", f"chatcmpl-{uuid.uuid4().hex[:12]}"),
        "object": "chat.completion",
        "created": int(time.time()),
        "model": anthropic_resp.get("model", "unknown"),
        "choices": [
            {
                "index": 0,
                "message": message,
                "finish_reason": finish_reason,
            }
        ],
        "usage": {
            "prompt_tokens": usage.get("input_tokens", 0),
            "completion_tokens": usage.get("output_tokens", 0),
            "total_tokens": usage.get("input_tokens", 0) + usage.get("output_tokens", 0),
        },
    }


def _convert_anthropic_tools_to_openai(anthropic_tools: list[dict]) -> list[dict]:
    converted = []
    removed_pattern_fields = 0
    for tool in anthropic_tools:
        input_schema, removed = _sanitize_tool_schema_for_llama(
            tool.get("input_schema", {})
        )
        removed_pattern_fields += removed
        converted.append(
            {
                "type": "function",
                "function": {
                    "name": tool.get("name", ""),
                    "description": tool.get("description", ""),
                    "parameters": input_schema,
                },
            }
        )
    if removed_pattern_fields > 0:
        logger.warning(
            "TOOL SCHEMA SANITIZE: removed %d regex pattern fields from %d tools",
            removed_pattern_fields,
            len(anthropic_tools),
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
        n_msgs = len(anthropic_body.get("messages", []))
        if (
            PROXY_TOOL_NARROWING_EXPAND_ON_LOOP
            and _conversation_has_tool_results(anthropic_body)
            and n_msgs >= 3
        ):
            logger.info(
                "TOOL NARROWING: %d tools retained (no query tokens during active loop)",
                len(openai_tools),
            )
            return openai_tools

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


def _update_tool_state_stagnation(
    monitor: SessionMonitor,
    latest_tool_fingerprint: str,
    last_user_has_tool_result: bool,
) -> None:
    if not PROXY_TOOL_STATE_MACHINE:
        return

    if not latest_tool_fingerprint or not last_user_has_tool_result:
        monitor.tool_state_stagnation_streak = 0
        monitor.last_tool_fingerprint = latest_tool_fingerprint
        return

    repeated = latest_tool_fingerprint == monitor.last_tool_fingerprint
    recently_seen = latest_tool_fingerprint in monitor.tool_call_history[-4:-1]

    if repeated or recently_seen:
        monitor.tool_state_stagnation_streak += 1
    else:
        monitor.tool_state_stagnation_streak = 0

    monitor.last_tool_fingerprint = latest_tool_fingerprint


def _resolve_state_machine_tool_choice(
    anthropic_body: dict,
    monitor: SessionMonitor,
    has_tool_results: bool,
    last_user_has_tool_result: bool,
) -> tuple[str | None, str]:
    if monitor.tool_turn_phase == "finalize" and monitor.completion_pending:
        # Option 1: Cap recovery attempts to prevent infinite finalize↔review ping-pong
        if monitor.completion_recovery_attempts >= PROXY_COMPLETION_RECOVERY_MAX:
            logger.warning(
                "TOOL STATE MACHINE: completion recovery exhausted (attempts=%d max=%d), "
                "proceeding with finalize despite blockers=%s",
                monitor.completion_recovery_attempts,
                PROXY_COMPLETION_RECOVERY_MAX,
                ",".join(monitor.completion_blockers),
            )
            monitor.completion_pending = False
            monitor.completion_blockers = []
            return None, "completion_recovery_exhausted"
        monitor.note_completion_recovery()
        monitor.set_tool_turn_phase("review", reason="completion_pending")
        monitor.tool_state_auto_budget_remaining = max(1, PROXY_TOOL_STATE_AUTO_BUDGET)
        monitor.tool_state_forced_budget_remaining = max(1, PROXY_TOOL_STATE_FORCED_BUDGET // 2)
        logger.warning(
            "TOOL STATE MACHINE: finalize blocked by completion contract (blockers=%s attempts=%d/%d)",
            ",".join(monitor.completion_blockers),
            monitor.completion_recovery_attempts,
            PROXY_COMPLETION_RECOVERY_MAX,
        )
        return "auto", "completion_pending"

    if not PROXY_TOOL_STATE_MACHINE:
        return None, "disabled"

    n_msgs = len(anthropic_body.get("messages", []))
    latest_user_text = _latest_user_text(anthropic_body).strip()
    if latest_user_text and not last_user_has_tool_result:
        monitor.tool_call_history = []
        if n_msgs <= 1:
            monitor.forced_auto_cooldown_turns = 0
            monitor.consecutive_forced_count = 0
            monitor.no_progress_streak = 0
            monitor.malformed_tool_streak = 0
            monitor.invalid_tool_call_streak = 0
            monitor.required_tool_miss_streak = 0
        monitor.reset_tool_turn_state(reason="fresh_user_text")
        monitor.finalize_continuation_count = 0
        monitor.finalize_synthetic_tool_id = ""
        return None, "fresh_user_text"

    active_loop = (
        has_tool_results
        and last_user_has_tool_result
        and n_msgs >= max(3, PROXY_TOOL_STATE_MIN_MESSAGES)
    )
    if not active_loop:
        if not has_tool_results:
            monitor.tool_call_history = []
            if n_msgs <= 1:
                monitor.forced_auto_cooldown_turns = 0
                monitor.consecutive_forced_count = 0
                monitor.no_progress_streak = 0
                monitor.malformed_tool_streak = 0
                monitor.invalid_tool_call_streak = 0
                monitor.required_tool_miss_streak = 0
        monitor.reset_tool_turn_state(reason="inactive_loop")
        monitor.finalize_continuation_count = 0
        monitor.finalize_synthetic_tool_id = ""
        return None, "inactive_loop"

    if monitor.tool_turn_phase == "bootstrap":
        monitor.set_tool_turn_phase("act", reason="loop_detected")
        monitor.tool_state_forced_budget_remaining = max(
            1, PROXY_TOOL_STATE_FORCED_BUDGET
        )
        monitor.tool_state_auto_budget_remaining = 0

    cycle_looping, cycle_repeat = monitor.detect_tool_cycle(
        window=max(2, PROXY_TOOL_STATE_CYCLE_WINDOW)
    )
    stagnating = monitor.tool_state_stagnation_streak >= max(
        1, PROXY_TOOL_STATE_STAGNATION_THRESHOLD
    )
    finalize_threshold = max(
        max(1, PROXY_TOOL_STATE_FINALIZE_THRESHOLD),
        max(1, PROXY_TOOL_STATE_STAGNATION_THRESHOLD) * 2,
    )
    review_cycle_limit = max(1, PROXY_TOOL_STATE_REVIEW_CYCLE_LIMIT)

    if cycle_looping and monitor.tool_state_stagnation_streak >= finalize_threshold:
        monitor.set_tool_turn_phase("finalize", reason="stagnation_limit")
        monitor.tool_state_auto_budget_remaining = 1
        logger.warning(
            "TOOL STATE MACHINE: forcing finalize turn after prolonged cycle (repeat=%d stagnation=%d)",
            cycle_repeat,
            monitor.tool_state_stagnation_streak,
        )
        return "finalize", "stagnation_limit"

    if (
        monitor.tool_turn_phase in {"act", "review"}
        and monitor.tool_state_review_cycles >= review_cycle_limit
    ):
        monitor.set_tool_turn_phase("finalize", reason="review_cycle_limit")
        monitor.tool_state_auto_budget_remaining = 1
        logger.warning(
            "TOOL STATE MACHINE: forcing finalize turn after repeated review cycles (cycles=%d stagnation=%d)",
            monitor.tool_state_review_cycles,
            monitor.tool_state_stagnation_streak,
        )
        return "finalize", "review_cycle_limit"

    if monitor.tool_turn_phase == "act":
        # Option 3: Early cycle break when same read target is hit 3+ times
        dup_target, dup_tool = monitor.has_duplicate_read_target(threshold=3)
        if dup_target and not cycle_looping and not stagnating:
            cycle_looping = True
            cycle_repeat = 2
            logger.warning(
                "TOOL STATE MACHINE: duplicate read target detected for '%s', triggering early cycle break",
                dup_tool,
            )

        if cycle_looping or stagnating:
            reason = "cycle_detected" if cycle_looping else "stagnation"
            monitor.set_tool_turn_phase("review", reason=reason)
            monitor.tool_state_review_cycles += 1
            monitor.tool_state_auto_budget_remaining = max(
                1, PROXY_TOOL_STATE_AUTO_BUDGET
            )
            monitor.tool_state_forced_budget_remaining = max(
                1, PROXY_TOOL_STATE_FORCED_BUDGET // 2
            )
            # Capture which tools are cycling for narrowing/hint injection
            # Strip argument hashes (e.g. "glob:abc12345" -> "glob") so that
            # tool narrowing can match against actual tool names.
            window = max(2, PROXY_TOOL_STATE_CYCLE_WINDOW)
            recent = [fp for fp in monitor.tool_call_history[-window:] if fp]
            raw_names = []
            for fp in recent:
                for part in fp.split("|"):
                    raw_names.append(part.split(":")[0])
            monitor.cycling_tool_names = list(dict.fromkeys(raw_names))
            # Cycle 18 Option 2: track per-tool cycle counts and ban after 3 cycles
            for name in monitor.cycling_tool_names:
                monitor.tool_cycle_counts[name] = monitor.tool_cycle_counts.get(name, 0) + 1
                if monitor.tool_cycle_counts[name] >= 3 and name not in monitor.session_banned_tools:
                    monitor.session_banned_tools.add(name)
                    logger.warning(
                        "TOOL BAN: '%s' banned for session after %d cycle detections",
                        name,
                        monitor.tool_cycle_counts[name],
                    )
            logger.warning(
                "TOOL STATE MACHINE: entering review (cycle=%s repeat=%d stagnation=%d cycles=%d cycling_tools=%s)",
                cycle_looping,
                cycle_repeat,
                monitor.tool_state_stagnation_streak,
                monitor.tool_state_review_cycles,
                monitor.cycling_tool_names,
            )
            return "required", reason

        if monitor.tool_state_forced_budget_remaining <= 0:
            monitor.set_tool_turn_phase("review", reason="forced_budget_exhausted")
            if cycle_looping or stagnating:
                monitor.tool_state_review_cycles += 1
                monitor.tool_state_unproductive_exhaustion_streak = 0
            else:
                # Track consecutive unproductive exhaustions. Even without a
                # detected cycle, if the model burns through the forced budget
                # repeatedly with distinct-but-useless tool calls, treat it as
                # a loop and force finalize. Catches the 35B-A3B failure mode
                # where different short tool calls defeat per-tool cycle
                # detection.
                monitor.tool_state_unproductive_exhaustion_streak += 1
                if monitor.tool_state_unproductive_exhaustion_streak >= PROXY_UNPRODUCTIVE_EXHAUSTION_LIMIT:
                    logger.warning(
                        "TOOL STATE MACHINE: %d consecutive unproductive budget exhaustions — forcing finalize",
                        monitor.tool_state_unproductive_exhaustion_streak,
                    )
                    monitor.set_tool_turn_phase("finalize", reason="unproductive_exhaustion")
                    monitor.tool_state_unproductive_exhaustion_streak = 0
                    monitor.tool_state_forced_budget_remaining = 0
                    monitor.tool_state_auto_budget_remaining = 0
                    return "finalize", "unproductive_exhaustion"
            monitor.tool_state_auto_budget_remaining = max(
                1, PROXY_TOOL_STATE_AUTO_BUDGET
            )
            monitor.tool_state_forced_budget_remaining = max(
                1, PROXY_TOOL_STATE_FORCED_BUDGET // 2
            )
            logger.warning(
                "TOOL STATE MACHINE: forced budget exhausted, entering review (cycles=%d cycling=%s stagnating=%s unprod_exh=%d)",
                monitor.tool_state_review_cycles,
                cycle_looping,
                stagnating,
                monitor.tool_state_unproductive_exhaustion_streak,
            )
            return "required", "forced_budget_exhausted"

        monitor.tool_state_forced_budget_remaining -= 1
        return "required", "act"

    if monitor.tool_turn_phase == "review":
        if monitor.tool_state_auto_budget_remaining <= 0:
            monitor.set_tool_turn_phase("act", reason="review_budget_spent")
            monitor.tool_state_forced_budget_remaining = max(
                1, PROXY_TOOL_STATE_FORCED_BUDGET // 2
            )
            # If stagnation cleared during review, the model tried a
            # different approach — reward by reducing cycle pressure and
            # lifting persistent tool exclusion.
            if monitor.tool_state_stagnation_streak == 0 and monitor.tool_state_review_cycles > 0:
                monitor.tool_state_review_cycles = max(0, monitor.tool_state_review_cycles - 1)
                monitor.cycling_tool_names = []
                logger.info(
                    "TOOL STATE MACHINE: review_cycles decremented to %d, cycling exclusion lifted (stagnation cleared)",
                    monitor.tool_state_review_cycles,
                )
            return "required", "review_complete"

        monitor.tool_state_auto_budget_remaining -= 1
        if monitor.tool_state_auto_budget_remaining == 0:
            monitor.set_tool_turn_phase("act", reason="review_budget_spent")
            monitor.tool_state_forced_budget_remaining = max(
                1, PROXY_TOOL_STATE_FORCED_BUDGET // 2
            )
            return "required", "review_complete"
        return "required", "review"

    if monitor.tool_turn_phase == "finalize":
        if monitor.tool_state_auto_budget_remaining <= 0:
            monitor.reset_tool_turn_state(reason="finalize_complete")
            monitor.reset_completion_recovery()
            return None, "finalize_complete"

        monitor.tool_state_auto_budget_remaining -= 1
        if monitor.tool_state_auto_budget_remaining == 0:
            monitor.reset_tool_turn_state(reason="finalize_complete")
            monitor.reset_completion_recovery()
        return "finalize", "finalize"

    monitor.reset_tool_turn_state(reason="unknown_phase")
    return None, "unknown_phase"


def build_openai_request(
    anthropic_body: dict,
    monitor: SessionMonitor,
    profile_prompt_suffix: str | None = None,
    profile_grammar: str | None = None,
) -> dict:
    """Build an OpenAI Chat Completions request from an Anthropic Messages request."""
    openai_body = {
        "model": anthropic_body.get("model", "default"),
        "messages": anthropic_to_openai_messages(anthropic_body),
        "stream": anthropic_body.get("stream", False),
    }

    has_tools = _has_tool_definitions(anthropic_body)

    # Global thinking-off (G stub): apply to every request, not just tool
    # turns. Currently default-off — enable_thinking=False breaks Gemma 4
    # (empty content with stop_reason=length). Per-path tool-turn handling
    # below (DISABLE_THINKING_ON_TOOL_TURNS) is additive — ALWAYS supersedes.
    if PROXY_DISABLE_THINKING_ALWAYS:
        openai_body["enable_thinking"] = False

    # Inject agentic protocol instructions only for tool-enabled turns.
    # Use minimal supplement for qwen models to reduce prompt leak surface.
    if has_tools:
        model_name = anthropic_body.get("model", "").lower()
        supplement = (
            _AGENTIC_SYSTEM_SUPPLEMENT_MINIMAL
            if "qwen" in model_name and PROXY_AGENTIC_SUPPLEMENT_MODE != "legacy"
            else _AGENTIC_SYSTEM_SUPPLEMENT
        )
        if (
            openai_body["messages"]
            and openai_body["messages"][0].get("role") == "system"
        ):
            openai_body["messages"][0]["content"] += supplement
        else:
            # No system message from the client; inject one.
            openai_body["messages"].insert(
                0,
                {
                    "role": "system",
                    "content": supplement.strip(),
                },
            )
        if profile_prompt_suffix:
            openai_body["messages"][0]["content"] += f"\n\n{profile_prompt_suffix}"

    if "max_tokens" in anthropic_body:
        requested_raw = max(1, int(anthropic_body["max_tokens"]))

        # Enforce configurable minimum floor for thinking mode: model needs
        # tokens for reasoning (<think>...</think>) plus actual response/tool
        # calls. Set PROXY_MAX_TOKENS_FLOOR=0 to disable this floor.
        #
        # The floor is ONLY applied when thinking is actually enabled —
        # skip it for non-tool requests (tools=0) and for tool turns
        # with thinking disabled, to prevent inflating short preflight
        # requests (e.g. max_tokens=100 for plan generation).
        thinking_active_for_request = (
            has_tools
            and not PROXY_DISABLE_THINKING_ON_TOOL_TURNS
            and not PROXY_DISABLE_THINKING_ALWAYS
        )
        skip_floor = (
            not has_tools  # non-tool requests don't need thinking headroom
            or PROXY_DISABLE_THINKING_ON_TOOL_TURNS  # thinking disabled on tool turns
            or PROXY_MAX_TOKENS_FLOOR <= 0  # floor explicitly disabled
        )
        if skip_floor:
            requested_max = requested_raw
            if requested_raw < PROXY_MAX_TOKENS_FLOOR and PROXY_MAX_TOKENS_FLOOR > 0:
                logger.info(
                    "MAX_TOKENS floor skipped: has_tools=%s thinking_active=%s requested=%d floor=%d",
                    has_tools,
                    thinking_active_for_request,
                    requested_raw,
                    PROXY_MAX_TOKENS_FLOOR,
                )
        else:
            requested_max = _resolve_max_tokens_request(requested_raw)

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

            model_name = str(anthropic_body.get("model", "")).lower()
            utilization = estimated_input / ctx_window if ctx_window else 0.0
            if (
                PROXY_OPUS46_MAX_TOKENS_HIGH_CTX > 0
                and "opus" in model_name
                and "4.6" in model_name
                and utilization >= PROXY_OPUS46_CTX_THRESHOLD
                and requested_max > PROXY_OPUS46_MAX_TOKENS_HIGH_CTX
            ):
                logger.warning(
                    "MAX_TOKENS capped for Opus 4.6 at high context: %d -> %d (ctx=%d input~%d util=%.1f%%)",
                    requested_max,
                    PROXY_OPUS46_MAX_TOKENS_HIGH_CTX,
                    ctx_window,
                    estimated_input,
                    utilization * 100,
                )
                requested_max = PROXY_OPUS46_MAX_TOKENS_HIGH_CTX

        # Option 1+3+4: Cap max_tokens for tool turns to prevent 32K waste.
        # Tool call responses rarely need more than a few thousand tokens.
        # After garbled/malformed output, use an even lower cap.
        if has_tools and PROXY_TOOL_TURN_MAX_TOKENS > 0:
            if monitor.last_response_garbled and PROXY_TOOL_TURN_MAX_TOKENS_GARBLED > 0:
                tool_cap = PROXY_TOOL_TURN_MAX_TOKENS_GARBLED
            else:
                tool_cap = PROXY_TOOL_TURN_MAX_TOKENS
            if requested_max > tool_cap:
                logger.info(
                    "TOOL TURN MAX_TOKENS cap: %d -> %d (garbled_prev=%s)",
                    requested_max,
                    tool_cap,
                    monitor.last_response_garbled,
                )
                requested_max = tool_cap

        openai_body["max_tokens"] = requested_max
    if "temperature" in anthropic_body:
        openai_body["temperature"] = anthropic_body["temperature"]
    if "top_p" in anthropic_body:
        openai_body["top_p"] = anthropic_body["top_p"]
    if "stop_sequences" in anthropic_body:
        openai_body["stop"] = anthropic_body["stop_sequences"]

    # Force controlled temperature for tool-call turns to reduce garbled output
    # Cycle 15 Option 2: use lower temperature after contamination resets
    if has_tools:
        client_temp = openai_body.get("temperature")
        target_temp = PROXY_TOOL_TURN_TEMPERATURE
        if monitor.contamination_resets > 0:
            target_temp = min(target_temp, 0.1)
        if client_temp is None or client_temp > target_temp:
            openai_body["temperature"] = target_temp
            extra = ""
            if monitor.contamination_resets > 0:
                extra = f" (post-contamination reset, resets={monitor.contamination_resets})"
            logger.info(
                "TOOL TURN TEMP: forcing temperature=%.2f (was %s) for tool-enabled request%s",
                target_temp,
                client_temp,
                extra,
            )

    # Convert Anthropic tools to OpenAI function-calling tools
    if has_tools:
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
        has_tool_results = _conversation_has_tool_results(anthropic_body)

        # Detect and strip synthetic finalize continuation before fingerprinting
        _detect_and_strip_synthetic_continuation(anthropic_body, monitor)

        # Record tool calls from the last assistant message for loop detection
        latest_tool_fingerprint = _record_last_assistant_tool_calls(
            anthropic_body, monitor
        )
        last_user_has_tool_result = _last_user_has_tool_result(anthropic_body)
        _update_tool_state_stagnation(
            monitor,
            latest_tool_fingerprint,
            last_user_has_tool_result,
        )
        monitor.finalize_turn_active = False
        monitor.update_completion_state(anthropic_body, has_tool_results)
        state_choice, state_reason = _resolve_state_machine_tool_choice(
            anthropic_body,
            monitor,
            has_tool_results,
            last_user_has_tool_result,
        )

        # TOOL STARVATION BREAKER: if model repeatedly fails to produce tool
        # calls despite required, strip tools to let it generate text and break
        # the forcing loop.
        if (
            monitor.consecutive_forced_count >= PROXY_TOOL_STARVATION_THRESHOLD
            and _last_assistant_was_text_only(anthropic_body)
        ):
            openai_body.pop("tool_choice", None)
            openai_body.pop("tools", None)
            monitor.tool_starvation_streak += 1
            monitor.consecutive_forced_count = 0
            monitor.no_progress_streak = 0
            monitor.reset_tool_turn_state(reason="tool_starvation_breaker")
            logger.warning(
                "TOOL STARVATION BREAKER: stripped tools after %d forced turns with no tool output (starvation_streak=%d)",
                PROXY_TOOL_STARVATION_THRESHOLD,
                monitor.tool_starvation_streak,
            )
            # Skip all further tool_choice logic — no tools this turn
            if PROXY_DISABLE_THINKING_ON_TOOL_TURNS:
                openai_body["enable_thinking"] = False
            if PROXY_DISABLE_SPEC_ON_TOOL_TURNS:
                openai_body["speculative.n_max"] = 0
            return openai_body

        # Check if forced-tool dampener or loop breaker should override tool_choice
        if monitor.consume_forced_auto_turn():
            openai_body["tool_choice"] = "auto"
            monitor.consecutive_forced_count = 0
            monitor.no_progress_streak = 0
            logger.warning(
                "tool_choice set to 'auto' by FORCED-TOOL DAMPENER (remaining=%d)",
                monitor.forced_auto_cooldown_turns,
            )
        elif state_choice == "auto":
            openai_body["tool_choice"] = "auto"
            monitor.consecutive_forced_count = 0
            monitor.no_progress_streak = 0
            logger.info(
                "tool_choice set to 'auto' by TOOL STATE MACHINE (phase=%s reason=%s auto_budget=%d stagnation=%d)",
                monitor.tool_turn_phase,
                state_reason,
                monitor.tool_state_auto_budget_remaining,
                monitor.tool_state_stagnation_streak,
            )
        elif state_choice == "finalize":
            openai_body.pop("tool_choice", None)
            openai_body.pop("tools", None)
            monitor.finalize_turn_active = True
            monitor.finalize_hard_stop_count += 1  # monotonic marker: a finalize fired this session
            monitor.consecutive_forced_count = 0
            monitor.no_progress_streak = 0
            # Option 3: Inject explicit "no tool calls" instruction to reduce XML leak
            finalize_instruction = {
                "role": "user",
                "content": (
                    "Respond with plain text only. Do not emit any tool calls, "
                    "XML tags, or JSON objects."
                ),
            }
            msgs = openai_body.get("messages", [])
            msgs.append(finalize_instruction)
            logger.warning(
                "TOOL STATE MACHINE: tools temporarily disabled for finalize turn (reason=%s)",
                state_reason,
            )
        elif state_choice == "required":
            openai_body["tool_choice"] = "required"
            monitor.consecutive_forced_count += 1
            monitor.no_progress_streak = (
                0 if last_user_has_tool_result else monitor.no_progress_streak + 1
            )
            # Inject cycle-break instruction when entering review
            # Option 3 (Cycle 14): Escalate hint text based on review cycle count
            if (
                monitor.tool_turn_phase == "review"
                and state_reason in {"cycle_detected", "stagnation"}
                and monitor.cycling_tool_names
            ):
                cycling_names = ", ".join(monitor.cycling_tool_names)
                cycles = monitor.tool_state_review_cycles
                if cycles <= 1:
                    cycle_hint = (
                        f"You have been repeatedly calling the same tool(s): {cycling_names}. "
                        "This is not making progress. Use a DIFFERENT tool to advance the task, "
                        "or call a tool that produces your final answer."
                    )
                else:
                    cycle_hint = (
                        f"CRITICAL: You have cycled {cycling_names} for {cycles} review rounds without progress. "
                        "State what you have accomplished so far and what the next DIFFERENT action should be. "
                        "Do NOT call the same tool again. Choose a completely different approach or "
                        "produce your final answer now."
                    )
                messages = openai_body.get("messages", [])
                messages.append({"role": "user", "content": cycle_hint})
                openai_body["messages"] = messages
                logger.warning(
                    "CYCLE BREAK: injected hint about cycling tools: %s (escalation=%d)",
                    cycling_names,
                    cycles,
                )
            # Narrow tools to exclude cycling tools + session-banned tools
            # Option 1 (Cycle 13): if any cycling tool is read-only, exclude entire class
            # Option 1 (Cycle 14): persist exclusion during act phase too, not just review
            # Option 2 (Cycle 18): always exclude session-banned tools
            if (
                (monitor.cycling_tool_names or monitor.session_banned_tools)
                and "tools" in openai_body
            ):
                exclude_set = set(monitor.cycling_tool_names) | monitor.session_banned_tools
                # Expand to full read-only class if any cycling tool is read-only
                if any(n.lower() in {c.lower() for c in _READ_ONLY_TOOL_CLASS} for n in exclude_set):
                    exclude_set |= _READ_ONLY_TOOL_CLASS
                original_count = len(openai_body["tools"])
                narrowed = [
                    t
                    for t in openai_body["tools"]
                    if t.get("function", {}).get("name") not in exclude_set
                ]
                if narrowed:
                    openai_body["tools"] = narrowed
                    # Only log on first activation or phase transitions to reduce noise
                    if state_reason in {"cycle_detected", "stagnation"}:
                        logger.warning(
                            "CYCLE BREAK: narrowed tools from %d to %d (excluded %s, read_only_class=%s)",
                            original_count,
                            len(narrowed),
                            monitor.cycling_tool_names,
                            any(n.lower() in {c.lower() for c in _READ_ONLY_TOOL_CLASS} for n in monitor.cycling_tool_names),
                        )
                else:
                    logger.warning(
                        "CYCLE BREAK: cannot narrow tools — all tools are cycling, keeping original set",
                    )
            logger.info(
                "tool_choice forced to 'required' by TOOL STATE MACHINE (phase=%s reason=%s forced_budget=%d)",
                monitor.tool_turn_phase,
                state_reason,
                monitor.tool_state_forced_budget_remaining,
            )
        elif state_reason in {"fresh_user_text", "inactive_loop"} and n_msgs <= 1:
            monitor.consecutive_forced_count = 0
            monitor.no_progress_streak = 0
            # Force tool_choice=required on first turn to ensure local models
            # produce a tool call instead of plain text (cold-start fix).
            # Gated by PROXY_FORCE_TOOL_CHOICE_ON_COLD_START — Gemma 4 routes
            # 'auto' correctly without needing the force, and the force
            # triggers malformed-JSON emissions on Gemma 4 cold turns.
            if has_tools and n_msgs == 1 and PROXY_FORCE_TOOL_CHOICE_ON_COLD_START:
                openai_body["tool_choice"] = "required"
                logger.info(
                    "tool_choice forced to 'required' on first turn (reason=%s n_msgs=%d cold_start_fix=true)",
                    state_reason,
                    n_msgs,
                )
            else:
                logger.info(
                    "tool_choice left unchanged after state reset (reason=%s n_msgs=%d)",
                    state_reason,
                    n_msgs,
                )
        elif monitor.should_release_tool_choice():
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
            if not has_tool_results:
                monitor.reset_tool_turn_state(reason="no_tool_results")


        if PROXY_DISABLE_THINKING_ALWAYS or PROXY_DISABLE_THINKING_ON_TOOL_TURNS:
            openai_body["enable_thinking"] = False
            logger.info(
                "Thinking disabled (always=%s tool_turns=%s)",
                PROXY_DISABLE_THINKING_ALWAYS,
                PROXY_DISABLE_THINKING_ON_TOOL_TURNS,
            )

        if PROXY_DISABLE_SPEC_ON_TOOL_TURNS:
            openai_body["speculative.n_max"] = 0
            logger.info(
                "Spec decoding disabled for tool turn (PROXY_DISABLE_SPEC_ON_TOOL_TURNS=on)"
            )

        _apply_tool_call_grammar(openai_body, grammar_override=profile_grammar)

    return openai_body


def _tool_call_fingerprint(block: dict) -> str:
    """Create a fingerprint for a tool call that includes both name and a
    short hash of the arguments.  This prevents false cycle detection when
    the same tool is called with different arguments (e.g. reading different
    files)."""
    name = block.get("name", "unknown")
    inp = block.get("input")
    if inp:
        arg_str = json.dumps(inp, sort_keys=True, separators=(",", ":"))
        arg_hash = hashlib.md5(arg_str.encode()).hexdigest()[:8]
        return f"{name}:{arg_hash}"
    return name


def _detect_and_strip_synthetic_continuation(
    anthropic_body: dict, monitor: SessionMonitor
) -> bool:
    """Detect if the latest messages contain a synthetic finalize continuation
    tool_use/tool_result pair.  If found, strip them from the conversation and
    reset the state machine so the model gets a fresh act cycle.

    Returns True if a synthetic continuation was detected and handled.
    """
    synthetic_id = monitor.finalize_synthetic_tool_id
    if not synthetic_id:
        return False

    messages = anthropic_body.get("messages", [])
    if not messages:
        return False

    # Walk backwards to find the synthetic tool_result in a user message
    found = False
    for msg in reversed(messages):
        if msg.get("role") != "user":
            continue
        content = msg.get("content")
        if not isinstance(content, list):
            break
        has_synthetic = any(
            isinstance(b, dict)
            and b.get("type") == "tool_result"
            and b.get("tool_use_id") == synthetic_id
            for b in content
        )
        if not has_synthetic:
            break

        # Strip synthetic tool_result from user message
        new_content = [
            b for b in content
            if not (
                isinstance(b, dict)
                and b.get("type") == "tool_result"
                and b.get("tool_use_id") == synthetic_id
            )
        ]
        if not new_content:
            msg["content"] = [{"type": "text", "text": "Continue working on the task."}]
        else:
            msg["content"] = new_content

        # Strip synthetic tool_use from the preceding assistant message
        for asst_msg in reversed(messages):
            if asst_msg.get("role") != "assistant":
                continue
            asst_content = asst_msg.get("content")
            if isinstance(asst_content, list):
                asst_msg["content"] = [
                    b for b in asst_content
                    if not (
                        isinstance(b, dict)
                        and b.get("type") == "tool_use"
                        and b.get("id") == synthetic_id
                    )
                ]
            break

        found = True
        break

    if not found:
        return False

    # Reset state machine for fresh act cycle
    monitor.finalize_synthetic_tool_id = ""
    monitor.reset_tool_turn_state(reason="finalize_continuation_resume")
    monitor.reset_completion_recovery()
    monitor.tool_call_history = []
    logger.info(
        "FINALIZE CONTINUATION: stripped synthetic tool id=%s, "
        "reset state machine for fresh act cycle (continuations=%d/%d)",
        synthetic_id,
        monitor.finalize_continuation_count,
        PROXY_FINALIZE_CONTINUATION_MAX,
    )
    return True


def _record_last_assistant_tool_calls(
    anthropic_body: dict, monitor: SessionMonitor
) -> str:
    """Extract tool call names from the last assistant message and record
    them in the session monitor for loop detection.

    Fingerprints now include an argument hash so that the same tool called
    with different arguments (e.g. read(file_a) vs read(file_b)) produces
    distinct fingerprints, preventing false cycle/stagnation detection."""
    messages = anthropic_body.get("messages", [])
    tool_fingerprints = []
    tool_targets: dict[str, str] = {}
    for msg in reversed(messages):
        if msg.get("role") != "assistant":
            continue
        content = msg.get("content")
        if isinstance(content, list):
            for block in content:
                if isinstance(block, dict) and block.get("type") == "tool_use":
                    tool_fingerprints.append(_tool_call_fingerprint(block))
                    # Extract target key for read-only dedup (Option 3)
                    name = block.get("name", "unknown")
                    inp = block.get("input", {})
                    if isinstance(inp, dict):
                        target = (
                            inp.get("file_path")
                            or inp.get("path")
                            or inp.get("pattern")
                            or inp.get("command", "")[:80]
                        )
                        if target:
                            tool_targets[name] = str(target)
        break
    if tool_fingerprints:
        fingerprint = "|".join(sorted(tool_fingerprints))
        monitor.record_tool_calls(
            [fp.split(":")[0] for fp in tool_fingerprints],
            tool_targets=tool_targets,
            fingerprint=fingerprint,
        )
        return fingerprint
    return ""


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

    has_tool_results = _conversation_has_tool_results(anthropic_body)

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


def _extract_openai_tool_calls(openai_resp: dict) -> list[dict]:
    _, message = _extract_openai_choice(openai_resp)
    tool_calls = message.get("tool_calls") or []
    return tool_calls if isinstance(tool_calls, list) else []


def _openai_has_tool_calls(openai_resp: dict) -> bool:
    return bool(_extract_openai_tool_calls(openai_resp))


def _parse_openai_function_arguments(raw_args) -> tuple[dict | None, str | None]:
    if isinstance(raw_args, dict):
        return raw_args, None
    if isinstance(raw_args, str):
        try:
            parsed = json.loads(raw_args)
        except json.JSONDecodeError:
            return None, "invalid_json"
        if not isinstance(parsed, dict):
            return None, "arguments_not_object"
        return parsed, None
    return None, "invalid_arguments_type"


def _schema_type_matches(value, expected_type: str) -> bool:
    if expected_type == "string":
        return isinstance(value, str)
    if expected_type == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if expected_type == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if expected_type == "boolean":
        return isinstance(value, bool)
    if expected_type == "array":
        return isinstance(value, list)
    if expected_type == "object":
        return isinstance(value, dict)
    if expected_type == "null":
        return value is None
    return True


def _string_contains_tool_markup(value: str) -> bool:
    lowered = value.lower()
    markers = (
        "<parameter", "</parameter", "<tool_call", "<function=", "</function",
        "<|tool_call>", "<tool_call|>",  # Gemma 4 native DSL
    )
    return any(marker in lowered for marker in markers)


def _validate_tool_arguments_against_schema(
    args: dict, input_schema: dict
) -> tuple[bool, str]:
    if not isinstance(input_schema, dict):
        return True, ""

    required = input_schema.get("required") or []
    if isinstance(required, list):
        for field in required:
            if not isinstance(field, str):
                continue
            if field not in args:
                return False, f"missing required field '{field}'"
            value = args.get(field)
            if value is None:
                return False, f"required field '{field}' is null"
            if isinstance(value, str) and not value.strip():
                return False, f"required field '{field}' is empty"
            if isinstance(value, str) and _string_contains_tool_markup(value):
                return (
                    False,
                    f"required field '{field}' contains malformed tool markup",
                )

    properties = input_schema.get("properties") or {}
    if isinstance(properties, dict):
        for key, prop_schema in properties.items():
            if key not in args:
                continue
            if not isinstance(prop_schema, dict):
                continue
            expected = prop_schema.get("type")
            if isinstance(expected, str):
                if not _schema_type_matches(args[key], expected):
                    return (
                        False,
                        f"type mismatch for '{key}' (expected {expected})",
                    )
                if expected == "string" and isinstance(args[key], str):
                    if _string_contains_tool_markup(args[key]):
                        return (
                            False,
                            f"string field '{key}' contains malformed tool markup",
                        )
            elif isinstance(expected, list) and expected:
                if not any(_schema_type_matches(args[key], t) for t in expected):
                    expected_str = ",".join(str(t) for t in expected)
                    return (
                        False,
                        f"type mismatch for '{key}' (expected one of {expected_str})",
                    )

    return True, ""


# ---------------------------------------------------------------------------
# Extract tool calls from <tool_call> XML tags in text content
# ---------------------------------------------------------------------------
# Qwen3.5 via llama.cpp sometimes emits tool calls as XML-wrapped JSON in the
# text content field rather than as structured ``tool_calls`` objects in the
# OpenAI response.  The regex below captures these and converts them to
# standard OpenAI-format tool_calls so downstream translation works correctly.

_TOOL_CALL_XML_RE = re.compile(
    r"<tool_call>\s*(\{.*?\})\s*</tool_call>",
    re.DOTALL,
)


# ---------------------------------------------------------------------------
# Gemma 4 tool-call DSL extractors
# ---------------------------------------------------------------------------
# Gemma 4's chat template emits tool calls as:
#   <|tool_call>call:NAME{key1:<|"|>value1<|"|>,key2:42}<tool_call|>
# Note the asymmetric open/close tags and `<|"|>` substitution for `"`.
# Llama-server's --jinja autoparser usually converts these to standard
# OpenAI tool_calls, but the raw form can leak through on (a) malformed
# emissions, (b) finalize turns, (c) non-tool-template requests where the
# model still tries to call a tool. This parser catches those cases.
#
# Gemma 4 also falls back to ```json {"name": "...", "arguments": {...}} ```
# markdown blocks when it doesn't trust the template — observed when
# tool_choice was forced 'required' but the model lacked confidence in the
# native format. Only treated as a tool call when the JSON has a "name".
_GEMMA4_TOOL_CALL_DSL_RE = re.compile(
    r"<\|tool_call>\s*call:\s*([A-Za-z_][A-Za-z0-9_]*)\s*\{(.*?)\}\s*<tool_call\|>",
    re.DOTALL,
)
# Markdown JSON code-block fallback. Group 1 = JSON content (may include
# leading/trailing whitespace inside the block).
_GEMMA4_MARKDOWN_JSON_RE = re.compile(
    r"```(?:json)?\s*(\{.*?\})\s*```",
    re.DOTALL,
)


def _parse_gemma4_dsl_args(raw: str) -> dict | None:
    """Parse Gemma 4's tool-call DSL arg body into a Python dict.

    Input shape (between the `{` and `}` of the DSL):
        key1:<|"|>str value<|"|>,key2:42,key3:true,key4:[<|"|>a<|"|>,<|"|>b<|"|>]

    Strategy: replace `<|"|>` with `"`, wrap unquoted keys in quotes, then
    feed to json.loads. Returns None on parse failure (caller decides).
    """
    if not raw or not raw.strip():
        return {}
    s = raw.replace('<|"|>', '"')
    # Wrap unquoted keys: `key:` -> `"key":` (only at start or after `,` / `{` / whitespace).
    s = re.sub(r"(^|[\s,{\[])([A-Za-z_][A-Za-z0-9_]*)\s*:", r'\1"\2":', s)
    s = "{" + s + "}"
    try:
        parsed = json.loads(s)
        return parsed if isinstance(parsed, dict) else None
    except json.JSONDecodeError:
        return None


def _schema_match_tool(payload: dict, available_tools: list[dict]) -> str | None:
    """Match a bare-args dict against available tool schemas.

    Score each tool by:
      - +10 per required field present in payload
      - +1 per optional property present
      - -5 per payload key NOT in tool's properties
      - -100 if any required field is missing
    Return the name of the highest-scoring tool, or None if no clear match.
    Caller must require score >= 10 (at least one required-field hit).
    """
    if not isinstance(payload, dict) or not available_tools:
        return None
    payload_keys = set(payload.keys())
    best_name = None
    best_score = 0
    for tool in available_tools:
        if not isinstance(tool, dict):
            continue
        # Anthropic tools format: {"name": ..., "input_schema": {...}}
        # OpenAI format: {"type": "function", "function": {"name": ..., "parameters": {...}}}
        name = tool.get("name")
        schema = tool.get("input_schema")
        if name is None and isinstance(tool.get("function"), dict):
            name = tool["function"].get("name")
            schema = tool["function"].get("parameters")
        if not isinstance(name, str) or not isinstance(schema, dict):
            continue
        properties = schema.get("properties") if isinstance(schema.get("properties"), dict) else {}
        required = set(schema.get("required") or [])
        prop_keys = set(properties.keys())
        score = 0
        missing_required = required - payload_keys
        if missing_required:
            score -= 100
        score += 10 * len(required & payload_keys)
        score += len((payload_keys & prop_keys) - required)
        score -= 5 * len(payload_keys - prop_keys)
        if score > best_score:
            best_score = score
            best_name = name
    return best_name if best_score >= 10 else None


def _extract_gemma4_tool_calls(
    text: str, available_tools: list[dict] | None = None
) -> tuple[list[dict], str]:
    """Parse Gemma 4 tool-call emissions out of *text*.

    Three formats handled, in order:
      1. Native DSL: ``<|tool_call>call:N{...}<tool_call|>``
      2. Markdown with name: ``​`json\\n{"name": "N", "arguments": {...}}\\n`​``
      3. Markdown bare-args + ``available_tools`` provided — schema-match
         against tool definitions (fix D for Gemma 4 cold-turn malformation
         where the model emits ``{"city": "Paris"}`` for a get_weather call
         instead of ``{"name": "get_weather", "arguments": {"city": "Paris"}}``).
         Without ``available_tools``, bare-args blocks pass through as text.

    Returns ``(extracted_openai_tool_calls, remaining_text)``.
    """
    if "<|tool_call>" not in text and "```" not in text:
        return [], text

    extracted: list[dict] = []
    matched_spans: list[tuple[int, int]] = []

    # Pattern 1: native DSL
    for m in _GEMMA4_TOOL_CALL_DSL_RE.finditer(text):
        name = m.group(1).strip()
        body = m.group(2) or ""
        if not name:
            continue
        args = _parse_gemma4_dsl_args(body)
        if args is None:
            # DSL body unparseable; skip and let model retry next turn.
            continue
        extracted.append(
            {
                "id": f"call_{uuid.uuid4().hex[:12]}",
                "type": "function",
                "function": {
                    "name": name,
                    "arguments": json.dumps(args, separators=(",", ":")),
                },
            }
        )
        matched_spans.append(m.span())

    # Pattern 2: markdown JSON fallback (only if no DSL hit AND text has ```)
    if not extracted and "```" in text:
        for m in _GEMMA4_MARKDOWN_JSON_RE.finditer(text):
            raw_json = m.group(1)
            try:
                payload = json.loads(raw_json)
            except json.JSONDecodeError:
                # Try a JSON repair like the Qwen path does
                repaired = _repair_tool_call_json(raw_json)
                if not repaired:
                    continue
                try:
                    payload = json.loads(repaired)
                except json.JSONDecodeError:
                    continue
            if not isinstance(payload, dict):
                continue
            name = payload.get("name")
            arguments_obj = None
            if isinstance(name, str) and name:
                # Standard {name, arguments} form
                arguments_obj = payload.get("arguments", payload.get("args", {}))
            elif available_tools:
                # Bare-args block — try schema-matching against available tools
                matched = _schema_match_tool(payload, available_tools)
                if matched is None:
                    continue
                name = matched
                arguments_obj = payload  # whole payload IS the args
                logger.info(
                    "TOOL CALL EXTRACTION: schema-matched bare-args markdown JSON to tool '%s' (keys=%s)",
                    name,
                    sorted(payload.keys())[:6],
                )
            else:
                # No name, no tools to match against — pass through as text
                continue
            if isinstance(arguments_obj, dict):
                arguments = json.dumps(arguments_obj, separators=(",", ":"))
            elif isinstance(arguments_obj, str):
                arguments = arguments_obj
            else:
                arguments = "{}"
            extracted.append(
                {
                    "id": f"call_{uuid.uuid4().hex[:12]}",
                    "type": "function",
                    "function": {"name": name, "arguments": arguments},
                }
            )
            matched_spans.append(m.span())

    if not extracted:
        return [], text

    # Strip matched spans from text (in reverse to keep indices valid)
    remaining = text
    for start, end in sorted(matched_spans, key=lambda s: -s[0]):
        remaining = remaining[:start] + remaining[end:]
    remaining = remaining.strip()

    logger.info(
        "TOOL CALL EXTRACTION: recovered %d Gemma 4 tool call(s) from text content",
        len(extracted),
    )
    return extracted, remaining


def _repair_tool_call_json(raw: str) -> str | None:
    """Attempt to repair common garbled JSON in tool call payloads.

    Returns repaired JSON string, or None if repair is not possible.
    Handles: trailing braces, unbalanced brackets, truncated strings.
    """
    s = raw.strip()
    if not s.startswith("{"):
        return None
    # Strip trailing garbage (runaway braces/brackets)
    while s.endswith("}}") and s.count("{") < s.count("}"):
        s = s[:-1]
    while s.endswith("]]") and s.count("[") < s.count("]"):
        s = s[:-1]
    # Balance braces
    open_b = s.count("{") - s.count("}")
    if open_b > 0:
        s += "}" * open_b
    elif open_b < 0:
        # Too many closing braces — trim from end
        for _ in range(-open_b):
            idx = s.rfind("}")
            if idx > 0:
                s = s[:idx] + s[idx + 1:]
    # Try to parse
    try:
        json.loads(s)
        return s
    except json.JSONDecodeError:
        pass
    # Try truncating at last valid comma + closing
    for end in range(len(s) - 1, max(0, len(s) - 200), -1):
        candidate = s[:end].rstrip().rstrip(",") + "}" * max(0, s[:end].count("{") - s[:end].count("}"))
        try:
            json.loads(candidate)
            return candidate
        except json.JSONDecodeError:
            continue
    return None


def _extract_tool_calls_from_text(
    text: str, available_tools: list[dict] | None = None
) -> tuple[list[dict], str]:
    """Parse ``<tool_call>{...}</tool_call>`` blocks out of *text*.

    Returns a tuple of (extracted_openai_tool_calls, remaining_text).
    Each extracted call is in OpenAI ``tool_calls`` format::

        {"id": "...", "type": "function", "function": {"name": "...", "arguments": "..."}}

    The *remaining_text* has the matched ``<tool_call>`` blocks removed.
    If no valid blocks are found, falls back to Gemma 4's
    ``<|tool_call>call:N{...}<tool_call|>`` DSL and ```json``` markdown
    blocks. Anything not matching any known format passes through unchanged
    so plain prose isn't mutated.
    """
    if (
        "<tool_call>" not in text
        and "<|tool_call>" not in text
        and "```" not in text
    ):
        return [], text

    extracted: list[dict] = []
    for match in _TOOL_CALL_XML_RE.finditer(text):
        raw_json = match.group(1)
        try:
            payload = json.loads(raw_json)
        except json.JSONDecodeError:
            # Cycle 15 Option 1: attempt JSON repair before giving up
            repaired = _repair_tool_call_json(raw_json)
            if repaired:
                try:
                    payload = json.loads(repaired)
                    logger.info(
                        "TOOL CALL EXTRACTION: repaired garbled JSON in <tool_call> block"
                    )
                except json.JSONDecodeError:
                    continue
            else:
                continue
        if not isinstance(payload, dict):
            continue

        name = payload.get("name")
        if not isinstance(name, str) or not name:
            continue

        arguments = payload.get("arguments", {})
        if isinstance(arguments, dict):
            arguments = json.dumps(arguments, separators=(",", ":"))
        elif not isinstance(arguments, str):
            arguments = "{}"

        extracted.append(
            {
                "id": f"call_{uuid.uuid4().hex[:12]}",
                "type": "function",
                "function": {"name": name, "arguments": arguments},
            }
        )

    if not extracted:
        # Try Gemma 4's DSL + markdown-JSON fallback. Anything still not
        # matching falls through as plain text so prose isn't mutated.
        return _extract_gemma4_tool_calls(text, available_tools=available_tools)

    # Strip matched tool_call blocks from the text
    remaining = _TOOL_CALL_XML_RE.sub("", text).strip()

    logger.info(
        "TOOL CALL EXTRACTION: recovered %d tool call(s) from <tool_call> XML in text content",
        len(extracted),
    )

    return extracted, remaining


# ---------------------------------------------------------------------------
# Strip residual <tool_call> XML from text (Option 1 for finalize turn leak)
# ---------------------------------------------------------------------------
# On finalize turns the model sometimes emits <tool_call> XML with garbled
# JSON that cannot be extracted into structured tool calls.  This function
# strips those residual tags so they don't leak into the final Anthropic
# response text shown to Claude Code.

_RESIDUAL_TOOL_CALL_XML_RE = re.compile(
    r"</?tool_call>",
    re.DOTALL,
)

_TOOL_CALL_BLOCK_RE = re.compile(
    r"<tool_call>.*?</tool_call>",
    re.DOTALL,
)


def _strip_residual_tool_call_xml(text: str) -> str:
    """Remove residual ``<tool_call>`` XML from *text*.

    First strips complete ``<tool_call>...</tool_call>`` blocks, then
    removes any orphaned opening/closing tags.  Returns cleaned text.
    """
    if "<tool_call>" not in text and "</tool_call>" not in text:
        return text

    # Strip complete blocks first
    cleaned = _TOOL_CALL_BLOCK_RE.sub("", text)
    # Strip orphaned tags
    cleaned = _RESIDUAL_TOOL_CALL_XML_RE.sub("", cleaned)
    # Collapse excessive whitespace left by removals
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned).strip()
    return cleaned


# Pattern: runaway closing braces like }}}}}
_GARBLED_RUNAWAY_BRACES_RE = re.compile(r"\}{4,}")
# Pattern: repetitive digit sequences like 000000 or 398859738398859738
_GARBLED_REPETITIVE_DIGITS_RE = re.compile(r"(\d{3,})\1{2,}")
# Pattern: long runs of zeros
_GARBLED_ZEROS_RE = re.compile(r"0{8,}")
# Pattern: extremely long unbroken digit strings (>30 digits)
_GARBLED_LONG_DIGITS_RE = re.compile(r"\d{30,}")


def _is_garbled_tool_arguments(arguments_str: str) -> bool:
    """Detect garbled/degenerate tool call arguments.

    Returns True if the arguments string shows signs of degenerate generation:
    - Runaway closing braces (}}}}})
    - Repetitive digit patterns (000000, 398859738398859738)
    - Extremely long digit strings
    - Unbalanced braces suggesting truncated/corrupt JSON
    """
    if not arguments_str or arguments_str == "{}":
        return False

    if _GARBLED_RUNAWAY_BRACES_RE.search(arguments_str):
        return True
    if _GARBLED_REPETITIVE_DIGITS_RE.search(arguments_str):
        return True
    if _GARBLED_ZEROS_RE.search(arguments_str):
        return True
    if _GARBLED_LONG_DIGITS_RE.search(arguments_str):
        return True

    # Check brace balance — more than 2 unmatched braces suggests corruption
    open_count = arguments_str.count("{")
    close_count = arguments_str.count("}")
    if abs(open_count - close_count) > 2:
        return True

    return False


def _sanitize_garbled_tool_calls(openai_resp: dict) -> bool:
    """Check tool calls in an OpenAI response for garbled arguments.

    If garbled arguments are detected, removes the affected tool calls
    and logs a warning. Returns True if any tool calls were removed.
    """
    choice = (openai_resp.get("choices") or [{}])[0]
    message = choice.get("message", {})
    tool_calls = message.get("tool_calls")
    if not tool_calls:
        return False

    clean = []
    garbled_count = 0
    for tc in tool_calls:
        fn = tc.get("function", {})
        args_str = fn.get("arguments", "{}")
        if _is_garbled_tool_arguments(args_str):
            garbled_count += 1
            logger.warning(
                "GARBLED TOOL ARGS: name=%s args_preview=%.120s",
                fn.get("name", "?"),
                args_str,
            )
        else:
            clean.append(tc)

    if garbled_count == 0:
        return False

    if clean:
        message["tool_calls"] = clean
    else:
        # All tool calls were garbled — remove tool_calls entirely
        message.pop("tool_calls", None)
        choice["finish_reason"] = "stop"

    logger.warning(
        "GARBLED TOOL ARGS: removed %d garbled tool call(s), %d clean remaining",
        garbled_count,
        len(clean),
    )
    return True


# Distinctive phrases from the agentic system supplement that Qwen3.5 leaks
# into tool call arguments.  Keep lowercase for case-insensitive matching.
_SYSTEM_PROMPT_LEAK_MARKERS = (
    "agentic-protocol",
    "agentic coding loop",
    "follow these rules",
    "function signatures within",
    "provided with function signatures",
    "you are provided with function",
    "call one or more functions",
    "xml tags:",
    "do not summarize the issue",
    "you must call a tool",
    "proceed immediately to make the fix",
    "do not ask for permission or confirmation",
    "do not give up after one failure",
    "emit a valid tool call object",
    "never output protocol fragments",
    "never emit literal tag artifacts",
    "use tools for concrete work",
    "stopping at analysis",
    # Client system prompt phrases that also leak into tool args
    "only produce a final text response without tool calls",
    "the entire task is fully complete",
    "always use tools to read, edit, write",
    "after reading files and identifying an issue",
    "do not output raw protocol tags",
    "valid tool call with strict json",
    "return exactly one valid tool call",
    "invalid tool call format",
    # Option 1: Spec mode system-reminder phrases
    "spec mode is active",
    "spec mode active",
    "executed askuser tool to gather requirements",
    "gather requirements and clarify decisions",
    "before finalizing your spec",
    "you must not make any edits",
    # Option 2: Broader Claude Code system-reminder phrases
    "the user indicated that they do not want you to execute",
    "run any non-readonly tools",
    "making communications or interacting with external services",
    "this is encouraged in spec mode",
    "user has executed askuser tool",
    "<system-reminder>",
    "</system-reminder>",
)


def _contains_system_prompt_leak(value) -> bool:
    """Check if any string leaf in *value* contains system prompt fragments."""
    for text in _iter_string_leaves(value):
        lowered = text.lower()
        if any(marker in lowered for marker in _SYSTEM_PROMPT_LEAK_MARKERS):
            return True
    return False


def _find_earliest_leak_position(text: str) -> int | None:
    """Return the character index where the first system prompt leak starts, or None."""
    lowered = text.lower()
    earliest = None
    for marker in _SYSTEM_PROMPT_LEAK_MARKERS:
        idx = lowered.find(marker)
        if idx != -1 and (earliest is None or idx < earliest):
            earliest = idx
    return earliest


def _repair_system_prompt_leak(openai_resp: dict) -> tuple[dict, int]:
    """Strip system prompt leak fragments from tool call argument values.

    Truncates string values at the first detected leak marker.
    Returns (possibly-mutated response, repair count).
    """
    if not _openai_has_tool_calls(openai_resp):
        return openai_resp, 0

    choice, message = _extract_openai_choice(openai_resp)
    tool_calls = message.get("tool_calls") or []
    if not tool_calls:
        return openai_resp, 0

    repaired_tool_calls = []
    repaired_count = 0

    for tool_call in tool_calls:
        fn = tool_call.get("function") if isinstance(tool_call, dict) else {}
        if not isinstance(fn, dict):
            fn = {}

        raw_args = fn.get("arguments", "{}")
        if isinstance(raw_args, dict):
            parsed_args = dict(raw_args)
        else:
            try:
                parsed_args = json.loads(str(raw_args))
            except json.JSONDecodeError:
                repaired_tool_calls.append(tool_call)
                continue

        if not isinstance(parsed_args, dict):
            repaired_tool_calls.append(tool_call)
            continue

        changed = False
        cleaned_args = {}
        for key, val in parsed_args.items():
            if isinstance(val, str):
                pos = _find_earliest_leak_position(val)
                if pos is not None and pos > 0:
                    cleaned_args[key] = val[:pos].rstrip()
                    changed = True
                    logger.warning(
                        "PROMPT LEAK REPAIR: tool=%s field=%s truncated at pos=%d",
                        fn.get("name", "?"),
                        key,
                        pos,
                    )
                elif pos == 0:
                    # Entire value is leaked content — clear it
                    cleaned_args[key] = ""
                    changed = True
                else:
                    cleaned_args[key] = val
            else:
                cleaned_args[key] = val

        if not changed:
            repaired_tool_calls.append(tool_call)
            continue

        new_tool_call = dict(tool_call)
        new_fn = dict(fn)
        new_fn["arguments"] = json.dumps(cleaned_args, separators=(",", ":"))
        new_tool_call["function"] = new_fn
        repaired_tool_calls.append(new_tool_call)
        repaired_count += 1

    if repaired_count > 0:
        repaired_response = dict(openai_resp)
        repaired_choice = dict(choice)
        repaired_message = dict(message)
        repaired_message["tool_calls"] = repaired_tool_calls
        repaired_choice["message"] = repaired_message
        repaired_response["choices"] = [repaired_choice]
        logger.warning(
            "PROMPT LEAK REPAIR: repaired %d tool call(s)",
            repaired_count,
        )
        return repaired_response, repaired_count

    return openai_resp, 0


def _tool_schema_map_from_anthropic_body(anthropic_body: dict) -> dict[str, dict]:
    schema_map: dict[str, dict] = {}
    for tool in anthropic_body.get("tools", []) or []:
        if not isinstance(tool, dict):
            continue
        name = tool.get("name")
        if isinstance(name, str) and name:
            schema = tool.get("input_schema")
            schema_map[name] = schema if isinstance(schema, dict) else {}
    return schema_map


def _invalid_tool_call_reason(openai_resp: dict, anthropic_body: dict) -> str | None:
    if "tools" not in anthropic_body:
        return None

    tool_calls = _extract_openai_tool_calls(openai_resp)
    if not tool_calls:
        return None

    schema_map = _tool_schema_map_from_anthropic_body(anthropic_body)
    if not schema_map:
        return None

    for idx, tc in enumerate(tool_calls):
        if not isinstance(tc, dict):
            return f"tool call {idx} is not an object"
        fn = tc.get("function")
        if not isinstance(fn, dict):
            return f"tool call {idx} missing function payload"

        name = fn.get("name")
        if not isinstance(name, str) or not name:
            return f"tool call {idx} missing function name"
        if name not in schema_map:
            return f"tool call {idx} uses unknown tool '{name}'"

        args, parse_error = _parse_openai_function_arguments(fn.get("arguments", "{}"))
        if parse_error:
            return f"tool call {idx} invalid arguments ({parse_error})"
        if args is None:
            return f"tool call {idx} has empty arguments"

        valid, reason = _validate_tool_arguments_against_schema(args, schema_map[name])
        if not valid:
            return f"tool call {idx} failed schema validation: {reason}"

    return None


def _openai_has_valid_tool_calls(openai_resp: dict, anthropic_body: dict) -> bool:
    return (
        _openai_has_tool_calls(openai_resp)
        and _invalid_tool_call_reason(openai_resp, anthropic_body) is None
    )


@dataclass
class ToolResponseIssue:
    kind: str = ""
    reason: str = ""
    retry_hint: str = ""

    def has_issue(self) -> bool:
        return bool(self.kind)


_TOOL_ARG_MARKERS = (
    "</parameter",
    "<parameter",
    "<tool_call",
    "</tool_call",
    "<function=",
    "</function",
    "</think>",
)

_BASH_PROTOCOL_LINE_RE = re.compile(
    r"^\s*</?(?:tool_call|tool_response|parameter(?:=[^>]*)?|function(?:=[^>]*)?|think)\s*>\s*$",
    re.IGNORECASE,
)


def _iter_string_leaves(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, list):
        for item in value:
            yield from _iter_string_leaves(item)
    elif isinstance(value, dict):
        for item in value.values():
            yield from _iter_string_leaves(item)


def _contains_tool_markup(value) -> bool:
    for text in _iter_string_leaves(value):
        lowered = text.lower()
        if any(marker in lowered for marker in _TOOL_ARG_MARKERS):
            return True
    return False


def _strip_tool_markup_artifacts(text: str) -> str:
    cleaned = re.sub(r"</?parameter[^>]*>", "", text, flags=re.IGNORECASE)
    cleaned = re.sub(r"</?tool_call[^>]*>", "", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"</?think>", "", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"<function=[^>]*>", "", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"</function>", "", cleaned, flags=re.IGNORECASE)
    return cleaned.strip()


def _strip_protocol_tag_only_lines(text: str) -> tuple[str, bool]:
    if not isinstance(text, str):
        return text, False

    lines = text.splitlines()
    kept_lines: list[str] = []
    stripped = False
    for line in lines:
        if _BASH_PROTOCOL_LINE_RE.match(line):
            stripped = True
            continue
        kept_lines.append(line)

    if not stripped:
        return text, False

    cleaned = "\n".join(kept_lines).strip()
    return cleaned, True


def _sanitize_markup_value(value):
    if isinstance(value, str):
        cleaned = _strip_tool_markup_artifacts(value)
        return cleaned, cleaned != value
    if isinstance(value, list):
        changed = False
        cleaned_items = []
        for item in value:
            cleaned_item, item_changed = _sanitize_markup_value(item)
            cleaned_items.append(cleaned_item)
            changed = changed or item_changed
        return cleaned_items, changed
    if isinstance(value, dict):
        changed = False
        cleaned_obj = {}
        for key, item in value.items():
            cleaned_item, item_changed = _sanitize_markup_value(item)
            cleaned_obj[key] = cleaned_item
            changed = changed or item_changed
        return cleaned_obj, changed
    return value, False


_REQUIRED_PLACEHOLDER = "__uap_required__"
_MISSING_REQUIRED_VALUE = object()


def _contains_required_placeholder(value) -> bool:
    if isinstance(value, str):
        return value.strip() == _REQUIRED_PLACEHOLDER
    if isinstance(value, list):
        return any(_contains_required_placeholder(item) for item in value)
    if isinstance(value, dict):
        return any(_contains_required_placeholder(item) for item in value.values())
    return False


def _repair_tool_call_markup(openai_resp: dict) -> tuple[dict, int]:
    if not _openai_has_tool_calls(openai_resp):
        return openai_resp, 0

    choice, message = _extract_openai_choice(openai_resp)
    tool_calls = message.get("tool_calls") or []
    if not tool_calls:
        return openai_resp, 0

    repaired_tool_calls = []
    repaired_count = 0

    for tool_call in tool_calls:
        fn = tool_call.get("function") if isinstance(tool_call, dict) else {}
        if not isinstance(fn, dict):
            fn = {}
        raw_args = fn.get("arguments", "{}")

        if isinstance(raw_args, (dict, list)):
            parsed_args = raw_args
            parse_recovered = False
        else:
            try:
                parsed_args = json.loads(str(raw_args))
                parse_recovered = False
            except json.JSONDecodeError:
                cleaned_text = _strip_tool_markup_artifacts(str(raw_args))
                candidate = cleaned_text
                if "{" in candidate and "}" in candidate:
                    candidate = candidate[
                        candidate.find("{") : candidate.rfind("}") + 1
                    ]
                try:
                    parsed_args = json.loads(candidate)
                    parse_recovered = True
                except json.JSONDecodeError:
                    repaired_tool_calls.append(tool_call)
                    continue

        cleaned_args, changed = _sanitize_markup_value(parsed_args)
        if parse_recovered:
            changed = True
        if not changed:
            repaired_tool_calls.append(tool_call)
            continue

        new_tool_call = dict(tool_call)
        new_fn = dict(fn)
        new_fn["arguments"] = json.dumps(cleaned_args, separators=(",", ":"))
        new_tool_call["function"] = new_fn
        repaired_tool_calls.append(new_tool_call)
        repaired_count += 1

    if repaired_count == 0:
        return openai_resp, 0

    repaired_response = dict(openai_resp)
    choices = list(openai_resp.get("choices") or [])
    if not choices:
        return openai_resp, 0

    updated_choice = dict(choice)
    updated_message = dict(message)
    updated_message["tool_calls"] = repaired_tool_calls
    updated_choice["message"] = updated_message
    choices[0] = updated_choice
    repaired_response["choices"] = choices
    return repaired_response, repaired_count


def _default_required_value(field_name: str, field_schema: dict):
    _ = field_name
    if not isinstance(field_schema, dict):
        return _MISSING_REQUIRED_VALUE

    if "default" in field_schema:
        default_value = copy.deepcopy(field_schema.get("default"))
        if not _contains_required_placeholder(default_value):
            return default_value

    enum_values = field_schema.get("enum")
    if isinstance(enum_values, list):
        for candidate in enum_values:
            if _required_value_is_empty(candidate):
                continue
            if _contains_required_placeholder(candidate):
                continue
            return copy.deepcopy(candidate)

    if "const" in field_schema:
        const_value = copy.deepcopy(field_schema.get("const"))
        if not _contains_required_placeholder(const_value):
            return const_value

    return _MISSING_REQUIRED_VALUE


def _repair_required_tool_args(
    openai_resp: dict, anthropic_body: dict
) -> tuple[dict, int]:
    if not _openai_has_tool_calls(openai_resp):
        return openai_resp, 0

    tools_by_name = _anthropic_tools_by_name(anthropic_body)
    if not tools_by_name:
        return openai_resp, 0

    choice, message = _extract_openai_choice(openai_resp)
    tool_calls = message.get("tool_calls") or []
    if not tool_calls:
        return openai_resp, 0

    repaired_tool_calls = []
    repaired_count = 0

    for tool_call in tool_calls:
        fn = tool_call.get("function") if isinstance(tool_call, dict) else {}
        if not isinstance(fn, dict):
            fn = {}
        tool_name = fn.get("name", "")
        schema = tools_by_name.get(tool_name, {})
        required = schema.get("required", []) if isinstance(schema, dict) else []
        if not isinstance(required, list) or not required:
            repaired_tool_calls.append(tool_call)
            continue

        properties = schema.get("properties", {}) if isinstance(schema, dict) else {}
        if not isinstance(properties, dict):
            properties = {}

        raw_args = fn.get("arguments", "{}")
        if isinstance(raw_args, dict):
            parsed_args = dict(raw_args)
            parse_failed = False
        else:
            try:
                parsed_args = json.loads(str(raw_args))
                parse_failed = False
            except json.JSONDecodeError:
                parsed_args = {}
                parse_failed = True

        if not isinstance(parsed_args, dict):
            parsed_args = {}
            parse_failed = True

        changed = parse_failed
        for field in required:
            if not isinstance(field, str):
                continue
            current = parsed_args.get(field)
            if field not in parsed_args or _required_value_is_empty(current):
                field_schema = (
                    properties.get(field, {})
                    if isinstance(properties.get(field), dict)
                    else {}
                )
                fallback_value = _default_required_value(field, field_schema)
                if fallback_value is _MISSING_REQUIRED_VALUE:
                    continue
                parsed_args[field] = fallback_value
                changed = True

        if not changed:
            repaired_tool_calls.append(tool_call)
            continue

        new_tool_call = dict(tool_call)
        new_fn = dict(fn)
        new_fn["arguments"] = json.dumps(parsed_args, separators=(",", ":"))
        new_tool_call["function"] = new_fn
        repaired_tool_calls.append(new_tool_call)
        repaired_count += 1

    if repaired_count == 0:
        return openai_resp, 0

    repaired_response = dict(openai_resp)
    choices = list(openai_resp.get("choices") or [])
    if not choices:
        return openai_resp, 0

    updated_choice = dict(choice)
    updated_message = dict(message)
    updated_message["tool_calls"] = repaired_tool_calls
    updated_choice["message"] = updated_message
    choices[0] = updated_choice
    repaired_response["choices"] = choices
    return repaired_response, repaired_count


def _repair_bash_command_artifacts(openai_resp: dict) -> tuple[dict, int]:
    if not _openai_has_tool_calls(openai_resp):
        return openai_resp, 0

    choice, message = _extract_openai_choice(openai_resp)
    tool_calls = message.get("tool_calls") or []
    if not tool_calls:
        return openai_resp, 0

    repaired_tool_calls = []
    repaired_count = 0

    for tool_call in tool_calls:
        fn = tool_call.get("function") if isinstance(tool_call, dict) else {}
        if not isinstance(fn, dict):
            fn = {}

        tool_name = str(fn.get("name", "")).strip().lower()
        if tool_name != "bash":
            repaired_tool_calls.append(tool_call)
            continue

        raw_args = fn.get("arguments", "{}")
        if isinstance(raw_args, dict):
            parsed_args = dict(raw_args)
        else:
            try:
                parsed_args = json.loads(str(raw_args))
            except json.JSONDecodeError:
                repaired_tool_calls.append(tool_call)
                continue

        if not isinstance(parsed_args, dict):
            repaired_tool_calls.append(tool_call)
            continue

        command = parsed_args.get("command")
        if not isinstance(command, str):
            repaired_tool_calls.append(tool_call)
            continue

        cleaned_command, changed = _strip_protocol_tag_only_lines(command)
        if not changed:
            repaired_tool_calls.append(tool_call)
            continue

        parsed_args["command"] = cleaned_command
        new_tool_call = dict(tool_call)
        new_fn = dict(fn)
        new_fn["arguments"] = json.dumps(parsed_args, separators=(",", ":"))
        new_tool_call["function"] = new_fn
        repaired_tool_calls.append(new_tool_call)
        repaired_count += 1

    if repaired_count == 0:
        return openai_resp, 0

    repaired_response = dict(openai_resp)
    choices = list(openai_resp.get("choices") or [])
    if not choices:
        return openai_resp, 0

    updated_choice = dict(choice)
    updated_message = dict(message)
    updated_message["tool_calls"] = repaired_tool_calls
    updated_choice["message"] = updated_message
    choices[0] = updated_choice
    repaired_response["choices"] = choices
    return repaired_response, repaired_count


def _required_value_is_empty(value) -> bool:
    if value is None:
        return True
    if isinstance(value, str):
        return not value.strip()
    if isinstance(value, (list, dict)):
        return len(value) == 0
    return False


def _matches_json_schema_type(value, expected_type) -> bool:
    if not expected_type:
        return True

    if isinstance(expected_type, list):
        return any(
            _matches_json_schema_type(value, candidate) for candidate in expected_type
        )

    if expected_type == "string":
        return isinstance(value, str)
    if expected_type == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if expected_type == "number":
        return (isinstance(value, int) and not isinstance(value, bool)) or isinstance(
            value, float
        )
    if expected_type == "boolean":
        return isinstance(value, bool)
    if expected_type == "object":
        return isinstance(value, dict)
    if expected_type == "array":
        return isinstance(value, list)
    return True


def _anthropic_tools_by_name(anthropic_body: dict) -> dict[str, dict]:
    tool_map: dict[str, dict] = {}
    for tool in anthropic_body.get("tools", []) or []:
        if not isinstance(tool, dict):
            continue
        name = tool.get("name", "")
        if not name:
            continue
        schema = tool.get("input_schema")
        if not isinstance(schema, dict):
            schema = (
                tool.get("parameters")
                if isinstance(tool.get("parameters"), dict)
                else {}
            )
        tool_map[name] = schema or {}
    return tool_map


def _validate_tool_call_arguments(
    tool_name: str,
    raw_arguments,
    tool_schema: dict,
    allowed_tools: set[str],
) -> ToolResponseIssue:
    if allowed_tools and tool_name not in allowed_tools:
        return ToolResponseIssue(
            kind="invalid_tool_args",
            reason=f"unknown tool '{tool_name}'",
            retry_hint="Use exactly one tool from the provided tool list.",
        )

    if isinstance(raw_arguments, (dict, list)):
        arg_text = json.dumps(raw_arguments)
    elif raw_arguments is None:
        arg_text = "{}"
    else:
        arg_text = str(raw_arguments)

    try:
        parsed = json.loads(arg_text)
    except json.JSONDecodeError as exc:
        return ToolResponseIssue(
            kind="invalid_tool_args",
            reason=f"invalid JSON arguments for '{tool_name}': {exc.msg}",
            retry_hint=(
                f"Emit exactly one `{tool_name}` tool call with `arguments` as a strict JSON object. "
                "Do not include prose before or after JSON."
            ),
        )

    if not isinstance(parsed, dict):
        return ToolResponseIssue(
            kind="invalid_tool_args",
            reason=f"arguments for '{tool_name}' must be a JSON object",
            retry_hint=(
                f"Emit exactly one `{tool_name}` tool call with `arguments` set to a JSON object (not a string or list)."
            ),
        )

    if tool_name.strip().lower() == "bash":
        command = parsed.get("command")
        if isinstance(command, str):
            cleaned_command, had_protocol_lines = _strip_protocol_tag_only_lines(
                command
            )
            if had_protocol_lines and not cleaned_command:
                return ToolResponseIssue(
                    kind="invalid_tool_args",
                    reason="arguments for 'Bash' contained only protocol tag lines",
                    retry_hint=(
                        "Emit exactly one `Bash` tool call with a valid shell command in `arguments.command`. "
                        "Do not include standalone XML/protocol tags."
                    ),
                )

    if _contains_tool_markup(parsed):
        return ToolResponseIssue(
            kind="invalid_tool_args",
            reason=f"arguments for '{tool_name}' contain malformed markup fragments",
            retry_hint=(
                f"Remove tag fragments from `{tool_name}` arguments and emit only plain JSON key/value pairs."
            ),
        )

    if _contains_system_prompt_leak(parsed):
        return ToolResponseIssue(
            kind="invalid_tool_args",
            reason=f"arguments for '{tool_name}' contain leaked system prompt fragments",
            retry_hint=(
                f"Emit exactly one `{tool_name}` tool call with only the requested arguments. "
                "Do not include any system instructions or protocol text in argument values."
            ),
        )

    if _is_garbled_tool_arguments(arg_text):
        return ToolResponseIssue(
            kind="invalid_tool_args",
            reason=f"arguments for '{tool_name}' contain garbled/degenerate content",
            retry_hint=(
                f"Emit exactly one `{tool_name}` tool call with well-formed JSON arguments. "
                "Do not repeat closing braces, brackets, or digits."
            ),
        )

    if _contains_required_placeholder(parsed):
        return ToolResponseIssue(
            kind="invalid_tool_args",
            reason=(
                f"arguments for '{tool_name}' contain unresolved placeholder values"
            ),
            retry_hint=(
                f"Emit exactly one `{tool_name}` tool call with real schema-valid arguments. "
                f"Never emit `{_REQUIRED_PLACEHOLDER}` placeholders."
            ),
        )

    if not isinstance(tool_schema, dict):
        tool_schema = {}

    required = tool_schema.get("required", [])
    if not isinstance(required, list):
        required = []

    properties = tool_schema.get("properties", {})
    if not isinstance(properties, dict):
        properties = {}

    missing: list[str] = []
    empty: list[str] = []
    wrong_type: list[str] = []
    enum_mismatch: list[str] = []

    for field in required:
        if not isinstance(field, str):
            continue

        if field not in parsed:
            missing.append(field)
            continue

        value = parsed.get(field)
        if _required_value_is_empty(value):
            empty.append(field)
            continue

        schema = (
            properties.get(field, {}) if isinstance(properties.get(field), dict) else {}
        )
        expected_type = schema.get("type")
        if expected_type and not _matches_json_schema_type(value, expected_type):
            wrong_type.append(field)
            continue

        enum_values = schema.get("enum")
        if isinstance(enum_values, list) and enum_values and value not in enum_values:
            enum_mismatch.append(field)
            continue

        if "const" in schema and value != schema.get("const"):
            enum_mismatch.append(field)
            continue

        min_length = schema.get("minLength")
        if (
            isinstance(min_length, int)
            and isinstance(value, str)
            and len(value.strip()) < min_length
        ):
            empty.append(field)
            continue

        min_items = schema.get("minItems")
        if (
            isinstance(min_items, int)
            and isinstance(value, list)
            and len(value) < min_items
        ):
            empty.append(field)

    if missing or empty or wrong_type or enum_mismatch:
        details = []
        if missing:
            details.append(f"missing: {', '.join(missing)}")
        if empty:
            details.append(f"empty: {', '.join(empty)}")
        if wrong_type:
            details.append(f"type mismatch: {', '.join(wrong_type)}")
        if enum_mismatch:
            details.append(f"enum mismatch: {', '.join(enum_mismatch)}")
        required_fields = ", ".join(str(f) for f in required if isinstance(f, str))
        required_hint = (
            f"Required fields must be non-empty: {required_fields}. "
            if required_fields
            else ""
        )
        return ToolResponseIssue(
            kind="invalid_tool_args",
            reason=f"invalid arguments for '{tool_name}' ({'; '.join(details)})",
            retry_hint=(
                f"Emit exactly one `{tool_name}` tool call with strict JSON arguments. "
                f"{required_hint}Do not include protocol tags or commentary."
            ).strip(),
        )

    return ToolResponseIssue()


def _classify_tool_response_issue(
    openai_resp: dict,
    anthropic_body: dict,
    required_tool_choice: bool = False,
) -> ToolResponseIssue:
    if "tools" not in anthropic_body:
        return ToolResponseIssue()

    if _is_malformed_tool_response(openai_resp, anthropic_body):
        return ToolResponseIssue(
            kind="malformed_payload",
            reason="malformed pseudo tool payload detected in assistant text",
            retry_hint=(
                "Return exactly one valid tool call with strict JSON arguments. "
                "Do not output raw protocol tags, schema fragments, or apologies about formatting."
            ),
        )

    has_tool_calls = _openai_has_tool_calls(openai_resp)
    if not has_tool_calls:
        if required_tool_choice:
            return ToolResponseIssue(
                kind="required_tool_miss",
                reason="required tool turn returned no tool calls",
                retry_hint=(
                    "A tool call is mandatory for this turn. Emit exactly one valid tool call now "
                    "with a strict JSON object in `arguments`."
                ),
            )
        return ToolResponseIssue()

    if not PROXY_TOOL_ARGS_PREFLIGHT:
        return ToolResponseIssue()

    _, message = _extract_openai_choice(openai_resp)
    tool_calls = message.get("tool_calls") or []
    tools_by_name = _anthropic_tools_by_name(anthropic_body)
    allowed_tools = set(tools_by_name.keys())

    for tc in tool_calls:
        fn = tc.get("function") if isinstance(tc, dict) else {}
        if not isinstance(fn, dict):
            fn = {}
        tool_name = fn.get("name", "")
        issue = _validate_tool_call_arguments(
            tool_name,
            fn.get("arguments", "{}"),
            tools_by_name.get(tool_name, {}),
            allowed_tools,
        )
        if issue.has_issue():
            return issue

    return ToolResponseIssue()


def _looks_malformed_tool_payload(text: str) -> bool:
    if not text:
        return False

    lowered = text.lower()
    if _contains_tool_call_apology(text):
        return True

    primary_markers = (
        "</parameter",
        "<parameter",
        "<tool_call",
        "<function=",
        "</function",
    )
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
    if _looks_repetitive_policy_echo(text):
        return True
    return False


def _looks_repetitive_policy_echo(text: str) -> bool:
    if not text:
        return False

    lowered = text.lower()
    compact = re.sub(r"\s+", " ", lowered).strip()
    if not compact:
        return False

    policy_phrase_markers = (
        "at least 2 new test cases",
        "tests must be in test/",
        "describe/it/expect using vitest",
    )
    if any(compact.count(marker) >= 4 for marker in policy_phrase_markers):
        return True

    lines = [
        re.sub(r"\s+", " ", line.strip().lower())
        for line in text.splitlines()
        if line.strip()
    ]
    if lines:
        line_counts: dict[str, int] = {}
        for line in lines:
            if len(line) < 24:
                continue
            line_counts[line] = line_counts.get(line, 0) + 1
        if line_counts and max(line_counts.values()) >= 8:
            return True

    repeated_phrase_match = re.search(
        r"((?:[a-z0-9_./-]+\s+){2,8}[a-z0-9_./-]+)(?:\s+\1){7,}",
        compact,
    )
    if repeated_phrase_match:
        return True

    return False


def _is_malformed_tool_response(openai_resp: dict, anthropic_body: dict) -> bool:
    if "tools" not in anthropic_body:
        return False

    if _invalid_tool_call_reason(openai_resp, anthropic_body):
        return True

    if _openai_has_tool_calls(openai_resp):
        return False

    return _looks_malformed_tool_payload(_openai_message_text(openai_resp))


def _should_retry_for_completion_contract(
    openai_resp: dict, anthropic_body: dict, monitor: SessionMonitor
) -> bool:
    if not monitor.completion_required or not monitor.completion_pending:
        return False

    finish_reason = (_extract_openai_choice(openai_resp)[0].get("finish_reason") or "").lower()
    if finish_reason not in {"stop", "end_turn"}:
        return False

    if _openai_has_tool_calls(openai_resp):
        return False

    return bool(_openai_message_text(openai_resp).strip())


def _build_completion_contract_retry_body(openai_body: dict, monitor: SessionMonitor) -> dict:
    retry_body = copy.deepcopy(openai_body)
    retry_body["stream"] = False
    retry_body["tool_choice"] = "required"
    blockers = ", ".join(monitor.completion_blockers) or "remaining_work"
    retry_instruction = (
        "The task is not complete yet. Continue the agentic loop with exactly one valid tool call. "
        f"Outstanding completion blockers: {blockers}. "
        "Do not provide a final summary or end_turn until the blockers are cleared."
    )
    retry_body.setdefault("messages", [])
    retry_body["messages"] = list(retry_body["messages"]) + [
        {"role": "system", "content": retry_instruction}
    ]
    return retry_body


async def _apply_completion_contract_guardrail(
    client: httpx.AsyncClient,
    openai_resp: dict,
    openai_body: dict,
    anthropic_body: dict,
    monitor: SessionMonitor,
    session_id: str,
) -> dict:
    if not _should_retry_for_completion_contract(openai_resp, anthropic_body, monitor):
        return openai_resp

    retry_body = _build_completion_contract_retry_body(openai_body, monitor)
    logger.warning(
        "COMPLETION CONTRACT retry for session %s (blockers=%s)",
        session_id,
        ",".join(monitor.completion_blockers),
    )
    retry_resp = await client.post(
        f"{LLAMA_CPP_BASE}/chat/completions",
        json=retry_body,
        headers={"Content-Type": "application/json"},
    )
    if retry_resp.status_code != 200:
        logger.error(
            "COMPLETION CONTRACT retry failed with HTTP %d for session %s",
            retry_resp.status_code,
            session_id,
        )
        return openai_resp

    monitor.note_completion_recovery()
    retried = retry_resp.json()
    if _openai_has_tool_calls(retried):
        monitor.completion_pending = False
    return retried


def _sanitize_assistant_messages_for_retry(messages: list[dict]) -> list[dict]:
    """Strip malformed tool-like text from assistant messages to prevent copy-contamination.

    Only sanitizes the last 4 assistant messages to avoid excessive processing.
    """
    import re

    # Patterns that indicate malformed tool call text in assistant content
    _TOOL_LIKE_PATTERNS = re.compile(
        r"<tool_call>.*?</tool_call>"
        r"|<function_call>.*?</function_call>"
        r'|\{"name"\s*:\s*"[^"]+"\s*,\s*"arguments"\s*:'
        r"|```json\s*\{[^}]*\"name\"\s*:",
        re.DOTALL,
    )

    result = list(messages)
    sanitized_count = 0
    for i in range(len(result) - 1, -1, -1):
        if sanitized_count >= 4:
            break
        msg = result[i]
        if msg.get("role") != "assistant":
            continue
        content = msg.get("content", "")
        if isinstance(content, str) and _TOOL_LIKE_PATTERNS.search(content):
            cleaned = _TOOL_LIKE_PATTERNS.sub("", content).strip()
            if not cleaned:
                cleaned = "I will use the appropriate tool."
            result[i] = {**msg, "content": cleaned}
            sanitized_count += 1
    return result


def _build_malformed_retry_body(
    openai_body: dict,
    anthropic_body: dict,
    retry_hint: str = "",
    tool_choice: str = "required",
    attempt: int = 1,
    total_attempts: int = 1,
    is_garbled: bool = False,
    exclude_tools: list[str] | None = None,
) -> dict:
    retry_body = dict(openai_body)
    retry_body["stream"] = False
    retry_body["tool_choice"] = tool_choice
    # Cycle 15 Option 3: vary temperature across retries to break degenerate patterns.
    # Attempt 1: use configured retry temp (default 0.0) for deterministic first try.
    # Attempt 2+: increase to 0.5 to escape the degenerate local minimum.
    if total_attempts > 1 and attempt > 1:
        retry_body["temperature"] = 0.5
    else:
        retry_body["temperature"] = PROXY_MALFORMED_TOOL_RETRY_TEMPERATURE

    if tool_choice == "required":
        retry_instruction = (
            "Your previous response had invalid tool-call formatting. "
            "Respond with exactly one valid tool call using the provided tools. "
            "Do not output prose, markdown, XML tags, or schema snippets."
        )
    else:
        retry_instruction = (
            "Your previous response had invalid tool-call formatting. "
            "If a tool is needed, emit exactly one valid tool call with strict JSON arguments. "
            "If no tool is needed for this turn, return concise plain text with no protocol tags."
        )

    malformed_retry_instruction = {
        "role": "user",
        "content": retry_instruction,
    }
    existing_messages = retry_body.get("messages")
    if isinstance(existing_messages, list) and existing_messages:
        # Strip malformed tool-like text from assistant messages to prevent
        # the model from copying contaminated patterns on retry
        sanitized = _sanitize_assistant_messages_for_retry(existing_messages)
        retry_body["messages"] = [*sanitized, malformed_retry_instruction]

    # Option 1: Progressive garbled-cap within retries — use smaller max_tokens
    # when the issue involves garbled/degenerate args to limit degeneration room.
    if is_garbled and PROXY_TOOL_TURN_MAX_TOKENS_GARBLED > 0:
        retry_body["max_tokens"] = PROXY_TOOL_TURN_MAX_TOKENS_GARBLED
        logger.info(
            "RETRY GARBLED CAP: max_tokens=%d for garbled retry attempt=%d",
            PROXY_TOOL_TURN_MAX_TOKENS_GARBLED,
            attempt,
        )
    elif PROXY_MALFORMED_TOOL_RETRY_MAX_TOKENS > 0:
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

    # Option 3: Exclude specific failing tools from retry to let the model
    # pick an alternative when a tool consistently produces garbled args.
    if exclude_tools and retry_body.get("tools"):
        exclude_lower = {t.lower() for t in exclude_tools}
        original_count = len(retry_body["tools"])
        retry_body["tools"] = [
            t for t in retry_body["tools"]
            if t.get("function", {}).get("name", "").lower() not in exclude_lower
        ]
        if len(retry_body["tools"]) < original_count:
            logger.info(
                "RETRY TOOL NARROWING: excluded %s, tools %d -> %d",
                exclude_tools,
                original_count,
                len(retry_body["tools"]),
            )

    if PROXY_DISABLE_THINKING_ON_TOOL_TURNS:
        retry_body["enable_thinking"] = False

    # Option 3: Proactively strip grammar from retry when tools are present and
    # grammar+tools is known to be incompatible. Prevents the 400 error
    # ("Cannot use custom grammar constraints with tools") on retry attempts.
    if retry_body.get("tools") and not TOOL_CALL_GRAMMAR_TOOLS_COMPATIBLE:
        retry_body.pop("grammar", None)
    _apply_tool_call_grammar(retry_body, tool_choice=tool_choice)

    if retry_hint:
        repair_prompt = (
            f"[TOOL CALL REPAIR attempt {attempt}/{total_attempts}]\n"
            f"{retry_hint}\n"
            "Return a valid response for this turn without protocol artifacts."
        )
        retry_messages = list(retry_body.get("messages", []))
        retry_messages.append({"role": "user", "content": repair_prompt})
        retry_body["messages"] = retry_messages

    return retry_body


def _retry_tool_choice_for_attempt(
    required_tool_choice: bool, attempt: int, total_attempts: int
) -> str:
    if not required_tool_choice:
        return "auto"
    if total_attempts <= 1:
        return "required"
    return "auto" if attempt == total_attempts - 1 else "required"


def _build_safe_text_openai_response(
    openai_resp: dict, text: str, finish_reason: str = "stop"
) -> dict:
    return {
        "id": openai_resp.get("id", f"chatcmpl_{uuid.uuid4().hex[:12]}"),
        "object": openai_resp.get("object", "chat.completion"),
        "created": openai_resp.get("created", int(time.time())),
        "model": openai_resp.get("model", "unknown"),
        "choices": [
            {
                "index": 0,
                "finish_reason": finish_reason,
                "message": {
                    "role": "assistant",
                    "content": text,
                },
            }
        ],
        "usage": openai_resp.get("usage", {}),
    }


def _build_clean_guardrail_openai_response(
    openai_resp: dict, finish_reason: str = "stop"
) -> dict:
    return {
        "id": openai_resp.get("id", f"chatcmpl_{uuid.uuid4().hex[:12]}"),
        "object": openai_resp.get("object", "chat.completion"),
        "created": openai_resp.get("created", int(time.time())),
        "model": openai_resp.get("model", "unknown"),
        "choices": [
            {
                "index": 0,
                "finish_reason": finish_reason,
                "message": {
                    "role": "assistant",
                    "content": _TOOL_CALL_RETRY_MESSAGE,
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

    if monitor.finalize_turn_active:
        logger.info("GUARDRAIL: skipped unexpected_end_turn retry on finalize turn")
        return openai_resp

    if not _is_unexpected_end_turn(openai_resp, anthropic_body):
        return openai_resp

    active_loop = _conversation_has_tool_results(anthropic_body) or _last_assistant_was_text_only(
        anthropic_body
    )

    if (
        active_loop
        and openai_body.get("tool_choice") == "auto"
        and monitor.tool_turn_phase in {"act", "review"}
    ):
        logger.warning(
            "GUARDRAIL: overriding %s auto-turn skip because active loop ended unexpectedly",
            monitor.tool_turn_phase,
        )

    monitor.unexpected_end_turn_count += 1
    logger.warning(
        "GUARDRAIL: unexpected end_turn without tool_use in active loop (session=%s), retrying once with tool_choice=required",
        session_id,
    )

    retry_body = dict(openai_body)
    retry_body["tool_choice"] = "required"
    retry_body["stream"] = False
    _apply_tool_call_grammar(retry_body, tool_choice="required")

    retry_resp = await client.post(
        f"{LLAMA_CPP_BASE}/chat/completions",
        json=retry_body,
        headers={"Content-Type": "application/json"},
    )
    if retry_resp.status_code == 200:
        retry_json = retry_resp.json()
        _maybe_extract_text_tool_calls(retry_json, anthropic_tools=anthropic_body.get("tools"))
        retry_choice, retry_message = _extract_openai_choice(retry_json)
        if _openai_has_valid_tool_calls(retry_json, anthropic_body):
            logger.info("GUARDRAIL: retry produced tool_use; using retried response")
            return retry_json
        invalid_reason = _invalid_tool_call_reason(retry_json, anthropic_body)
        if invalid_reason:
            logger.warning(
                "GUARDRAIL: retry produced invalid tool_call payload (%s)",
                invalid_reason,
            )
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

    if monitor.finalize_turn_active:
        # Option 2: Don't fully skip on finalize — strip residual <tool_call> XML
        text = _openai_message_text(openai_resp)
        if text and "<tool_call>" in text:
            cleaned = _strip_residual_tool_call_xml(text)
            if cleaned != text:
                choices = openai_resp.get("choices", [])
                if choices:
                    choices[0].get("message", {})["content"] = cleaned
                logger.warning(
                    "GUARDRAIL: stripped residual <tool_call> XML on finalize turn"
                )
        else:
            logger.info("GUARDRAIL: finalize turn clean, no tool call XML detected")
        return openai_resp

    working_resp = openai_resp
    repair_count = 0
    if PROXY_TOOL_ARGS_PREFLIGHT and _openai_has_tool_calls(openai_resp):
        working_resp, markup_repairs = _repair_tool_call_markup(openai_resp)
        working_resp, required_repairs = _repair_required_tool_args(
            working_resp, anthropic_body
        )
        working_resp, bash_repairs = _repair_bash_command_artifacts(working_resp)
        working_resp, leak_repairs = _repair_system_prompt_leak(working_resp)
        repair_count = markup_repairs + required_repairs + bash_repairs + leak_repairs

    required_tool_choice = openai_body.get("tool_choice") == "required"
    has_tool_calls = _openai_has_tool_calls(working_resp)
    if required_tool_choice and not has_tool_calls:
        monitor.required_tool_miss_streak += 1

    issue = _classify_tool_response_issue(
        working_resp,
        anthropic_body,
        required_tool_choice=required_tool_choice,
    )
    if not issue.has_issue():
        if required_tool_choice and not has_tool_calls:
            monitor.maybe_activate_forced_tool_dampener("required_tool_miss")
        if has_tool_calls:
            monitor.malformed_tool_streak = 0
            monitor.invalid_tool_call_streak = 0
            monitor.required_tool_miss_streak = 0
            monitor.last_response_garbled = False
        if repair_count > 0:
            monitor.arg_preflight_repairs += repair_count
            logger.info(
                "TOOL ARG REPAIR: session=%s repaired=%d source=initial",
                session_id,
                repair_count,
            )
        return working_resp

    # Mark garbled state for progressive max_tokens reduction on next turn
    monitor.last_response_garbled = True

    if issue.kind == "malformed_payload":
        monitor.malformed_tool_streak += 1
    elif issue.kind == "invalid_tool_args":
        monitor.invalid_tool_call_streak += 1
        monitor.arg_preflight_rejections += 1

    monitor.maybe_activate_forced_tool_dampener(issue.kind)
    excerpt = _openai_message_text(working_resp)[:220].replace("\n", " ")
    # Option 2: Log garbled argument content for diagnostics
    arg_excerpt = ""
    if issue.kind == "invalid_tool_args":
        for tc in (working_resp.get("choices", [{}])[0].get("message", {}).get("tool_calls", [])):
            raw_args = tc.get("function", {}).get("arguments", "")
            if raw_args and _is_garbled_tool_arguments(raw_args):
                arg_excerpt = raw_args[:200].replace("\n", " ")
                break
    logger.warning(
        "TOOL RESPONSE ISSUE: session=%s kind=%s reason=%s malformed=%d invalid=%d required_miss=%d excerpt=%.220s args=%.200s",
        session_id,
        issue.kind,
        issue.reason,
        monitor.malformed_tool_streak,
        monitor.invalid_tool_call_streak,
        monitor.required_tool_miss_streak,
        excerpt,
        arg_excerpt,
    )

    attempts = max(0, PROXY_MALFORMED_TOOL_RETRY_MAX)
    current_issue = issue
    # Track failing tool names for tool narrowing on retry
    failing_tools: set[str] = set()
    if issue.kind == "invalid_tool_args":
        for tc in (working_resp.get("choices", [{}])[0].get("message", {}).get("tool_calls", [])):
            fn_name = tc.get("function", {}).get("name", "")
            raw_args = tc.get("function", {}).get("arguments", "")
            if fn_name and raw_args and _is_garbled_tool_arguments(raw_args):
                failing_tools.add(fn_name)
    # Cycle 15 Option 1: For malformed_payload retries, exclude complex
    # multi-field tools (task, Agent) that are prone to garbled generation
    # after the first retry fails.
    _COMPLEX_TOOLS_TO_EXCLUDE_ON_MALFORMED = {"task", "Agent"}
    malformed_exclude_active = False
    for attempt in range(attempts):
        attempt_tool_choice = _retry_tool_choice_for_attempt(
            required_tool_choice,
            attempt,
            attempts,
        )
        # On attempt >= 1, exclude consistently failing tools OR complex tools for malformed
        exclude_set = set(failing_tools) if failing_tools else set()
        if malformed_exclude_active:
            exclude_set |= _COMPLEX_TOOLS_TO_EXCLUDE_ON_MALFORMED
        exclude = list(exclude_set) if (attempt >= 1 and exclude_set) else None
        retry_body = _build_malformed_retry_body(
            openai_body,
            anthropic_body,
            retry_hint=current_issue.retry_hint,
            tool_choice=attempt_tool_choice,
            attempt=attempt + 1,
            total_attempts=attempts,
            is_garbled=current_issue.kind == "invalid_tool_args",
            exclude_tools=exclude,
        )
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
        _maybe_extract_text_tool_calls(retry_json, anthropic_tools=anthropic_body.get("tools"))
        retry_working = retry_json
        retry_repairs = 0
        if PROXY_TOOL_ARGS_PREFLIGHT and _openai_has_tool_calls(retry_json):
            retry_working, retry_markup_repairs = _repair_tool_call_markup(retry_json)
            retry_working, retry_required_repairs = _repair_required_tool_args(
                retry_working, anthropic_body
            )
            retry_working, retry_bash_repairs = _repair_bash_command_artifacts(
                retry_working
            )
            retry_working, retry_leak_repairs = _repair_system_prompt_leak(
                retry_working
            )
            retry_repairs = (
                retry_markup_repairs + retry_required_repairs + retry_bash_repairs + retry_leak_repairs
            )

        working_resp = retry_working

        retry_has_tool_calls = _openai_has_tool_calls(retry_working)
        retry_required = retry_body.get("tool_choice") == "required"
        if retry_required and not retry_has_tool_calls:
            monitor.required_tool_miss_streak += 1

        retry_issue = _classify_tool_response_issue(
            retry_working,
            anthropic_body,
            required_tool_choice=retry_required,
        )

        if not retry_issue.has_issue():
            monitor.malformed_tool_streak = 0
            monitor.invalid_tool_call_streak = 0
            monitor.required_tool_miss_streak = 0
            monitor.last_response_garbled = False
            logger.info(
                "TOOL RESPONSE RETRY success: kind=%s attempt=%d/%d",
                current_issue.kind,
                attempt + 1,
                attempts,
            )
            if retry_repairs > 0:
                monitor.arg_preflight_repairs += retry_repairs
                logger.info(
                    "TOOL ARG REPAIR: session=%s repaired=%d source=retry",
                    session_id,
                    retry_repairs,
                )
            return retry_working

        if retry_issue.kind == "malformed_payload":
            monitor.malformed_tool_streak += 1
            # Cycle 15 Option 1: activate complex tool exclusion for next retry
            malformed_exclude_active = True
        elif retry_issue.kind == "invalid_tool_args":
            monitor.invalid_tool_call_streak += 1
            monitor.arg_preflight_rejections += 1
            # Track failing tools from retries for progressive narrowing
            for tc in (retry_working.get("choices", [{}])[0].get("message", {}).get("tool_calls", [])):
                fn_name = tc.get("function", {}).get("name", "")
                raw_args = tc.get("function", {}).get("arguments", "")
                if fn_name and raw_args and _is_garbled_tool_arguments(raw_args):
                    failing_tools.add(fn_name)

        monitor.maybe_activate_forced_tool_dampener(retry_issue.kind)
        logger.warning(
            "TOOL RESPONSE RETRY invalid: session=%s attempt=%d/%d kind=%s reason=%s",
            session_id,
            attempt + 1,
            attempts,
            retry_issue.kind,
            retry_issue.reason,
        )
        current_issue = retry_issue

    # Option 2 (PR #154): When retries exhaust during review phase, reset to
    # bootstrap instead of returning guardrail fallback. This re-enables all
    # tools (including previously excluded cycling ones) and gives the model
    # a clean shot. The cycle detector will catch re-cycling if it recurs.
    if monitor.tool_turn_phase == "review":
        logger.warning(
            "TOOL RESPONSE review-phase reset: session=%s retries exhausted in review "
            "(kind=%s malformed=%d), resetting to bootstrap for fresh attempt",
            session_id,
            current_issue.kind or issue.kind,
            monitor.malformed_tool_streak,
        )
        monitor.reset_tool_turn_state(reason="review_retry_exhausted")
        monitor.malformed_tool_streak = 0
        monitor.invalid_tool_call_streak = 0
        # Return the best response we have — even if degraded — to keep
        # the conversation moving rather than returning a guardrail stub.
        degraded_text = _sanitize_tool_call_apology_text(
            _openai_message_text(working_resp)
        ).strip()
        if degraded_text and not _looks_malformed_tool_payload(degraded_text):
            return _build_safe_text_openai_response(
                working_resp, degraded_text, finish_reason="tool_calls",
            )
        return _build_clean_guardrail_openai_response(
            working_resp, finish_reason="tool_calls",
        )

    logger.error(
        "TOOL RESPONSE issue persisted after retries (session=%s kind=%s malformed=%d invalid=%d required_miss=%d); returning clean guardrail response",
        session_id,
        current_issue.kind or issue.kind,
        monitor.malformed_tool_streak,
        monitor.invalid_tool_call_streak,
        monitor.required_tool_miss_streak,
    )

    active_loop = _conversation_has_tool_results(anthropic_body) or _last_assistant_was_text_only(
        anthropic_body
    )
    fallback_finish_reason = "tool_calls" if active_loop else "stop"

    degraded_text = _sanitize_tool_call_apology_text(
        _openai_message_text(working_resp)
    ).strip()
    if degraded_text and not _looks_malformed_tool_payload(degraded_text):
        logger.warning(
            "TOOL RESPONSE degrade: session=%s returning %s safe fallback after retry exhaustion",
            session_id,
            "non-terminal active-loop" if active_loop else "terminal",
        )
        return _build_safe_text_openai_response(
            working_resp,
            degraded_text,
            finish_reason=fallback_finish_reason,
        )

    if active_loop:
        logger.warning(
            "TOOL RESPONSE guardrail: session=%s returning non-terminal active-loop fallback",
            session_id,
        )

    return _build_clean_guardrail_openai_response(
        working_resp,
        finish_reason=fallback_finish_reason,
    )


def _maybe_apply_session_contamination_breaker(
    anthropic_body: dict, monitor: SessionMonitor, session_id: str
) -> dict:
    if not PROXY_SESSION_CONTAMINATION_BREAKER:
        return anthropic_body

    threshold = max(1, PROXY_SESSION_CONTAMINATION_THRESHOLD)
    forced_threshold = max(1, PROXY_SESSION_CONTAMINATION_FORCED_THRESHOLD)
    required_miss_threshold = max(
        1, PROXY_SESSION_CONTAMINATION_REQUIRED_MISS_THRESHOLD
    )
    bad_streak = monitor.guardrail_streak()
    should_reset = (
        bad_streak >= threshold
        or (
            bad_streak >= max(1, threshold - 1)
            and monitor.consecutive_forced_count >= forced_threshold
        )
        or monitor.required_tool_miss_streak >= required_miss_threshold
    )
    if not should_reset:
        return anthropic_body

    # Cycle 15 Option 3: if contamination has already reset N+ times in this
    # session, the model is fundamentally unable to produce valid tool calls.
    # Force finalize so the Droid framework can intervene.
    max_contamination_resets = 3
    if monitor.contamination_resets >= max_contamination_resets:
        logger.error(
            "SESSION CONTAMINATION LOOP: session=%s contamination_resets=%d >= %d, forcing finalize",
            session_id,
            monitor.contamination_resets,
            max_contamination_resets,
        )
        monitor.set_tool_turn_phase("finalize", reason="contamination_loop")
        monitor.contamination_resets += 1
        monitor.malformed_tool_streak = 0
        monitor.invalid_tool_call_streak = 0
        # Remove tools to force text-only response
        updated = dict(anthropic_body)
        updated.pop("tools", None)
        updated.pop("tool_choice", None)
        msgs = updated.get("messages", [])
        msgs.append({
            "role": "user",
            "content": (
                "Tool-call generation has failed repeatedly. Respond with plain text only. "
                "Summarize what you have accomplished and what remains to be done."
            ),
        })
        return updated

    messages = anthropic_body.get("messages", [])
    keep_last = max(2, PROXY_SESSION_CONTAMINATION_KEEP_LAST)
    if len(messages) <= keep_last + 1:
        monitor.malformed_tool_streak = 0
        monitor.invalid_tool_call_streak = 0
        monitor.required_tool_miss_streak = 0
        monitor.reset_tool_turn_state(reason="contamination_guardrail_soft_reset")
        return anthropic_body

    head = messages[:1]
    tail = messages[-keep_last:]
    reset_marker = {
        "role": "user",
        "content": (
            "[SESSION RESET: tool-call quality degraded in earlier turns. "
            "Continue from the recent context and emit valid tool calls with strict JSON arguments only.]"
        ),
    }

    updated_body = dict(anthropic_body)
    updated_body["messages"] = head + [reset_marker] + tail

    forced_before = monitor.consecutive_forced_count
    required_miss_before = monitor.required_tool_miss_streak
    monitor.contamination_resets += 1
    monitor.malformed_tool_streak = 0
    monitor.invalid_tool_call_streak = 0
    monitor.required_tool_miss_streak = 0
    monitor.no_progress_streak = 0
    monitor.consecutive_forced_count = 0
    monitor.forced_auto_cooldown_turns = 0
    monitor.reset_tool_turn_state(reason="contamination_guardrail_reset")
    logger.warning(
        "SESSION CONTAMINATION BREAKER: session=%s reset applied, kept=%d messages (bad_streak=%d forced=%d required_miss=%d)",
        session_id,
        len(updated_body["messages"]),
        bad_streak,
        forced_before,
        required_miss_before,
    )

    return updated_body


# ===========================================================================
# Response Translation: OpenAI -> Anthropic
# ===========================================================================


def _maybe_extract_text_tool_calls(
    openai_resp: dict, anthropic_tools: list[dict] | None = None
) -> dict:
    """Mutate *openai_resp* in-place: if the message has no structured
    ``tool_calls`` but contains tool-call markup in text, extract them
    and promote to real ``tool_calls`` on the message.

    *anthropic_tools* (optional): list of tool definitions from the original
    Anthropic request. Enables schema-matching of bare-args markdown JSON
    blocks emitted by Gemma 4 cold turns (fix D). Without it, bare-args
    blocks pass through as text.

    Returns the (possibly-mutated) response for chaining."""
    choice = (openai_resp.get("choices") or [{}])[0]
    message = choice.get("message", {})

    # Only attempt extraction when there are NO structured tool calls
    if message.get("tool_calls"):
        return openai_resp

    text = message.get("content", "")
    if not isinstance(text, str):
        return openai_resp
    # Quick early-exit if no markers present (matches dispatcher guard)
    if (
        "<tool_call>" not in text
        and "<|tool_call>" not in text
        and "```" not in text
    ):
        return openai_resp

    extracted, remaining = _extract_tool_calls_from_text(
        text, available_tools=anthropic_tools
    )
    if not extracted:
        return openai_resp

    # Promote extracted calls to structured tool_calls
    message["tool_calls"] = extracted
    message["content"] = remaining if remaining else None
    # Fix finish_reason so downstream sees tool_calls
    choice["finish_reason"] = "tool_calls"
    return openai_resp


def _detect_and_truncate_degenerate_repetition(
    openai_resp: dict,
) -> tuple[dict, bool]:
    """Detect degenerate repetitive text and truncate at first repetition.

    When the model produces highly repetitive output (e.g. the same 20+ char
    substring repeated 10+ times), truncate at the first repetition boundary
    and set finish_reason to stop.

    Returns (response, was_degenerate) so the caller can retry if needed.
    """
    text = _openai_message_text(openai_resp)
    if not text or len(text) < 200:
        return openai_resp, False

    # Look for repeated substrings of length 20-100
    for substr_len in (60, 40, 20):
        # Sample from the middle of the text to find the repeating pattern
        mid = len(text) // 2
        sample = text[mid : mid + substr_len]
        if not sample.strip():
            continue
        count = text.count(sample)
        if count >= 8:
            # Found degenerate repetition — truncate at first occurrence + one repeat
            first_pos = text.find(sample)
            second_pos = text.find(sample, first_pos + len(sample))
            if second_pos > first_pos:
                truncated = text[:second_pos].rstrip()
                logger.warning(
                    "DEGENERATE REPETITION: detected %d repeats of %d-char substring, truncating %d -> %d chars",
                    count,
                    substr_len,
                    len(text),
                    len(truncated),
                )
                # Update the response
                choices = openai_resp.get("choices", [])
                if choices:
                    msg = choices[0].get("message", {})
                    msg["content"] = truncated
                    choices[0]["finish_reason"] = "stop"
                return openai_resp, True
    return openai_resp, False


def _client_has_tool(anthropic_body: dict, tool_name: str) -> bool:
    """Check if the client's tool list contains a tool with the given name (case-insensitive)."""
    lower = tool_name.lower()
    return any(
        (t.get("name") or "").lower() == lower for t in anthropic_body.get("tools", [])
    )


def _client_tool_name(anthropic_body: dict, tool_name: str) -> str:
    """Return the actual tool name as the client spells it (case-sensitive match)."""
    lower = tool_name.lower()
    for t in anthropic_body.get("tools", []):
        if (t.get("name") or "").lower() == lower:
            return t["name"]
    return tool_name


def _inject_synthetic_continuation(
    anthropic_resp: dict, monitor: SessionMonitor, anthropic_body: dict
) -> dict:
    """Inject a synthetic tool_use into a finalize-turn response to keep the
    client's agentic loop alive.

    Appends a no-op Read("/dev/null") tool_use block and changes stop_reason
    from "end_turn" to "tool_use" so the client continues sending requests.
    """
    # Session-level hard cap: if we've already done N continuations in this
    # session (counter is monotonic, survives fresh-user-text resets), stop
    # injecting and let the response terminate. This catches runaway loops
    # that dodge the per-cycle cap via state resets.
    if monitor.finalize_hard_stop_count >= PROXY_FINALIZE_SESSION_HARD_CAP:
        logger.warning(
            "FINALIZE CONTINUATION: session hard cap reached (%d/%d) — not injecting, allowing termination",
            monitor.finalize_hard_stop_count,
            PROXY_FINALIZE_SESSION_HARD_CAP,
        )
        return anthropic_resp

    # Pick a safe tool the client knows about (case-insensitive match,
    # then use the client's actual casing for the tool name)
    if _client_has_tool(anthropic_body, "read"):
        tool_name = _client_tool_name(anthropic_body, "read")
        tool_input = {"file_path": "/dev/null"}
    elif _client_has_tool(anthropic_body, "bash"):
        tool_name = _client_tool_name(anthropic_body, "bash")
        tool_input = {"command": "true", "description": "continuation ping"}
    else:
        logger.warning("FINALIZE CONTINUATION: no suitable tool found, skipping injection")
        return anthropic_resp

    synthetic_id = f"toolu_{uuid.uuid4().hex[:12]}"
    monitor.finalize_synthetic_tool_id = synthetic_id
    monitor.finalize_continuation_count += 1
    monitor.finalize_hard_stop_count += 1

    content = anthropic_resp.get("content", [])
    content.append({
        "type": "tool_use",
        "id": synthetic_id,
        "name": tool_name,
        "input": tool_input,
    })
    anthropic_resp["content"] = content
    anthropic_resp["stop_reason"] = "tool_use"

    logger.info(
        "FINALIZE CONTINUATION: injected synthetic %s tool_use id=%s (count=%d/%d, session=%d/%d)",
        tool_name,
        synthetic_id,
        monitor.finalize_continuation_count,
        PROXY_FINALIZE_CONTINUATION_MAX,
        monitor.finalize_hard_stop_count,
        PROXY_FINALIZE_SESSION_HARD_CAP,
    )
    return anthropic_resp


def openai_to_anthropic_response(openai_resp: dict, model: str) -> dict:
    """Convert an OpenAI Chat Completions response to Anthropic Messages format."""
    # First: try to recover tool calls trapped in text XML tags
    _maybe_extract_text_tool_calls(openai_resp)
    # Second: strip garbled/degenerate tool call arguments
    _sanitize_garbled_tool_calls(openai_resp)

    choice = openai_resp.get("choices", [{}])[0]
    message = choice.get("message", {})
    finish = choice.get("finish_reason", "stop")

    content = []
    if message.get("content"):
        raw_text = (
            message["content"]
            if isinstance(message["content"], str)
            else str(message["content"])
        )
        sanitized_text = _sanitize_tool_call_apology_text(raw_text)
        if sanitized_text != raw_text:
            logger.warning(
                "SANITIZE: replaced known malformed tool-call apology text in assistant response"
            )
        # Option 1: Strip residual <tool_call> XML that wasn't extracted
        sanitized_text = _strip_residual_tool_call_xml(sanitized_text)
        if sanitized_text != raw_text and "<tool_call>" in raw_text:
            logger.warning(
                "SANITIZE: stripped residual <tool_call> XML from text content"
            )
        content.append({"type": "text", "text": sanitized_text})

    # Convert tool calls
    for tc in message.get("tool_calls", []):
        fn = tc.get("function", {})
        try:
            args = json.loads(fn.get("arguments", "{}"))
        except json.JSONDecodeError:
            args = {}
        if fn.get("name", "").strip().lower() == "bash" and isinstance(args, dict):
            command = args.get("command")
            if isinstance(command, str):
                cleaned_command, had_protocol_lines = _strip_protocol_tag_only_lines(
                    command
                )
                if had_protocol_lines:
                    args = dict(args)
                    args["command"] = cleaned_command
                    logger.warning(
                        "BASH SAFETY: stripped standalone protocol-tag lines from command before tool execution"
                    )
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

    # Close any open tool call blocks (skip if XML recovery already emitted them)
    xml_recovered = tool_calls_by_index.pop("_xml_recovered", False)
    if tool_calls_by_index and not xml_recovered:
        for tc in tool_calls_by_index.values():
            if isinstance(tc, dict) and "block_index" in tc:
                yield (
                    f"event: content_block_stop\n"
                    f"data: {json.dumps({'type': 'content_block_stop', 'index': tc['block_index']})}\n\n"
                )
    elif not tool_calls_by_index:
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
    tc_names = [
        tc["name"]
        for tc in tool_calls_by_index.values()
        if isinstance(tc, dict) and "name" in tc
    ]
    tc_args = [
        tc.get("arguments", "")
        for tc in tool_calls_by_index.values()
        if isinstance(tc, dict) and "name" in tc
    ]
    logger.info(
        "RESP: finish=%s output_tokens=%d text_len=%d text=%.300s tool_calls=%s args=%s",
        finish_reason,
        output_tokens,
        len(accumulated_text),
        accumulated_text[:300],
        tc_names,
        [a[:200] for a in tc_args],
    )

    # -------------------------------------------------------------------
    # Post-stream: recover <tool_call> XML from accumulated text
    # -------------------------------------------------------------------
    if not tool_calls_by_index and "<tool_call>" in accumulated_text:
        xml_extracted, remaining_text = _extract_tool_calls_from_text(accumulated_text)
        if xml_extracted:
            # We already streamed the text as-is.  We cannot un-stream it,
            # but we CAN close the text block, emit the recovered tool_use
            # blocks, and fix the finish_reason so Claude Code sees them.
            yield (
                f"event: content_block_stop\n"
                f"data: {json.dumps({'type': 'content_block_stop', 'index': 0})}\n\n"
            )
            for idx, xtc in enumerate(xml_extracted, start=1):
                fn = xtc.get("function", {})
                tc_id = xtc.get("id", f"toolu_{uuid.uuid4().hex[:12]}")
                tc_name = fn.get("name", "")
                tc_args = fn.get("arguments", "{}")
                tool_calls_by_index[idx] = {
                    "id": tc_id,
                    "name": tc_name,
                    "arguments": tc_args,
                    "block_index": idx,
                }
                yield (
                    f"event: content_block_start\n"
                    f"data: {json.dumps({'type': 'content_block_start', 'index': idx, 'content_block': {'type': 'tool_use', 'id': tc_id, 'name': tc_name}})}\n\n"
                )
                yield (
                    f"event: content_block_delta\n"
                    f"data: {json.dumps({'type': 'content_block_delta', 'index': idx, 'delta': {'type': 'input_json_delta', 'partial_json': tc_args}})}\n\n"
                )
                yield (
                    f"event: content_block_stop\n"
                    f"data: {json.dumps({'type': 'content_block_stop', 'index': idx})}\n\n"
                )
            finish_reason = "tool_use"
            accumulated_text = remaining_text
            # Skip the normal text block close below
            tool_calls_by_index["_xml_recovered"] = True

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
                        if isinstance(tc, dict) and "name" in tc
                    ],
                },
            }
        ]
    }

    stream_issue = _classify_tool_response_issue(
        synthetic_openai_resp,
        anthropic_body,
        required_tool_choice=False,
    )

    if stream_issue.kind == "malformed_payload":
        monitor.malformed_tool_streak += 1
    elif stream_issue.kind == "invalid_tool_args":
        monitor.invalid_tool_call_streak += 1
        monitor.arg_preflight_rejections += 1
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
        monitor.invalid_tool_call_streak = 0
        monitor.required_tool_miss_streak = 0

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


def _build_passthrough_headers(request: Request) -> dict | None:
    api_key = request.headers.get("x-api-key") or ANTHROPIC_API_KEY
    if not api_key:
        return None
    headers = {
        "Content-Type": "application/json",
        "x-api-key": api_key,
        "anthropic-version": request.headers.get("anthropic-version", "2023-06-01"),
    }
    beta = request.headers.get("anthropic-beta")
    if beta:
        headers["anthropic-beta"] = beta
    return headers


async def _stream_passthrough(resp: httpx.Response):
    async for chunk in resp.aiter_bytes():
        yield chunk
    await resp.aclose()


async def _passthrough_anthropic_request(
    request: Request, body: dict, is_stream: bool
) -> Response:
    headers = _build_passthrough_headers(request)
    if not headers:
        return Response(
            content=json.dumps(
                {
                    "type": "error",
                    "error": {
                        "type": "authentication_error",
                        "message": "Missing Anthropic API key for passthrough request",
                    },
                }
            ),
            status_code=401,
            media_type="application/json",
        )

    client = http_client
    if client is None:
        return Response(
            content=json.dumps({"error": "Proxy not initialized"}),
            status_code=503,
            media_type="application/json",
        )

    url = f"{ANTHROPIC_API_BASE.rstrip('/')}/v1/messages"

    if is_stream:
        resp = await client.send(
            client.build_request("POST", url, json=body, headers=headers)
        )
        if resp.status_code != 200:
            return Response(
                content=resp.text,
                status_code=resp.status_code,
                media_type=resp.headers.get("content-type", "application/json"),
            )
        return StreamingResponse(
            _stream_passthrough(resp),
            status_code=resp.status_code,
            media_type=resp.headers.get("content-type", "text/event-stream"),
        )

    resp = await client.post(url, json=body, headers=headers)
    return Response(
        content=resp.content,
        status_code=resp.status_code,
        media_type=resp.headers.get("content-type", "application/json"),
    )


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
    is_stream = body.get("stream", False)
    model = body.get("model", "default")
    client_id = resolve_client_id(request)

    # Periodically re-detect context window from upstream (handles server restarts)
    await _maybe_recheck_context_window()

    if _should_passthrough_model(model):
        logger.info("PASSTHROUGH: model=%s -> %s", model, ANTHROPIC_API_BASE)
        return await _passthrough_anthropic_request(request, body, is_stream)
    session_id = resolve_session_id(request, body)
    monitor = get_session_monitor(session_id)
    last_session_id = session_id

    profile_prompt_suffix = None
    profile_grammar = None
    requested_profile = _resolve_profile_name(request.headers, body)
    if requested_profile:
        profile_config = _load_profile_config(requested_profile)
        if not profile_config and requested_profile != "generic":
            profile_config = _load_profile_config("generic")
            if requested_profile not in PROFILE_WARNED:
                logger.warning(
                    "Profile %s not found; falling back to generic",
                    requested_profile,
                )
                PROFILE_WARNED.add(requested_profile)
            requested_profile = "generic"
        if profile_config:
            body, profile_prompt_suffix, profile_grammar = _apply_profile_overrides(
                body, profile_config
            )
            if profile_config.get("context_window"):
                monitor.context_window = int(profile_config["context_window"])
            logger.info("PROFILE: request=%s model=%s", requested_profile, body.get("model"))

    model = body.get("model", "default")
    body = _maybe_apply_session_contamination_breaker(body, monitor, session_id)
    body, analysis_tools_removed = _maybe_route_analysis_without_tools(body)
    if analysis_tools_removed > 0:
        monitor.consecutive_forced_count = 0
        monitor.no_progress_streak = 0
        logger.info(
            "ANALYSIS ROUTE: disabled %d tools for analysis-only prompt",
            analysis_tools_removed,
        )

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
    rate_count = log_client_rate(client_id)
    logger.info(
        "REQ: client=%s sess=%s rate_%ss=%d stream=%s msgs=%d tools=%d max_tokens=%s last_role=%s last_content=%.200s",
        client_id,
        session_id,
        PROXY_CLIENT_RATE_WINDOW_SECS,
        rate_count,
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
    # Option 1: Prefer upstream actual token count over local estimate
    ctx_window = monitor.context_window
    if ctx_window > 0:
        # Use the upstream's actual prompt_tokens if available and higher
        # than the local estimate (the upstream counts chat template overhead,
        # tool schema tokenization, etc. that local heuristics miss).
        effective_tokens = estimated_tokens
        if monitor.last_input_tokens > estimated_tokens:
            effective_tokens = monitor.last_input_tokens
            logger.info(
                "Using upstream token count %d (local estimate %d) for prune decision",
                effective_tokens,
                estimated_tokens,
            )
        utilization = effective_tokens / ctx_window
        if utilization >= PROXY_CONTEXT_PRUNE_THRESHOLD:
            logger.warning(
                "Context utilization %.1f%% exceeds threshold %.1f%% -- pruning conversation",
                utilization * 100,
                PROXY_CONTEXT_PRUNE_THRESHOLD * 100,
            )
            # Option 3: Aggressive pruning at critical utilization
            target_frac = _resolve_prune_target_fraction()
            keep_last = 8
            if utilization >= 0.90:
                keep_last = 4
                target_frac = min(target_frac, 0.40)
                logger.warning(
                    "CRITICAL PRUNE: utilization %.1f%% >= 90%%, using keep_last=%d target=%.0f%%",
                    utilization * 100,
                    keep_last,
                    target_frac * 100,
                )
            body = prune_conversation(
                body, ctx_window, target_fraction=target_frac, keep_last=keep_last
            )
            monitor.prune_count += 1
            # Option 4: Post-prune validation — verify actual reduction
            estimated_tokens = estimate_total_tokens(body)
            monitor.record_request(estimated_tokens)
            post_util = estimated_tokens / ctx_window
            n_messages = len(body.get("messages", []))
            logger.info(
                "After pruning: ~%d tokens (%d messages), utilization %.1f%%",
                estimated_tokens,
                n_messages,
                post_util * 100,
            )
            # If still above threshold after first prune, do aggressive second pass
            if post_util >= PROXY_CONTEXT_PRUNE_THRESHOLD:
                logger.warning(
                    "POST-PRUNE VALIDATION: still at %.1f%% after prune, doing aggressive pass",
                    post_util * 100,
                )
                body = prune_conversation(
                    body, ctx_window, target_fraction=0.35, keep_last=4
                )
                monitor.prune_count += 1
                estimated_tokens = estimate_total_tokens(body)
                monitor.record_request(estimated_tokens)
                post_util = estimated_tokens / ctx_window
                n_messages = len(body.get("messages", []))
                logger.info(
                    "After aggressive prune: ~%d tokens (%d messages), utilization %.1f%%",
                    estimated_tokens,
                    n_messages,
                    post_util * 100,
                )
            # Option 2: Circuit breaker — if 3+ consecutive prunes and still above,
            # force finalize (drop tools, let model wrap up)
            if monitor.prune_count >= 3 and post_util >= PROXY_CONTEXT_PRUNE_THRESHOLD:
                logger.error(
                    "PRUNE CIRCUIT BREAKER: %d consecutive prunes, still at %.1f%%. "
                    "Forcing finalize to prevent death spiral.",
                    monitor.prune_count,
                    post_util * 100,
                )
                monitor.set_tool_turn_phase("finalize", reason="prune_circuit_breaker")
                monitor.tool_state_auto_budget_remaining = 1
                monitor.reset_completion_recovery()

    openai_body = build_openai_request(
        body,
        monitor,
        profile_prompt_suffix=profile_prompt_suffix,
        profile_grammar=profile_grammar,
    )

    client = http_client
    if client is None:
        return Response(
            content=json.dumps({"error": "Proxy not initialized"}),
            status_code=503,
            media_type="application/json",
        )

    use_guarded_non_stream = _should_use_guarded_non_stream(
        is_stream,
        body,
        openai_body,
    )
    if use_guarded_non_stream:
        strict_body = dict(openai_body)
        strict_body["stream"] = False

        try:
            strict_resp = await _post_with_generation_timeout(
                client,
                f"{LLAMA_CPP_BASE}/chat/completions",
                strict_body,
                {"Content-Type": "application/json"},
            )
        except Exception as exc:
            # Check if upstream is hung before returning error
            await _check_slot_hang(f"{LLAMA_CPP_BASE}/slots")
            return Response(
                content=json.dumps(
                    {
                        "type": "error",
                        "error": {
                            "type": "overloaded_error",
                            "message": f"Upstream server unavailable after {PROXY_UPSTREAM_RETRY_MAX} retries: {exc}",
                        },
                    }
                ),
                status_code=529,
                media_type="application/json",
            )

        if strict_resp.status_code != 200:
            error_text = strict_resp.text[:1000]
            if _maybe_disable_grammar_for_tools_error(
                strict_body,
                strict_resp.status_code,
                error_text,
                "strict-stream",
            ):
                try:
                    strict_resp = await _post_with_generation_timeout(
                        client,
                        f"{LLAMA_CPP_BASE}/chat/completions",
                        strict_body,
                        {"Content-Type": "application/json"},
                    )
                except Exception as exc:
                    return Response(
                        content=json.dumps(
                            {
                                "type": "error",
                                "error": {
                                    "type": "overloaded_error",
                                    "message": f"Upstream server unavailable after {PROXY_UPSTREAM_RETRY_MAX} retries: {exc}",
                                },
                            }
                        ),
                        status_code=529,
                        media_type="application/json",
                    )

        if strict_resp.status_code != 200:
            error_text = strict_resp.text[:1000]
            # Cycle 19 Option 2: For 503 "Loading model", don't advance state
            # machine — return retriable 503 with Retry-After header so the
            # client can retry without wasting state machine budget.
            if _is_loading_model_503(strict_resp):
                logger.warning(
                    "Upstream 503 Loading model (strict-stream) — returning retriable 503 without advancing state",
                )
                return Response(
                    content=json.dumps(
                        {
                            "type": "error",
                            "error": {
                                "type": "overloaded_error",
                                "message": "Upstream model is loading. Retry in 10 seconds.",
                            },
                        }
                    ),
                    status_code=503,
                    headers={"Retry-After": "10"},
                    media_type="application/json",
                )
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
        # Recover tool calls from <tool_call> XML before guardrails run
        _maybe_extract_text_tool_calls(openai_resp, anthropic_tools=body.get("tools"))
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

        openai_resp, was_degenerate = _detect_and_truncate_degenerate_repetition(openai_resp)
        if was_degenerate:
            # Retry with constrained parameters to avoid degenerate output.
            # With tools: force tool_choice=required for a useful tool call.
            # Without tools (finalize): retry with capped max_tokens for clean text.
            has_tools = bool(strict_body.get("tools"))
            retry_body = dict(strict_body)
            retry_body["max_tokens"] = 2048
            retry_body["temperature"] = 0.1
            retry_body["stream"] = False
            if has_tools:
                retry_body["tool_choice"] = "required"
                logger.warning("DEGENERATE RETRY: retrying with tool_choice=required max_tokens=2048")
            else:
                logger.warning("DEGENERATE RETRY: retrying text-only with max_tokens=2048 temp=0.1")
            try:
                retry_resp = await _post_with_generation_timeout(
                    client, f"{LLAMA_CPP_BASE}/chat/completions", retry_body,
                    {"Content-Type": "application/json"},
                )
                if retry_resp.status_code == 200:
                    retry_data = retry_resp.json()
                    retry_text = _openai_message_text(retry_data)
                    _, retry_degenerate = _detect_and_truncate_degenerate_repetition(retry_data)
                    if retry_degenerate:
                        logger.info("DEGENERATE RETRY: retry also degenerate, using truncated original")
                    elif has_tools and (retry_data.get("choices", [{}])[0]
                            .get("message", {}).get("tool_calls")):
                        logger.info("DEGENERATE RETRY: success, got tool call")
                        openai_resp = retry_data
                    elif not has_tools and retry_text and len(retry_text) > 50:
                        logger.info("DEGENERATE RETRY: success, got clean text (%d chars)", len(retry_text))
                        openai_resp = retry_data
                    else:
                        logger.info("DEGENERATE RETRY: retry insufficient, using truncated original")
            except Exception as exc:
                logger.warning("DEGENERATE RETRY: failed: %s", exc)
        anthropic_resp = openai_to_anthropic_response(openai_resp, model)
        # FINALIZE CONTINUATION: inject synthetic tool_use to keep client loop alive
        if (
            monitor.finalize_turn_active
            and monitor.finalize_continuation_count < PROXY_FINALIZE_CONTINUATION_MAX
            and anthropic_resp.get("stop_reason") == "end_turn"
        ):
            anthropic_resp = _inject_synthetic_continuation(anthropic_resp, monitor, body)
        monitor.record_response(anthropic_resp.get("usage", {}).get("output_tokens", 0))
        # Update last_input_tokens from upstream's actual prompt_tokens
        upstream_input = anthropic_resp.get("usage", {}).get("input_tokens", 0)
        if upstream_input > 0:
            monitor.last_input_tokens = upstream_input
        if PROXY_FORCE_NON_STREAM:
            logger.info(
                "FORCED NON-STREAM: served stream response via guarded non-stream path"
            )
        elif PROXY_MALFORMED_TOOL_STREAM_STRICT and _has_tool_definitions(body):
            logger.info(
                "STRICT STREAM GUARDRAIL: served stream response via guarded non-stream path"
            )
        else:
            logger.info(
                "REQUIRED TOOL STREAM GUARDRAIL: served stream response via guarded non-stream path"
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
        MAX_UPSTREAM_RETRIES = PROXY_UPSTREAM_RETRY_MAX
        RETRY_DELAY_SECS = PROXY_UPSTREAM_RETRY_DELAY_SECS
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
            except (httpx.ConnectError, httpx.RemoteProtocolError, httpx.ReadTimeout) as exc:
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
            if _maybe_disable_grammar_for_tools_error(
                openai_body,
                resp.status_code,
                error_text,
                "stream",
            ):
                resp = await client.send(
                    client.build_request(
                        "POST",
                        f"{LLAMA_CPP_BASE}/chat/completions",
                        json=openai_body,
                        headers={"Content-Type": "application/json"},
                    ),
                    stream=True,
                )
                if resp.status_code == 200:
                    return StreamingResponse(
                        stream_anthropic_response(resp, model, monitor, body),
                        media_type="text/event-stream",
                        headers={
                            "Cache-Control": "no-cache",
                            "Connection": "keep-alive",
                        },
                    )

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
        try:
            resp = await _post_with_generation_timeout(
                client,
                f"{LLAMA_CPP_BASE}/chat/completions",
                openai_body,
                {"Content-Type": "application/json"},
            )
        except Exception as exc:
            return Response(
                content=json.dumps(
                    {
                        "type": "error",
                        "error": {
                            "type": "overloaded_error",
                            "message": f"Upstream server unavailable after {PROXY_UPSTREAM_RETRY_MAX} retries: {exc}",
                        },
                    }
                ),
                status_code=529,
                media_type="application/json",
            )

        if resp.status_code != 200:
            error_text = resp.text[:1000]
            if _maybe_disable_grammar_for_tools_error(
                openai_body,
                resp.status_code,
                error_text,
                "non-stream",
            ):
                try:
                    resp = await _post_with_generation_timeout(
                        client,
                        f"{LLAMA_CPP_BASE}/chat/completions",
                        openai_body,
                        {"Content-Type": "application/json"},
                    )
                except Exception as exc:
                    return Response(
                        content=json.dumps(
                            {
                                "type": "error",
                                "error": {
                                    "type": "overloaded_error",
                                    "message": f"Upstream server unavailable after {PROXY_UPSTREAM_RETRY_MAX} retries: {exc}",
                                },
                            }
                        ),
                        status_code=529,
                        media_type="application/json",
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
        # Recover tool calls from <tool_call> XML before guardrails run
        _maybe_extract_text_tool_calls(openai_resp, anthropic_tools=body.get("tools"))
        openai_resp = await _apply_unexpected_end_turn_guardrail(
            client,
            openai_resp,
            openai_body,
            body,
            monitor,
            session_id,
        )
        openai_resp = await _apply_completion_contract_guardrail(
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
            monitor.invalid_tool_call_streak = 0
            monitor.required_tool_miss_streak = 0

        openai_resp, was_degenerate = _detect_and_truncate_degenerate_repetition(openai_resp)
        # Degenerate retry for non-guarded stream path
        if was_degenerate and openai_body.get("tools"):
            logger.warning("DEGENERATE RETRY (stream): retrying with tool_choice=required max_tokens=2048")
            retry_body = dict(openai_body)
            retry_body["tool_choice"] = "required"
            retry_body["max_tokens"] = 2048
            retry_body["temperature"] = 0.1
            retry_body["stream"] = False
            try:
                retry_resp = await _post_with_generation_timeout(
                    client, f"{LLAMA_CPP_BASE}/chat/completions", retry_body,
                    {"Content-Type": "application/json"},
                )
                if retry_resp.status_code == 200:
                    retry_data = retry_resp.json()
                    if (retry_data.get("choices", [{}])[0]
                            .get("message", {}).get("tool_calls")):
                        logger.info("DEGENERATE RETRY (stream): success, got tool call")
                        openai_resp = retry_data
                    else:
                        logger.info("DEGENERATE RETRY (stream): no tool call, using truncated")
            except Exception as exc:
                logger.warning("DEGENERATE RETRY (stream): failed: %s", exc)
        anthropic_resp = openai_to_anthropic_response(openai_resp, model)
        # FINALIZE CONTINUATION: inject synthetic tool_use (non-guarded stream path)
        if (
            monitor.finalize_turn_active
            and monitor.finalize_continuation_count < PROXY_FINALIZE_CONTINUATION_MAX
            and anthropic_resp.get("stop_reason") == "end_turn"
        ):
            anthropic_resp = _inject_synthetic_continuation(anthropic_resp, monitor, body)

        # Track output tokens in session monitor
        output_tokens = anthropic_resp.get("usage", {}).get("output_tokens", 0)
        monitor.record_response(output_tokens)
        # Update last_input_tokens from upstream's actual prompt_tokens
        upstream_input = anthropic_resp.get("usage", {}).get("input_tokens", 0)
        if upstream_input > 0:
            monitor.last_input_tokens = upstream_input

        return anthropic_resp


@app.post("/anthropic/v1/messages")
async def messages_anthropic(request: Request):
    """Alternative endpoint path used by some Claude Code configurations."""
    return await messages(request)


@app.post("/v1/chat/completions")
async def chat_completions(request: Request):
    """OpenAI-compatible chat/completions endpoint for clients like Forge
    that require the OpenAI API shape.

    FULL GUARDRAIL PATH: Converts the OpenAI request to Anthropic format,
    runs the full /v1/messages pipeline (loop detection, tool narrowing,
    cycle breaking, malformed tool retry, context pruning, etc.), then
    converts the Anthropic response back to OpenAI format.

    Streaming is down-converted to a single final OpenAI SSE chunk sequence
    built from the completed Anthropic response (not token-by-token from
    upstream). This preserves guardrails at the cost of stream granularity.
    """
    body_bytes = await request.body()
    try:
        openai_body = json.loads(body_bytes) if body_bytes else {}
    except (ValueError, TypeError):
        return Response(
            content=b'{"error":{"message":"invalid JSON","type":"invalid_request_error"}}',
            status_code=400,
            media_type="application/json",
        )

    requested_stream = bool(openai_body.get("stream", False))
    model = openai_body.get("model", "default")
    client_id = resolve_client_id(request)

    logger.info(
        "CHAT (guarded): client=%s model=%s stream=%s msgs=%d tools=%d",
        client_id,
        model,
        requested_stream,
        len(openai_body.get("messages", [])),
        len(openai_body.get("tools", []) or []),
    )

    # Convert OpenAI request -> Anthropic request
    anthropic_body = openai_to_anthropic_request(openai_body)
    # Force non-streaming through the pipeline; we re-stream at the end if the
    # client wanted streaming. This keeps guardrail logic simpler/consistent.
    anthropic_body["stream"] = False

    # Build a synthetic Request that the existing messages() handler can consume
    fake_body_bytes = json.dumps(anthropic_body).encode("utf-8")

    async def receive():
        return {"type": "http.request", "body": fake_body_bytes, "more_body": False}

    fake_scope = dict(request.scope)
    # Preserve client/headers but override the body + path
    fake_scope["path"] = "/v1/messages"
    fake_scope["raw_path"] = b"/v1/messages"
    # Strip content-length since the body changes
    fake_scope["headers"] = [
        (k, v)
        for (k, v) in fake_scope.get("headers", [])
        if k.lower() != b"content-length"
    ]
    fake_request = Request(fake_scope, receive)

    # Run the full guarded Anthropic pipeline
    inner_resp = await messages(fake_request)

    # Extract the Anthropic-format JSON from whatever messages() returned
    anthropic_resp_dict: dict | None = None
    status_code = 200
    if isinstance(inner_resp, StreamingResponse):
        # Pipeline shouldn't stream because we set stream=False, but defensively
        # consume the stream and parse the final message event.
        chunks: list[bytes] = []
        async for chunk in inner_resp.body_iterator:
            if isinstance(chunk, bytes):
                chunks.append(chunk)
            elif isinstance(chunk, str):
                chunks.append(chunk.encode("utf-8"))
        raw = b"".join(chunks)
        # Try to parse as JSON directly first, then fall back to SSE parsing
        try:
            anthropic_resp_dict = json.loads(raw)
        except (ValueError, TypeError):
            anthropic_resp_dict = _parse_anthropic_sse_to_message(raw)
    elif isinstance(inner_resp, Response):
        status_code = inner_resp.status_code
        try:
            anthropic_resp_dict = json.loads(inner_resp.body)
        except (ValueError, TypeError):
            anthropic_resp_dict = None
    elif isinstance(inner_resp, dict):
        anthropic_resp_dict = inner_resp

    if anthropic_resp_dict is None or "content" not in anthropic_resp_dict:
        # Upstream error: forward as-is in OpenAI error shape
        err_msg = "upstream returned no message"
        if isinstance(anthropic_resp_dict, dict) and "error" in anthropic_resp_dict:
            err_msg = anthropic_resp_dict["error"].get("message", err_msg)
        return Response(
            content=json.dumps({"error": {"message": err_msg, "type": "upstream_error"}}).encode(),
            status_code=status_code if status_code >= 400 else 502,
            media_type="application/json",
        )

    # Ensure model field is set for response
    anthropic_resp_dict.setdefault("model", model)
    openai_resp = anthropic_to_openai_response(anthropic_resp_dict)

    if not requested_stream:
        return Response(
            content=json.dumps(openai_resp).encode(),
            status_code=200,
            media_type="application/json",
        )

    # Client requested streaming: emit the response as OpenAI SSE chunks
    async def emit_openai_stream():
        resp_id = openai_resp["id"]
        created = openai_resp["created"]
        model_name = openai_resp["model"]
        choice = openai_resp["choices"][0]
        message = choice["message"]

        # Opening chunk: role
        opening = {
            "id": resp_id,
            "object": "chat.completion.chunk",
            "created": created,
            "model": model_name,
            "choices": [{"index": 0, "delta": {"role": "assistant"}, "finish_reason": None}],
        }
        yield f"data: {json.dumps(opening)}\n\n".encode()

        # Content chunk
        if message.get("content"):
            content_chunk = {
                "id": resp_id,
                "object": "chat.completion.chunk",
                "created": created,
                "model": model_name,
                "choices": [
                    {
                        "index": 0,
                        "delta": {"content": message["content"]},
                        "finish_reason": None,
                    }
                ],
            }
            yield f"data: {json.dumps(content_chunk)}\n\n".encode()

        # Tool call chunks
        for idx, tc in enumerate(message.get("tool_calls", []) or []):
            tc_chunk = {
                "id": resp_id,
                "object": "chat.completion.chunk",
                "created": created,
                "model": model_name,
                "choices": [
                    {
                        "index": 0,
                        "delta": {
                            "tool_calls": [
                                {
                                    "index": idx,
                                    "id": tc["id"],
                                    "type": "function",
                                    "function": {
                                        "name": tc["function"]["name"],
                                        "arguments": tc["function"]["arguments"],
                                    },
                                }
                            ]
                        },
                        "finish_reason": None,
                    }
                ],
            }
            yield f"data: {json.dumps(tc_chunk)}\n\n".encode()

        # Final chunk with finish_reason
        final_chunk = {
            "id": resp_id,
            "object": "chat.completion.chunk",
            "created": created,
            "model": model_name,
            "choices": [
                {"index": 0, "delta": {}, "finish_reason": choice["finish_reason"]}
            ],
        }
        yield f"data: {json.dumps(final_chunk)}\n\n".encode()
        yield b"data: [DONE]\n\n"

    return StreamingResponse(
        emit_openai_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


def _parse_anthropic_sse_to_message(raw: bytes) -> dict | None:
    """Parse a concatenated Anthropic SSE stream into a final message dict.
    Used as a fallback when messages() returns a StreamingResponse despite stream=False.
    """
    try:
        text = raw.decode("utf-8", errors="replace")
    except Exception:
        return None

    text_parts: list[str] = []
    tool_uses: list[dict] = []
    usage = {"input_tokens": 0, "output_tokens": 0}
    stop_reason = "end_turn"
    model = "unknown"
    message_id = f"msg_{uuid.uuid4().hex[:24]}"

    current_block: dict | None = None
    current_json_buffer = ""

    for line in text.splitlines():
        if not line.startswith("data:"):
            continue
        payload = line[5:].strip()
        if not payload or payload == "[DONE]":
            continue
        try:
            evt = json.loads(payload)
        except (ValueError, TypeError):
            continue
        etype = evt.get("type")
        if etype == "message_start":
            m = evt.get("message", {}) or {}
            message_id = m.get("id", message_id)
            model = m.get("model", model)
            if "usage" in m:
                usage.update(m["usage"])
        elif etype == "content_block_start":
            current_block = evt.get("content_block", {})
            current_json_buffer = ""
            if current_block.get("type") == "text":
                text_parts.append(current_block.get("text", ""))
        elif etype == "content_block_delta":
            d = evt.get("delta", {}) or {}
            if d.get("type") == "text_delta":
                text_parts.append(d.get("text", ""))
            elif d.get("type") == "input_json_delta":
                current_json_buffer += d.get("partial_json", "")
        elif etype == "content_block_stop":
            if current_block and current_block.get("type") == "tool_use":
                try:
                    input_obj = json.loads(current_json_buffer) if current_json_buffer else {}
                except (ValueError, TypeError):
                    input_obj = {}
                tool_uses.append(
                    {
                        "type": "tool_use",
                        "id": current_block.get("id", f"toolu_{uuid.uuid4().hex[:12]}"),
                        "name": current_block.get("name", ""),
                        "input": input_obj,
                    }
                )
            current_block = None
            current_json_buffer = ""
        elif etype == "message_delta":
            d = evt.get("delta", {}) or {}
            if "stop_reason" in d:
                stop_reason = d["stop_reason"] or stop_reason
            u = evt.get("usage", {}) or {}
            if u:
                usage.update(u)

    content: list[dict] = []
    joined_text = "".join(text_parts)
    if joined_text:
        content.append({"type": "text", "text": joined_text})
    content.extend(tool_uses)

    return {
        "id": message_id,
        "type": "message",
        "role": "assistant",
        "content": content if content else [{"type": "text", "text": ""}],
        "model": model,
        "stop_reason": stop_reason,
        "stop_sequence": None,
        "usage": usage,
    }


@app.get("/v1/models")
async def models():
    """Return available model list (spoofs Anthropic model IDs for client compatibility)."""
    return {
        "data": [
            {"id": "claude-opus-4-6-20260101", "object": "model"},
            {"id": "claude-sonnet-4-6-20250514", "object": "model"},
            {"id": "gpt-5.4", "object": "model"},
            {"id": "gpt-5.3-codex", "object": "model"},
            {"id": "claude-opus-4-6-20250616", "object": "model"},
            {"id": "qwen35-a3b-iq4xs", "object": "model"},
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
        "tool_call_grammar": {
            "enabled": PROXY_TOOL_CALL_GRAMMAR,
            "required_only": PROXY_TOOL_CALL_GRAMMAR_REQUIRED_ONLY,
            "path": PROXY_TOOL_CALL_GRAMMAR_PATH,
            "loaded": bool(TOOL_CALL_GBNF),
            "tools_compatible": TOOL_CALL_GRAMMAR_TOOLS_COMPATIBLE,
        },
        # Loop protection stats
        "loop_protection": {
            "enabled": PROXY_LOOP_BREAKER,
            "consecutive_forced_count": monitor.consecutive_forced_count,
            "no_progress_streak": monitor.no_progress_streak,
            "loop_warnings_emitted": monitor.loop_warnings_emitted,
            "unexpected_end_turn_count": monitor.unexpected_end_turn_count,
            "malformed_tool_streak": monitor.malformed_tool_streak,
            "invalid_tool_call_streak": monitor.invalid_tool_call_streak,
            "required_tool_miss_streak": monitor.required_tool_miss_streak,
            "guardrail_streak": monitor.guardrail_streak(),
            "arg_preflight_rejections": monitor.arg_preflight_rejections,
            "arg_preflight_repairs": monitor.arg_preflight_repairs,
            "forced_auto_cooldown_turns": monitor.forced_auto_cooldown_turns,
            "forced_dampener_triggers": monitor.forced_dampener_triggers,
            "contamination_resets": monitor.contamination_resets,
            "tool_turn_phase": monitor.tool_turn_phase,
            "tool_state_forced_budget_remaining": monitor.tool_state_forced_budget_remaining,
            "tool_state_auto_budget_remaining": monitor.tool_state_auto_budget_remaining,
            "tool_state_stagnation_streak": monitor.tool_state_stagnation_streak,
            "tool_state_transitions": monitor.tool_state_transitions,
            "tool_state_review_cycles": monitor.tool_state_review_cycles,
            "finalize_turn_active": monitor.finalize_turn_active,
            "completion_required": monitor.completion_required,
            "completion_pending": monitor.completion_pending,
            "completion_verified": monitor.completion_verified,
            "completion_blockers": monitor.completion_blockers,
            "completion_progress_signals": monitor.completion_progress_signals,
            "completion_recovery_attempts": monitor.completion_recovery_attempts,
            "tool_call_history_len": len(monitor.tool_call_history),
            "is_looping": monitor.detect_tool_loop(window=PROXY_LOOP_WINDOW)[0],
            "loop_repeat_count": monitor.detect_tool_loop(window=PROXY_LOOP_WINDOW)[1],
            "is_cycle_looping": monitor.detect_tool_cycle(
                window=max(2, PROXY_TOOL_STATE_CYCLE_WINDOW)
            )[0],
            "cycle_repeat_count": monitor.detect_tool_cycle(
                window=max(2, PROXY_TOOL_STATE_CYCLE_WINDOW)
            )[1],
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
