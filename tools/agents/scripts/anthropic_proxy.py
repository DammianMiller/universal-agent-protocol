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
import copy
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
    os.environ.get("PROXY_TOOL_STATE_FORCED_BUDGET", "24")
)
PROXY_TOOL_STATE_AUTO_BUDGET = int(os.environ.get("PROXY_TOOL_STATE_AUTO_BUDGET", "2"))
PROXY_TOOL_STATE_STAGNATION_THRESHOLD = int(
    os.environ.get("PROXY_TOOL_STATE_STAGNATION_THRESHOLD", "12")
)
PROXY_TOOL_STATE_CYCLE_WINDOW = int(
    os.environ.get("PROXY_TOOL_STATE_CYCLE_WINDOW", "8")
)
PROXY_TOOL_STATE_FINALIZE_THRESHOLD = int(
    os.environ.get("PROXY_TOOL_STATE_FINALIZE_THRESHOLD", "24")
)
PROXY_TOOL_STATE_REVIEW_CYCLE_LIMIT = int(
    os.environ.get("PROXY_TOOL_STATE_REVIEW_CYCLE_LIMIT", "3")
)
PROXY_TOOL_NARROWING_EXPAND_ON_LOOP = os.environ.get(
    "PROXY_TOOL_NARROWING_EXPAND_ON_LOOP", "on"
).lower() not in {
    "0",
    "false",
    "off",
    "no",
}
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
    os.environ.get("PROXY_MALFORMED_TOOL_RETRY_MAX", "2")
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

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------
logging.basicConfig(
    level=getattr(logging, PROXY_LOG_LEVEL, logging.INFO),
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("uap.anthropic_proxy")


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
TOOL_CALL_GRAMMAR_PROBE_DONE = False


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
    request_body: dict, tool_choice: str | None = None
) -> None:
    global TOOL_CALL_GRAMMAR_PROBE_DONE

    request_body.pop("grammar", None)

    if not PROXY_TOOL_CALL_GRAMMAR or not TOOL_CALL_GBNF:
        return

    if not request_body.get("tools"):
        return

    if TOOL_CALL_GRAMMAR_PROBE_DONE or not TOOL_CALL_GRAMMAR_TOOLS_COMPATIBLE:
        return

    effective_tool_choice = (
        tool_choice if tool_choice is not None else request_body.get("tool_choice")
    )
    if PROXY_TOOL_CALL_GRAMMAR_REQUIRED_ONLY and effective_tool_choice != "required":
        return

    TOOL_CALL_GRAMMAR_PROBE_DONE = True
    request_body["grammar"] = TOOL_CALL_GBNF


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
    last_tool_fingerprint: str = ""
    finalize_turn_active: bool = False
    last_seen_ts: float = 0.0
    last_request_had_tools: bool = False
    last_request_max_tokens: int = 0
    last_response_had_tool_calls: bool = False
    last_rejected_tiny_prompt_fingerprint: str = ""
    last_rejected_tiny_prompt_ts: float = 0.0
    last_completion_classification: str = ""
    last_rejected_tool_turn_fingerprint: str = ""
    last_rejected_tool_turn_ts: float = 0.0
    repeated_tool_turn_rejection_count: int = 0
    last_continuation_prompt_fingerprint: str = ""
    last_continuation_prompt_ts: float = 0.0
    repeated_continuation_prompt_count: int = 0

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
        self.last_tool_fingerprint = ""

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
    if _has_tool_definitions(anthropic_body):
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


def _conversation_has_tool_results(anthropic_body: dict) -> bool:
    return any(
        _message_has_tool_result(msg.get("content"))
        for msg in anthropic_body.get("messages", [])
        if isinstance(msg, dict)
    )


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
            logger.warning(
                "TOOL STATE MACHINE: entering review (cycle=%s repeat=%d stagnation=%d cycles=%d)",
                cycle_looping,
                cycle_repeat,
                monitor.tool_state_stagnation_streak,
                monitor.tool_state_review_cycles,
            )
            return "auto", reason

        if monitor.tool_state_forced_budget_remaining <= 0:
            monitor.set_tool_turn_phase("review", reason="forced_budget_exhausted")
            monitor.tool_state_review_cycles += 1
            monitor.tool_state_auto_budget_remaining = max(
                1, PROXY_TOOL_STATE_AUTO_BUDGET
            )
            monitor.tool_state_forced_budget_remaining = max(
                1, PROXY_TOOL_STATE_FORCED_BUDGET // 2
            )
            logger.warning(
                "TOOL STATE MACHINE: forced budget exhausted, entering review (cycles=%d)",
                monitor.tool_state_review_cycles,
            )
            return "auto", "forced_budget_exhausted"

        monitor.tool_state_forced_budget_remaining -= 1
        return "required", "act"

    if monitor.tool_turn_phase == "review":
        if monitor.tool_state_auto_budget_remaining <= 0:
            monitor.set_tool_turn_phase("act", reason="review_budget_spent")
            monitor.tool_state_forced_budget_remaining = max(
                1, PROXY_TOOL_STATE_FORCED_BUDGET // 2
            )
            return "required", "review_complete"

        monitor.tool_state_auto_budget_remaining -= 1
        if monitor.tool_state_auto_budget_remaining == 0:
            monitor.set_tool_turn_phase("act", reason="review_budget_spent")
            monitor.tool_state_forced_budget_remaining = max(
                1, PROXY_TOOL_STATE_FORCED_BUDGET // 2
            )
            return "required", "review_complete"
        return "auto", "review"

    if monitor.tool_turn_phase == "finalize":
        if monitor.tool_state_auto_budget_remaining <= 0:
            monitor.reset_tool_turn_state(reason="finalize_complete")
            return None, "finalize_complete"

        monitor.tool_state_auto_budget_remaining -= 1
        if monitor.tool_state_auto_budget_remaining == 0:
            monitor.reset_tool_turn_state(reason="finalize_complete")
        return "finalize", "finalize"

    monitor.reset_tool_turn_state(reason="unknown_phase")
    return None, "unknown_phase"


def build_openai_request(anthropic_body: dict, monitor: SessionMonitor) -> dict:
    """Build an OpenAI Chat Completions request from an Anthropic Messages request."""
    openai_body = {
        "model": anthropic_body.get("model", "default"),
        "messages": anthropic_to_openai_messages(anthropic_body),
        "stream": anthropic_body.get("stream", False),
    }

    has_tools = _has_tool_definitions(anthropic_body)

    # Inject agentic protocol instructions only for tool-enabled turns.
    if has_tools:
        if (
            openai_body["messages"]
            and openai_body["messages"][0].get("role") == "system"
        ):
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
        requested_raw = max(1, int(anthropic_body["max_tokens"]))

        # Enforce configurable minimum floor for thinking mode: model needs
        # tokens for reasoning (<think>...</think>) plus actual response/tool
        # calls. Set PROXY_MAX_TOKENS_FLOOR=0 to disable this floor.
        floor_bypassed_for_tool_turn = (
            has_tools
            and PROXY_DISABLE_THINKING_ON_TOOL_TURNS
            and PROXY_MAX_TOKENS_FLOOR > 0
        )
        if floor_bypassed_for_tool_turn:
            requested_max = requested_raw
            if requested_raw < PROXY_MAX_TOKENS_FLOOR:
                logger.info(
                    "MAX_TOKENS floor bypassed for tool turn with thinking disabled: requested=%d floor=%d",
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

        openai_body["max_tokens"] = requested_max
    if "temperature" in anthropic_body:
        openai_body["temperature"] = anthropic_body["temperature"]
    if "top_p" in anthropic_body:
        openai_body["top_p"] = anthropic_body["top_p"]
    if "stop_sequences" in anthropic_body:
        openai_body["stop"] = anthropic_body["stop_sequences"]

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
        state_choice, state_reason = _resolve_state_machine_tool_choice(
            anthropic_body,
            monitor,
            has_tool_results,
            last_user_has_tool_result,
        )

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
            monitor.consecutive_forced_count = 0
            monitor.no_progress_streak = 0
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
            logger.info(
                "tool_choice forced to 'required' by TOOL STATE MACHINE (phase=%s reason=%s forced_budget=%d)",
                monitor.tool_turn_phase,
                state_reason,
                monitor.tool_state_forced_budget_remaining,
            )
        elif state_reason in {"fresh_user_text", "inactive_loop"} and n_msgs <= 1:
            monitor.consecutive_forced_count = 0
            monitor.no_progress_streak = 0
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

        if PROXY_DISABLE_THINKING_ON_TOOL_TURNS:
            openai_body["enable_thinking"] = False
            logger.info(
                "Thinking disabled for tool turn (PROXY_DISABLE_THINKING_ON_TOOL_TURNS=on)"
            )

        _apply_tool_call_grammar(openai_body)

    return openai_body


def _record_last_assistant_tool_calls(
    anthropic_body: dict, monitor: SessionMonitor
) -> str:
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
        return "|".join(sorted(tool_names))
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
        return "I couldn't produce a usable answer on that turn. Please retry the request."

    logger.warning(
        "Unknown PROXY_STREAM_REASONING_FALLBACK=%r; disabling reasoning fallback",
        fallback_mode,
    )
    return None


def _build_actionable_reasoning_summary(reasoning_chunks: list[str]) -> str | None:
    raw_text = "".join(reasoning_chunks).strip()
    if not raw_text:
        return None

    cleaned = _sanitize_reasoning_fallback_text(raw_text)
    if not cleaned:
        return None

    findings: list[str] = []
    recommendations: list[str] = []

    for fragment in re.split(r"(?<=[.!?])\s+|\n+", cleaned):
        sentence = fragment.strip(" -\t")
        if len(sentence) < 24:
            continue
        lowered = sentence.lower()
        if any(
            token in lowered
            for token in (
                "error",
                "issue",
                "problem",
                "slow",
                "latency",
                "timeout",
                "retry",
                "loop",
                "bottleneck",
                "throughput",
                "empty",
                "thinking",
            )
        ):
            findings.append(sentence)
        if any(
            token in lowered
            for token in (
                "recommend",
                "should",
                "tune",
                "adjust",
                "increase",
                "decrease",
                "disable",
                "enable",
                "use ",
                "set ",
            )
        ):
            recommendations.append(sentence)

    picked_findings: list[str] = []
    for sentence in findings:
        if sentence not in picked_findings:
            picked_findings.append(sentence)
        if len(picked_findings) == 2:
            break

    picked_recommendations: list[str] = []
    for sentence in recommendations:
        if sentence not in picked_recommendations and sentence not in picked_findings:
            picked_recommendations.append(sentence)
        if len(picked_recommendations) == 2:
            break

    if not picked_findings and not picked_recommendations:
        return None

    parts = ["Actionable summary from model reasoning:"]
    if picked_findings:
        parts.append("Findings: " + " ".join(picked_findings))
    if picked_recommendations:
        parts.append("Recommendations: " + " ".join(picked_recommendations))
    return " ".join(parts)


def _build_reasoning_fallback_error_response(message: str | None = None) -> Response:
    return _transport_error_response(
        message
        or "Upstream produced no usable visible answer for this turn. Please retry the request."
    )


def _build_tiny_non_tool_terminal_response(message: str | None = None) -> Response:
    return _transport_error_response(
        message
        or "A tiny non-tool retry loop was terminated. Restart the session or send a fresh substantive request."
    )


def _build_empty_visible_stream_terminal_response(message: str | None = None) -> Response:
    return _transport_error_response(
        message
        or "An empty visible streaming retry loop was terminated. Restart the session or send a fresh request."
    )


def _build_empty_visible_stream_fallback_response(message: str | None = None) -> dict:
    fallback_text = (
        message
        or "I couldn't produce a direct visible answer from the streaming path on that turn. "
        "Here is the bounded fallback result instead."
    )
    return {
        "id": f"msg_{uuid.uuid4().hex[:24]}",
        "type": "message",
        "role": "assistant",
        "model": "proxy-fallback",
        "content": [{"type": "text", "text": fallback_text}],
        "stop_reason": "end_turn",
        "stop_sequence": None,
        "usage": {"input_tokens": 0, "output_tokens": 0},
    }


def _build_tool_turn_no_tool_use_error_response(message: str | None = None) -> Response:
    return _transport_error_response(
        message
        or "A tool-enabled turn ended without any usable tool call. Please retry the request."
    )


def _should_hard_fail_tool_turn_without_tool_use(
    anthropic_body: dict,
    openai_resp: dict,
) -> bool:
    if not _has_tool_definitions(anthropic_body):
        return False

    if _openai_has_tool_calls(openai_resp):
        return False

    choice, _ = _extract_openai_choice(openai_resp)
    finish_reason = choice.get("finish_reason")
    if finish_reason not in {"stop", "end_turn", "length", "max_tokens"}:
        return False

    return True


def _should_reject_tiny_post_tool_non_tool_completion(
    anthropic_body: dict,
    monitor: SessionMonitor,
    openai_resp: dict,
) -> bool:
    if _has_tool_definitions(anthropic_body):
        return False

    if monitor.last_request_had_tools is not True:
        return False

    if monitor.last_response_had_tool_calls is not True:
        return False

    if monitor.last_request_max_tokens > 256:
        return False

    messages = anthropic_body.get("messages") or []
    if len(messages) > 1:
        return False

    text = _openai_message_text(openai_resp).strip()
    if not text:
        return True

    if len(text) <= 96 and len(text.split()) <= 16:
        return True

    return False


def _tiny_non_tool_prompt_fingerprint(anthropic_body: dict) -> str:
    messages = anthropic_body.get("messages") or []
    if len(messages) != 1:
        return ""

    msg = messages[0] or {}
    if msg.get("role") != "user":
        return ""

    content = msg.get("content")
    if isinstance(content, str):
        text = content.strip()
    elif isinstance(content, list):
        text = " ".join(
            block.get("text", "")
            for block in content
            if isinstance(block, dict) and block.get("type") == "text"
        ).strip()
    else:
        text = str(content).strip()

    if not text:
        return ""

    return hashlib.sha1(text.encode("utf-8")).hexdigest()


def _tool_turn_prompt_fingerprint(anthropic_body: dict) -> str:
    messages = anthropic_body.get("messages") or []
    tools = anthropic_body.get("tools") or []
    payload = {
        "messages": messages,
        "tools": tools,
        "max_tokens": anthropic_body.get("max_tokens"),
    }
    return hashlib.sha1(
        json.dumps(payload, sort_keys=True, ensure_ascii=False).encode("utf-8")
    ).hexdigest()


def _is_continuation_prompt_text(text: str) -> bool:
    normalized = " ".join((text or "").strip().lower().split())
    if not normalized:
        return False
    return (
        "previous response was truncated" in normalized
        and "continue where you left off" in normalized
    )


def _continuation_prompt_fingerprint(anthropic_body: dict) -> str:
    if not _has_tool_definitions(anthropic_body):
        return ""

    messages = anthropic_body.get("messages") or []
    if not messages:
        return ""

    last_msg = messages[-1] or {}
    if last_msg.get("role") != "user":
        return ""

    text = _extract_text(last_msg.get("content", ""))
    if not _is_continuation_prompt_text(text):
        return ""

    payload = {
        "messages": messages,
        "tools": anthropic_body.get("tools") or [],
        "max_tokens": anthropic_body.get("max_tokens"),
    }
    return hashlib.sha1(
        json.dumps(payload, sort_keys=True, ensure_ascii=False).encode("utf-8")
    ).hexdigest()


def _record_continuation_prompt(anthropic_body: dict, monitor: SessionMonitor) -> None:
    fingerprint = _continuation_prompt_fingerprint(anthropic_body)
    if not fingerprint:
        return

    now = time.time()
    if fingerprint == monitor.last_continuation_prompt_fingerprint and (
        now - monitor.last_continuation_prompt_ts
    ) <= 90:
        monitor.repeated_continuation_prompt_count += 1
    else:
        monitor.repeated_continuation_prompt_count = 1
    monitor.last_continuation_prompt_fingerprint = fingerprint
    monitor.last_continuation_prompt_ts = now


def _should_suppress_repeated_continuation_prompt(
    anthropic_body: dict,
    monitor: SessionMonitor,
) -> bool:
    fingerprint = _continuation_prompt_fingerprint(anthropic_body)
    if not fingerprint:
        return False

    if fingerprint != monitor.last_continuation_prompt_fingerprint:
        return False

    if (time.time() - monitor.last_continuation_prompt_ts) > 90:
        return False

    return monitor.repeated_continuation_prompt_count >= 2


def _should_suppress_repeated_tiny_non_tool_retry(
    anthropic_body: dict,
    monitor: SessionMonitor,
) -> bool:
    if _has_tool_definitions(anthropic_body):
        return False

    max_tokens = int(anthropic_body.get("max_tokens", 0) or 0)
    if max_tokens > 256:
        return False

    fingerprint = _tiny_non_tool_prompt_fingerprint(anthropic_body)
    if not fingerprint:
        return False

    if fingerprint != monitor.last_rejected_tiny_prompt_fingerprint:
        return False

    if (time.time() - monitor.last_rejected_tiny_prompt_ts) > 30:
        return False

    return True


def _record_tool_turn_rejection(anthropic_body: dict, monitor: SessionMonitor) -> None:
    _record_continuation_prompt(anthropic_body, monitor)
    monitor.forced_auto_cooldown_turns = max(monitor.forced_auto_cooldown_turns, 1)
    fingerprint = _tool_turn_prompt_fingerprint(anthropic_body)
    now = time.time()
    if fingerprint == monitor.last_rejected_tool_turn_fingerprint and (
        now - monitor.last_rejected_tool_turn_ts
    ) <= 30:
        monitor.repeated_tool_turn_rejection_count += 1
    else:
        monitor.repeated_tool_turn_rejection_count = 1
    monitor.last_rejected_tool_turn_fingerprint = fingerprint
    monitor.last_rejected_tool_turn_ts = now


def _should_suppress_repeated_tool_turn_rejection(
    anthropic_body: dict,
    monitor: SessionMonitor,
) -> bool:
    if not _has_tool_definitions(anthropic_body):
        return False

    fingerprint = _tool_turn_prompt_fingerprint(anthropic_body)
    if fingerprint != monitor.last_rejected_tool_turn_fingerprint:
        return False

    if (time.time() - monitor.last_rejected_tool_turn_ts) > 30:
        return False

    return monitor.repeated_tool_turn_rejection_count >= 2


def _is_tiny_non_tool_followup_request(anthropic_body: dict) -> bool:
    if _has_tool_definitions(anthropic_body):
        return False

    max_tokens = int(anthropic_body.get("max_tokens", 0) or 0)
    if max_tokens > 256:
        return False

    messages = anthropic_body.get("messages") or []
    return len(messages) == 1


def _should_terminalize_tiny_followup_after_completed_analysis(monitor: SessionMonitor, anthropic_body: dict) -> bool:
    if not _is_tiny_non_tool_followup_request(anthropic_body):
        return False

    last_class = monitor.last_completion_classification or ""
    return last_class.endswith(":tiny_non_tool_text") or last_class.endswith(":text")


def _should_terminalize_empty_visible_stream_retry(monitor: SessionMonitor, anthropic_body: dict) -> bool:
    if not _has_tool_definitions(anthropic_body):
        return False

    last_class = monitor.last_completion_classification or ""
    return last_class == "stream:empty_visible_retryable"


def _is_empty_visible_response(message: dict | None) -> bool:
    if not isinstance(message, dict):
        return False

    content = message.get("content")
    return (
        isinstance(content, str)
        and not content.strip()
        and not message.get("tool_calls")
    )


def _classify_completion(
    anthropic_body: dict,
    openai_resp: dict,
    *,
    guardrail_path: str,
) -> str:
    if _has_tool_definitions(anthropic_body):
        if _openai_has_tool_calls(openai_resp):
            return f"{guardrail_path}:tool_use"
        return f"{guardrail_path}:tool_turn_no_tool_use"

    if _is_tiny_non_tool_followup_request(anthropic_body):
        text = _openai_message_text(openai_resp).strip()
        if not text:
            return f"{guardrail_path}:tiny_non_tool_empty"
        return f"{guardrail_path}:tiny_non_tool_text"

    if _openai_has_tool_calls(openai_resp):
        return f"{guardrail_path}:unexpected_tool_use"

    return f"{guardrail_path}:plain_text"


def _build_reasoning_retry_nudge_message() -> dict:
    return {
        "role": "system",
        "content": (
            "Your previous reply was empty or contained only hidden reasoning. "
            "Respond directly to the user in 1-3 short sentences. "
            "Do not emit hidden reasoning, titles, or placeholders."
        ),
    }


def _transport_error_response(message: str, *, status_code: int = 529) -> Response:
    return Response(
        content=json.dumps(
            {
                "type": "error",
                "error": {
                    "type": "overloaded_error",
                    "message": message,
                },
            }
        ),
        status_code=status_code,
        media_type="application/json",
    )


async def _safe_post_chat_completions(
    client: httpx.AsyncClient,
    payload: dict,
    *,
    context_label: str,
) -> httpx.Response | None:
    try:
        return await client.post(
            f"{LLAMA_CPP_BASE}/chat/completions",
            json=payload,
            headers={"Content-Type": "application/json"},
        )
    except (
        httpx.ConnectError,
        httpx.RemoteProtocolError,
        httpx.ReadError,
        httpx.WriteError,
        httpx.TimeoutException,
    ) as exc:
        logger.warning(
            "Upstream transport failure during %s: %s: %s",
            context_label,
            type(exc).__name__,
            exc,
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
    markers = ("<parameter", "</parameter", "<tool_call", "<function=", "</function")
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
_BASH_PLACEHOLDER_VALUES = {
    "command",
    "description",
    "timeout",
    "workdir",
    "arguments",
}


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


def _strip_bash_noise_lines(text: str) -> tuple[str, bool]:
    if not isinstance(text, str):
        return text, False

    noise_patterns = (
        re.compile(r"^\s*bash:\s+line\s+\d+:\s+fg:\s+no job control\s*$", re.IGNORECASE),
        re.compile(r"^\s*bash:\s+line\s+\d+:\s+.+:\s+command not found\s*$", re.IGNORECASE),
    )

    lines = text.splitlines()
    kept_lines: list[str] = []
    stripped = False
    for line in lines:
        if any(p.match(line) for p in noise_patterns):
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
        cleaned_command, noise_changed = _strip_bash_noise_lines(cleaned_command)
        if not changed and not noise_changed:
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


def _is_placeholder_string(value) -> bool:
    if not isinstance(value, str):
        return False
    lowered = value.strip().lower()
    if not lowered:
        return True
    if lowered in _BASH_PLACEHOLDER_VALUES:
        return True
    if lowered in {"string", "number", "integer", "boolean", "object", "array"}:
        return True
    if lowered.startswith(_REQUIRED_PLACEHOLDER):
        return True
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

    lowered_tool_name = tool_name.strip().lower()
    if lowered_tool_name in {"task", "omp_task"}:
        subagent_value = parsed.get("subagent_type")
        agent_value = parsed.get("agent")
        prompt_value = parsed.get("prompt")

        if isinstance(subagent_value, str):
            cleaned_subagent = subagent_value.strip()
            if (
                _is_placeholder_string(cleaned_subagent)
                or cleaned_subagent.lower() == "type"
            ):
                return ToolResponseIssue(
                    kind="invalid_tool_args",
                    reason=f"arguments for '{tool_name}' used a junk subagent value",
                    retry_hint=(
                        f"Emit exactly one `{tool_name}` tool call with a real subagent selection. "
                        "Do not use schema fragments like `type` or placeholder values for the agent."
                    ),
                )

        if isinstance(agent_value, str):
            cleaned_agent = agent_value.strip()
            if _is_placeholder_string(cleaned_agent):
                return ToolResponseIssue(
                    kind="invalid_tool_args",
                    reason=f"arguments for '{tool_name}' used a placeholder agent value",
                    retry_hint=(
                        f"Emit exactly one `{tool_name}` tool call with a real agent value from the provided schema."
                    ),
                )

        if isinstance(prompt_value, str):
            cleaned_prompt = prompt_value.strip()
            if (
                _is_placeholder_string(cleaned_prompt)
                or cleaned_prompt.lower() == "type"
            ):
                return ToolResponseIssue(
                    kind="invalid_tool_args",
                    reason=f"arguments for '{tool_name}' used a junk prompt value",
                    retry_hint=(
                        f"Emit exactly one `{tool_name}` tool call with a concrete task prompt, "
                        "not a schema field name, placeholder, or fragment."
                    ),
                )

    if lowered_tool_name == "bash":
        command = parsed.get("command")
        if isinstance(command, str):
            cleaned_command, had_protocol_lines = _strip_protocol_tag_only_lines(
                command
            )
            cleaned_command, had_noise_lines = _strip_bash_noise_lines(cleaned_command)
            if (had_protocol_lines or had_noise_lines) and not cleaned_command:
                return ToolResponseIssue(
                    kind="invalid_tool_args",
                    reason="arguments for 'Bash' contained only malformed protocol/noise lines",
                    retry_hint=(
                        "Emit exactly one `Bash` tool call with a valid shell command in `arguments.command`. "
                        "Do not include standalone XML/protocol tags or shell error output."
                    ),
                )
            if _is_placeholder_string(cleaned_command):
                return ToolResponseIssue(
                    kind="invalid_tool_args",
                    reason="arguments for 'Bash' used a placeholder command value",
                    retry_hint=(
                        "Emit exactly one `Bash` tool call with a real shell command in `arguments.command`, "
                        "not schema field names or placeholders like `command`, `description`, or `timeout`."
                    ),
                )
        else:
            return ToolResponseIssue(
                kind="invalid_tool_args",
                reason="arguments for 'Bash' must include a string command",
                retry_hint=(
                    "Emit exactly one `Bash` tool call with a real shell command string in `arguments.command`."
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


def _build_terminal_invalid_tool_call_response(
    openai_resp: dict, issue: ToolResponseIssue
) -> dict:
    reason = issue.reason.strip() if issue.reason else "invalid tool call arguments"
    guidance = issue.retry_hint.strip() if issue.retry_hint else ""
    parts = [
        "The previous tool request was rejected because it contained invalid arguments.",
        f"Reason: {reason}.",
        "Stop issuing tool calls for this turn and continue with a normal assistant response grounded in completed results only.",
    ]
    if guidance:
        parts.append(f"Guidance: {guidance}")
    return _build_safe_text_openai_response(
        openai_resp,
        " ".join(parts),
        finish_reason="stop",
    )


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


def _build_malformed_retry_body(
    openai_body: dict,
    anthropic_body: dict,
    retry_hint: str = "",
    tool_choice: str = "required",
    attempt: int = 1,
    total_attempts: int = 1,
) -> dict:
    retry_body = dict(openai_body)
    retry_body["stream"] = False
    retry_body["tool_choice"] = tool_choice
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
        retry_body["messages"] = [*existing_messages, malformed_retry_instruction]

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


def _is_empty_end_turn_response(openai_resp: dict) -> bool:
    choices = openai_resp.get("choices") or []
    if not choices:
        return False

    choice = choices[0]
    finish = choice.get("finish_reason")
    if finish not in {"stop", "end_turn"}:
        return False

    message = choice.get("message") or {}
    if message.get("tool_calls"):
        return False

    content = message.get("content")
    if content is None:
        return True
    if isinstance(content, str):
        return not content.strip()

    return not str(content).strip()


def _is_useless_short_end_turn_response(openai_resp: dict) -> bool:
    choices = openai_resp.get("choices") or []
    if not choices:
        return False

    choice = choices[0]
    finish = choice.get("finish_reason")
    if finish not in {"stop", "end_turn"}:
        return False

    message = choice.get("message") or {}
    if message.get("tool_calls"):
        return False

    content = message.get("content")
    if not isinstance(content, str):
        return False

    text = re.sub(r"\s+", " ", content).strip()
    if not text:
        return False

    if len(text) > 80:
        return False

    word_count = len(text.split())
    if word_count > 12:
        return False

    if any(p in text for p in ".!?;:\n"):
        return False

    if text.startswith("{") or text.startswith("["):
        return False

    lowered = text.lower()
    if lowered.startswith(
        ("analyze ", "review ", "inspect ", "check ", "investigate ", "debug ")
    ):
        return True

    title_case_like = text == text.title()
    no_verb_markers = not any(
        marker in lowered
        for marker in (
            "here",
            "found",
            "because",
            "error",
            "issue",
            "fix",
            "result",
            "status",
            "running",
            "failed",
            "success",
        )
    )
    return title_case_like or no_verb_markers


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

    retry_resp = await _safe_post_chat_completions(
        client,
        retry_body,
        context_label="unexpected end_turn guardrail retry",
    )
    if retry_resp is None:
        logger.warning(
            "GUARDRAIL retry transport failure; keeping original response"
        )
        return openai_resp
    if retry_resp.status_code == 200:
        retry_json = retry_resp.json()
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
        elif _is_unexpected_end_turn(retry_json, anthropic_body):
            logger.warning(
                "GUARDRAIL: retry still ended turn without tool_use; "
                "marking as tool_turn_no_tool_use for outer rejection handling"
            )
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


async def _apply_empty_end_turn_guardrail(
    client: httpx.AsyncClient,
    openai_resp: dict,
    openai_body: dict,
    anthropic_body: dict,
    session_id: str,
) -> dict:
    if not PROXY_GUARDRAIL_RETRY:
        return openai_resp

    if not _is_empty_end_turn_response(openai_resp):
        return openai_resp

    if openai_body.get("tools"):
        return openai_resp

    logger.warning(
        "GUARDRAIL: empty end_turn with no tool calls (session=%s), retrying once with a direct-answer nudge",
        session_id,
    )

    retry_body = copy.deepcopy(openai_body)
    messages = list(retry_body.get("messages") or [])
    messages.append(
        {
            "role": "system",
            "content": (
                "Your previous reply was empty. Respond with a brief direct user-visible answer. "
                "Do not leave the response empty."
            ),
        }
    )
    retry_body["messages"] = messages
    retry_body["stream"] = False

    retry_resp = await _safe_post_chat_completions(
        client,
        retry_body,
        context_label="empty end_turn guardrail retry",
    )
    if retry_resp is None:
        logger.warning(
            "GUARDRAIL empty-response retry transport failure; keeping original response"
        )
        return openai_resp
    if retry_resp.status_code == 200:
        retry_json = retry_resp.json()
        if not _is_empty_end_turn_response(retry_json):
            logger.info(
                "GUARDRAIL: empty end_turn retry produced visible content; using retried response"
            )
            return retry_json
        logger.warning(
            "GUARDRAIL: empty end_turn retry also returned empty content; keeping original response"
        )
    else:
        logger.warning(
            "GUARDRAIL empty-response retry upstream status=%d; keeping original response",
            retry_resp.status_code,
        )

    return openai_resp


async def _apply_useless_short_end_turn_guardrail(
    client: httpx.AsyncClient,
    openai_resp: dict,
    openai_body: dict,
    session_id: str,
) -> dict:
    if not PROXY_GUARDRAIL_RETRY:
        return openai_resp

    if not _is_useless_short_end_turn_response(openai_resp):
        return openai_resp

    if openai_body.get("tools"):
        return openai_resp

    logger.warning(
        "GUARDRAIL: short/title-like end_turn with no tool calls (session=%s), retrying once with a direct-answer nudge",
        session_id,
    )

    retry_body = copy.deepcopy(openai_body)
    messages = list(retry_body.get("messages") or [])
    messages.append(
        {
            "role": "system",
            "content": (
                "Your previous reply was too brief and not useful enough. "
                "Respond with a direct, user-visible answer in 1-3 full sentences."
            ),
        }
    )
    retry_body["messages"] = messages
    retry_body["stream"] = False

    retry_resp = await _safe_post_chat_completions(
        client,
        retry_body,
        context_label="short end_turn guardrail retry",
    )
    if retry_resp is None:
        logger.warning(
            "GUARDRAIL short-response retry transport failure; keeping original response"
        )
        return openai_resp
    if retry_resp.status_code == 200:
        retry_json = retry_resp.json()
        if not _is_empty_end_turn_response(
            retry_json
        ) and not _is_useless_short_end_turn_response(retry_json):
            logger.info(
                "GUARDRAIL: short/title-like retry produced substantive content; using retried response"
            )
            return retry_json
        logger.warning(
            "GUARDRAIL: short/title-like retry remained non-substantive; keeping original response"
        )
    else:
        logger.warning(
            "GUARDRAIL short-response retry upstream status=%d; keeping original response",
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
        logger.info("GUARDRAIL: skipped malformed-tool retries on finalize turn")
        return openai_resp

    working_resp = openai_resp
    repair_count = 0
    if PROXY_TOOL_ARGS_PREFLIGHT and _openai_has_tool_calls(openai_resp):
        working_resp, markup_repairs = _repair_tool_call_markup(openai_resp)
        working_resp, required_repairs = _repair_required_tool_args(
            working_resp, anthropic_body
        )
        working_resp, bash_repairs = _repair_bash_command_artifacts(working_resp)
        repair_count = markup_repairs + required_repairs + bash_repairs

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
        if repair_count > 0:
            monitor.arg_preflight_repairs += repair_count
            logger.info(
                "TOOL ARG REPAIR: session=%s repaired=%d source=initial",
                session_id,
                repair_count,
            )
        return working_resp

    if issue.kind == "malformed_payload":
        monitor.malformed_tool_streak += 1
    elif issue.kind == "invalid_tool_args":
        monitor.invalid_tool_call_streak += 1
        monitor.arg_preflight_rejections += 1

    monitor.maybe_activate_forced_tool_dampener(issue.kind)
    excerpt = _openai_message_text(working_resp)[:220].replace("\n", " ")
    logger.warning(
        "TOOL RESPONSE ISSUE: session=%s kind=%s reason=%s malformed=%d invalid=%d required_miss=%d excerpt=%.220s",
        session_id,
        issue.kind,
        issue.reason,
        monitor.malformed_tool_streak,
        monitor.invalid_tool_call_streak,
        monitor.required_tool_miss_streak,
        excerpt,
    )

    attempts = max(0, PROXY_MALFORMED_TOOL_RETRY_MAX)
    current_issue = issue
    for attempt in range(attempts):
        attempt_tool_choice = _retry_tool_choice_for_attempt(
            required_tool_choice,
            attempt,
            attempts,
        )
        retry_body = _build_malformed_retry_body(
            openai_body,
            anthropic_body,
            retry_hint=current_issue.retry_hint,
            tool_choice=attempt_tool_choice,
            attempt=attempt + 1,
            total_attempts=attempts,
        )
        retry_resp = await _safe_post_chat_completions(
            client,
            retry_body,
            context_label="malformed tool retry",
        )
        if retry_resp is None:
            logger.warning(
                "MALFORMED RETRY transport failure (attempt %d/%d)",
                attempt + 1,
                attempts,
            )
            continue
        if retry_resp.status_code != 200:
            logger.warning(
                "MALFORMED RETRY failed (attempt %d/%d): HTTP %d",
                attempt + 1,
                attempts,
                retry_resp.status_code,
            )
            continue

        retry_json = retry_resp.json()
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
            retry_repairs = (
                retry_markup_repairs + retry_required_repairs + retry_bash_repairs
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
        elif retry_issue.kind == "invalid_tool_args":
            monitor.invalid_tool_call_streak += 1
            monitor.arg_preflight_rejections += 1

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
    if current_issue.kind == "invalid_tool_args":
        logger.warning(
            "TOOL RESPONSE guardrail: session=%s terminalizing invalid tool args after retry exhaustion",
            session_id,
        )
        return _build_terminal_invalid_tool_call_response(working_resp, current_issue)

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


def openai_to_anthropic_response(openai_resp: dict, model: str) -> dict:
    """Convert an OpenAI Chat Completions response to Anthropic Messages format."""
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
                cleaned_command, had_noise_lines = _strip_bash_noise_lines(
                    cleaned_command
                )
                if had_protocol_lines or had_noise_lines:
                    args = dict(args)
                    args["command"] = cleaned_command
                    logger.warning(
                        "BASH SAFETY: stripped malformed protocol/noise lines from command before tool execution"
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
        logger.info(
            "Client disconnected, closing upstream stream (last_class=%s)",
            monitor.last_completion_classification or "stream_in_progress",
        )
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
            fallback_text = None

            if not fallback_text:
                fallback_text = _build_reasoning_fallback_text(reasoning_chunks)
            if not fallback_text:
                fallback_text = _build_actionable_reasoning_summary(reasoning_chunks)

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
    monitor.last_request_had_tools = _has_tool_definitions(body)
    monitor.last_request_max_tokens = int(body.get("max_tokens", 0) or 0)

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
    logger.info(
        "REQ: stream=%s msgs=%d tools=%d max_tokens=%s last_role=%s last_content=%.200s",
        is_stream,
        n_messages,
        n_tools,
        max_tokens,
        last_role,
        last_text,
    )

    if _should_suppress_repeated_tiny_non_tool_retry(body, monitor):
        logger.warning(
            "Suppressing repeated tiny non-tool retry after prior rejection"
        )
        monitor.last_completion_classification = "guarded_non_stream:tiny_non_tool_terminal"
        return _build_tiny_non_tool_terminal_response(
            "Repeated tiny non-tool retry was terminated. Restart the session or send a fresh substantive request instead of retrying the tiny follow-up."
        )
    if _should_terminalize_tiny_followup_after_completed_analysis(monitor, body):
        logger.warning(
            "Terminalizing tiny non-tool follow-up after completed analysis response"
        )
        monitor.last_completion_classification = "guarded_non_stream:tiny_non_tool_completed_analysis_terminal"
        return _build_tiny_non_tool_terminal_response(
            "The prior analysis response already completed the turn. This tiny follow-up is being terminated; restart the session or send a fresh substantive request."
        )
    if _should_terminalize_empty_visible_stream_retry(monitor, body):
        logger.warning(
            "Terminalizing repeated empty-visible streaming retry after prior retryable response"
        )
        monitor.last_completion_classification = "guarded_non_stream:empty_visible_terminal"
        monitor.forced_auto_cooldown_turns = max(monitor.forced_auto_cooldown_turns, 1)
        return _build_empty_visible_stream_terminal_response(
            "Repeated empty-visible streaming retries were terminated. Restart the session or send a fresh request instead of retrying the same tool-enabled turn."
        )
    if _should_suppress_repeated_continuation_prompt(body, monitor):
        logger.warning(
            "Suppressing repeated continuation prompt loop after prior guarded tool-turn failures"
        )
        monitor.last_completion_classification = "guarded_non_stream:continuation_loop_terminal"
        monitor.forced_auto_cooldown_turns = max(monitor.forced_auto_cooldown_turns, 1)
        return _build_tool_turn_no_tool_use_error_response(
            "Repeated continuation prompts were suppressed because the session is stuck retrying a tool-required turn without producing a valid tool call. This turn is being terminated; restart the session or send a fresh request instead of continuing."
        )
    if _should_suppress_repeated_tool_turn_rejection(body, monitor):
        logger.warning(
            "Suppressing repeated guarded tool-turn retry after prior no-tool-use failures"
        )
        monitor.last_completion_classification = "guarded_non_stream:tool_turn_no_tool_use_suppressed"
        return _transport_error_response(
            "Repeated tool-enabled retries were suppressed because the model is not producing valid tool calls for this turn. Please retry later or restart the session."
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

    use_guarded_non_stream = _should_use_guarded_non_stream(
        is_stream,
        body,
        openai_body,
    )
    if use_guarded_non_stream:
        strict_body = dict(openai_body)
        strict_body["stream"] = False

        strict_resp = await _safe_post_chat_completions(
            client,
            strict_body,
            context_label="strict guarded non-stream request",
        )
        if strict_resp is None:
            return _transport_error_response(
                "Upstream server disconnected before sending a response during guarded request."
            )

        if strict_resp.status_code != 200:
            error_text = strict_resp.text[:1000]
            if _maybe_disable_grammar_for_tools_error(
                strict_body,
                strict_resp.status_code,
                error_text,
                "strict-stream",
            ):
                strict_resp = await _safe_post_chat_completions(
                    client,
                    strict_body,
                    context_label="strict guarded non-stream grammar retry",
                )
                if strict_resp is None:
                    return _transport_error_response(
                        "Upstream server disconnected before sending a response during guarded retry."
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
        if _should_hard_fail_tool_turn_without_tool_use(body, openai_resp):
            _record_tool_turn_rejection(body, monitor)
            monitor.last_completion_classification = "guarded_non_stream:tool_turn_no_tool_use_rejected"
            logger.warning(
                "Hard-failing guarded tool-enabled response without tool use before further processing"
            )
            return _build_tool_turn_no_tool_use_error_response()
        openai_resp = await _apply_malformed_tool_guardrail(
            client,
            openai_resp,
            strict_body,
            body,
            monitor,
            session_id,
        )
        openai_resp = await _apply_empty_end_turn_guardrail(
            client,
            openai_resp,
            strict_body,
            body,
            session_id,
        )
        openai_resp = await _apply_useless_short_end_turn_guardrail(
            client,
            openai_resp,
            strict_body,
            session_id,
        )
        if _should_reject_tiny_post_tool_non_tool_completion(body, monitor, openai_resp):
            monitor.last_rejected_tiny_prompt_fingerprint = _tiny_non_tool_prompt_fingerprint(body)
            monitor.last_rejected_tiny_prompt_ts = time.time()
            monitor.last_completion_classification = "guarded_non_stream:tiny_post_tool_rejected"
            logger.warning(
                "Rejecting tiny post-tool non-tool completion; returning retryable error instead of terminal response"
            )
            return _build_reasoning_fallback_error_response(
                "A non-substantive follow-up completion was rejected. Please retry the request."
            )

        monitor.last_completion_classification = _classify_completion(
            body,
            openai_resp,
            guardrail_path="guarded_non_stream",
        )
        anthropic_resp = openai_to_anthropic_response(openai_resp, model)
        monitor.record_response(anthropic_resp.get("usage", {}).get("output_tokens", 0))
        monitor.last_response_had_tool_calls = _openai_has_tool_calls(openai_resp)
        logger.info(
            "SESSION END CLASSIFICATION: session=%s class=%s output_tokens=%d",
            session_id,
            monitor.last_completion_classification,
            anthropic_resp.get("usage", {}).get("output_tokens", 0),
        )
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

        if _is_tiny_non_tool_followup_request(body):
            logger.warning(
                "Fast-path rejecting tiny non-tool follow-up request to avoid slow preview/disconnect path"
            )
            await resp.aclose()
            monitor.last_rejected_tiny_prompt_fingerprint = _tiny_non_tool_prompt_fingerprint(body)
            monitor.last_rejected_tiny_prompt_ts = time.time()
            monitor.last_completion_classification = "stream:tiny_non_tool_fast_rejected"
            return _build_tiny_non_tool_terminal_response(
                "Tiny non-tool follow-up was terminated early to avoid a stalled terminal completion. Restart the session or send a substantive fresh request."
            )

        try:
            preview_resp = await _safe_post_chat_completions(
                client,
                {**openai_body, "stream": False},
                context_label="stream preview for reasoning-only fallback detection",
            )
            if preview_resp is not None and preview_resp.status_code == 200:
                preview_json = preview_resp.json()
                preview_choice = (preview_json.get("choices") or [{}])[0]
                preview_message = preview_choice.get("message") or {}
                preview_content = preview_message.get("content")
                if _is_empty_visible_response(preview_message):
                    preview_reasoning_chunks = []
                    preview_reasoning = preview_message.get("reasoning_content", "")
                    if preview_reasoning:
                        preview_reasoning_chunks.append(preview_reasoning)
                    preview_text = preview_content if isinstance(preview_content, str) else ""
                    if preview_text:
                        preview_reasoning_chunks.append(preview_text)

                    fallback_text = _build_actionable_reasoning_summary(
                        preview_reasoning_chunks
                    )
                    if not fallback_text:
                        fallback_text = _build_reasoning_fallback_text(
                            preview_reasoning_chunks
                        )
                    if not fallback_text:
                        fallback_text = (
                            "I couldn't produce a usable direct answer on that turn. "
                            "Please retry the same request."
                        )
                    logger.warning(
                        "Preview detected empty visible response on streaming request; "
                        "serving bounded fallback response instead of terminal retry-loop breaker"
                    )
                    await resp.aclose()
                    monitor.last_completion_classification = "stream:empty_visible_fallback"
                    monitor.forced_auto_cooldown_turns = max(
                        monitor.forced_auto_cooldown_turns, 1
                    )
                    anthropic_resp = _build_empty_visible_stream_fallback_response(
                        fallback_text
                    )
                    monitor.record_response(0)
                    monitor.last_response_had_tool_calls = False
                    return StreamingResponse(
                        stream_anthropic_message(anthropic_resp),
                        media_type="text/event-stream",
                        headers={
                            "Cache-Control": "no-cache",
                            "Connection": "keep-alive",
                        },
                    )
        except Exception as exc:
            logger.warning(
                "Streaming preview check failed (%s: %s); continuing with normal stream",
                type(exc).__name__,
                exc,
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
        resp = await _safe_post_chat_completions(
            client,
            openai_body,
            context_label="non-stream request",
        )
        if resp is None:
            return _transport_error_response(
                "Upstream server disconnected before sending a response."
            )

        if resp.status_code != 200:
            error_text = resp.text[:1000]
            if _maybe_disable_grammar_for_tools_error(
                openai_body,
                resp.status_code,
                error_text,
                "non-stream",
            ):
                resp = await _safe_post_chat_completions(
                    client,
                    openai_body,
                    context_label="non-stream grammar retry",
                )
                if resp is None:
                    return _transport_error_response(
                        "Upstream server disconnected before sending a response during retry."
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
        if _should_hard_fail_tool_turn_without_tool_use(body, openai_resp):
            _record_tool_turn_rejection(body, monitor)
            monitor.last_completion_classification = "non_stream:tool_turn_no_tool_use_rejected"
            logger.warning(
                "Hard-failing non-stream tool-enabled response without tool use"
            )
            return _build_tool_turn_no_tool_use_error_response()

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

        if _should_reject_tiny_post_tool_non_tool_completion(body, monitor, openai_resp):
            monitor.last_rejected_tiny_prompt_fingerprint = _tiny_non_tool_prompt_fingerprint(body)
            monitor.last_rejected_tiny_prompt_ts = time.time()
            monitor.last_completion_classification = "non_stream:tiny_post_tool_rejected"
            logger.warning(
                "Rejecting tiny post-tool non-tool completion; returning retryable error instead of terminal response"
            )
            return _build_reasoning_fallback_error_response(
                "A non-substantive follow-up completion was rejected. Please retry the request."
            )

        monitor.last_completion_classification = _classify_completion(
            body,
            openai_resp,
            guardrail_path="non_stream",
        )
        anthropic_resp = openai_to_anthropic_response(openai_resp, model)

        # Track output tokens in session monitor
        output_tokens = anthropic_resp.get("usage", {}).get("output_tokens", 0)
        monitor.record_response(output_tokens)
        monitor.last_response_had_tool_calls = _openai_has_tool_calls(openai_resp)
        logger.info(
            "SESSION END CLASSIFICATION: session=%s class=%s output_tokens=%d",
            session_id,
            monitor.last_completion_classification,
            output_tokens,
        )

        return anthropic_resp


@app.post("/anthropic/v1/messages")
async def messages_anthropic(request: Request):
    """Alternative endpoint path used by some Claude Code configurations."""
    return await messages(request)


@app.get("/v1/models")
async def models():
    """Return the active upstream model list in Anthropic-compatible shape."""
    data = []

    try:
        if http_client:
            resp = await http_client.get(f"{LLAMA_CPP_BASE}/models", timeout=10.0)
            if resp.status_code == 200:
                upstream = resp.json()
                if isinstance(upstream, dict):
                    models = upstream.get("data")
                    if isinstance(models, list):
                        for entry in models:
                            if not isinstance(entry, dict):
                                continue
                            model_id = entry.get("id") or entry.get("model") or entry.get("name")
                            if model_id:
                                data.append({"id": model_id, "object": "model"})
                    elif isinstance(upstream.get("models"), list):
                        for entry in upstream.get("models", []):
                            if not isinstance(entry, dict):
                                continue
                            model_id = entry.get("id") or entry.get("model") or entry.get("name")
                            if model_id:
                                data.append({"id": model_id, "object": "model"})
    except Exception as exc:
        logger.warning("Failed to fetch upstream model list for /v1/models: %s", exc)

    if not data:
        data.append({"id": "unknown-upstream-model", "object": "model"})

    return {"data": data}


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
            "tools_probe_done": TOOL_CALL_GRAMMAR_PROBE_DONE,
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
