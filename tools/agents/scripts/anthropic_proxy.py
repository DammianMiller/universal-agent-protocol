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
import contextvars
import copy
import hashlib
import json
import logging
import os
import re
import sys
import time
import uuid
from collections import OrderedDict, defaultdict, deque

try:
    import confidence_escalation as _ce  # serving-layer Confidence recipe
except Exception:  # pragma: no cover - fail open if module missing
    _ce = None
from dataclasses import dataclass, field
from pathlib import Path

import httpx
from contextlib import asynccontextmanager
from fastapi import FastAPI, Request, Response
from fastapi.responses import StreamingResponse
import uvicorn


def _load_proxy_env_file() -> None:
    """Load .uap/proxy.env (KEY=VALUE) written by `uap setup` into os.environ so
    recipe / escalation / delivery selections reach the proxy without the user
    hand-exporting env. Existing process env ALWAYS wins (setdefault). Walks up
    from CWD to the filesystem root looking for a .uap/proxy.env; override the
    path with UAP_PROXY_ENV_FILE. Runs before the import-time env reads below.
    Fails open."""
    try:
        candidates = []
        explicit = os.environ.get("UAP_PROXY_ENV_FILE")
        if explicit:
            candidates.append(Path(explicit))
        d = Path.cwd()
        for base in [d, *d.parents]:
            candidates.append(base / ".uap" / "proxy.env")
        for path in candidates:
            try:
                if not path.is_file():
                    continue
            except OSError:
                continue
            for raw in path.read_text().splitlines():
                line = raw.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, val = line.partition("=")
                key = key.strip()
                val = val.strip().strip('"').strip("'")
                if key:
                    os.environ.setdefault(key, val)
            break  # first file found wins
    except Exception:
        pass


_load_proxy_env_file()

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
# Bind loopback by DEFAULT (security audit: an unauthenticated 0.0.0.0 listener
# let any LAN host drive the local model and reach cloud passthrough). To run
# the proxy as a shared LAN service, set PROXY_HOST=0.0.0.0 AND set
# PROXY_AUTH_TOKEN so the exposure is credential-gated.
PROXY_HOST = os.environ.get("PROXY_HOST", "127.0.0.1")
# Optional shared secret. When set, every request to a model route must present
# it as `Authorization: Bearer <token>` or `X-Uap-Proxy-Token: <token>`. Unset
# (default) = no check, which is safe only because the default bind is loopback.
# The health probe stays open so liveness checks don't need the secret.
PROXY_AUTH_TOKEN = os.environ.get("PROXY_AUTH_TOKEN", "").strip()
PROXY_LOG_LEVEL = os.environ.get("PROXY_LOG_LEVEL", "INFO").upper()
PROXY_READ_TIMEOUT = float(os.environ.get("PROXY_READ_TIMEOUT", "180"))
PROXY_GENERATION_TIMEOUT = float(os.environ.get("PROXY_GENERATION_TIMEOUT", "300"))
# Bound Anthropic-passthrough upstream calls. Without this they inherit the
# long streaming read timeout (default 1800s) and — because /v1/chat/completions
# forces a single non-streaming upstream call (for guardrail simplicity) — a
# slow or stuck Anthropic generation holds the request (and the single llama
# slot) for up to that long, which produced ~77-min benchmark hangs. 600s is
# generous for a long legitimate generation but converts a true hang into a
# fast, recoverable error.
PROXY_PASSTHROUGH_TIMEOUT = float(os.environ.get("PROXY_PASSTHROUGH_TIMEOUT", "600"))
PROXY_SLOT_HANG_TIMEOUT = float(os.environ.get("PROXY_SLOT_HANG_TIMEOUT", "120"))
PROXY_UPSTREAM_RETRY_MAX = int(os.environ.get("PROXY_UPSTREAM_RETRY_MAX", "3"))
PROXY_UPSTREAM_RETRY_DELAY_SECS = float(os.environ.get("PROXY_UPSTREAM_RETRY_DELAY_SECS", "5"))
PROXY_MAX_CONNECTIONS = int(os.environ.get("PROXY_MAX_CONNECTIONS", "20"))
# CLOSE-WAIT reaper: abandoned upstream connections (a cancelled request
# whose httpx connection is never closed — llama's response sits unread in
# the socket, CLOSE-WAIT) accrue and saturate the pool. The reaper reads
# /proc/net/tcp, counts CLOSE-WAIT sockets to the upstream, and triggers a
# (safe, stream-preserving) pool self-heal when they exceed the threshold.
PROXY_CLOSEWAIT_REAP_THRESHOLD = int(os.environ.get("PROXY_CLOSEWAIT_REAP_THRESHOLD", "30"))
# Reaper is OPT-IN (default 0 = off): live 2026-07-12 under a SATURATED
# upstream (llama at 3/3 slots), its pool-swap mechanism turned a slow
# abandoned-connection leak into ReadError->500 bursts (74 500s/16min) —
# constant swaps churned in-flight connections. The graceful path
# (PoolTimeout -> 529 backoff + a large PROXY_MAX_CONNECTIONS) handles the
# leak without client-visible errors. Set >0 to re-enable the reaper.
PROXY_CLOSEWAIT_REAP_INTERVAL = float(os.environ.get("PROXY_CLOSEWAIT_REAP_INTERVAL", "0"))
PROXY_CONTEXT_WINDOW = int(os.environ.get("PROXY_CONTEXT_WINDOW", "0"))
PROXY_CONTEXT_PRUNE_THRESHOLD = float(
    os.environ.get("PROXY_CONTEXT_PRUNE_THRESHOLD", "0.85")
)
# Compaction forcing (Option A, 2026-07-10): Claude Code decides when to
# auto-compact against ITS believed model window (~200k) using
# /v1/messages/count_tokens, so an HONEST count on a smaller local rail lets
# every session grow into the "thrash band" — above the rail (per-request
# critical prunes, findings evaporate, read-only doom loops; observed live:
# 87 reads / 0 writes in 30 min at 122% utilization) but below the client's
# compact trigger (~92.5% of 200k). Scaling the reported count makes the
# client compact BEFORE the rail. "auto" (default) derives the scale from the
# LIVE rail at call time — assumed_window / (rail * target_fraction) — so it
# tracks rail resizes; a number forces that scale; "1"/"off" disables.
PROXY_COUNT_TOKENS_SCALE = os.environ.get("PROXY_COUNT_TOKENS_SCALE", "auto")
PROXY_CLIENT_ASSUMED_WINDOW = int(
    os.environ.get("PROXY_CLIENT_ASSUMED_WINDOW", "200000")
)
# Where compaction should land sessions, as a fraction of the rail. Unset
# (0) = auto: just under the pruner threshold (x0.95), so the client's own
# compaction fires BEFORE the proxy ever needs to prune — the pruner stays on
# purely as a backstop. An explicit value overrides (clamped to <1).
PROXY_COMPACT_TARGET_FRACTION = float(
    os.environ.get("PROXY_COMPACT_TARGET_FRACTION", "0")
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
# Fix K (2026-04-22): minimum consecutive cycle-repeat count required to flip
# phase from act -> review. The old behaviour accepted cycle_repeat=2, which
# is normal in a working session (re-reading the same file across edits).
# Set higher to tolerate legitimate re-reads; set 1 to restore old behaviour.
PROXY_CYCLE_TRIGGER_REPEAT = int(os.environ.get("PROXY_CYCLE_TRIGGER_REPEAT", "3"))
PROXY_FORCED_THRESHOLD = int(os.environ.get("PROXY_FORCED_THRESHOLD", "15"))
PROXY_NO_PROGRESS_THRESHOLD = int(os.environ.get("PROXY_NO_PROGRESS_THRESHOLD", "3"))
# Fix D: streak-independent escape hatch. `no_progress_streak` resets to 0 on
# every turn whose last user message carries a tool_result (line ~3835) — i.e.
# every turn of a normal agentic loop — so the no_progress-gated LOOP BREAKER
# patterns can never accumulate. After this many *consecutive* forced-'required'
# turns (which DOES accumulate across an agentic loop via consecutive_forced_count),
# release tool_choice to 'auto' regardless of no_progress_streak so the model can
# emit a terminating response. Set well above any healthy run length (healthy
# loops hit auto/finalize/review phases that reset the count). 0 disables.
PROXY_FORCED_HARD_RELEASE = int(os.environ.get("PROXY_FORCED_HARD_RELEASE", "30"))
PROXY_CONTEXT_RELEASE_THRESHOLD = float(
    os.environ.get("PROXY_CONTEXT_RELEASE_THRESHOLD", "0.90")
)
# ---------------------------------------------------------------------------
# STUCK-BREAK guardrail: a small model can recognize it is looping ("I've been
# stuck in a loop, let me break out") yet keep repeating the SAME failing tool
# call -- meta-cognition without an exit. Two signals, both observed live on a
# qwen3.6 session that looped ~18min fetching a rate-limited GitHub API:
#   (a) repeated self-reported "stuck" assistant text, and
#   (b) repeated tool calls hitting a known rate-limited API host.
# When either streak crosses its threshold the proxy forces a TERMINAL turn:
# tool_choice back to auto + a firm directive to stop retrying and either
# proceed without the unreachable resource or ask the operator. Default on;
# PROXY_STUCK_BREAK=off to disable.
PROXY_STUCK_BREAK = os.environ.get("PROXY_STUCK_BREAK", "on").lower() not in {
    "0", "false", "off", "no",
}
# Self-reported-stuck phrases (lowercased match). Deliberately narrow.
_STUCK_PHRASE_RE = re.compile(
    r"stuck in a loop|been stuck|break out of (?:this|the) loop|going in circles|"
    r"repeating myself|same (?:thing|error) (?:again|repeatedly)",
    re.IGNORECASE,
)
# Tool args reaching into a rate-limited REST API host (the wrong channel; the
# hint steers to the browser tool / git clone, which are not rate-limited).
_RATE_LIMITED_API_RE = re.compile(r"api\.github\.com", re.IGNORECASE)
PROXY_STUCK_TEXT_THRESHOLD = int(os.environ.get("PROXY_STUCK_TEXT_THRESHOLD", "2"))
PROXY_STUCK_API_THRESHOLD = int(os.environ.get("PROXY_STUCK_API_THRESHOLD", "3"))

# ---------------------------------------------------------------------------
# ERROR-LOOP guardrail: the model edits, runs a command, hits the SAME failure,
# edits again (a DIFFERENT edit), runs, hits the same failure — for many turns.
# The identical-tool-call loop/cycle detectors never trip because each edit
# differs; the model looks productive while never addressing the real blocker
# (observed live: a duplicate function declaration in test.js kept the test from
# compiling, and the model chased an unrelated error in another file for 35 min).
# Detect a repeated tool_RESULT error SIGNATURE (normalized: paths/line numbers/
# digits/hex stripped so it's edit-invariant) and, past the threshold, inject a
# nudge to STOP editing and re-read the failing file/output end-to-end.
# PROXY_ERROR_LOOP=off to disable.
PROXY_ERROR_LOOP = os.environ.get("PROXY_ERROR_LOOP", "on").lower() not in {
    "0", "off", "false", "no",
}
PROXY_ERROR_LOOP_THRESHOLD = int(os.environ.get("PROXY_ERROR_LOOP_THRESHOLD", "3"))

_ERROR_LINE_RE = re.compile(
    r"^.*(?:Error|Exception|Traceback|FAILED|assert(?:ion)?|SyntaxError|"
    r"TypeError|ReferenceError|not found|cannot find|undefined|panic|"
    r"fatal|command not found|exit code [1-9]).*$",
    re.IGNORECASE | re.MULTILINE,
)


def _error_signature(text: str) -> str:
    """Edit-invariant signature of the first error line in a tool result.

    Normalizes away paths, line:col numbers, hex, and bare digits so that the
    SAME underlying failure produces the SAME signature across turns even as the
    model edits different code around it. Returns "" when no error line is found
    (a passing result resets the streak)."""
    if not text:
        return ""
    m = _ERROR_LINE_RE.search(text)
    if not m:
        return ""
    line = m.group(0)
    line = re.sub(r"(/[^\s:]+)+", "<path>", line)          # unix paths
    line = re.sub(r"\b[0-9a-fA-F]{6,}\b", "<hex>", line)    # hashes/addresses
    line = re.sub(r"\d+", "#", line)                        # line numbers, counts
    line = re.sub(r"\s+", " ", line).strip().lower()
    return line[:200]

# ---------------------------------------------------------------------------
# DEFERRAL-BREAK guardrail (Fix A): a model can end a turn with plain prose that
# DEFERS the work instead of doing it -- "I need more exploration cycles to
# complete the plan", "let me continue exploring", "I'll need a few more passes"
# -- with NO tool call. This is a turn-ending *capitulation*, not a loop
# admission, so STUCK-BREAK's phrase list never matches it; and because it is a
# no-tool turn, recon-convergence never advanced its streak either (that counter
# only moves on turns that emit tool calls). The stall therefore slips through
# every guardrail and silently halts a hands-free build (observed live: a run of
# back-to-back session-ends with "Code changed: false"). When a no-tool turn
# matches the deferral phrasing PROXY_DEFERRAL_THRESHOLD times in a row, the
# proxy forces the NEXT turn to take a concrete action: tool_choice=required plus
# a firm "continue autonomously, you will not be re-prompted" directive. This is
# the INVERSE of STUCK-BREAK (which releases to a prose exit) -- a deferral means
# work REMAINS, so we drive an action rather than allow a stop. Default on;
# PROXY_DEFERRAL_BREAK=off to disable.
PROXY_DEFERRAL_BREAK = os.environ.get("PROXY_DEFERRAL_BREAK", "on").lower() not in {
    "0", "false", "off", "no",
}
# Turn-ending deferral/capitulation phrases (lowercased match). Deliberately
# narrow -- it must catch "I need more exploration cycles to complete the plan"
# and close kin, WITHOUT firing on ordinary forward-looking narration that is
# actually followed by a tool call (the no-tool-turn gate handles that too).
_DEFERRAL_PHRASE_RE = re.compile(
    r"need (?:more|additional|further|extra) (?:exploration |investigation |research )?"
    r"(?:cycles|passes|turns|iterations|rounds)"
    r"|more (?:exploration |investigation )?(?:cycles|passes|iterations) "
    r"(?:to|are needed|is needed|required|before)"
    r"|to (?:complete|finish|continue) (?:the|my) (?:plan|exploration|investigation)"
    r"|(?:let me|allow me to|i'?ll|i will|i need to|i'?d need to|"
    r"we(?:'?ll| will| need to)) (?:keep|continue) "
    r"(?:exploring|investigating|researching|working through|going)"
    r"|(?:once|after) i(?:'ve| have)? (?:explored|investigated|gathered|reviewed) "
    r"(?:more|additional|further|enough)"
    r"|need to (?:gather|do|run|perform) (?:more|additional|further) "
    r"(?:exploration|research|investigation|analysis)",
    re.IGNORECASE,
)
# Fire on the FIRST deferral by default: a single "I need more cycles" no-tool
# turn IS the halt, unlike STUCK-BREAK which waits for a sustained loop.
PROXY_DEFERRAL_THRESHOLD = int(os.environ.get("PROXY_DEFERRAL_THRESHOLD", "1"))

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
# #4 Coordination no-op suppression. Pure-bookkeeping tools (task/board status
# updates) are never productive to repeat, so they are banned after fewer cycle
# detections than the generic per-tool threshold. This targets the 35B-A3B
# "update the task instead of doing the actual work" loop (observed live:
# cycling_tools=['TaskUpdate']). Tunable via env; set the threshold to 0 to
# disable the faster ban and fall back to the generic threshold.
PROXY_COORDINATION_TOOLS = {
    t.strip()
    for t in os.environ.get(
        "PROXY_COORDINATION_TOOLS",
        "TaskUpdate,TaskCreate,TaskList,TaskGet,TaskOutput",
    ).split(",")
    if t.strip()
}
PROXY_COORDINATION_BAN_THRESHOLD = int(
    os.environ.get("PROXY_COORDINATION_BAN_THRESHOLD", "2")
)
# R4: early coordination-loop ban. The per-tool cycle ban above engages only
# inside an active agentic loop (tool_results present). But a model can loop on a
# coordination tool from the very FIRST moves -- e.g. repeatedly creating a task
# ABOUT doing X instead of doing X (observed: TaskCreate x4 identical args at
# session start) -- where the cycle detector never engages. This bans a
# coordination tool after N consecutive IDENTICAL calls regardless of loop state.
# 0 disables.
PROXY_COORDINATION_EARLY_BAN = int(
    os.environ.get("PROXY_COORDINATION_EARLY_BAN", "3")
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

# Tools that produce or mutate a deliverable. Using any of these in a turn
# means the agent is converging from exploration toward output, and resets
# the recon-convergence streak (B1). This is deliberately a SHORT allowlist
# of write tools, NOT a read-only denylist: exploration happens through an
# open-ended set of tools (Bash, WebFetch, Agent, ...) that cannot be
# enumerated, but "the agent produced a write" is a small, stable signal.
# Names are matched case-insensitively (callers lower() before lookup).
_WRITE_TOOL_CLASS = frozenset({
    "write", "edit", "multiedit", "notebookedit",
    "str_replace", "str_replace_editor", "str_replace_based_edit_tool",
    "create_file", "applypatch", "apply_patch",
    # OpenAI-style tool-loop names (uap deliver's agentic executor and other
    # OpenAI-compat agents). Without these, every agentic round that WRITES
    # files still counted as a no-write turn, the recon-convergence streak
    # grew unbounded, and the proxy injected "stop exploring, synthesize"
    # directives into a loop that was mid-build — observed live at
    # no_write_streak=62 with the model then emitting files as plain text.
    "write_file", "edit_file", "save_file",
    # A: `deliver` is the ONLY write path when delivery-enforcement gates
    # direct Edit/Write. Counting it as a write means (a) a deliver call
    # resets the no-write streak instead of looking like more exploration,
    # and (b) the recon-convergence restore loop re-injects `deliver` when
    # narrowing dropped it, so a gated "route through deliver" directive is
    # actually satisfiable.
    "deliver",
})

# Open-ended exploration tools the agent uses to make a DIFFERENT move once a
# read/grep/glob loop is broken. The code cannot enumerate every exploration
# tool, but these are the universal escape hatches. Cycle-break narrowing must
# NEVER strip these: a cycling *Bash* means "vary the command" (handled by the
# injected cycle hint), NOT "lose the ability to run bash at all". Excluding
# Bash here stranded autonomous ("auto mode") agents with no way to explore the
# filesystem — the whole toolset minus its exploration escape hatch.
_EXPLORATION_ESCAPE_TOOLS = frozenset({
    "bash", "shell", "sh", "run_bash", "runbash", "run_command",
    "run_terminal_cmd", "execute_command", "executecommand", "terminal",
    "webfetch", "web_fetch", "fetch", "websearch", "web_search",
    "agent", "task", "dispatch_agent",
})


def _narrow_tools_for_cycle_break(tools, cycling_tool_names, session_banned_tools):
    """Drop cycling + session-banned tools from the toolset, expanding to the
    whole read-only class when any excluded tool is read-only.

    The open-ended exploration escape hatch (Bash/WebFetch/Agent) is kept out of
    the CYCLING-derived exclusion: a cycling Bash means "vary the command"
    (handled by the injected cycle hint), not "lose the ability to run bash".
    An explicit session ban is a stronger, deliberate signal (a tool that keeps
    malforming) and IS still honored, even for those tools.

    Returns ``(narrowed_tools, expanded_read_only_class)``. Tool-name matching is
    case-insensitive so "Bash"/"bash" and "Read"/"read" behave identically.
    """
    read_only_lower = {c.lower() for c in _READ_ONLY_TOOL_CLASS}
    cycling_lower = {n.lower() for n in cycling_tool_names}
    banned_lower = {n.lower() for n in session_banned_tools}
    # Expand to the full read-only class if any excluded tool is read-only
    # (preserves the original trigger over cycling ∪ banned).
    expanded = any(n in read_only_lower for n in (cycling_lower | banned_lower))
    cycling_exclude = set(cycling_lower)
    if expanded:
        cycling_exclude |= read_only_lower
    # Never let the cycling path narrow away the exploration escape hatch — that
    # is exactly the filesystem-exploration capability the cycle-break is trying
    # to redirect the agent toward.
    cycling_exclude -= _EXPLORATION_ESCAPE_TOOLS
    exclude_set = cycling_exclude | banned_lower

    def _name(t):
        return ((t.get("function", {}) or {}).get("name", "") or "").lower()

    narrowed = [t for t in tools if _name(t) not in exclude_set]

    # Floor invariant: a loop-breaker must never strand the agent. If narrowing
    # would remove the last way to make a DIFFERENT move — i.e. no exploration
    # escape hatch AND no write tool survives, but the original set had one —
    # keep the original toolset. This closes the door where an explicit ban of
    # the sole exploration tool re-creates the very "can't explore" bug.
    write_lower = {w.lower() for w in _WRITE_TOOL_CLASS}

    def _has_action_path(tool_list):
        names = {_name(t) for t in tool_list}
        return bool(names & _EXPLORATION_ESCAPE_TOOLS) or bool(names & write_lower)

    if _has_action_path(tools) and not _has_action_path(narrowed):
        return list(tools), expanded
    return narrowed, expanded


def _should_auto_ban(name, cycle_count, ban_at):
    """Whether a cycling tool should be added to session_banned_tools this round.

    The auto-ban accumulator is itself cycling-derived (ban after N detections),
    so exploration escape-hatch tools (Bash/WebFetch/Agent) are NEVER auto-banned
    — banning Bash would re-strip the agent's only way to explore the filesystem
    on the Nth cycle, re-creating the bug the narrowing exemption fixes for
    earlier cycles. Repeated Bash is redirected via the injected cycle hint.
    """
    if name.lower() in _EXPLORATION_ESCAPE_TOOLS:
        return False
    return cycle_count >= ban_at

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
# Hard turn-count finalize backstop (2026-06-22). Catches "mode B" runaways: the
# model keeps emitting DISTINCT, well-formed tool calls and never emits end_turn,
# so the synthetic-continuation, context-death-spiral, and tool-starvation paths
# never engage and 'release to auto' just lets it keep choosing tools — it loops
# until the client's agent timeout. After this many assistant tool-using turns in
# the (post-prune) transcript, strip tools so the only possible output is a
# terminal text summary (end_turn). Gated HIGH so only a genuine runaway trips it;
# pruning-heavy large legitimate sessions keep a low post-prune turn count and are
# unaffected. Set 0 to disable. Empirically motivated by the paired benchmark
# where every hard-suite run looped to timeout (see project_uap_paired_bench).
PROXY_HARD_FINALIZE_TURNS = int(
    os.environ.get("PROXY_HARD_FINALIZE_TURNS", "40")
)
# Self-Harness middleware (2026-06-23): conversation-aware tool-call path
# normalizer. When ON, garbled file paths in outgoing tool_use blocks
# (case/extension/stray-dir/whitespace mangling — the toolcall.path.garbled
# failure) are snapped to the nearest path the model already used correctly
# earlier in the conversation. Default OFF (a Self-Harness `middleware` Mod
# enables it after the loop validates it). See toolcall_path_normalizer.py and
# docs/design/SELF_HARNESS.md §4.
PROXY_TOOLCALL_PATH_NORMALIZE = os.environ.get(
    "PROXY_TOOLCALL_PATH_NORMALIZE", "off"
).lower() in ("on", "1", "true", "yes")
# Path CONTAINMENT (separate from same-dir normalization): snap a garbled
# out-of-workdir path (the small quant mangling the absolute PREFIX, e.g.
# /home/cogtek -> /home/cogtec, octopus_invaders -> octus_invaders) back ONTO the
# session workdir. Safe because the OS sandbox contains any mis-snap to the
# workdir — without the sandbox this would risk cross-project relocation, so it
# defaults ON only alongside sandboxed sessions. Set off to disable.
PROXY_TOOLCALL_PATH_CONTAIN = os.environ.get(
    "PROXY_TOOLCALL_PATH_CONTAIN", "on"
).lower() in ("on", "1", "true", "yes")
try:
    import sys as _sys
    _sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # launch-robust sibling import
    from toolcall_path_normalizer import extract_known_paths as _shz_known_paths
    from toolcall_path_normalizer import normalize_tool_uses as _shz_normalize_tool_uses
    from toolcall_path_normalizer import derive_workdir as _shz_derive_workdir
    from toolcall_path_normalizer import contain_tool_uses as _shz_contain_tool_uses
    _TOOLCALL_NORMALIZER_OK = True
except Exception:  # pragma: no cover - optional middleware
    _TOOLCALL_NORMALIZER_OK = False


def _record_project_telemetry(body, model, usage, duration_ms: float = 0.0) -> None:
    """Fail-open per-project routing/cost telemetry: derive the request's project
    dir and append a task_outcomes row (plus a dashboard live-feed event) to its
    analytics/telemetry DBs so per-project dashboards see the model calls this
    shared proxy makes. See tools/agents/scripts/project_telemetry.py. Never
    raises."""
    try:
        import sys as _s
        _d = os.path.dirname(os.path.abspath(__file__))
        if _d not in _s.path:
            _s.path.insert(0, _d)
        import project_telemetry as _pt
        _pt.record_from_request(body, model, usage, duration_ms=duration_ms)
    except Exception:
        pass


def _toolcall_workdir_hint(messages: list, limit: int = 8000) -> str:
    """Recent text/tool_result content (capped) so derive_workdir can recover the
    real workdir echoed in command outputs even when the model's own tool-call
    paths are all garbled."""
    out: list[str] = []
    total = 0
    for msg in reversed(messages or []):
        content = msg.get("content")
        chunks: list[str] = []
        if isinstance(content, str):
            chunks.append(content)
        elif isinstance(content, list):
            for b in content:
                if not isinstance(b, dict) or b.get("type") not in ("text", "tool_result"):
                    continue
                c = b.get("content", b.get("text", ""))
                if isinstance(c, list):
                    c = " ".join(x.get("text", "") for x in c if isinstance(x, dict))
                if isinstance(c, str):
                    chunks.append(c)
        for c in chunks:
            out.append(c)
            total += len(c)
        if total >= limit:
            break
    return " ".join(out)[:limit]


def _maybe_normalize_toolcall_paths(anthropic_resp: dict, request_body: dict) -> None:
    """Gated: (1) CONTAIN garbled out-of-workdir paths back onto the session
    workdir (safe under the OS sandbox), then (2) snap remaining garbles to the
    same real directory. No-op unless enabled + available."""
    if not _TOOLCALL_NORMALIZER_OK or not (
        PROXY_TOOLCALL_PATH_NORMALIZE or PROXY_TOOLCALL_PATH_CONTAIN
    ):
        return
    try:
        content = anthropic_resp.get("content")
        if not isinstance(content, list):
            return
        tool_uses = [b for b in content if isinstance(b, dict) and b.get("type") == "tool_use"]
        if not tool_uses:
            return
        messages = request_body.get("messages", [])
        known = _shz_known_paths(messages)

        # 1) Containment first, so step 2 sees corrected paths.
        if PROXY_TOOLCALL_PATH_CONTAIN:
            workdir = _shz_derive_workdir(known, _toolcall_workdir_hint(messages))
            if workdir:
                for tu_id, key, frm, to, reason in _shz_contain_tool_uses(tool_uses, workdir):
                    logger.info(
                        "TOOLCALL PATH CONTAINMENT: %s.%s '%.80s' -> '%.80s' (%s)",
                        tu_id, key, frm, to, reason,
                    )

        # 2) Same-directory filename normalization (filesystem-verified).
        if PROXY_TOOLCALL_PATH_NORMALIZE and known:
            for tu_id, key, frm, to, reason in _shz_normalize_tool_uses(tool_uses, known):
                logger.info(
                    "TOOLCALL PATH NORMALIZER: %s.%s '%s' -> '%s' (%s)",
                    tu_id, key, frm, to, reason,
                )
    except Exception as exc:  # never break a response over normalization
        logger.warning("TOOLCALL PATH NORMALIZER: skipped (%s)", type(exc).__name__)
# Recon-convergence guardrail: after this many consecutive turns that use
# tools but produce NO write/deliverable tool call (see _WRITE_TOOL_CLASS),
# the proxy injects a directive telling the model to stop exploring and
# produce its deliverable. Targets the failure mode where an agentic recon
# task explores for hundreds of turns and never converges to the
# synthesis/write step (observed: 664-turn recon, no deliverable started).
# Defined as write-tool ABSENCE rather than read-tool presence: a real
# recon agent explores via Bash/WebFetch/Agent, not just Read/Grep, so a
# "all tools are recognized read-only" test never accumulates a streak.
# 0 disables.
PROXY_RECON_CONVERGENCE_THRESHOLD = int(
    os.environ.get("PROXY_RECON_CONVERGENCE_THRESHOLD", "40")
)
# Fix C: the hard tier historically fired at 2x the base threshold (80 turns
# at the default 40) -- far too late; the model burns ~40 extra turns reading
# before the stronger "STOP, write now / release tool_choice" directive kicks
# in. This multiplier makes the hard-tier onset configurable. 1.5x (60 turns)
# escalates sooner while still leaving the firm tier a working window. Clamped
# to >= 1.0 so the hard tier can never precede the firm tier.
PROXY_RECON_HARD_MULTIPLIER = max(1.0, float(
    os.environ.get("PROXY_RECON_HARD_MULTIPLIER", "1.5")
))
# Fix E: the recon hard tier (streak >= 2x threshold) fires a directive + flips
# tool_choice to 'auto', but `consecutive_no_write_turns` resets to 0 whenever
# the model emits any write tool — so a loop that periodically writes sawtooths
# the streak (observed: 90 -> 0 -> climb again), re-triggering the hard tier
# forever and never actually terminating. This counts how many times the hard
# tier has fired across the whole session (monotonic, never reset). Once it
# reaches this cap, the guard escalates: it strips tools for the turn so the
# model is forced to emit a terminal prose summary, breaking the sawtooth. 0
# disables the escalation (hard tier still flips to 'auto' each time).
PROXY_RECON_SESSION_HARD_CAP = int(
    os.environ.get("PROXY_RECON_SESSION_HARD_CAP", "3")
)
# Fix F: context death-spiral breaker. When the *raw* (pre-prune) incoming
# context stays catastrophically over the window for several consecutive turns,
# releasing tool_choice to 'auto' (Fix B / LOOP BREAKER) is NOT enough — the
# model keeps voluntarily emitting tool calls and the client keeps resending an
# ever-growing transcript (observed: ctx 936%, model emits tool_calls 18/min
# despite tool_choice=auto). After this many consecutive turns at/above the
# ratio, strip tools entirely so the only possible response is a terminal text
# summary (end_turn), which ends the client's agentic loop. Ratio is set high
# enough that only a true runaway trips it — a merely-full session tops out near
# 100-130%, never 300%. 0 disables.
PROXY_RAW_CTX_FINALIZE_RATIO = float(
    os.environ.get("PROXY_RAW_CTX_FINALIZE_RATIO", "3.0")
)
PROXY_RAW_CTX_FINALIZE_STREAK = int(
    os.environ.get("PROXY_RAW_CTX_FINALIZE_STREAK", "2")
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
# Disable thinking on EVERY turn (not just tool turns). For models like Gemma 4
# that emit ~100 thinking tokens for trivial replies, this halves output cost.
PROXY_DISABLE_THINKING_ALWAYS = os.environ.get(
    "PROXY_DISABLE_THINKING_ALWAYS", "off"
).lower() not in {"0", "false", "off", "no"}
# Force tool_choice='required' on the first turn of a fresh session. Originally
# Qwen-tuned to break out of cold-start "tries to chat instead of calling a tool"
# behaviour. Gemma 4 doesn't need this — it routes 'auto' correctly and the
# force triggers malformed-JSON emissions when it would rather speak. Default
# off; set 'on' to restore the legacy Qwen-style behaviour.
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
# Empty-max_tokens recovery (Option 3): a reasoning model can consume the ENTIRE
# output budget in reasoning_content and emit NO content/tool_calls
# (finish_reason=length, empty message) — a thinking-runaway. The upstream
# --reasoning-budget cap is the primary fix; this is the backstop: on detecting
# such an empty truncation, retry ONCE with thinking disabled so the turn yields
# a usable answer instead of an empty response the client blindly re-sends
# (observed: 529 retry cascades). PROXY_EMPTY_MAXTOKENS_RECOVER=off to disable.
PROXY_EMPTY_MAXTOKENS_RECOVER = os.environ.get(
    "PROXY_EMPTY_MAXTOKENS_RECOVER", "on"
).lower() not in {"0", "off", "false", "no"}
PROXY_EMPTY_MAXTOKENS_RETRY_MAX_TOKENS = int(
    os.environ.get("PROXY_EMPTY_MAXTOKENS_RETRY_MAX_TOKENS", "4096")
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
# A2: stream-passthrough on required-tool turns. By default the proxy DOWNGRADES
# a streaming request to the guarded non-stream path whenever tool_choice is
# 'required', so it can buffer + validate/repair the tool call (observed: ~88%
# of tool turns buffered, costing client-perceived streaming latency). When this
# is ON, required-tool streaming turns stream through directly instead — relying
# on llama.cpp's native tool_choice='required' constraint (measured tool-miss
# rate ~0). force-non-stream and malformed-strict still buffer. Default OFF
# (preserves the safe buffer+repair behavior); opt in for the latency win.
PROXY_STREAM_REQUIRED_TOOL = os.environ.get(
    "PROXY_STREAM_REQUIRED_TOOL", "off"
).lower() not in {"", "0", "false", "off", "no"}
# Streaming keep-alive heartbeat (seconds) for the guarded-non-stream path.
# That path buffers the ENTIRE upstream generation before emitting any SSE
# bytes, so a long generation (e.g. a 28k-token runaway taking ~14 min at
# depth-slowed decode) sends the client nothing for the whole wait and the
# client's streaming idle-timeout fires -> "API Error". When > 0, the proxy
# emits an immediate `message_start` then periodic `ping` events to the client
# while it awaits+guards the buffered upstream response, keeping the connection
# alive; the buffered content is streamed once ready. 0 disables (old behavior).
try:
    PROXY_STREAM_HEARTBEAT_SECS = float(
        os.environ.get("PROXY_STREAM_HEARTBEAT_SECS", "0")
    )
except ValueError:
    PROXY_STREAM_HEARTBEAT_SECS = 0.0
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
# Attractor-aware contamination escape. When the same fault excerpt repeats
# across consecutive contamination resets the model is in a stable output
# attractor that the standard kept_last reset cannot escape (the preserved
# tail re-primes the same fixed-point response). Detect via excerpt hash and
# respond with a harder reset + corrective injection + temperature bump.
PROXY_ATTRACTOR_DETECT = os.environ.get(
    "PROXY_ATTRACTOR_DETECT", "on"
).lower() not in {"0", "false", "off", "no"}
PROXY_ATTRACTOR_TEMP_OVERRIDE = float(
    os.environ.get("PROXY_ATTRACTOR_TEMP_OVERRIDE", "1.20")
)
PROXY_ATTRACTOR_FINALIZE_THRESHOLD = max(1, int(
    os.environ.get("PROXY_ATTRACTOR_FINALIZE_THRESHOLD", "2")
))
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
# Structured thinking grammar — forces a compact <think> header on non-tool
# reasoning turns so downstream verifiers can parse the model's framing.
# Default off (opt-in) because it changes output shape.
PROXY_THINKING_GRAMMAR = os.environ.get(
    "PROXY_THINKING_GRAMMAR", "off"
).lower() not in {
    "0",
    "false",
    "off",
    "no",
}
PROXY_THINKING_GRAMMAR_PATH = os.path.abspath(
    os.environ.get(
        "PROXY_THINKING_GRAMMAR_PATH",
        os.path.join(os.path.dirname(__file__), "..", "config", "thinking.gbnf"),
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
    re.compile(r"^claude-opus-4-8", re.IGNORECASE),
    re.compile(r"^claude-sonnet-4-6", re.IGNORECASE),
    re.compile(r"^claude-sonnet-5", re.IGNORECASE),
    re.compile(r"^claude-haiku-4-5", re.IGNORECASE),
    re.compile(r"^claude-haiku-3-5", re.IGNORECASE),
    re.compile(r"^claude-fable-5", re.IGNORECASE),
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
# Sandbox browser-tool stripping fires on EVERY request of a sandboxed session
# (v1.119.4). Logging it at WARNING per request floods the journal (~140/2h for a
# handful of sessions). Track which clients we've already told, log once each at
# INFO. Bounded to avoid unbounded growth across long-lived proxies.
_SANDBOX_STRIP_LOGGED: set[str] = set()

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


def _load_thinking_grammar(path: str) -> str:
    if not PROXY_THINKING_GRAMMAR:
        return ""

    try:
        with open(path, "r", encoding="utf-8") as fh:
            return fh.read().strip()
    except OSError as exc:
        logger.warning(
            "Thinking grammar disabled: failed to read %s (%s)",
            path,
            exc,
        )
        return ""


THINKING_GBNF = _load_thinking_grammar(PROXY_THINKING_GRAMMAR_PATH)

# JSON-response grammar (evaluator verdicts): when a client marks a no-tool
# request with the x-uap-json-response header, constrain sampling to a bare
# JSON value. Kills the "<think> ate the verdict / unparseable judgment"
# failure class at the decoder. Default on; PROXY_JSON_RESPONSE_GRAMMAR=off.
PROXY_JSON_RESPONSE_GRAMMAR = os.environ.get(
    "PROXY_JSON_RESPONSE_GRAMMAR", "on"
).lower() not in {"0", "false", "off", "no"}
PROXY_JSON_RESPONSE_GRAMMAR_PATH = os.path.abspath(
    os.environ.get(
        "PROXY_JSON_RESPONSE_GRAMMAR_PATH",
        os.path.join(os.path.dirname(__file__), "..", "config", "json-response.gbnf"),
    )
)


def _load_json_response_grammar(path: str) -> str:
    if not PROXY_JSON_RESPONSE_GRAMMAR:
        return ""
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return fh.read().strip()
    except OSError as exc:
        logger.warning("JSON-response grammar disabled: failed to read %s (%s)", path, exc)
        return ""


JSON_RESPONSE_GBNF = _load_json_response_grammar(PROXY_JSON_RESPONSE_GRAMMAR_PATH)


def _apply_json_response_grammar(openai_body: dict, anthropic_body: dict) -> None:
    """Constrain a marked no-tool request to emit a bare JSON value.

    Fires only when the client tagged the request (x-uap-json-response, staged
    into the body as _uap_json_response), there are no tools, the grammar
    loaded, and nothing upstream set a grammar already. Thinking is forced off
    — the grammar forbids a <think> preamble by construction.
    """
    if not anthropic_body.get("_uap_json_response"):
        return
    if not JSON_RESPONSE_GBNF:
        return
    if openai_body.get("tools") or openai_body.get("grammar"):
        return
    openai_body["grammar"] = JSON_RESPONSE_GBNF
    openai_body["enable_thinking"] = False
    ctk = openai_body.setdefault("chat_template_kwargs", {})
    ctk["enable_thinking"] = False
    logger.info("JSON-RESPONSE grammar applied (evaluator verdict turn)")


def _apply_thinking_grammar(request_body: dict) -> None:
    """Apply the structured-thinking GBNF grammar to non-tool turns.

    Only fires when PROXY_THINKING_GRAMMAR is on, the grammar loaded
    successfully, the request has no tools, and no upstream grammar was
    already set (tool-call grammar takes precedence on tool turns).
    """
    if not PROXY_THINKING_GRAMMAR or not THINKING_GBNF:
        return
    if request_body.get("tools"):
        return
    if request_body.get("grammar"):
        return
    request_body["grammar"] = THINKING_GBNF

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


def _is_gemma4_peg_parse_failure(status_code: int, error_text: str) -> bool:
    """Detect Gemma 4's PEG-parser failure on tool-turn output.

    llama-server returns HTTP 500 with `failed to parse grammar` /
    `Failed to parse input at pos N: <|tool_call>call:...` when the model
    emits an incomplete tool call (missing required schema fields) under
    tool_choice='required'. The PEG grammar enforces the schema strictly
    and rejects the partial output. Caller should retry with relaxed
    tool_choice='auto' so the model can emit prose or a complete call
    without grammar enforcement triggering this failure mode.
    """
    if status_code != 500:
        return False
    text = error_text or ""
    return (
        "Failed to parse input at pos" in text
        or "<|tool_call>call:" in text
    )


def _relax_tool_choice_for_gemma4_peg_retry(request_body: dict, source: str) -> bool:
    """When a Gemma 4 PEG parse failure is detected on a tool turn, drop
    tool_choice='required' so the retry has a permissive grammar. Returns
    True if the body was modified (caller should retry POST)."""
    if not request_body.get("tools"):
        return False
    current = request_body.get("tool_choice")
    if current in ("required", {"type": "any"}):
        request_body["tool_choice"] = "auto"
        logger.warning(
            "GEMMA4 PEG RETRY (%s): relaxed tool_choice='required' -> 'auto' "
            "to bypass strict-grammar parse failure on incomplete model output",
            source,
        )
        return True
    return False


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
    sandboxed: bool = False  # True when the client is a `uap sandbox` (bwrap) session (X-Uap-Sandbox header)
    total_requests: int = 0
    last_input_tokens: int = 0  # Estimated input tokens of last request
    last_output_tokens: int = 0  # Actual output tokens of last response
    peak_input_tokens: int = 0  # High-water mark
    # Fix B: the incoming (pre-prune) token count for the current request. The
    # proxy prunes the conversation and then calls record_request() again with
    # the post-prune total, so last_input_tokens / get_utilization() reflect the
    # *pruned* size (~30%) by the time the tool_choice guards run — masking the
    # fact that the client just sent e.g. 800% of the window. This preserves the
    # raw size so LOOP BREAKER pattern 3 can release on real context blow-up.
    pre_prune_input_tokens: int = 0
    prune_count: int = 0  # How many times pruning was triggered
    overflow_count: int = 0  # How many context overflow errors caught
    prune_drop_count: int = 0  # monotonic: # of oldest middle msgs pruned (B3)
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
    consecutive_no_write_turns: int = 0  # turns exploring with no write tool (B1)
    recon_hard_fires: int = 0  # Fix E: monotonic count of recon hard-tier firings
    catastrophic_ctx_streak: int = 0  # Fix F: consecutive turns raw ctx >= finalize ratio
    unexpected_end_turn_count: int = 0  # end_turn without tool_use in active loop
    self_stuck_streak: int = 0  # consecutive assistant texts self-reporting a loop
    error_signature_streak: int = 0  # consecutive turns with the SAME tool_result error
    last_error_signature: str = ""  # normalized signature of that recurring error
    error_loop_fires: int = 0  # telemetry: error-loop nudges injected
    empty_maxtokens_recoveries: int = 0  # telemetry: thinking-runaway recoveries
    rate_limited_api_streak: int = 0  # consecutive tool calls hitting a rate-limited API host
    stuck_break_fires: int = 0  # monotonic count of forced stuck-breaks
    deferral_streak: int = 0  # consecutive no-tool turns deferring the work (Fix A)
    deferral_break_fires: int = 0  # monotonic count of forced deferral-breaks (Fix A)
    mandate_deliver_fires: int = 0  # monotonic count of forced deliver-routings (mandate)
    tool_starvation_streak: int = 0  # Consecutive forced turns with no tool_calls produced
    last_request_msg_count: int = 0  # Message count of the previous request (compaction-boundary detection)
    malformed_tool_streak: int = 0  # consecutive malformed pseudo tool payloads
    invalid_tool_call_streak: int = 0  # consecutive invalid tool arg payloads
    required_tool_miss_streak: int = 0  # required tool turns with no tool call
    contamination_resets: int = 0  # how many contamination resets were applied
    last_fault_excerpt_hash: str = ""  # hash of last TOOL RESPONSE ISSUE excerpt (attractor detection)
    attractor_correction_active: bool = False  # next turn uses high-temp escape sampling
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
    coordination_repeat_streak: int = 0  # R4: consecutive identical coordination-tool calls
    last_coordination_fp: str = ""       # R4: fingerprint of the last coordination call
    session_banned_tools: set = field(default_factory=set)  # tools banned for entire session after repeated cycling
    tool_cycle_counts: dict = field(default_factory=dict)  # {tool_name: cycle_count} across resets
    last_response_garbled: bool = False  # previous turn had garbled/malformed output
    finalize_turn_active: bool = False
    # Set True for the single turn on which a hard finalize breaker (TURN-COUNT
    # or CONTAMINATION LOOP) strips tools to force a terminal text-only end_turn.
    # Suppresses response-side prose->tool_call resurrection so a contaminated
    # model emitting `<function=...>`/`<tool_call>` prose does not get it promoted
    # back into a structured tool_use, which would continue the very loop the
    # breaker is ending. Reset to False at the start of every request.
    suppress_text_tool_extraction: bool = False
    # Tool-turn count at which the TURN-COUNT FINALIZE BREAKER last fired. The
    # count is derived from the (only-growing) conversation, so without this the
    # breaker would re-fire on EVERY turn once the ceiling is first crossed —
    # permanently stripping tools and stalling a legitimately long agentic task.
    # Gating on (last + ceiling) makes it a PERIODIC nudge (80, 160, 240, ...)
    # with tools restored in between, so long tasks complete while a true runaway
    # still gets bounded (and the contamination/prune/cycle breakers catch faster).
    last_hard_finalize_turn_count: int = 0
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

    def get_raw_utilization(self) -> float:
        """Pre-prune context utilization for the current request (Fix B).

        Reflects what the client actually sent this turn, before the proxy
        pruned it. Used by the loop breaker so a runaway client that resends
        800% of the window each turn is detected even though post-prune
        utilization reads ~30%. Returns 0.0 until the first request is recorded.
        """
        if self.context_window <= 0:
            return 0.0
        return self.pre_prune_input_tokens / self.context_window

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
            # WARNING, not ERROR: critical context utilization is a *handled*
            # condition — the proxy force-prunes and the session continues.
            # Logging it at ERROR floods the error stream (100+/2h for a few
            # context-saturated agentic sessions) and drowns genuine failures.
            # CONTEXT HIGH below is already WARNING; this keeps parity.
            logger.warning(
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

        # R4: early coordination-loop ban (independent of the active-loop cycle
        # detector). A coordination/bookkeeping tool repeated with IDENTICAL args
        # is never productive; ban it directly so narrowing drops it next turn,
        # breaking the "create a task ABOUT X instead of doing X" loop.
        coord_names = [n for n in (tool_names or []) if n in PROXY_COORDINATION_TOOLS]
        if fp and coord_names and fp == self.last_coordination_fp:
            self.coordination_repeat_streak += 1
        elif coord_names:
            self.coordination_repeat_streak = 1
            self.last_coordination_fp = fp
        else:
            self.coordination_repeat_streak = 0
            self.last_coordination_fp = ""
        if (
            PROXY_COORDINATION_EARLY_BAN > 0
            and self.coordination_repeat_streak >= PROXY_COORDINATION_EARLY_BAN
        ):
            for n in coord_names:
                if n not in self.session_banned_tools:
                    self.session_banned_tools.add(n)
                    logger.warning(
                        "TOOL BAN (R4 early): '%s' banned after %d consecutive "
                        "identical coordination calls",
                        n,
                        self.coordination_repeat_streak,
                    )

        # Recon-convergence (B1): count consecutive turns that use tools but
        # produce NO write/deliverable tool call. A turn that uses any write
        # tool resets the streak — that's the model converging from
        # exploration toward synthesis/output. A turn with no tool calls at
        # all is a plain-text turn (neither exploration nor a write) and
        # leaves the streak unchanged. This is the inverse of the old
        # "all tools are recognized read-only" test, which reset on any
        # Bash/WebFetch/Agent turn and so never accumulated for real agents.
        if tool_names:
            if any(n.lower() in _WRITE_TOOL_CLASS for n in tool_names):
                self.consecutive_no_write_turns = 0
            else:
                self.consecutive_no_write_turns += 1

        # Track read-only tool targets for dedup (Option 3)
        if tool_targets:
            for name, target in tool_targets.items():
                if name.lower() in {n.lower() for n in _READ_ONLY_TOOL_CLASS} and target:
                    by_tool = self.tool_target_history.setdefault(name, {})
                    by_tool[target] = by_tool.get(target, 0) + 1

    def note_tool_result_error(self, latest_result_text: str) -> None:
        """Track a repeated tool_result error signature (ERROR-LOOP guardrail).

        Same normalized error as last turn -> increment the streak; a new error
        or a clean (error-free) result -> reset. Only a SUSTAINED same-failure
        streak (despite the model's varied edits) trips the nudge."""
        if not PROXY_ERROR_LOOP:
            return
        sig = _error_signature(latest_result_text or "")
        if sig and sig == self.last_error_signature:
            self.error_signature_streak += 1
        elif sig:
            self.error_signature_streak = 1
            self.last_error_signature = sig
        else:
            self.error_signature_streak = 0
            self.last_error_signature = ""

    def note_assistant_text(self, text: str) -> None:
        """Track the model self-reporting that it is stuck (STUCK-BREAK signal
        (a)). A matching turn increments the streak; a non-matching turn resets
        it, so only SUSTAINED self-reported looping trips the break."""
        if not PROXY_STUCK_BREAK or not text:
            self.self_stuck_streak = 0
            return
        if _STUCK_PHRASE_RE.search(text):
            self.self_stuck_streak += 1
        else:
            self.self_stuck_streak = 0

    def note_tool_arg_hosts(self, arg_blobs: list) -> None:
        """Track repeated tool calls into a rate-limited API host (STUCK-BREAK
        signal (b)). Reset when a turn uses none, so only a sustained wrong-
        channel loop trips the hint."""
        if not PROXY_STUCK_BREAK:
            return
        blob = " ".join(a for a in arg_blobs if isinstance(a, str))
        if _RATE_LIMITED_API_RE.search(blob):
            self.rate_limited_api_streak += 1
        else:
            self.rate_limited_api_streak = 0

    def should_force_stuck_break(self) -> tuple[bool, str]:
        """True + reason when a terminal break should be forced this turn."""
        if not PROXY_STUCK_BREAK:
            return False, ""
        if self.self_stuck_streak >= PROXY_STUCK_TEXT_THRESHOLD:
            return True, f"self-reported stuck x{self.self_stuck_streak}"
        if self.rate_limited_api_streak >= PROXY_STUCK_API_THRESHOLD:
            return True, f"rate-limited-API retries x{self.rate_limited_api_streak}"
        return False, ""

    def note_deferral_signal(self, text: str, had_tool_call: bool) -> None:
        """Track a turn-ending deferral/capitulation stall (Fix A): a plain-text
        assistant turn with NO tool call that asks for more cycles / more
        exploration / permission to keep going instead of taking the next build
        action. Only a no-tool turn whose text matches the deferral phrasing
        increments the streak; ANY tool call or non-matching text resets it, so a
        model that actually acts (or writes a normal summary) is never flagged."""
        if not PROXY_DEFERRAL_BREAK:
            self.deferral_streak = 0
            return
        if (not had_tool_call) and text and _DEFERRAL_PHRASE_RE.search(text):
            self.deferral_streak += 1
        else:
            self.deferral_streak = 0

    def should_force_deferral_break(self) -> tuple[bool, str]:
        """True + reason when a deferral-break should be forced this turn."""
        if not PROXY_DEFERRAL_BREAK:
            return False, ""
        if self.deferral_streak >= PROXY_DEFERRAL_THRESHOLD:
            return True, f"deferral/plan-capitulation x{self.deferral_streak}"
        return False, ""

    def recon_convergence_pending(self) -> bool:
        """True when recon-convergence will own this turn. DEFERRAL-BREAK yields
        to it (as it does to STUCK-BREAK) so the two guards never emit
        contradictory tool_choice/directives in the same request. Fix B makes
        their triggers climb in lockstep on prose-only stalls, so without this
        yield a deep prose stall could trip both and undo recon's terminal tier
        (which may strip tools and force a plain-text summary that ends the task)."""
        return (
            PROXY_RECON_CONVERGENCE_THRESHOLD > 0
            and self.consecutive_no_write_turns >= PROXY_RECON_CONVERGENCE_THRESHOLD
        )

    def note_no_tool_turn(self) -> None:
        """Fix B: a plain-text assistant turn with no tool call is still a
        non-write turn, so advance the recon-convergence streak. The old code
        only moved `consecutive_no_write_turns` on turns that emitted tool calls,
        so a model that stalls in prose (no tools at all) froze the counter and
        never escalated to the recon-convergence directive. Resets, like the
        tool-turn path, whenever a write tool is later emitted."""
        self.consecutive_no_write_turns += 1

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

        # Pattern 2b (Fix D): streak-independent forced-count ceiling. In an
        # agentic loop no_progress_streak resets every turn (tool_result always
        # present), so Pattern 2 never fires. consecutive_forced_count, however,
        # accumulates across the loop. Release once it crosses the hard ceiling
        # regardless of no_progress_streak so the model can terminate.
        if (
            PROXY_FORCED_HARD_RELEASE > 0
            and self.consecutive_forced_count >= PROXY_FORCED_HARD_RELEASE
        ):
            logger.warning(
                "LOOP BREAKER: %d consecutive forced tool_choice requests (hard ceiling %d) -- "
                "releasing to 'auto' regardless of progress streak.",
                self.consecutive_forced_count,
                PROXY_FORCED_HARD_RELEASE,
            )
            self.loop_warnings_emitted += 1
            return True

        # Pattern 3: Context almost full -- let model wrap up naturally.
        # Fix B: check BOTH post-prune utilization and the raw pre-prune size.
        # The proxy prunes before this runs, so get_utilization() reads ~30%
        # even when the client just sent 800% of the window; get_raw_utilization()
        # exposes the real blow-up so a runaway client is actually released.
        eff_util = max(self.get_utilization(), self.get_raw_utilization())
        if eff_util >= PROXY_CONTEXT_RELEASE_THRESHOLD:
            logger.warning(
                "LOOP BREAKER: Context utilization %.1f%% (post-prune %.1f%%, raw %.1f%%) -- "
                "releasing tool_choice to let model wrap up.",
                eff_util * 100,
                self.get_utilization() * 100,
                self.get_raw_utilization() * 100,
            )
            return True

        return False


session_monitors: dict[str, SessionMonitor] = {}
default_context_window = 0
last_session_id = ""
_last_ctx_recheck_ts: float = 0.0
_CTX_RECHECK_INTERVAL: float = 60.0  # Re-detect context window every 60s

# ── Vision (multimodal) support ──────────────────────────────────────────────
# The upstream llama-server advertises image support in /props
# (modalities.vision: true when launched with --mmproj). When available, the
# proxy passes Anthropic `image` content blocks through to the model as
# OpenAI image_url data-URI parts, so coding agents can visually check their
# outputs (screenshots, rendered pages). PROXY_VISION=auto probes and
# self-configures per upstream; on/off force it.
PROXY_VISION = os.environ.get("PROXY_VISION", "auto").strip().lower()
# Rough per-image token cost for context accounting (Qwen-VL-class encoders
# land in the hundreds-to-~1k range per image at typical screenshot sizes).
PROXY_IMAGE_TOKEN_ESTIMATE = int(os.environ.get("PROXY_IMAGE_TOKEN_ESTIMATE", "800"))
upstream_vision: bool = False
_last_vision_recheck_ts: float = 0.0
_VISION_RECHECK_INTERVAL: float = 60.0


def vision_enabled() -> bool:
    if PROXY_VISION == "on":
        return True
    if PROXY_VISION == "off":
        return False
    return upstream_vision


async def _maybe_recheck_vision() -> None:
    """Periodically re-probe upstream /props for vision support (auto mode).

    Handles server restarts that add/remove --mmproj mid-session. Non-blocking:
    skips inside the check interval; failures keep the last known value.
    """
    global upstream_vision, _last_vision_recheck_ts
    if PROXY_VISION != "auto":
        return
    now = time.time()
    if now - _last_vision_recheck_ts < _VISION_RECHECK_INTERVAL:
        return
    _last_vision_recheck_ts = now
    if http_client is None:
        return
    try:
        props_url = LLAMA_CPP_BASE.replace("/v1", "/props")
        resp = await http_client.get(props_url, timeout=2.0)
        if resp.status_code == 200:
            modalities = (resp.json() or {}).get("modalities") or {}
            detected = bool(modalities.get("vision"))
            if detected != upstream_vision:
                logger.warning(
                    "VISION: upstream modalities.vision=%s — image passthrough %s",
                    detected, "ENABLED" if detected else "DISABLED",
                )
                upstream_vision = detected
    except Exception:
        pass  # Non-critical; retry next interval


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
                    inner = block.get("content")
                    if isinstance(inner, list):
                        tokens += PROXY_IMAGE_TOKEN_ESTIMATE * sum(
                            1 for b in inner if isinstance(b, dict) and b.get("type") == "image"
                        )
                elif block.get("type") == "image":
                    tokens += PROXY_IMAGE_TOKEN_ESTIMATE
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


# Max tool-result breadcrumbs listed in a prune summary (B2). Bounds the
# summary size — beyond this the oldest breadcrumbs are elided.
_PRUNE_SUMMARY_MAX_ITEMS = int(os.environ.get("PROXY_PRUNE_SUMMARY_MAX_ITEMS", "30"))


def _summarize_pruned_block(dropped: list[dict]) -> str:
    """Build a compact breadcrumb summary of pruned messages (B2).

    Instead of discarding dropped tool-results outright, leave a one-line
    trace of each so the agent retains *what it already found*. A recon
    agent that can still see "I read auth_handler.cpp — JWT validation in
    validateToken()" is far likelier to converge to a synthesis than one
    whose findings vanished entirely and which therefore re-explores.

    Heuristic only — no LLM call. Bounded to the most recent
    PROXY_PRUNE_SUMMARY_MAX_ITEMS tool-result breadcrumbs so the summary
    itself cannot grow unbounded.
    """
    breadcrumbs: list[str] = []
    for msg in dropped:
        content = msg.get("content", [])
        if not isinstance(content, list):
            continue
        for block in content:
            if isinstance(block, dict) and block.get("type") == "tool_result":
                text = _extract_text(block.get("content", "")).strip()
                if not text:
                    continue
                excerpt = " ".join(text.split())[:100]
                breadcrumbs.append(
                    f"- tool result (~{estimate_tokens(text)} tok): {excerpt}"
                )
    if not breadcrumbs:
        return (
            "[CONTEXT PRUNED: older messages were removed to fit the context "
            "window. The conversation continues from recent context below.]"
        )
    total = len(breadcrumbs)
    if total > _PRUNE_SUMMARY_MAX_ITEMS:
        breadcrumbs = breadcrumbs[-_PRUNE_SUMMARY_MAX_ITEMS:]
    header = (
        f"[CONTEXT PRUNED — {len(dropped)} older messages removed to fit the "
        "context window. Breadcrumbs of earlier findings"
    )
    if total > len(breadcrumbs):
        header += f" (most recent {len(breadcrumbs)} of {total} tool results)"
    header += " — rely on these instead of re-reading those files:]"
    return header + "\n" + "\n".join(breadcrumbs)


def _truncate_oversized_message_content(messages: list, budget_tokens: int) -> bool:
    """Truncate the largest message content in-place until the total fits
    budget_tokens. Used when message-DROPPING cannot reduce below the window —
    e.g. Claude Code's auto-compact sends a single `<transcript>` message LARGER
    than the whole context window, so keeping even the last 2 messages overflows
    and the pruner would otherwise thrash (prune -> still >100% -> retry).

    Truncatable content = plain-string content, `text` blocks, and `tool_result`
    blocks. Each truncated block keeps a head+tail slice (70/30) around a marker
    so a summarization request still sees the start and end. Returns True if it
    got the total under budget, False if nothing left worth truncating.
    """
    MARKER = "\n...[TRUNCATED FOR CONTEXT WINDOW]...\n"

    def _texts(msg):
        # yield (kind, block_or_None, text) for each truncatable content in msg
        content = msg.get("content", "")
        if isinstance(content, str):
            yield ("str", None, content)
        elif isinstance(content, list):
            for block in content:
                if isinstance(block, dict):
                    if block.get("type") == "text":
                        yield ("text", block, block.get("text", "") or "")
                    elif block.get("type") == "tool_result":
                        yield ("tool_result", block, _extract_text(block.get("content", "")))

    for _ in range(40):  # bounded: each pass truncates the single largest block
        total = sum(estimate_message_tokens(m) for m in messages)
        if total <= budget_tokens:
            return True
        biggest = None  # (len, msg, kind, block, text)
        for msg in messages:
            for kind, block, text in _texts(msg):
                if biggest is None or len(text) > biggest[0]:
                    biggest = (len(text), msg, kind, block, text)
        if biggest is None or biggest[0] < 400:
            return False  # nothing left worth truncating
        _, msg, kind, block, text = biggest
        excess_tokens = total - budget_tokens
        cut_chars = int(excess_tokens * CHARS_PER_TOKEN) + len(MARKER) + 512
        keep = max(400, len(text) - cut_chars)
        head = int(keep * 0.7)
        tail = keep - head
        new_text = text[:head] + MARKER + (text[-tail:] if tail > 0 else "")
        if kind == "str":
            msg["content"] = new_text
        elif kind == "text":
            block["text"] = new_text
        elif kind == "tool_result":
            block["content"] = new_text
    return sum(estimate_message_tokens(m) for m in messages) <= budget_tokens


def prune_conversation(
    anthropic_body: dict,
    context_window: int,
    monitor: "SessionMonitor | None" = None,
    target_fraction: float = 0.65,
    keep_last: int = 8,
) -> dict:
    """Prune the conversation to fit within the context window.

    Strategy (reworked — UAP PR #186):
    - Always keep: system prompt, first user message, last N messages.
    - Drop a CONTIGUOUS block of the oldest middle messages. The drop
      count is persisted per-session on the monitor (`prune_drop_count`)
      and is monotonic — it only ever grows. This keeps the retained
      region a stable recent *suffix*: on turns where the boundary does
      not advance, the upstream KV-cache prefix stays valid and the turn
      is not reprocessed. (The previous priority-greedy keep was
      non-contiguous and reshuffled the prompt mid-stream every turn,
      defeating the cache.)
    - Replace the dropped block with a breadcrumb summary (see
      _summarize_pruned_block) so the agent keeps its earlier findings.

    Args:
        anthropic_body: The full Anthropic request body
        context_window: Maximum context window in tokens
        monitor: SessionMonitor — carries the monotonic prune boundary.
            When None, pruning still works but is non-monotonic per call.
        target_fraction: Target utilization after pruning (0.0-1.0)
        keep_last: Number of recent messages to always keep (default 8)

    Returns:
        Modified anthropic_body with pruned messages
    """
    messages = anthropic_body.get("messages", [])
    if len(messages) <= 4:
        # Too few messages to prune by DROPPING — but a single message can still
        # exceed the whole window (Claude Code's auto-compact sends a
        # `<transcript>` larger than the context window). Message-dropping can't
        # help and returning as-is wedges the request in a prune->still-over->
        # retry loop, so truncate the oversized content in-place to fit.
        if messages and estimate_total_tokens(anthropic_body) > context_window:
            budget = max(1, int(context_window * target_fraction))
            logger.warning(
                "Few-message request (%d msgs) exceeds window %d -- truncating oversized content to fit",
                len(messages),
                context_window,
            )
            _truncate_oversized_message_content(messages, budget)
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
        # Tool-heavy clients (observed: 37 MCP tools whose schema estimate x1.5
        # safety factor exceeds the whole 40% critical-prune target) used to
        # ERROR-RETURN here with the body untouched — no pruning at all, so the
        # session pinned at 115%+, Option E clamped every output to 1024 tokens,
        # and all substantial writes truncated forever (24+ consecutive no-op
        # prunes + circuit breaker every turn). The schemas are client-fixed
        # and non-droppable; give MESSAGES a minimal floor and prune into it
        # best-effort instead of giving up.
        message_budget = max(1, int(context_window * 0.20))
        # The condition is PERMANENT for a tool-heavy client (fires per
        # request, observed every ~2s) — warn once per session, then debug.
        already = bool(monitor is not None and getattr(monitor, "floor_budget_logged", False))
        log = logger.debug if already else logger.warning
        if monitor is not None:
            monitor.floor_budget_logged = True
        log(
            "System+tools overhead (~%d est tokens) consumes the %.0f%% prune "
            "target — pruning messages into a floor budget of %d tokens instead",
            overhead_tokens,
            target_fraction * 100,
            message_budget,
        )

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
        # Even the protected (undroppable) messages exceed budget. Message-
        # dropping can't help, so truncate the largest content in-place to fit.
        # Covers tool_result AND oversized user/text messages (the auto-compact
        # <transcript> larger than the whole window) — the tool_result-only
        # version left such a message intact, so pruning never converged and the
        # request wedged in a prune->still-over->retry loop.
        logger.warning(
            "Protected messages (%d tokens) exceed budget (%d) -- truncating oversized content",
            protected_tokens,
            message_budget,
        )
        protected = protected_head + protected_tail
        fit = _truncate_oversized_message_content(protected, message_budget)
        if not fit:
            logger.warning(
                "Post-truncation still over budget (%d msgs) -- forwarding truncated best-effort",
                len(protected),
            )
        anthropic_body["messages"] = protected
        return anthropic_body

    remaining_budget = message_budget - protected_tokens

    # --- Monotonic contiguous prune boundary (cache-stable, B3) ---
    # Drop the oldest `drop_count` middle messages as one contiguous block.
    # Seed from the monitor's persisted boundary; advance it only as far as
    # the budget forces. Persist back monotonically so a later/looser prune
    # in the same turn can't shrink it (which would reshuffle the prompt).
    drop_count = 0
    if monitor is not None:
        drop_count = min(max(0, monitor.prune_drop_count), len(middle))
    while drop_count < len(middle):
        kept_tokens = sum(estimate_message_tokens(m) for m in middle[drop_count:])
        if kept_tokens <= remaining_budget:
            break
        drop_count += 1
    if monitor is not None:
        monitor.prune_drop_count = max(monitor.prune_drop_count, drop_count)

    dropped = middle[:drop_count]
    kept_msgs = middle[drop_count:]

    if dropped:
        # Replace the dropped block with a findings-breadcrumb summary (B2),
        # PLUS a state-carryover (plan + files ALREADY WRITTEN) reconstructed
        # from the full pre-prune conversation. The breadcrumb only captures
        # tool_result *reads*; it never captures the assistant's own write
        # actions, so on a long build the pruner drops the write-history and the
        # model forgets what it created — then re-reads/re-creates its own files
        # (observed live: `cat lib.rs` ×16 at ctx 140% on a 3-day session). The
        # carryover keeps "you already wrote X — don't redo it" across the drop.
        # (#2 companion: the contamination breaker already carries this; the
        # pruner is the HIGHER-frequency state-dropper on huge sessions, so the
        # carryover matters most here.)
        carry = _extract_state_carryover(messages)
        marker_content = _summarize_pruned_block(dropped)
        if carry:
            marker_content = f"{carry}\n\n{marker_content}"
        prune_marker = {
            "role": "user",
            "content": marker_content,
        }
        anthropic_body["messages"] = (
            protected_head + [prune_marker] + kept_msgs + protected_tail
        )
        logger.warning(
            "PRUNED: dropped %d oldest middle messages (boundary=%d), "
            "kept %d total, target=%.0f%% of %d ctx",
            len(dropped),
            drop_count,
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
_last_pool_reset_ts: float = 0.0

# Transient upstream failures that are safe to retry (a fresh POST re-runs
# the request). Single source of truth — used by BOTH the buffered
# _post_with_retry_inner AND the streaming send loop, which previously had
# divergent copies (the streaming copy lacked ReadError, so a mid-setup
# connection reset on a streamed turn 500'd; live 2026-07-11).
_UPSTREAM_RETRY_EXCEPTIONS = (
    httpx.ConnectError,
    httpx.ConnectTimeout,
    httpx.RemoteProtocolError,
    httpx.ReadTimeout,
    httpx.ReadError,
    httpx.WriteError,
)


def _upstream_port() -> int:
    """The upstream (llama) TCP port, for CLOSE-WAIT accounting."""
    try:
        return int(LLAMA_CPP_BASE.rsplit(":", 1)[1].split("/")[0])
    except Exception:
        return 8080


def _count_upstream_close_wait() -> int:
    """Count CLOSE-WAIT sockets to the upstream port via /proc/net/tcp.

    Cheap (one file read), no subprocess. TCP state 08 == CLOSE_WAIT; the
    remote port is hex in the 3rd column's ':PORT' suffix.
    """
    port_hex = f"{_upstream_port():04X}"
    n = 0
    try:
        with open("/proc/net/tcp", "r") as fh:
            next(fh, None)
            for line in fh:
                parts = line.split()
                if len(parts) < 4:
                    continue
                if parts[3] == "08" and parts[2].endswith(":" + port_hex):
                    n += 1
    except Exception:
        return 0
    return n


async def _closewait_reaper() -> None:
    """Periodic: reap abandoned upstream CLOSE-WAIT connections.

    When they exceed the threshold, replace the pool (safe self-heal) — the
    retired pool's aclose (once its legit in-flight drains) force-closes the
    abandoned connections, which have no in-flight coroutine of their own.
    """
    if PROXY_CLOSEWAIT_REAP_INTERVAL <= 0:
        return
    while True:
        try:
            await asyncio.sleep(PROXY_CLOSEWAIT_REAP_INTERVAL)
            cw = _count_upstream_close_wait()
            if cw >= PROXY_CLOSEWAIT_REAP_THRESHOLD:
                _maybe_reset_http_client(f"CLOSE-WAIT reaper ({cw} abandoned upstream connections)")
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.warning("CLOSE-WAIT reaper error: %s", exc)


def _inflight_inc(client) -> None:
    try:
        client._uap_inflight += 1
    except Exception:
        pass


def _inflight_dec(client) -> None:
    try:
        client._uap_inflight -= 1
    except Exception:
        pass


def _detach_aclose(closeable) -> None:
    """Close an upstream stream/response on a DETACHED task so it completes
    even when the requesting ASGI task is being cancelled (client disconnect).
    An in-line ``await x.aclose()`` in a streaming finally can itself be
    cancelled before it closes the socket, leaking the upstream connection —
    it accrues as CLOSE-WAIT and eventually saturates the pool (live
    2026-07-11: CW climbed 26→52 with zero client errors after the cascade was
    fixed). ensure_future schedules the close independently of the dying task.
    """
    async def _run() -> None:
        try:
            await closeable.aclose()
        except Exception:
            pass
    try:
        asyncio.ensure_future(_run())
    except RuntimeError:
        pass  # no running loop — nothing to detach onto


def _build_http_client() -> httpx.AsyncClient:
    """Upstream client factory — used at startup AND by pool self-healing."""
    c = httpx.AsyncClient(
        timeout=httpx.Timeout(
            connect=10.0,  # 10s to establish connection
            read=PROXY_READ_TIMEOUT,  # configurable (default 10 min)
            write=30.0,  # 30s to send the request body
            pool=10.0,  # 10s to acquire a pool connection
        ),
        limits=httpx.Limits(
            max_connections=PROXY_MAX_CONNECTIONS,
            # No upstream keepalive: llama.cpp closes idle keepalive
            # connections faster than a 120s expiry, so they piled as
            # CLOSE-WAIT and exhausted the pool (live: 51 zombies, PoolTimeout
            # 500-storm). The upstream is localhost at low concurrency —
            # connection reuse saves microseconds and is not worth the leak
            # class. Each request opens and cleanly closes its own connection.
            max_keepalive_connections=0,
            keepalive_expiry=0,
        ),
    )
    # Per-CLIENT in-flight counter: a retired pool must drain on ITS OWN
    # requests (a global counter can't isolate it — new-pool traffic keeps a
    # global high, so the retire waited the full backstop and never reaped;
    # live 2026-07-11: reaper fired 7x, CLOSE-WAIT still climbed 30→50).
    c._uap_inflight = 0  # type: ignore[attr-defined]
    return c


def _maybe_reset_http_client(reason: str) -> bool:
    """Pool self-healing: swap in a fresh AsyncClient, retiring the old one.

    Rare cancellation races (asyncio.wait_for cutting an httpx send mid-
    response — the guarded non-stream path every tool turn uses) leak
    connections the pool counts as busy forever; observed live as 12
    CLOSE-WAIT zombies out of a 20-connection pool and a 205-request
    PoolTimeout 500-storm. There is no public API to reap them, so on
    saturation we REPLACE the client: new requests get a fresh pool
    immediately (handlers snapshot the global per request), in-flight
    requests finish on the old object, which is closed after a grace period.
    Cooldown-guarded so a burst cannot thrash clients.
    """
    global http_client, _last_pool_reset_ts
    now = time.time()
    if now - _last_pool_reset_ts < 60:
        return False
    if http_client is None:
        return False
    _last_pool_reset_ts = now
    old_client = http_client
    http_client = _build_http_client()
    logger.error(
        "POOL SELF-HEAL: replaced upstream connection pool (%s); old pool closes after grace period",
        reason,
    )

    async def _retire() -> None:
        # Close the old pool once ITS OWN in-flight requests (per-client
        # counter — streaming + buffered) drain to zero: no live request
        # remains on the old client, so aclose() force-closes only its
        # ABANDONED CLOSE-WAIT connections and never a live stream. Capped at
        # GENERATION_TIMEOUT as a backstop.
        deadline = time.time() + max(60.0, PROXY_GENERATION_TIMEOUT)
        while time.time() < deadline and getattr(old_client, "_uap_inflight", 0) > 0:
            await asyncio.sleep(1.0)
        try:
            await old_client.aclose()
        except Exception:
            pass

    asyncio.ensure_future(_retire())
    return True

# ---------------------------------------------------------------------------
# Concurrency Control
# ---------------------------------------------------------------------------
# Semaphore to serialize upstream requests. llama.cpp is configured with
# --parallel 1 (LLAMA_PARALLEL=1), so it can only process one inference at
# a time. Without this gate, concurrent client requests (Shannon sub-agents,
# multiple Claude Code sessions) would all hit llama.cpp at once and the
# server would serialize them while the proxy holds N httpx connections
# open — potentially exhausting the proxy's connection pool while requests
# queue inside llama.cpp opaquely.
#
# With the semaphore: requests queue inside the proxy (cheap, just asyncio
# tasks waiting) and only PROXY_CONCURRENCY_LIMIT at a time reaches
# llama.cpp. Each httpx connection is held only for the actual inference
# duration, not the queue wait.
#
# Default: 1 (matches LLAMA_PARALLEL=1). Increase if you raise --parallel.
PROXY_CONCURRENCY_LIMIT = int(os.environ.get("PROXY_CONCURRENCY_LIMIT", "1"))
# Max time to wait for a slot before returning 503. Generous because real
# inference can take 30-600s and queued requests must wait through that.
# 0 = wait indefinitely.
PROXY_CONCURRENCY_QUEUE_TIMEOUT = float(
    os.environ.get("PROXY_CONCURRENCY_QUEUE_TIMEOUT", "900")
)
upstream_semaphore: asyncio.Semaphore | None = None


# ---------------------------------------------------------------------------
# Session admission control — cap the number of DISTINCT "hot" sessions
# ---------------------------------------------------------------------------
# The semaphore above limits CONCURRENT REQUESTS. On a multi-slot llama.cpp
# (--parallel N) llama's native prompt-cache keeps each session on its own slot
# across turns — but only N slots exist. When MORE than N distinct sessions are
# active, a returning session finds its slot reassigned to another session, its
# KV gone, forcing a from-scratch reprocess of the whole context (brutal on an
# SSM/Mamba model, which cannot restore partial KV: every eviction is a full
# prefill). The per-request semaphore can't prevent this — it lets session A
# finish + release, then admits session E, which evicts A's slot.
#
# Session admission caps the number of DISTINCT sessions holding a slot at once.
# A new session over the limit WAITS (queues) until an admitted session goes
# idle (no request for IDLE_TTL) and is pruned, instead of barging in and
# evicting a hot session. Admission is STICKY across a session's turns; it is
# released only by idle-TTL expiry (or, under sustained over-subscription, a
# wait-timeout graceful-degrade that force-admits, evicting the LRU). Default
# OFF — opt in via PROXY_SESSION_ADMISSION=on (set the LIMIT to the llama slot
# count / --parallel value).
PROXY_SESSION_ADMISSION = os.environ.get(
    "PROXY_SESSION_ADMISSION", "off"
).lower() not in {"", "0", "off", "false", "no"}
# Max distinct hot sessions. Default = the concurrency limit (= llama slots).
PROXY_SESSION_ADMISSION_LIMIT = int(
    os.environ.get("PROXY_SESSION_ADMISSION_LIMIT", str(PROXY_CONCURRENCY_LIMIT))
)
# Seconds a session may be idle (no request) before its admission is pruned,
# freeing a slot for a waiting session. Tune ABOVE typical inter-turn gaps so an
# actively-working session is never pruned mid-task. 0 = never prune on idle.
PROXY_SESSION_ADMISSION_IDLE_TTL = float(
    os.environ.get("PROXY_SESSION_ADMISSION_IDLE_TTL", "90")
)
# Max seconds a new session waits for admission before graceful-degrade
# (force-admit, evicting the LRU admitted session). 0 = wait indefinitely.
PROXY_SESSION_ADMISSION_WAIT_TIMEOUT = float(
    os.environ.get("PROXY_SESSION_ADMISSION_WAIT_TIMEOUT", "300")
)
# How often a waiter re-checks for a freed slot (re-prunes idle admissions).
PROXY_SESSION_ADMISSION_POLL = float(
    os.environ.get("PROXY_SESSION_ADMISSION_POLL", "3")
)


# ---------------------------------------------------------------------------
# Slot save/restore — cross-session KV-cache preservation
# ---------------------------------------------------------------------------
# llama.cpp runs --parallel 1 (a single slot). When N distinct client
# sessions multiplex onto that slot, each session switch evicts the prior
# session's KV cache: the incoming request shares only the ~32-token
# chat-template header, so llama-server force-reprocesses the entire prompt
# (observed: ~17% of requests, 60-96s of prompt eval each).
#
# When PROXY_SLOT_SAVE_RESTORE is on, the proxy saves the outgoing session's
# slot KV state to disk and restores the incoming session's state on a
# switch, via llama-server's /slots/{id}?action=save|restore API (requires
# the server to be launched with --slot-save-path). A restore reads
# ~150-940 MiB from disk (~1-3s) instead of a 60-96s full recompute.
#
# Default OFF — opt in per-deployment via PROXY_SLOT_SAVE_RESTORE=on.
PROXY_SLOT_SAVE_RESTORE = os.environ.get(
    "PROXY_SLOT_SAVE_RESTORE", "off"
).lower() not in {"", "0", "off", "false", "no"}
# Directory the proxy uses for its own LRU bookkeeping + startup cleanup.
# MUST match the llama-server --slot-save-path value: the server resolves
# the filename the proxy sends relative to its own --slot-save-path.
PROXY_SLOT_SAVE_DIR = os.environ.get(
    "PROXY_SLOT_SAVE_DIR", "/home/cogtek/.cache/uap/llama-slots"
)
# Max saved slot files kept on disk; least-recently-used files are evicted
# beyond this. Each file can be ~1 GiB for a 100k-token session.
PROXY_SLOT_CACHE_MAX_FILES = int(os.environ.get("PROXY_SLOT_CACHE_MAX_FILES", "12"))
# llama-server slot id — always 0 under --parallel 1.
PROXY_SLOT_ID = int(os.environ.get("PROXY_SLOT_ID", "0"))
# HTTP timeouts for the /slots save|restore calls. A large session's KV
# state (131k ctx) is ~1 GiB; serializing it to / loading it from disk on
# a slower model (e.g. Qwen3.6-35B-A3B MoE) can exceed the original
# hardcoded 60s/120s, surfacing as `SLOT SAVE/RESTORE error` with an empty
# httpx-timeout exception. Restore is given more headroom than save since
# it also waits on the disk read + KV reload.
PROXY_SLOT_SAVE_TIMEOUT = float(os.environ.get("PROXY_SLOT_SAVE_TIMEOUT", "180"))
PROXY_SLOT_RESTORE_TIMEOUT = float(os.environ.get("PROXY_SLOT_RESTORE_TIMEOUT", "300"))

# Module state. Mutated only inside the upstream_semaphore-held section
# (_post_with_retry), so no extra lock is needed.
_slot_owner_session: str | None = None  # session id currently loaded in the slot
_slot_lru: "OrderedDict[str, float]" = OrderedDict()  # session -> last-access ts

# Per-request session id, set by the request handler and read by
# _ensure_slot_for_session inside _post_with_retry. A ContextVar keeps the
# value request-local without threading it through every call signature.
_current_request_session: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "uap_current_request_session", default=None
)

# Session admission state. _admitted_sessions maps session_id -> last-seen
# monotonic ts; OrderedDict insertion order is the LRU (oldest = front).
# Guarded by _admission_cond's lock (created lazily on the running event loop).
_admitted_sessions: "OrderedDict[str, float]" = OrderedDict()
_admission_cond: "asyncio.Condition | None" = None


def _slot_endpoint_base() -> str:
    """Base URL for llama-server's /slots endpoint (LLAMA_CPP_BASE without /v1)."""
    base = LLAMA_CPP_BASE.rstrip("/")
    if base.endswith("/v1"):
        base = base[: -len("/v1")]
    return base


def _slot_filename(session_id: str) -> str:
    """Map a session id to a filesystem-safe slot-state filename."""
    safe = re.sub(r"[^A-Za-z0-9_.-]", "_", session_id)
    return f"slot-{safe}.bin"


async def _save_slot(client: httpx.AsyncClient, session_id: str) -> bool:
    """Persist the current slot KV state under *session_id*'s filename."""
    fn = _slot_filename(session_id)
    url = f"{_slot_endpoint_base()}/slots/{PROXY_SLOT_ID}?action=save"
    try:
        resp = await client.post(
            url, json={"filename": fn}, timeout=PROXY_SLOT_SAVE_TIMEOUT
        )
        if resp.status_code == 200:
            logger.info("SLOT SAVE: session=%s -> %s", session_id, fn)
            return True
        logger.warning(
            "SLOT SAVE failed: session=%s http=%d %s",
            session_id, resp.status_code, resp.text[:200],
        )
    except Exception as exc:
        # Include the exception TYPE — httpx timeout exceptions stringify
        # to "" and an empty message log line is undiagnosable.
        logger.warning(
            "SLOT SAVE error: session=%s %s: %s",
            session_id, type(exc).__name__, exc,
        )
    return False


async def _restore_slot(client: httpx.AsyncClient, session_id: str) -> bool:
    """Restore *session_id*'s saved slot KV state.

    Returns False if no saved file exists or the restore failed — the caller
    then proceeds with a normal (full-reprocess) upstream call.
    """
    fn = _slot_filename(session_id)
    path = os.path.join(PROXY_SLOT_SAVE_DIR, fn)
    if not os.path.exists(path):
        return False
    url = f"{_slot_endpoint_base()}/slots/{PROXY_SLOT_ID}?action=restore"
    try:
        resp = await client.post(
            url, json={"filename": fn}, timeout=PROXY_SLOT_RESTORE_TIMEOUT
        )
        if resp.status_code == 200:
            logger.info("SLOT RESTORE: session=%s <- %s", session_id, fn)
            return True
        logger.warning(
            "SLOT RESTORE failed: session=%s http=%d %s",
            session_id, resp.status_code, resp.text[:200],
        )
    except Exception as exc:
        # Include the exception TYPE — httpx timeout exceptions stringify
        # to "" and an empty message log line is undiagnosable.
        logger.warning(
            "SLOT RESTORE error: session=%s %s: %s",
            session_id, type(exc).__name__, exc,
        )
    return False


def _evict_slot_files() -> None:
    """LRU-evict saved slot files beyond PROXY_SLOT_CACHE_MAX_FILES.

    The session currently owning the slot is never evicted (its file is the
    live restore point). Eviction order is oldest-access first.
    """
    if len(_slot_lru) <= PROXY_SLOT_CACHE_MAX_FILES:
        return
    evictable = [s for s in _slot_lru if s != _slot_owner_session]
    excess = len(_slot_lru) - PROXY_SLOT_CACHE_MAX_FILES
    for old_session in evictable[:excess]:
        old_path = os.path.join(PROXY_SLOT_SAVE_DIR, _slot_filename(old_session))
        try:
            os.remove(old_path)
        except FileNotFoundError:
            pass
        except OSError as exc:
            logger.warning("SLOT EVICT error: %s", exc)
        del _slot_lru[old_session]
        logger.info("SLOT EVICT: removed LRU slot file for session=%s", old_session)


async def _ensure_slot_for_session(
    client: httpx.AsyncClient | None, session_id: str | None
) -> None:
    """Make the upstream slot hold *session_id*'s KV state.

    Called inside the upstream_semaphore-held section, so module state is
    mutated without an extra lock. No-op when slot save/restore is disabled
    or the slot already belongs to this session. On a session switch, saves
    the outgoing session's state and restores the incoming session's.
    """
    global _slot_owner_session
    if not PROXY_SLOT_SAVE_RESTORE or not session_id or client is None:
        return
    if session_id == _slot_owner_session:
        if session_id in _slot_lru:
            _slot_lru.move_to_end(session_id)
        return
    if _slot_owner_session is not None:
        if await _save_slot(client, _slot_owner_session):
            _slot_lru[_slot_owner_session] = time.time()
            _slot_lru.move_to_end(_slot_owner_session)
    await _restore_slot(client, session_id)
    _slot_owner_session = session_id
    _slot_lru[session_id] = time.time()
    _slot_lru.move_to_end(session_id)
    _evict_slot_files()


def _prepare_slot_save_dir() -> None:
    """Create + clear the slot-save directory at proxy startup.

    Stale files from a previous run may be shape-incompatible with the
    current model (e.g. after a 35B->27B switch); restoring a mismatched
    file could crash or corrupt the slot. Clearing on startup is the safe
    belt-and-suspenders move — cross-restart cache reuse is sacrificed for
    correctness. llama-server itself also rejects mismatched restores, but
    we do not rely on that alone.
    """
    if not PROXY_SLOT_SAVE_RESTORE:
        return
    try:
        os.makedirs(PROXY_SLOT_SAVE_DIR, exist_ok=True)
        removed = 0
        for f in os.listdir(PROXY_SLOT_SAVE_DIR):
            if f.startswith("slot-") and f.endswith(".bin"):
                os.remove(os.path.join(PROXY_SLOT_SAVE_DIR, f))
                removed += 1
        _slot_lru.clear()
        logger.info(
            "SLOT SAVE/RESTORE: enabled, dir=%s, cleared %d stale file(s) on startup",
            PROXY_SLOT_SAVE_DIR, removed,
        )
    except OSError as exc:
        logger.warning("SLOT SAVE/RESTORE: startup dir prep failed: %s", exc)


def _prune_idle_admissions(now: float) -> list[str]:
    """Remove admitted sessions idle longer than the TTL; return their ids.
    Caller must hold the admission lock. 0 TTL disables idle pruning."""
    ttl = PROXY_SESSION_ADMISSION_IDLE_TTL
    if ttl <= 0:
        return []
    stale = [sid for sid, ts in _admitted_sessions.items() if now - ts > ttl]
    for sid in stale:
        _admitted_sessions.pop(sid, None)
    return stale


def _try_admit_session(session_id: str, now: float) -> bool:
    """Synchronous admission core (caller holds the admission lock). Returns
    True if the session is admitted — already hot (refreshed) or newly admitted
    into a free slot — False if the hot set is full. Pure/deterministic given
    `now`, so it is unit-tested directly."""
    _prune_idle_admissions(now)
    if session_id in _admitted_sessions:
        _admitted_sessions[session_id] = now
        _admitted_sessions.move_to_end(session_id)
        return True
    if len(_admitted_sessions) < PROXY_SESSION_ADMISSION_LIMIT:
        _admitted_sessions[session_id] = now
        _admitted_sessions.move_to_end(session_id)
        return True
    return False


async def _ensure_session_admitted(session_id: str | None) -> None:
    """Block until `session_id` is admitted to the hot set (size <= LIMIT).

    Sticky: admission persists across a session's turns and is released only by
    idle-TTL pruning. A new session over the limit queues (waits) rather than
    evicting a hot session. On wait-timeout it force-admits, evicting the LRU,
    to avoid a hard stall (graceful degrade to pre-admission behaviour).
    No-op when disabled or when there is no session id."""
    global _admission_cond
    if not PROXY_SESSION_ADMISSION or not session_id:
        return
    if _admission_cond is None:
        _admission_cond = asyncio.Condition()
    cond = _admission_cond
    deadline = (
        time.monotonic() + PROXY_SESSION_ADMISSION_WAIT_TIMEOUT
        if PROXY_SESSION_ADMISSION_WAIT_TIMEOUT > 0
        else None
    )
    waited = False
    async with cond:
        while True:
            now = time.monotonic()
            if _try_admit_session(session_id, now):
                if waited:
                    logger.info(
                        "SESSION ADMISSION: admitted %s after wait (%d/%d hot)",
                        session_id[:12], len(_admitted_sessions),
                        PROXY_SESSION_ADMISSION_LIMIT,
                    )
                # A refresh/new admit may have pruned idle sessions; wake peers.
                cond.notify_all()
                return
            # Hot set full and this session isn't in it.
            if deadline is not None and now >= deadline:
                evicted = "-"
                if _admitted_sessions:
                    evicted = next(iter(_admitted_sessions))  # LRU = oldest front
                    _admitted_sessions.pop(evicted, None)
                _admitted_sessions[session_id] = now
                logger.warning(
                    "SESSION ADMISSION: wait timeout (%ds), force-admitted %s "
                    "(evicted LRU %s) — sustained over-subscription (>%d hot sessions)",
                    int(PROXY_SESSION_ADMISSION_WAIT_TIMEOUT), session_id[:12],
                    evicted[:12], PROXY_SESSION_ADMISSION_LIMIT,
                )
                cond.notify_all()
                return
            waited = True
            timeout = PROXY_SESSION_ADMISSION_POLL
            if deadline is not None:
                timeout = max(0.0, min(timeout, deadline - now))
            try:
                await asyncio.wait_for(cond.wait(), timeout=timeout)
            except asyncio.TimeoutError:
                pass  # re-loop: re-prune idle admissions, retry


async def _acquire_upstream_slot() -> bool:
    """Acquire a semaphore slot for an upstream request.

    Returns True if a slot was acquired, False if the wait timed out.
    asyncio.Semaphore.acquire() preserves wait order via futures, so this
    gives a natural FIFO queue.
    """
    if upstream_semaphore is None:
        return True  # Not yet initialized; proceed without limiting
    if PROXY_CONCURRENCY_QUEUE_TIMEOUT <= 0:
        await upstream_semaphore.acquire()
        return True
    try:
        await asyncio.wait_for(
            upstream_semaphore.acquire(),
            timeout=PROXY_CONCURRENCY_QUEUE_TIMEOUT,
        )
        return True
    except asyncio.TimeoutError:
        return False


def _release_upstream_slot() -> None:
    """Release a semaphore slot. MUST be called once per successful acquire.

    Note: asyncio.Semaphore.release() always increments the counter — we
    do NOT gate on locked() because that returns True only when the counter
    is 0 (no slots left). Gating would cause a slot leak when limit > 1 and
    multiple holders release simultaneously.
    """
    if upstream_semaphore is not None:
        upstream_semaphore.release()


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
    """Post with upstream-retry + concurrency-slot acquire.

    Acquires a slot from upstream_semaphore before making the request, so
    concurrent client requests queue in the proxy (cheap asyncio waits)
    rather than all hammering llama.cpp at once. Slot is released in a
    finally block so it's always returned to the pool even on error.
    """
    # Session admission: cap DISTINCT hot sessions to <= the slot count so they
    # don't evict each other's KV (sticky, released by idle-TTL). No-op when
    # PROXY_SESSION_ADMISSION is off. Runs BEFORE the per-request semaphore so a
    # queued new session waits without holding a concurrency slot.
    await _ensure_session_admitted(_current_request_session.get())
    acquired = await _acquire_upstream_slot()
    if not acquired:
        logger.warning(
            "CONCURRENCY: queue timeout (%ds) exceeded waiting for upstream slot",
            int(PROXY_CONCURRENCY_QUEUE_TIMEOUT),
        )
        raise httpx.RemoteProtocolError(
            f"Upstream concurrency queue timed out after {int(PROXY_CONCURRENCY_QUEUE_TIMEOUT)}s "
            f"(limit={PROXY_CONCURRENCY_LIMIT})",
            request=None,
        )
    try:
        # Inside the serialized section: swap the upstream slot's KV state to
        # this request's session if needed (no-op when disabled or unchanged).
        await _ensure_slot_for_session(client, _current_request_session.get())
        return await _post_with_retry_inner(client, url, payload, headers)
    finally:
        _release_upstream_slot()


async def _post_with_retry_inner(
    client: httpx.AsyncClient,
    url: str,
    payload: dict,
    headers: dict,
) -> httpx.Response:
    last_exc: Exception | None = None
    for attempt in range(PROXY_UPSTREAM_RETRY_MAX):
        try:
            _inflight_inc(client)
            try:
                resp = await client.post(url, json=payload, headers=headers)
            finally:
                _inflight_dec(client)
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
        except _UPSTREAM_RETRY_EXCEPTIONS as exc:
            last_exc = exc
            if attempt < PROXY_UPSTREAM_RETRY_MAX - 1:
                logger.warning(
                    "Upstream transient error (attempt %d/%d): %s – retrying in %.0fs",
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
    Also acquires a concurrency slot before making the request.

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
    global upstream_semaphore
    global _admission_cond
    upstream_semaphore = asyncio.Semaphore(PROXY_CONCURRENCY_LIMIT)
    # Bind the admission condition to THIS event loop and clear stale state.
    _admission_cond = asyncio.Condition()
    _admitted_sessions.clear()
    if PROXY_SESSION_ADMISSION:
        logger.info(
            "SESSION ADMISSION: on (limit=%d hot sessions, idle_ttl=%.0fs, "
            "wait_timeout=%.0fs)",
            PROXY_SESSION_ADMISSION_LIMIT,
            PROXY_SESSION_ADMISSION_IDLE_TTL,
            PROXY_SESSION_ADMISSION_WAIT_TIMEOUT,
        )
    logger.info(
        "CONCURRENCY: upstream semaphore initialized limit=%d queue_timeout=%.0fs",
        PROXY_CONCURRENCY_LIMIT,
        PROXY_CONCURRENCY_QUEUE_TIMEOUT,
    )
    _prepare_slot_save_dir()
    http_client = _build_http_client()
    logger.info(
        "Proxy started: listening on %s:%d -> upstream %s",
        PROXY_HOST,
        PROXY_PORT,
        LLAMA_CPP_BASE,
    )

    _reaper_task = asyncio.ensure_future(_closewait_reaper())

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
        "Thinking grammar: enabled=%s loaded=%s path=%s",
        PROXY_THINKING_GRAMMAR,
        bool(THINKING_GBNF),
        PROXY_THINKING_GRAMMAR_PATH,
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
    _reaper_task.cancel()
    await http_client.aclose()
    http_client = None
    if upstream_semaphore is not None:
        upstream_semaphore = None
    _admission_cond = None
    _admitted_sessions.clear()
    logger.info("Proxy shut down")


app = FastAPI(
    title="UAP Anthropic Proxy",
    description="Translates Anthropic Messages API to OpenAI Chat Completions API",
    version="1.0.0",
    lifespan=lifespan,
)

@app.exception_handler(httpx.PoolTimeout)
async def _pool_timeout_handler(request: Request, exc: httpx.PoolTimeout):
    """Saturated upstream pool: answer 529 overloaded (Anthropic semantics —
    clients back off with jitter instead of fast-retrying a 500 traceback,
    which amplified the storm).

    NOTE: this deliberately does NOT swap the pool. Under a saturated upstream
    (llama at 3/3 slots) the pool-swap self-heal churned in-flight connections
    into ReadError→500 bursts (live 2026-07-12) — the same mechanism the
    reaper was disabled for. Pure backpressure (529 + a large
    PROXY_MAX_CONNECTIONS) is the graceful posture; leaked connections are
    cleared by the periodic proxy restart, not by mid-load pool churn. Set
    PROXY_POOL_SWAP_ON_SATURATION=1 to restore the swap."""
    if os.environ.get("PROXY_POOL_SWAP_ON_SATURATION") == "1":
        _maybe_reset_http_client("PoolTimeout on " + request.url.path)
    return Response(
        content=json.dumps(
            {
                "type": "error",
                "error": {
                    "type": "overloaded_error",
                    "message": "Upstream connection pool saturated — retry shortly.",
                },
            }
        ),
        status_code=529,
        media_type="application/json",
        headers={"retry-after": "10"},
    )



# Open paths that never require the shared secret (liveness / discovery), so a
# LAN health check or an SDK model-list probe works without the token.
_PROXY_AUTH_OPEN_PATHS = frozenset({"/health", "/", "/v1/models"})


@app.middleware("http")
async def _shared_secret_auth(request: Request, call_next):
    """Gate every request behind PROXY_AUTH_TOKEN when it is set.

    No-op when the token is unset (the default; safe only because the default
    bind is loopback). When set — the intended posture for a shared LAN service
    (PROXY_HOST=0.0.0.0) — a request must present the token as
    `Authorization: Bearer <token>` or `X-Uap-Proxy-Token: <token>`; otherwise
    401. Uses a constant-time compare to avoid a timing oracle.
    """
    if PROXY_AUTH_TOKEN and request.url.path not in _PROXY_AUTH_OPEN_PATHS and request.method != "OPTIONS":
        provided = request.headers.get("x-uap-proxy-token", "")
        if not provided:
            auth = request.headers.get("authorization", "")
            if auth.lower().startswith("bearer "):
                provided = auth[7:].strip()
        import hmac as _hmac

        if not (provided and _hmac.compare_digest(provided, PROXY_AUTH_TOKEN)):
            return Response(
                content=json.dumps(
                    {
                        "type": "error",
                        "error": {
                            "type": "authentication_error",
                            "message": "missing or invalid proxy token (set X-Uap-Proxy-Token or Authorization: Bearer)",
                        },
                    }
                ),
                status_code=401,
                media_type="application/json",
            )
    return await call_next(request)

# NOTE: Concurrency control is enforced by _acquire_upstream_slot() inside
# _post_with_retry (the single point where we hit llama.cpp). An earlier
# implementation also added an HTTP middleware that acquired the same
# semaphore — this caused a self-deadlock (middleware holds slot, inner
# call waits for slot, both on the same task). The middleware approach
# also called non-existent asyncio.Semaphore methods (try_acquire /
# acquire_nowait) and ran an async primitive in a thread executor.
# Removed 2026-05-13.



# ===========================================================================
# Request Translation: Anthropic -> OpenAI
# ===========================================================================


def _image_block_to_openai(block: dict) -> dict | None:
    """Anthropic image block → OpenAI image_url part (data URI or URL)."""
    src = block.get("source") or {}
    if src.get("type") == "base64" and src.get("data"):
        media_type = src.get("media_type", "image/png")
        return {"type": "image_url", "image_url": {"url": f"data:{media_type};base64,{src['data']}"}}
    if src.get("type") == "url" and src.get("url"):
        return {"type": "image_url", "image_url": {"url": src["url"]}}
    return None


def _extract_images(content) -> list[dict]:
    """Collect OpenAI image_url parts nested in Anthropic content."""
    images: list[dict] = []
    if isinstance(content, list):
        for b in content:
            if isinstance(b, dict) and b.get("type") == "image":
                part = _image_block_to_openai(b)
                if part:
                    images.append(part)
    return images


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

        # Strip <think>...</think> blocks from PRIOR assistant turns. Qwen is
        # heavily few-shot influenced by its own conversation history — if
        # earlier assistant turns contain reasoning blocks, the next turn
        # will pattern-match and emit <think> tags even when the system
        # prompt forbids them. Stripping breaks the copy cycle.
        if role == "assistant":
            if isinstance(content, str) and "<think>" in content:
                content = _THINKING_BLOCK_RE.sub("", content).lstrip()
            elif isinstance(content, list):
                stripped = []
                for b in content:
                    if isinstance(b, dict) and b.get("type") == "text":
                        t = b.get("text", "")
                        if "<think>" in t:
                            t = _THINKING_BLOCK_RE.sub("", t).lstrip()
                        if t:
                            stripped.append({**b, "text": t})
                    elif isinstance(b, dict) and b.get("type") == "thinking":
                        # Anthropic-style thinking block — drop entirely
                        # (don't replay it back to the model).
                        continue
                    else:
                        stripped.append(b)
                content = stripped

        if isinstance(content, str):
            messages.append({"role": role, "content": content})
        elif isinstance(content, list):
            parts = []
            image_parts: list[dict] = []
            for block in content:
                if isinstance(block, str):
                    parts.append(block)
                elif block.get("type") == "text":
                    parts.append(block.get("text", ""))
                elif block.get("type") == "image":
                    # Vision passthrough: forward as an OpenAI image_url part
                    # when the upstream model has an mmproj loaded; otherwise
                    # leave an explicit placeholder (silent drops made agents
                    # think the model saw the screenshot).
                    part = _image_block_to_openai(block) if vision_enabled() else None
                    if part:
                        image_parts.append(part)
                    else:
                        parts.append("[image omitted: the serving model has no vision support]")
                elif block.get("type") == "thinking":
                    # Drop thinking blocks from user/assistant content when
                    # echoed back into history — model shouldn't see them.
                    continue
                elif block.get("type") == "tool_use":
                    messages.append(
                        {
                            "role": "assistant",
                            "content": None,
                            "tool_calls": [
                                {
                                    "id": block.get(
                                        "id", f"toolu_{uuid.uuid4().hex[:24]}"
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
                    # Strip Anthropic-spec toolu_ prefix so the upstream
                    # tool_call_id matches what llama-server originally
                    # emitted (we stamped the prefix on outbound; reverse it
                    # here so the loop closes correctly).
                    tu_id = block.get("tool_use_id", "")
                    if isinstance(tu_id, str) and tu_id.startswith("toolu_"):
                        tu_id = tu_id[len("toolu_"):]
                    tr_text = _extract_text(block.get("content", ""))
                    tr_images = _extract_images(block.get("content", "")) if vision_enabled() else []
                    if not vision_enabled():
                        inner = block.get("content")
                        n_imgs = (
                            sum(1 for b in inner if isinstance(b, dict) and b.get("type") == "image")
                            if isinstance(inner, list) else 0
                        )
                        if n_imgs:
                            tr_text = (tr_text + f"\n[{n_imgs} image(s) omitted: the serving model has no vision support]").strip()
                    messages.append(
                        {
                            "role": "tool",
                            "tool_call_id": tu_id,
                            "content": tr_text,
                        }
                    )
                    if tr_images:
                        # OpenAI tool messages are text-only for llama.cpp —
                        # deliver tool-result images as an adjacent user turn
                        # so the model actually SEES them.
                        messages.append(
                            {
                                "role": "user",
                                "content": [
                                    {"type": "text", "text": "[image(s) attached from the preceding tool result]"},
                                    *tr_images,
                                ],
                            }
                        )
                    continue
            if image_parts:
                typed: list[dict] = []
                if parts:
                    typed.append({"type": "text", "text": "\n".join(parts)})
                typed.extend(image_parts)
                messages.append({"role": role, "content": typed})
            elif parts:
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

    # Confidence-escalation (vLLM "Confidence" recipe) needs the FULL answer
    # buffered to score it before deciding whether to escalate. Buffer single-
    # answer (no-tool) streaming turns when escalation is enabled. Default OFF.
    if not has_tools and _ce is not None:
        try:
            if _ce.Settings.from_env().enabled:
                return True
        except Exception:
            pass

    # A2: when stream-passthrough is enabled, do NOT buffer required-tool turns
    # (native tool_choice='required' constrains them); force-non-stream and
    # malformed-strict above still apply.
    if PROXY_STREAM_REQUIRED_TOOL:
        return False
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

# Directive appended when the upstream model (Qwen) is configured with
# enable_thinking=False but consistently emits <think>...</think> blocks
# anyway, consuming the max_tokens budget before any tool_use is generated.
# Empirically required for Shannon-style workflows where max_tokens=512
# leaves no room for both internal reasoning AND a tool call.
_NO_THINKING_DIRECTIVE = (
    "\n\nCRITICAL: Do NOT output <think>...</think> tags or any internal "
    "reasoning. Begin your response IMMEDIATELY with the appropriate "
    "tool_call. If you have no tool to call, reply with plain text only — "
    "never include reasoning blocks."
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

    llama.cpp's tool grammar generator can fail on regex-heavy schema fields:

    - "pattern" / "patternProperties" — regex strings (e.g. "\\w").
    - "format" — string formats. llama.cpp's json-schema-to-grammar turns
      "format": "date" / "date-time" / "time" / "uuid" into grammar rules
      built from `\\d`, which its own GBNF parser then rejects with
      `error parsing grammar: unknown escape at \\d...` → `failed to parse
      grammar`. Observed on MCP tools with date fields (Atlassian
      getJiraIssue, tempo bulkCreateWorklogs). "format" is an advisory
      annotation — dropping it just leaves the field as an unconstrained
      string in the tool-call grammar, which is correct behaviour.

    All three are stripped only when they appear as schema *keywords*, not
    when they are property *names* (a tool may legitimately have a parameter
    literally called "pattern" or "format").
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
                    key in ("pattern", "format")
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
                    "id": block.get("id", f"toolu_{uuid.uuid4().hex[:24]}"),
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


# A3: the anthropic->openai tool conversion + schema sanitize walks every tool's
# (often deeply nested) JSON schema. The tool set is IDENTICAL across every turn
# of a session, so this recomputed the same result each turn (observed: ~1
# SCHEMA SANITIZE log per turn). Cache by a stable hash of the tool definitions.
# Downstream only READS the converted dicts and FILTERS the list (narrowing), so
# returning the cached object directly is safe.
_TOOL_CONVERT_CACHE: "OrderedDict[str, list]" = OrderedDict()
_TOOL_CONVERT_CACHE_MAX = 32


def _convert_anthropic_tools_to_openai(anthropic_tools: list[dict]) -> list[dict]:
    cache_key = None
    try:
        cache_key = hashlib.sha1(
            json.dumps(anthropic_tools, sort_keys=True, default=str).encode("utf-8")
        ).hexdigest()
    except Exception:
        cache_key = None
    if cache_key is not None and cache_key in _TOOL_CONVERT_CACHE:
        _TOOL_CONVERT_CACHE.move_to_end(cache_key)
        return _TOOL_CONVERT_CACHE[cache_key]

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
    if cache_key is not None:
        _TOOL_CONVERT_CACHE[cache_key] = converted
        if len(_TOOL_CONVERT_CACHE) > _TOOL_CONVERT_CACHE_MAX:
            _TOOL_CONVERT_CACHE.popitem(last=False)
    return converted


def _latest_user_text(anthropic_body: dict) -> str:
    for msg in reversed(anthropic_body.get("messages", [])):
        if msg.get("role") != "user":
            continue
        return _extract_text(msg.get("content", ""))
    return ""


# 2026-05-12: Detect "no-task" user turns to gate the state machine's
# force-required path. When the last actual human query is a short ack
# ("ok", "3", "test"), an acknowledgement phrase ("standing by", "awaiting
# next instruction"), or a status report ending in an ack ("scan complete.
# awaiting next instruction"), there is no genuine work for the model to
# do. Forcing tool_choice='required' in this state causes the model to
# ruminate in <think> blocks, and the meta-tool talk inside those blocks
# trips the malformed-pseudo-tool detector. Conservative patterns only.
_NO_TASK_SHORT_ACKS = frozenset({
    "ok", "okay", "k", "kk", "y", "n", "yes", "no", "nope", "yep", "yeah",
    "thanks", "thank", "thx", "ty", "ack", "noted", "received", "understood",
    "test", "ping", "hi", "hello",
})

_NO_TASK_ACK_PATTERNS = (
    re.compile(r"awaiting\s+(?:next|further|your)\s+(?:instruction|input|command|task|directive)", re.I),
    re.compile(r"standing\s+by(?:\s+for\s+(?:your\s+)?(?:next|further|new)\s+(?:instruction|input|command|task|directive)?)?", re.I),
    re.compile(r"\b(?:ready|waiting|holding)\s+for\s+(?:your\s+)?(?:next|further|new)\s+(?:task|instruction|command|input|directive)", re.I),
    # Status report ending in ack: "X complete. {awaiting/standing/ready/done}"
    re.compile(r"\bcomplet(?:e|ed)\b[\s.,;:!\-]+(?:awaiting|standing\s+by|ready|done|finished|over\s+to\s+you)", re.I),
)


def _is_no_task_user_text(text: str) -> bool:
    if not text:
        return False
    stripped = text.strip()
    if not stripped:
        return False
    bare = re.sub(r"[^\w\s]", "", stripped).strip().lower()
    if bare in _NO_TASK_SHORT_ACKS:
        return True
    if re.fullmatch(r"\d+(?:\.\d+)?", bare):
        return True
    snippet = stripped[:400]
    return any(p.search(snippet) for p in _NO_TASK_ACK_PATTERNS)


def _latest_user_query_text(anthropic_body: dict) -> str:
    """Return the most recent user message *text* — walking past
    tool_result-only messages to find the last actual human query.

    During agentic loops the trailing user message is a tool_result block
    with no ``text`` parts, so ``_latest_user_text`` returns empty.
    Tool-narrowing needs query tokens to score tools; without them it
    keeps all tools (defeating the purpose). This walker pulls text
    from prior user turns as a fallback so narrowing stays useful in
    long loops.
    """
    for msg in reversed(anthropic_body.get("messages", [])):
        if msg.get("role") != "user":
            continue
        content = msg.get("content", "")
        if isinstance(content, str) and content.strip():
            return content
        if isinstance(content, list):
            text_parts = [
                b.get("text", "")
                for b in content
                if isinstance(b, dict) and b.get("type") == "text" and b.get("text")
            ]
            if text_parts:
                return "\n".join(text_parts)
    return ""


def _tokenize_for_tool_ranking(text: str) -> set[str]:
    return {m.group(0).lower() for m in re.finditer(r"[a-zA-Z0-9_]{2,}", text)}


# Core action tools a coding agent must always retain through narrowing — losing
# any of these strands the agent (it can read/think but not act). Names are the
# Claude Code canonical tool names, matched case-insensitively.
_CORE_TOOL_NAMES = frozenset({
    "read", "write", "edit", "multiedit", "notebookedit",
    "bash", "glob", "grep", "ls", "applypatch", "apply_patch",
})


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
        # Walk back past tool_result turns to find the prior real human
        # query. Lets narrowing stay effective during agentic loops where
        # the latest user msg is just a tool_result block (no text).
        fallback_query = _latest_user_query_text(anthropic_body).lower()
        query_text = fallback_query or query_text
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
    # Always retain core action tools, regardless of lexical score. A real task
    # description ("build an octopus invaders game") rarely contains tool names
    # like "write"/"edit", so overlap ties at 0 and the -idx tiebreaker would
    # otherwise keep an arbitrary first-N subset — observed dropping
    # Write/Edit/Bash entirely and stalling the agent on meta-tools. `keep` thus
    # acts as a soft floor: core tools are added on top of the top-scored set.
    for tool in openai_tools:
        nm = tool.get("function", {}).get("name", "").lower()
        if nm in _CORE_TOOL_NAMES:
            selected.add(id(tool))
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

    # 2026-05-12: No-task ack guard. When the latest user message is just a
    # tool_result (no fresh text), walk back to the most recent human query.
    # If that query is a short ack or "X complete. awaiting next" status,
    # do not force tool_choice — let the model produce a natural finalization
    # text instead of ruminating in <think> blocks.
    last_user_query = _latest_user_query_text(anthropic_body).strip()
    if last_user_query and _is_no_task_user_text(last_user_query):
        monitor.reset_tool_turn_state(reason="no_task_user_text")
        monitor.finalize_continuation_count = 0
        monitor.finalize_synthetic_tool_id = ""
        return None, "no_task_user_text"

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
            # Consume the evidence: the per-target counts are cumulative for
            # the life of the tool loop, so without this reset the detector
            # stays latched after one legitimate 3x re-read and re-breaks the
            # cycle on EVERY later act turn — even productive ones reading
            # distinct new files — inflating review_cycles toward a premature
            # forced finalize (observed live 2026-07-09: 57 fires in one
            # evening, still firing during distinct-file reads). Clearing
            # demands 3 fresh repeats before the next fire.
            monitor.reset_tool_targets()
            logger.warning(
                "TOOL STATE MACHINE: duplicate read target detected for '%s', triggering early cycle break",
                dup_tool,
            )

        # Fix K (2026-04-22): require cycle_repeat >= PROXY_CYCLE_TRIGGER_REPEAT
        # before flipping phase. Single-repeat cycles are legitimate in working
        # sessions (e.g. re-reading the same file across edits). dup_target
        # above already demands threshold=3 before asserting a cycle, so the
        # `cycle_looping = True, cycle_repeat = 2` pair from that branch is
        # kept as a strong signal (read target repeated 3+ times). Low-repeat
        # cycles detected by detect_tool_cycle get filtered here.
        cycle_trip = cycle_looping and cycle_repeat >= PROXY_CYCLE_TRIGGER_REPEAT
        if cycle_trip or stagnating:
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
            # Cycle 18 Option 2: track per-tool cycle counts and ban after N cycles.
            # #4: coordination/bookkeeping tools (TaskUpdate etc.) are banned
            # faster (PROXY_COORDINATION_BAN_THRESHOLD) since repeating them is
            # never productive; other tools keep the generic threshold of 3.
            for name in monitor.cycling_tool_names:
                monitor.tool_cycle_counts[name] = monitor.tool_cycle_counts.get(name, 0) + 1
                is_coord = (
                    name in PROXY_COORDINATION_TOOLS
                    and PROXY_COORDINATION_BAN_THRESHOLD > 0
                )
                ban_at = PROXY_COORDINATION_BAN_THRESHOLD if is_coord else 3
                # Exploration escape-hatch tools are never auto-banned — see
                # _should_auto_ban (banning Bash re-creates the "can't explore"
                # bug since the ban is itself cycling-derived).
                if (
                    _should_auto_ban(name, monitor.tool_cycle_counts[name], ban_at)
                    and name not in monitor.session_banned_tools
                ):
                    monitor.session_banned_tools.add(name)
                    logger.warning(
                        "TOOL BAN: '%s' banned for session after %d cycle detections "
                        "(threshold=%d%s)",
                        name,
                        monitor.tool_cycle_counts[name],
                        ban_at,
                        ", coordination" if is_coord else "",
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


def _writes_are_gated(openai_body: dict) -> bool:
    """True when the harness is BLOCKING direct writes (delivery-enforcement),
    so a "write the file" directive is futile and the model must route through
    the deliver tool instead. Aligns the recon directive with the gate to break
    the read-forever / can't-write deadlock.

    Two detection paths:
      * reactive -- a recent tool_result shows a write was actually blocked
        (last 8 messages); and
      * proactive (A) -- the harness gate banner is present anywhere in the
        context (system / injected-user prompt). A session stuck reading
        forever NEVER attempts a doomed write, so the reactive path never
        fires and the deliver redirect never triggers -- the loop is
        permanent. The proactive path fires the redirect on turn 1 of the
        streak. Phrases matched are stable harness strings, not model output.
    """
    msgs = openai_body.get("messages") or []
    # Reactive: a recent turn was actually blocked by the gate.
    for m in msgs[-8:]:
        c = m.get("content")
        text = c if isinstance(c, str) else (json.dumps(c) if c else "")
        low = text.lower()
        if "delivery-enforcement" in low or (
            "blocked" in low and "deliver" in low and "tool" in low
        ):
            return True
    # Proactive (A): the gate banner is present in context (esp. the system /
    # UserPromptSubmit-injected prompt announcing "route through deliver").
    # Bounded scan: the banner lives in the system prompt(s) or the recent
    # window, never deep in history -- so we only serialize/lower those, not
    # the whole (66k-token) transcript on this stuck-path hot request.
    system_msgs = [m for m in msgs if m.get("role") == "system"]
    for m in system_msgs + msgs[-8:]:
        if m.get("role") not in ("system", "user"):
            continue
        c = m.get("content")
        text = c if isinstance(c, str) else (json.dumps(c) if c else "")
        low = text.lower()
        if (
            "gated and will be blocked" in low
            or "route through deliver" in low
            or ("direct edit/write" in low and "gated" in low)
        ):
            return True
    return False


# MCP tool prefixes a bubblewrap sandbox (`uap sandbox`) cannot reach: the
# claude-in-chrome browser extension talks over a socket that is not bound into
# the sandbox mount namespace, so every browser_batch call dead-ends. Offering
# these tools to a sandboxed session guarantees a fetch/tool-selection loop.
# Env-configurable (colon-separated) so a deployment that DOES bind the browser
# extension socket into the sandbox can disable stripping (set empty), or extend
# it to other sandbox-unreachable MCP servers. Default: the claude-in-chrome
# browser bridge, empirically unreachable in the bwrap namespace (observed live:
# browser_batch dead-ended repeatedly and the model reported it unavailable).
_SANDBOX_UNREACHABLE_TOOL_PREFIXES = tuple(
    p
    for p in os.environ.get(
        "PROXY_SANDBOX_UNREACHABLE_PREFIXES", "mcp__claude-in-chrome__"
    ).split(":")
    if p
)


def _strip_sandbox_unreachable_tools(body: dict) -> int:
    """Drop browser/extension MCP tools a bwrap sandbox can't reach from the
    Anthropic-format tool list in ``body['tools']``. Returns the count removed
    so the caller can log it. The model then falls back to WebFetch / local
    file reads instead of looping on an unreachable browser_batch."""
    tools = body.get("tools")
    if not isinstance(tools, list) or not _SANDBOX_UNREACHABLE_TOOL_PREFIXES:
        return 0
    kept = [
        t
        for t in tools
        if not (
            isinstance(t, dict)
            and str(t.get("name", "")).startswith(_SANDBOX_UNREACHABLE_TOOL_PREFIXES)
        )
    ]
    removed = len(tools) - len(kept)
    if removed:
        body["tools"] = kept
    return removed


def _maybe_inject_stuck_break(openai_body: dict, monitor: "SessionMonitor") -> None:
    """Force a terminal turn when the model is looping self-awarely or hammering
    a rate-limited API. Unlike the cycle-breaker (which narrows tools), this
    STOPS tool coercion and tells the model to synthesize / ask / route around
    the unreachable resource -- converting the model's own "I'm stuck" into an
    actual exit. Fires at most escalating; monotonic counter for telemetry."""
    should, reason = monitor.should_force_stuck_break()
    if not should:
        return
    monitor.stuck_break_fires += 1
    # Release the tool-choice coercion so a plain text turn is allowed.
    if openai_body.get("tool_choice") == "required":
        openai_body["tool_choice"] = "auto"
    # Sandboxed sessions can't reach the browser extension, so don't steer them
    # to it (that is the very dead-end this guard is trying to break).
    channel_hint = (
        "use `git clone` (git protocol) or WebFetch"
        if monitor.sandboxed
        else "use the browser tool or `git clone` (git protocol)"
    )
    directive = (
        "\n\nSTOP — you are repeating a failing action (" + reason + "). Do NOT "
        "retry the same tool or fetch again. If a resource is unreachable (e.g. a "
        "rate-limited GitHub REST API), switch channel: " + channel_hint + ", NOT "
        "api.github.com. If it is still "
        "unavailable, proceed WITHOUT it using what you already have, or ask the "
        "operator the single blocking question in one sentence. Take a DIFFERENT "
        "action now."
    )
    msgs = openai_body.get("messages")
    if not isinstance(msgs, list):
        msgs = []
    if msgs and msgs[0].get("role") == "system":
        msgs[0]["content"] = (msgs[0].get("content") or "") + directive
    else:
        msgs.insert(0, {"role": "system", "content": directive.strip()})
    openai_body["messages"] = msgs  # reattach in case messages was empty/absent
    logger.warning("STUCK-BREAK: forced terminal turn (%s, fires=%d)", reason, monitor.stuck_break_fires)


def _maybe_inject_error_loop_break(openai_body: dict, monitor: "SessionMonitor") -> None:
    """Nudge the model out of a repeated-same-error loop (ERROR-LOOP guardrail).

    When the SAME normalized tool_result error has recurred >= threshold times
    despite the model's (varied) edits, its edits aren't addressing the real
    blocker. Inject a directive to STOP editing and re-read the whole failing
    file/output — the bug is likely somewhere it hasn't looked. Advisory: does
    NOT release tool_choice (the model should keep acting, just diagnose first)."""
    if not PROXY_ERROR_LOOP:
        return
    if monitor.error_signature_streak < PROXY_ERROR_LOOP_THRESHOLD:
        return
    monitor.error_loop_fires += 1
    directive = (
        "\n\nSTOP — the SAME failure has now recurred "
        + str(monitor.error_signature_streak)
        + " times in a row despite your edits: \""
        + monitor.last_error_signature[:120]
        + "\". Your edits are NOT addressing the real cause. Do NOT make another "
        "edit yet. FIRST re-read the ENTIRE failing file (and the full error "
        "output) top-to-bottom — the bug is very likely somewhere you have not "
        "looked (a duplicate declaration, a wrong import, a different file). "
        "Only after you can name the exact line causing THIS error, fix that."
    )
    msgs = openai_body.get("messages")
    if not isinstance(msgs, list):
        msgs = []
    if msgs and msgs[0].get("role") == "system":
        msgs[0]["content"] = (msgs[0].get("content") or "") + directive
    else:
        msgs.insert(0, {"role": "system", "content": directive.strip()})
    openai_body["messages"] = msgs
    logger.warning(
        "ERROR-LOOP: same failure x%d — injected re-read nudge (sig=%r, fires=%d)",
        monitor.error_signature_streak,
        monitor.last_error_signature[:80],
        monitor.error_loop_fires,
    )


def _maybe_inject_deferral_break(openai_body: dict, monitor: "SessionMonitor") -> None:
    """Convert a turn-ending deferral into forward motion (Fix A).

    The model ended a turn with prose that DEFERS the work -- "I need more
    exploration cycles to complete the plan", "let me continue exploring" -- with
    no tool call, instead of taking the next build step. That stall is invisible
    to STUCK-BREAK (not a loop-admission phrase) and to recon-convergence (a
    no-tool turn never advanced its streak), so it silently ends a hands-free
    build. This forces the NEXT turn to ACT: it forces tool_choice and tells the
    model it will not be re-prompted. The INVERSE of STUCK-BREAK, which releases
    to a prose exit -- a deferral means work REMAINS.
    """
    should, reason = monitor.should_force_deferral_break()
    if not should:
        return
    # STUCK-BREAK (a self-aware loop wanting a prose exit) is the more urgent
    # signal; if it will fire this turn, yield to it rather than force a tool.
    stuck, _ = monitor.should_force_stuck_break()
    if stuck:
        return
    # Also yield to recon-convergence: once the no-write streak is deep enough
    # for recon to own the turn (it may strip tools / force a terminal summary),
    # a "keep building" deferral directive would directly contradict it.
    if monitor.recon_convergence_pending():
        return
    # Only force an action if there are tools to call and the choice is not
    # already pinned to a specific tool by an earlier guard.
    has_tools = bool(openai_body.get("tools"))
    if has_tools and openai_body.get("tool_choice") in (None, "auto"):
        openai_body["tool_choice"] = "required"
    monitor.deferral_break_fires += 1
    directive = (
        "\n\nCONTINUE AUTONOMOUSLY (" + reason + "). You do NOT need more "
        "exploration cycles, another pass, or permission, and you will NOT be "
        "re-prompted to keep going. Do the next concrete step of the plan NOW: "
        "pick the next un-built file/component and create it with the write tool "
        "(or run the next required command). Never end a turn with only a plan, a "
        "status note, or a request for more cycles -- take the action this turn."
    )
    msgs = openai_body.get("messages")
    if not isinstance(msgs, list):
        msgs = []
    if msgs and msgs[0].get("role") == "system":
        msgs[0]["content"] = (msgs[0].get("content") or "") + directive
    else:
        msgs.insert(0, {"role": "system", "content": directive.strip()})
    openai_body["messages"] = msgs  # reattach in case messages was empty/absent
    logger.warning(
        "DEFERRAL-BREAK: forced action turn (%s, fires=%d)",
        reason,
        monitor.deferral_break_fires,
    )


# MANDATE-DELIVER guardrail: delivery-enforcement blocks a direct source edit and
# tells the model to "call the `deliver` tool", but the enforcer's route:deliver
# signal is only honored by harnesses that understand it -- weak local models see
# the text and flail (RECON deadlock). This makes the routing BINDING for ANY
# model: on detecting the enforcer's block marker in the just-returned turn AND a
# deliver-class tool in the request, pin tool_choice to that tool so the next turn
# MUST call deliver. PROXY_MANDATE_DELIVER=off disables.
PROXY_MANDATE_DELIVER = os.environ.get("PROXY_MANDATE_DELIVER", "on").lower() not in {
    "0", "off", "false", "no",
}
# Enforcer-block-SPECIFIC phrases only (src/policies/enforcers/delivery_enforcement.py).
# Deliberately NOT matching the reactor's STANDING "route through deliver" guidance
# (which is injected every turn) -- only the actual block event must trigger.
_DELIVER_BLOCK_RE = re.compile(
    r"BLOCKED: do not edit|do NOT retry this edit|\"route\"\s*:\s*\"deliver\"",
    re.IGNORECASE,
)


def _deliver_tool_name(tools) -> "str | None":
    """Name of a deliver-class tool in the request (exact `deliver` or an
    MCP-namespaced `..._deliver`), or None when the agent has no deliver tool."""
    if not isinstance(tools, list):
        return None
    for t in tools:
        name = ((t.get("function", {}) or {}).get("name", "") or "")
        low = name.lower()
        if low == "deliver" or low.endswith("__deliver") or low.endswith("_deliver") or (
            "deliver" in low and "delivery" not in low
        ):
            return name
    return None


def _recent_text_has_block(messages) -> bool:
    """True when a user/tool message in the current turn's tail carries the
    delivery-enforcement block marker (a direct edit was just gated)."""
    if not isinstance(messages, list):
        return False
    for m in reversed(messages[-4:]):
        role = m.get("role")
        if role == "assistant":
            break  # older blocks belong to a prior, already-handled turn
        if role not in ("user", "tool"):
            continue
        content = m.get("content")
        text = ""
        if isinstance(content, str):
            text = content
        elif isinstance(content, list):
            parts = []
            for c in content:
                if isinstance(c, dict):
                    parts.append(c.get("text") or c.get("content") or "")
                else:
                    parts.append(str(c))
            text = " ".join(parts)
        if text and _DELIVER_BLOCK_RE.search(text):
            return True
    return False


def _assistant_already_called_deliver(messages, deliver_name: str) -> bool:
    """True if the MOST RECENT assistant turn already called the deliver tool --
    then we must NOT re-force (let the tool result return); prevents a force loop."""
    if not isinstance(messages, list):
        return False
    for m in reversed(messages):
        if m.get("role") != "assistant":
            continue
        for tc in (m.get("tool_calls") or []):
            if ((tc.get("function", {}) or {}).get("name", "") or "").lower() == deliver_name.lower():
                return True
        return False  # only inspect the latest assistant turn
    return False


def _maybe_inject_mandate_deliver(openai_body: dict, monitor: "SessionMonitor") -> None:
    """MANDATORY deliver-routing: when a direct source edit was just blocked by
    delivery-enforcement, force the next turn to call the `deliver` tool for ANY
    model. Pins tool_choice to the deliver tool + injects a terse directive.
    Runs before the softer guards so the pin stands. PROXY_MANDATE_DELIVER=off."""
    if not PROXY_MANDATE_DELIVER:
        return
    deliver_name = _deliver_tool_name(openai_body.get("tools"))
    if not deliver_name:
        return  # cannot mandate a tool the agent does not have
    messages = openai_body.get("messages")
    if not _recent_text_has_block(messages):
        return
    if _assistant_already_called_deliver(messages, deliver_name):
        return  # deliver is already in flight -- don't loop on it
    openai_body["tool_choice"] = {"type": "function", "function": {"name": deliver_name}}
    monitor.mandate_deliver_fires += 1
    directive = (
        "\n\nMANDATORY: your direct source edit was BLOCKED by delivery-enforcement. "
        "You MUST call the `" + deliver_name + "` tool now with a one-line description "
        "of the change. Do NOT retry the edit, do NOT claim the file is written, do "
        "NOT explain -- call `" + deliver_name + "` this turn. Deliver writes the "
        "files and verifies them against the gates."
    )
    msgs = openai_body.get("messages")
    if not isinstance(msgs, list):
        msgs = []
    if msgs and msgs[0].get("role") == "system":
        msgs[0]["content"] = (msgs[0].get("content") or "") + directive
    else:
        msgs.insert(0, {"role": "system", "content": directive.strip()})
    openai_body["messages"] = msgs
    logger.warning(
        "MANDATE-DELIVER: pinned tool_choice to deliver (tool=%s, fires=%d)",
        deliver_name, monitor.mandate_deliver_fires,
    )


def _maybe_inject_recon_convergence(
    openai_body: dict,
    monitor: "SessionMonitor",
    full_tools: list[dict] | None = None,
) -> None:
    """Nudge a session stuck in prolonged exploration toward its deliverable.

    Fires when `consecutive_no_write_turns` crosses
    PROXY_RECON_CONVERGENCE_THRESHOLD — the model has used tools for many
    turns without producing any write/deliverable tool call. Targets the
    observed failure mode of an agentic recon task wandering for hundreds
    of turns and never converging to the synthesis/write step. Two
    escalation tiers: a firm "switch to synthesis" directive, then a hard
    "STOP, write it now" once the streak crosses PROXY_RECON_HARD_MULTIPLIER
    x threshold (default 1.5x).

    `full_tools` is the request's tool list *before* `_narrow_tools_for_request`
    pruned it. When the directive fires, any write/deliverable tool that
    narrowing dropped is re-injected into `openai_body["tools"]` — narrowing
    scores tools against the (exploration-heavy) recon prompt and runs before
    this guardrail, so it routinely strips the very write tool the directive
    tells the model to use, leaving the directive impossible to satisfy.
    """
    if PROXY_RECON_CONVERGENCE_THRESHOLD <= 0:
        return
    streak = monitor.consecutive_no_write_turns
    if streak < PROXY_RECON_CONVERGENCE_THRESHOLD:
        return
    # Report the *raw* (pre-prune) utilization — post-prune util understates the
    # blow-up (~30%) and makes the directive's "context is at X%" misleading.
    util = max(monitor.get_utilization(), monitor.get_raw_utilization())
    hard = streak >= PROXY_RECON_HARD_MULTIPLIER * PROXY_RECON_CONVERGENCE_THRESHOLD
    escalate = False
    if hard:
        monitor.recon_hard_fires += 1  # Fix E: monotonic, never reset
        escalate = (
            PROXY_RECON_SESSION_HARD_CAP > 0
            and monitor.recon_hard_fires >= PROXY_RECON_SESSION_HARD_CAP
        )

    if escalate:
        # Fix E: the hard tier has fired repeatedly this session — the model
        # keeps writing just enough to reset consecutive_no_write_turns, then
        # re-diverges, sawtoothing the streak and re-triggering the hard tier
        # forever. Stop negotiating: strip tools so the model MUST emit a
        # terminal plain-text summary, breaking the sawtooth for good.
        directive = (
            f"STOP. You have hit the exploration limit {monitor.recon_hard_fires} "
            f"times in this session and context is at {util * 100:.0f}%. No tools "
            "are available this turn. Reply NOW with a plain-text summary of what "
            "you found and what remains — this ends the task."
        )
        tier = "hard-escalated"
    elif hard:
        directive = (
            f"STOP exploring. You have run {streak} consecutive turns of "
            f"exploration without producing a deliverable and context is at "
            f"{util * 100:.0f}%. You will NOT finish if you keep exploring. "
            "Produce your deliverable NOW from the information you already "
            "have — write it to a file with the appropriate tool. Do not "
            "read or run anything else."
        )
        tier = "hard"
    else:
        directive = (
            f"You have explored for {streak} consecutive turns without "
            f"producing a deliverable (context {util * 100:.0f}%). You have "
            "enough to begin. Switch from exploration to synthesis: write "
            "your deliverable now. Explore at most one more time, and only "
            "if strictly required to write it."
        )
        tier = "firm"
    # #1: if the harness is blocking direct writes (delivery-enforcement), a
    # "write the file" directive is impossible to satisfy and the model loops in
    # recon. Redirect it to the deliver tool — the only write path under a gate.
    if not escalate and _writes_are_gated(openai_body):
        directive += (
            " IMPORTANT: your direct Edit/Write calls are being BLOCKED by policy. "
            "Do NOT try to write the file directly. Call the `deliver` tool (or run "
            "`uap deliver \"<one-line task>\"`) to produce the deliverable — that is "
            "the only path that can write here."
        )
        tier = tier + "+deliver-gated"

    msgs = openai_body.get("messages", [])
    msgs.append({"role": "user", "content": directive})
    openai_body["messages"] = msgs

    restored: list[str] = []
    stripped: list[str] = []
    if escalate:
        # Strip tools entirely so the only possible response is terminal prose.
        openai_body.pop("tools", None)
        openai_body.pop("tool_choice", None)
        openai_body.pop("grammar", None)
        # POISON FIX (2026-06-22): reset the no-write streak after forcing the
        # terminal summary. Without this, escalate is a permanent death-spiral:
        # recon_hard_fires is monotonic so `escalate` stays true for the whole
        # session, and stripping tools means the model CAN'T write, so
        # consecutive_no_write_turns never falls back below threshold — every
        # subsequent request (including unrelated ones sharing the session
        # fingerprint) gets tools stripped forever, until a proxy restart.
        # Resetting the streak makes escalate a ONE-SHOT per window: it forces
        # a terminal summary once, then the next turn falls below threshold so
        # tools are restored; if the model genuinely keeps exploring without
        # writing it rebuilds the streak and re-fires — bounded, not permanent.
        monitor.consecutive_no_write_turns = 0
    else:
        # Fix C (hard) + Fix B (firm): drop the structural "must call a tool"
        # coercion at BOTH directive tiers. The state machine forces
        # tool_choice='required' during the active agentic loop; paired with a
        # "switch to synthesis / write your deliverable now" directive that is a
        # trap -- the model cannot terminate and, when it does not pick the
        # write tool, emits another read, so the streak climbs unbounded.
        # Releasing to 'auto' lets it write, call deliver, or stop. (Previously
        # only the hard tier released; the firm tier left the coercion on, which
        # is where the observed read-forever loop lived.)
        if openai_body.get("tool_choice") == "required" or hard:
            openai_body["tool_choice"] = "auto"
            openai_body.pop("grammar", None)
        # Re-inject any write/deliverable tool that narrowing dropped, so the
        # "write your deliverable" directive is actually satisfiable. Without
        # this the model is told to write but has no write tool to call, picks
        # another read tool, and the streak climbs unbounded.
        if full_tools:
            present = {
                (t.get("function", {}).get("name", "") or "").lower()
                for t in openai_body.get("tools", [])
            }
            for tool in full_tools:
                name = (tool.get("function", {}).get("name", "") or "")
                if name.lower() in _WRITE_TOOL_CLASS and name.lower() not in present:
                    openai_body.setdefault("tools", []).append(tool)
                    present.add(name.lower())
                    restored.append(name)

        # FORCE-WRITE (hard tier): a nudge that leaves BOTH read and write tools
        # available lets the model keep picking a read — the live failure mode
        # (no_write_streak climbing to 45+ while write tools were re-injected but
        # tool_choice stayed 'auto', so the model just read again). At the hard
        # tier, remove the exploration path (read-only class + escape hatches) so
        # the only actions left are write/deliver, and force tool_choice=required
        # so a write MUST happen this turn. Floor-guarded: if stripping would
        # leave no write path, leave the toolset untouched (never strand — the
        # firm tier keeps reads, the escalate tier strips everything). Bounded:
        # if the model still produces no write, the streak keeps climbing and the
        # next fire escalates to the terminal-summary tier above.
        if hard:
            tools_now = openai_body.get("tools") or []
            deny = {c.lower() for c in _READ_ONLY_TOOL_CLASS} | {
                e.lower() for e in _EXPLORATION_ESCAPE_TOOLS
            }
            write_lower = {w.lower() for w in _WRITE_TOOL_CLASS}

            def _rc_name(t: dict) -> str:
                return ((t.get("function", {}) or {}).get("name", "") or "").lower()

            kept = [t for t in tools_now if _rc_name(t) not in deny]
            if kept and any(_rc_name(t) in write_lower for t in kept):
                stripped = [
                    ((t.get("function", {}) or {}).get("name", "") or "")
                    for t in tools_now
                    if _rc_name(t) in deny
                ]
                if stripped:
                    openai_body["tools"] = kept
                    openai_body["tool_choice"] = "required"
                    openai_body.pop("grammar", None)

    logger.warning(
        "RECON CONVERGENCE: injected %s directive (no_write_streak=%d, hard_fires=%d, "
        "ctx=%.0f%%, tool_choice=%s, restored_write_tools=%s, stripped_read_tools=%s)",
        tier, streak, monitor.recon_hard_fires, util * 100,
        openai_body.get("tool_choice", "stripped"), restored or "none", stripped or "none",
    )


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

    # Translate Anthropic `thinking` parameter to upstream `enable_thinking`.
    # Anthropic shape: {"thinking": {"type": "enabled", "budget_tokens": 1024}}
    # or {"type": "disabled"}. Per the Anthropic spec, thinking is OFF by
    # default and ONLY enabled when the client opts in. Match that behaviour:
    #   - thinking.type == "enabled" -> enable_thinking=True
    #   - thinking.type == "disabled" or absent -> enable_thinking=False
    # Without this, Qwen's chat template (which defaults thinking ON) would
    # consume the client's max_tokens budget on internal reasoning, leaving
    # nothing for the visible answer.
    anthropic_thinking = anthropic_body.get("thinking")
    if isinstance(anthropic_thinking, dict):
        ttype = (anthropic_thinking.get("type") or "").lower()
        if ttype == "enabled":
            openai_body["enable_thinking"] = True
        else:
            openai_body["enable_thinking"] = False
    else:
        # Match Anthropic default: thinking off unless explicitly requested.
        openai_body["enable_thinking"] = False

    # Global thinking-off (G): apply to every request, not just tool turns.
    # Only applies when the client did NOT explicitly request thinking above.
    # Per-path tool-turn handling below (DISABLE_THINKING_ON_TOOL_TURNS) is
    # additive — ALWAYS supersedes when set.
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
        # When thinking is explicitly disabled (Anthropic default, plus our
        # tool-turn forcing) but the upstream model is Qwen — which emits
        # <think> blocks regardless of enable_thinking — append a strong
        # directive that suppresses internal reasoning. Without this, small
        # max_tokens budgets get fully consumed by the model's reasoning,
        # producing required_tool_miss retries (observed in Shannon workflows
        # with max_tokens=512 + tool_choice=required).
        if openai_body.get("enable_thinking") is False:
            supplement = supplement + _NO_THINKING_DIRECTIVE
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

        # Enforce configurable minimum floor for tool turns: the model needs
        # enough headroom to emit complete tool-call arguments (long heredocs,
        # full-function oldString/newString pairs, etc.) without hitting the
        # client-requested max_tokens in the middle of a JSON string. If the
        # client requested >= the floor we keep their value; short preflight
        # requests (max_tokens <= 1024) always skip the floor to avoid
        # inflating plan-generation turns.
        #
        # The earlier gating on PROXY_DISABLE_THINKING_ON_TOOL_TURNS was too
        # restrictive: it skipped the floor on every tool turn once thinking
        # was off, which re-introduced truncated tool calls on long edits.
        # Set PROXY_MAX_TOKENS_FLOOR=0 to disable the floor entirely.
        thinking_active_for_request = (
            has_tools
            and not PROXY_DISABLE_THINKING_ON_TOOL_TURNS
            and not PROXY_DISABLE_THINKING_ALWAYS
        )
        SMALL_PREFLIGHT_THRESHOLD = 1024
        # Qwen-style models emit <think> blocks regardless of the
        # enable_thinking flag (template ignored by trained behaviour).
        # For tool turns those blocks alone consume ~400-1000 tokens, so a
        # client-requested max_tokens < THINKING_MIN_FOR_TOOLS leaves no
        # budget for the tool_call itself — manifesting as required_tool_miss
        # retries (observed Shannon: max_tokens=512 + tools=7 -> ~5 retries
        # per turn). Bump up to THINKING_MIN_FOR_TOOLS for these requests.
        THINKING_MIN_FOR_TOOLS = 2048
        skip_floor = (
            not has_tools  # non-tool requests don't need the headroom
            or PROXY_MAX_TOKENS_FLOOR <= 0  # floor explicitly disabled
            or requested_raw <= SMALL_PREFLIGHT_THRESHOLD  # tiny preflight request
        )
        # Qwen-style models emit <think> blocks regardless of the
        # enable_thinking flag (template ignored by trained behaviour).
        # For tool turns those blocks alone consume ~400-1000 tokens, so a
        # client-requested max_tokens < THINKING_MIN_FOR_TOOLS leaves no
        # budget for the tool_call itself — manifesting as required_tool_miss
        # retries (observed Shannon: max_tokens=512 + tools=7 -> ~5 retries
        # per turn). Bump up to THINKING_MIN_FOR_TOOLS for these requests.
        THINKING_MIN_FOR_TOOLS = 2048
        # No-tool turns need thinking headroom too: evaluator calls (acceptance
        # judge, critic, ideation) request ~4096 max_tokens, Qwen spends all of
        # it inside <think>, the EMPTY-OUTPUT GUARD promotes truncated
        # reasoning as the body, and the caller gets an unparseable verdict —
        # observed live as every acceptance judgment failing. Bump small
        # no-tool budgets so the model can finish thinking AND answer.
        THINKING_MIN_NO_TOOLS = int(os.environ.get("PROXY_THINKING_MIN_NO_TOOLS", "8192"))
        if skip_floor:
            requested_max = requested_raw
            # Even when skipping the big floor, bump small tool-turn
            # budgets so Qwen's mandatory thinking has room before the
            # tool_call. Only applies when tools are present.
            if (
                has_tools
                and requested_raw < THINKING_MIN_FOR_TOOLS
                and requested_raw > 16  # leave true preflight (e.g. max_tokens=1) alone
            ):
                requested_max = THINKING_MIN_FOR_TOOLS
                logger.info(
                    "MAX_TOKENS thinking-floor: %d -> %d (tool turn, Qwen mandatory thinking)",
                    requested_raw,
                    requested_max,
                )
            elif (
                not has_tools
                and THINKING_MIN_NO_TOOLS > 0
                and requested_raw < THINKING_MIN_NO_TOOLS
                and requested_raw > 16  # leave true preflight alone
            ):
                requested_max = THINKING_MIN_NO_TOOLS
                logger.info(
                    "MAX_TOKENS thinking-floor (no-tool): %d -> %d (Qwen mandatory thinking; evaluator verdicts need room after <think>)",
                    requested_raw,
                    requested_max,
                )
            elif requested_raw < PROXY_MAX_TOKENS_FLOOR and PROXY_MAX_TOKENS_FLOOR > 0:
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
    # Cycle 15 Option 2: use lower temperature after contamination resets.
    # Attractor escape: when an attractor correction is active, OVERRIDE the
    # low-temp default with a HIGH-temp sample so the deterministic output
    # trajectory has a chance to break. Single-turn override (cleared on
    # successful tool_use further down in the response handler).
    if has_tools:
        client_temp = openai_body.get("temperature")
        target_temp = PROXY_TOOL_TURN_TEMPERATURE
        attractor_active = getattr(monitor, "attractor_correction_active", False)
        if attractor_active:
            target_temp = max(target_temp, PROXY_ATTRACTOR_TEMP_OVERRIDE)
            openai_body["temperature"] = target_temp
            logger.info(
                "TOOL TURN TEMP: ATTRACTOR ESCAPE temperature=%.2f (was %s)",
                target_temp,
                client_temp,
            )
        else:
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
    full_openai_tools: list[dict] = []
    if has_tools:
        openai_body["tools"] = _convert_anthropic_tools_to_openai(
            anthropic_body.get("tools", [])
        )
        # Keep the full (pre-narrowing) list so the recon-convergence
        # guardrail can restore a write tool that narrowing dropped.
        full_openai_tools = openai_body["tools"]
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

        # CONTEXT DEATH-SPIRAL BREAKER (Fix F): raw incoming context has been
        # catastrophically over the window for several consecutive turns. The
        # LOOP BREAKER already released tool_choice to 'auto', but the model
        # keeps voluntarily emitting tool calls and the client keeps resending a
        # growing transcript, so the loop never ends. Strip tools entirely so
        # the only possible output is a terminal text summary (end_turn), which
        # ends the client's agentic loop. Gated high (raw ctx >= 300% for >= N
        # turns) so only a true runaway trips it, never a merely-full session.
        if (
            PROXY_RAW_CTX_FINALIZE_STREAK > 0
            and monitor.catastrophic_ctx_streak >= PROXY_RAW_CTX_FINALIZE_STREAK
        ):
            openai_body.pop("tool_choice", None)
            openai_body.pop("tools", None)
            openai_body.pop("grammar", None)
            msgs = openai_body.get("messages", [])
            msgs.append({
                "role": "user",
                "content": (
                    "The conversation has exceeded the context window "
                    f"({monitor.get_raw_utilization() * 100:.0f}%) and cannot "
                    "continue. No tools are available. Reply with a brief "
                    "plain-text summary of what was accomplished and what "
                    "remains, then stop."
                ),
            })
            openai_body["messages"] = msgs
            monitor.reset_tool_turn_state(reason="context_death_spiral_breaker")
            logger.error(
                "CONTEXT DEATH-SPIRAL BREAKER: raw ctx %.0f%% for %d consecutive "
                "turns -- stripped tools to force terminal summary (end_turn).",
                monitor.get_raw_utilization() * 100,
                monitor.catastrophic_ctx_streak,
            )
            if PROXY_DISABLE_THINKING_ON_TOOL_TURNS:
                openai_body["enable_thinking"] = False
            if PROXY_DISABLE_SPEC_ON_TOOL_TURNS:
                openai_body["speculative.n_max"] = 0
            return openai_body

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

        # TURN-COUNT FINALIZE BREAKER (mode-B runaway backstop): the model keeps
        # emitting distinct, well-formed tool calls and never emits end_turn, so
        # none of the other terminal paths engage and 'release to auto' just lets
        # it keep choosing tools — it loops to the client's agent timeout. After a
        # high tool-turn ceiling, strip tools so the only possible output is a
        # terminal text summary (end_turn), ending the loop. Gated HIGH so only a
        # genuine runaway trips it; see PROXY_HARD_FINALIZE_TURNS.
        if PROXY_HARD_FINALIZE_TURNS > 0:
            _agent_tool_turns = _count_agent_tool_turns(anthropic_body)
            # PERIODIC, not permanent: fire once each time the count crosses
            # another `ceiling` worth of tool turns past the last firing. Without
            # the `last + ceiling` gate this fires on EVERY turn past the first
            # crossing (the count only grows), permanently denying tools and
            # stalling a long-but-legitimate task. Between fires tools are restored
            # so the agent keeps making progress.
            if _agent_tool_turns >= monitor.last_hard_finalize_turn_count + PROXY_HARD_FINALIZE_TURNS:
                monitor.last_hard_finalize_turn_count = _agent_tool_turns
                openai_body.pop("tool_choice", None)
                openai_body.pop("tools", None)
                openai_body.pop("grammar", None)
                msgs = openai_body.get("messages", [])
                msgs.append({
                    "role": "user",
                    "content": (
                        f"You have made {_agent_tool_turns} tool calls. Pause for a "
                        "progress checkpoint: in a brief plain-text summary, state "
                        "what is done and the single most important next step. No "
                        "tools are available this turn — do NOT emit any tool call "
                        "or tool-call-like syntax. If the task is complete, say so; "
                        "otherwise you will continue on the next turn."
                    ),
                })
                openai_body["messages"] = msgs
                monitor.reset_tool_turn_state(reason="turn_count_finalize_breaker")
                # Tools were stripped to force a terminal text summary; do not let
                # the response-side extractor resurrect prose tool-calls (which
                # would defeat the breaker and continue the loop).
                monitor.suppress_text_tool_extraction = True
                logger.warning(
                    "TURN-COUNT FINALIZE BREAKER: %d agent tool turns >= ceiling %d "
                    "-- stripped tools to force terminal summary (end_turn).",
                    _agent_tool_turns,
                    PROXY_HARD_FINALIZE_TURNS,
                )
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
            # Fix H/J (2026-04-22): Do NOT strip tools from the body on
            # cycle-limit finalize. Stripping tools lets the model emit
            # prose that LOOKS like a tool call ("<function=edit>…") but
            # has no structured tool_calls array, so the Anthropic client
            # sees end_turn with no action and halts. Instead, keep tools
            # available, set tool_choice=auto, and nudge the model to
            # either complete with a tool call OR emit a proper summary.
            # Grammar (when PROXY_TOOL_CALL_GRAMMAR_REQUIRED_ONLY=off) will
            # still constrain tool-call emission to valid JSON format.
            openai_body["tool_choice"] = "auto"
            monitor.finalize_turn_active = True
            monitor.finalize_hard_stop_count += 1  # monotonic marker: a finalize fired this session
            monitor.consecutive_forced_count = 0
            monitor.no_progress_streak = 0
            finalize_instruction = {
                "role": "user",
                "content": (
                    "You have been looping on the same tools for several turns. "
                    "Wrap up: either emit ONE decisive tool call that completes "
                    "the task, or reply with a plain-text summary of what you "
                    "accomplished and what is blocking further progress. Do NOT "
                    "emit tool call text in prose form — if you call a tool, do "
                    "it through the structured tool_call mechanism."
                ),
            }
            msgs = openai_body.get("messages", [])
            msgs.append(finalize_instruction)
            logger.warning(
                "TOOL STATE MACHINE: finalize turn (reason=%s) — tools kept, tool_choice=auto",
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
                original_count = len(openai_body["tools"])
                # Drop cycling/banned tools (and the read-only class if any
                # cycling tool is read-only) but always keep the exploration
                # escape hatch — see _narrow_tools_for_cycle_break.
                narrowed, expanded_read_only = _narrow_tools_for_cycle_break(
                    openai_body["tools"],
                    monitor.cycling_tool_names,
                    monitor.session_banned_tools,
                )
                if narrowed:
                    openai_body["tools"] = narrowed
                    # Only log on first activation or phase transitions to reduce noise
                    if state_reason in {"cycle_detected", "stagnation"}:
                        logger.warning(
                            "CYCLE BREAK: narrowed tools from %d to %d (excluded %s, read_only_class=%s)",
                            original_count,
                            len(narrowed),
                            monitor.cycling_tool_names,
                            expanded_read_only,
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

    # Recon-convergence guardrail (B1) — runs on every built request so a
    # session wandering in exploration without producing a write is nudged
    # toward its deliverable regardless of tool-turn phase. Passed the full
    # pre-narrowing toolset so it can restore a dropped write tool.
    # MANDATE-DELIVER: a just-blocked direct edit MUST route to the deliver tool
    # (makes the enforcer's route:deliver signal binding for any model). Runs first
    # so the forced tool_choice pins before the softer guards.
    _maybe_inject_mandate_deliver(openai_body, monitor)

    _maybe_inject_recon_convergence(openai_body, monitor, full_openai_tools)

    _maybe_inject_stuck_break(openai_body, monitor)

    # ERROR-LOOP: same tool_result failure recurring despite varied edits.
    _maybe_inject_error_loop_break(openai_body, monitor)

    # DEFERRAL-BREAK (Fix A): after stuck-break, drive a no-tool deferral turn
    # into a concrete action. Runs last so it can yield to stuck-break.
    _maybe_inject_deferral_break(openai_body, monitor)

    _apply_thinking_grammar(openai_body)

    _apply_json_response_grammar(openai_body, anthropic_body)

    # qwen3.5-enhanced.jinja (the MTP/130 config template) rejects an assistant
    # PREFILL (trailing assistant message) unless thinking is disabled VIA
    # chat_template_kwargs — the top-level `enable_thinking` flag is not read by
    # this template, so a prefill otherwise 400s ("Assistant response prefill is
    # incompatible with enable_thinking"). There is nothing to think about on a
    # continuation, so disable thinking the way the template actually reads.
    _final_msgs = openai_body.get("messages") or []
    if _final_msgs and isinstance(_final_msgs[-1], dict) and _final_msgs[-1].get("role") == "assistant":
        ctk = openai_body.setdefault("chat_template_kwargs", {})
        if isinstance(ctk, dict):
            ctk["enable_thinking"] = False
        openai_body.pop("enable_thinking", None)

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
    # ERROR-LOOP tracking: feed the monitor the most recent tool_result text so a
    # recurring same-failure signature can be detected across (varied) edits.
    _latest_tr = ""
    for _m in reversed(messages):
        _c = _m.get("content")
        if isinstance(_c, list):
            _parts = [
                _extract_text(b.get("content", ""))
                for b in _c
                if isinstance(b, dict) and b.get("type") == "tool_result"
            ]
            if _parts:
                _latest_tr = "\n".join(p for p in _parts if p)
                break
    monitor.note_tool_result_error(_latest_tr)
    tool_fingerprints = []
    tool_targets: dict[str, str] = {}
    assistant_had_text = False  # Fix B: did the last assistant turn emit prose?
    for msg in reversed(messages):
        if msg.get("role") != "assistant":
            continue
        content = msg.get("content")
        if isinstance(content, str) and content.strip():
            assistant_had_text = True
        if isinstance(content, list):
            for block in content:
                if (
                    isinstance(block, dict)
                    and block.get("type") == "text"
                    and str(block.get("text", "")).strip()
                ):
                    assistant_had_text = True
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
    # Fix B: no tool call in the last assistant turn. A plain-text turn is still
    # a non-write turn, so advance the recon-convergence streak (previously it
    # only moved on tool turns, freezing the counter through prose-only stalls).
    # Guard on real prose so an empty/absent assistant turn never inflates it.
    if assistant_had_text:
        monitor.note_no_tool_turn()
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


def _count_agent_tool_turns(anthropic_body: dict) -> int:
    """Count assistant turns that emitted at least one tool_use block — i.e. how
    many tool-using steps the agent has already taken in the (post-prune)
    transcript. Used by the TURN-COUNT FINALIZE BREAKER to detect mode-B
    runaways that never converge. Counting from the possibly-pruned history is
    intentional: a pruning-heavy legitimate long session keeps a low post-prune
    count and is left alone, while a small-context non-terminating loop (no
    pruning) accumulates turns until the ceiling trips."""
    n = 0
    for msg in anthropic_body.get("messages", []):
        if msg.get("role") != "assistant":
            continue
        content = msg.get("content")
        if isinstance(content, list) and any(
            isinstance(b, dict) and b.get("type") == "tool_use" for b in content
        ):
            n += 1
    return n


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


def _hash_fault_excerpt(excerpt: str) -> str:
    """Stable hash of a fault excerpt for attractor-repeat detection. Lowercased
    + whitespace-collapsed so trivial rendering differences don't break the match."""
    if not excerpt:
        return ""
    normalized = " ".join(excerpt.lower().split())[:200]
    if not normalized:
        return ""
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:16]


def _extract_openai_tool_calls(openai_resp: dict) -> list[dict]:
    _, message = _extract_openai_choice(openai_resp)
    tool_calls = message.get("tool_calls") or []
    return tool_calls if isinstance(tool_calls, list) else []


def _openai_has_tool_calls(openai_resp: dict) -> bool:
    return bool(_extract_openai_tool_calls(openai_resp))


def _json_close_suffix(fragment: str) -> str:
    """Minimal suffix that closes a truncated JSON fragment so it parses.

    Streamed tool-call arguments cut off by the token limit (finish_reason=
    length) used to reach the client as unterminated JSON — Claude Code then
    throws InputValidationError ("could not be parsed as JSON ... first 200 of
    N bytes") and retries into the same wall. Scanning with the same
    in-string/escape/nesting rules a JSON parser uses, this returns the
    characters needed to terminate the fragment: a visible truncation marker +
    closing quote when cut mid-string, then closers for every open object /
    array. Returns '' when the fragment already parses (or is empty).
    """
    if not fragment:
        return ""
    try:
        json.loads(fragment)
        return ""
    except Exception:
        pass
    stack: list[str] = []
    in_string = False
    escaped = False
    for ch in fragment:
        if in_string:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                in_string = False
            continue
        if ch == '"':
            in_string = True
        elif ch in "{[":
            stack.append("}" if ch == "{" else "]")
        elif ch in "}]" and stack:
            stack.pop()
    suffix = ""
    if in_string:
        if escaped:
            suffix += "\\"  # complete the dangling escape as a literal backslash
        suffix += "\u2026[TRUNCATED BY TOKEN LIMIT]\""
    suffix += "".join(reversed(stack))
    return suffix


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

# Hermes-style XML function call format emitted by some Qwen/Llama fine-tunes
# when grammar is not applied:
#   <function=name>
#   <parameter=key>
#   value
#   </parameter>
#   ...
#   </function>
#
# The value of a <parameter=KEY> block may span multiple lines and include
# arbitrary characters (code snippets, JSON, quotes). The closing
# </parameter> tag may be missing if the model emitted EOS prematurely —
# in which case we consume up to the next <parameter=...> tag or end of
# string. Names are captured as alphanumeric + underscore to avoid pulling
# in attribute-like garbage.
_HERMES_FUNCTION_RE = re.compile(
    r"<function=([A-Za-z_][A-Za-z0-9_]*)>(.*?)(?:</function>|\Z)",
    re.DOTALL,
)
_HERMES_PARAMETER_RE = re.compile(
    r"<parameter=([A-Za-z_][A-Za-z0-9_]*)>\s*(.*?)\s*(?=</parameter>|<parameter=|\Z)",
    re.DOTALL,
)


def _extract_hermes_tool_calls(text: str) -> tuple[list[dict], str]:
    """Parse Hermes-style ``<function=name><parameter=k>v</parameter></function>``
    blocks out of *text*. Used as a fallback when the Qwen JSON format
    (``<tool_call>{...}</tool_call>``) is not present — for example on
    finalize turns where grammar does not constrain the output. Tolerates
    premature EOS (missing closing ``</parameter>`` / ``</function>``)."""
    if "<function=" not in text:
        return [], text

    extracted: list[dict] = []
    matched_spans: list[tuple[int, int]] = []

    for fn_match in _HERMES_FUNCTION_RE.finditer(text):
        name = fn_match.group(1).strip()
        body = fn_match.group(2) or ""
        if not name:
            continue
        args: dict = {}
        for p_match in _HERMES_PARAMETER_RE.finditer(body):
            key = p_match.group(1).strip()
            value = p_match.group(2)
            if key:
                # Strip one leading newline that the template usually adds
                # but preserve interior whitespace (code indentation, etc.)
                if value.startswith("\n"):
                    value = value[1:]
                args[key] = value
        extracted.append(
            {
                "id": f"toolu_{uuid.uuid4().hex[:24]}",
                "type": "function",
                "function": {
                    "name": name,
                    "arguments": json.dumps(args, separators=(",", ":")),
                },
            }
        )
        matched_spans.append(fn_match.span())

    if not extracted:
        return [], text

    # Remove matched function blocks from text (plus any dangling
    # <tool_call>/</tool_call> wrappers around them).
    remaining = text
    for start, end in reversed(matched_spans):
        remaining = remaining[:start] + remaining[end:]
    # Strip leftover <tool_call>…</tool_call> envelopes that now enclose
    # nothing useful.
    remaining = re.sub(r"<tool_call>\s*</tool_call>", "", remaining, flags=re.DOTALL)
    remaining = remaining.strip()

    logger.info(
        "TOOL CALL EXTRACTION: recovered %d Hermes-format tool call(s) from text content",
        len(extracted),
    )
    return extracted, remaining


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
                "id": f"toolu_{uuid.uuid4().hex[:24]}",
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
                    "id": f"toolu_{uuid.uuid4().hex[:24]}",
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



def _repair_tool_call_json(raw: str) -> str | None:
    """Attempt to repair common garbled JSON in tool call payloads.

    Returns repaired JSON string, or None if repair is not possible.
    Handles: trailing braces, unbalanced brackets, truncated strings.
    """
    s = raw.strip()
    if not s.startswith("{"):
        return None
    # Strip runaway trailing closers (safe: only removes excess closers at the
    # very end, where count is already unbalanced).
    while s.endswith("}}") and s.count("{") < s.count("}"):
        s = s[:-1]
    while s.endswith("]]") and s.count("[") < s.count("]"):
        s = s[:-1]
    # Balance braces by APPENDING closers only — never delete or trim interior
    # content. A lossy tail-trim silently drops a truncated trailing field (e.g.
    # a cut-off Write "content"), producing empty/partial files like the 0-byte
    # "audio.j" seen in octopus_invaders. If the payload was genuinely truncated
    # mid-value, appending closers won't yield valid JSON → return None so the
    # caller routes it to the existing truncated_tool_args retry path instead of
    # executing a content-less tool call.
    open_b = s.count("{") - s.count("}")
    if open_b > 0:
        s += "}" * open_b
    elif open_b < 0:
        # Too many closers and not a simple runaway-tail case: can't fix by
        # appending without deleting interior content. Bail out non-destructively.
        return None
    try:
        json.loads(s)
        return s
    except json.JSONDecodeError:
        return None


def _extract_tool_calls_from_text(
    text: str, available_tools: list[dict] | None = None
) -> tuple[list[dict], str]:
    """Parse ``<tool_call>{...}</tool_call>`` blocks out of *text*.

    Returns a tuple of (extracted_openai_tool_calls, remaining_text).
    Each extracted call is in OpenAI ``tool_calls`` format::

        {"id": "...", "type": "function", "function": {"name": "...", "arguments": "..."}}

    The *remaining_text* has the matched ``<tool_call>`` blocks removed.
    If no valid blocks are found the original text is returned unchanged.
    Falls back to Hermes-style ``<function=X><parameter=K>V</parameter></function>``
    for older Qwen/Llama fine-tunes, then to Gemma 4's
    ``<|tool_call>call:N{...}<tool_call|>`` DSL and ```json``` markdown
    blocks. Anything not matching any known format falls through unchanged
    so plain prose passes the parser without mutation.
    """
    if (
        "<tool_call>" not in text
        and "<function=" not in text
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
                "id": f"toolu_{uuid.uuid4().hex[:24]}",
                "type": "function",
                "function": {"name": name, "arguments": arguments},
            }
        )

    if not extracted:
        # Fall back to Hermes format. This catches Qwen emissions on finalize
        # turns where grammar is not applied and the model defaults to its
        # base training's <function=X><parameter=K>V</parameter></function>
        # format instead of the <tool_call>{JSON}</tool_call> Qwen template
        # format. Without this path, tool_calls=[] and the client halts.
        hermes_calls, hermes_remaining = _extract_hermes_tool_calls(text)
        if hermes_calls:
            return hermes_calls, hermes_remaining
        # Then try Gemma 4's DSL + markdown-JSON fallback. Anything still
        # not matching falls through as plain text.
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

    # When the upstream response was cut off by max_tokens (finish_reason=length),
    # any garbled/unbalanced-brace appearance in the tool args is almost
    # certainly truncation, not degenerate generation. Re-classify such
    # issues as "truncated_tool_args" so the caller can still retry (with a
    # larger cap) but WITHOUT triggering the forced-tool dampener, which
    # otherwise penalises a perfectly-recoverable truncation event.
    choice_for_finish, _ = _extract_openai_choice(openai_resp)
    finish_reason = (choice_for_finish.get("finish_reason") or "").lower()
    was_truncated = finish_reason == "length"

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
            # Downgrade invalid_tool_args to truncated_tool_args when the
            # response hit max_tokens — retry path still fires but the
            # dampener/streak counters stay cold.
            if was_truncated and issue.kind == "invalid_tool_args":
                return ToolResponseIssue(
                    kind="truncated_tool_args",
                    reason=(
                        f"tool call for '{tool_name}' truncated by max_tokens "
                        f"({issue.reason})"
                    ),
                    retry_hint=issue.retry_hint,
                )
            return issue

    return ToolResponseIssue()


# 2026-05-12: Regex for the tool-XML tag scanner. Captures opening vs
# closing form (group 1: "/" or ""), the tag name (group 2), and any
# attributes (group 3). Matches <parameter>, <parameter=key>,
# <parameter name="key">, </parameter>, <function=name>, </function>.
_TOOL_XML_TAG_RE = re.compile(r"<(/?)(parameter|function)\b([^>]*)>")


def _strip_orphan_tool_xml(text: str) -> str:
    """Remove orphan </parameter> and </function> closing tags that have
    no matching opener earlier in the text.

    Qwen3.6 trained on the qwen3_coder XML format leaks these closers
    after its actual answer when forced into tool_choice='required' with
    no genuine tool to call. The closers are training residuals, not real
    malformed tool-call markup — keeping them in the text causes the
    primary_markers branch of _looks_malformed_tool_payload to fire on
    every clean-but-runaway-shaped response. Real malformed tool-call
    attempts always have at least one matching opener ('<parameter' or
    '<function='), which the regex preserves, so primary_markers still
    fires correctly on genuine bad output.
    """
    if "</parameter" not in text and "</function" not in text:
        return text

    out: list[str] = []
    pos = 0
    open_param = 0
    open_func = 0
    for m in _TOOL_XML_TAG_RE.finditer(text):
        out.append(text[pos:m.start()])
        is_close = m.group(1) == "/"
        tag = m.group(2)
        if is_close:
            if tag == "parameter":
                if open_param > 0:
                    open_param -= 1
                    out.append(m.group(0))
            else:  # function
                if open_func > 0:
                    open_func -= 1
                    out.append(m.group(0))
            # else: orphan closer, skip (strip)
        else:
            if tag == "parameter":
                open_param += 1
            else:
                open_func += 1
            out.append(m.group(0))
        pos = m.end()
    out.append(text[pos:])
    return "".join(out)


def _looks_malformed_tool_payload(text: str) -> bool:
    if not text:
        return False

    # 2026-05-12: Strip balanced <think>...</think> blocks before applying
    # the heuristic. Qwen3.6 emits <think> blocks regardless of
    # enable_thinking, and two scenarios were tripping false positives:
    #   1. Meta-tool reasoning inside the thinking ({"description":...},
    #      repeated "must call a tool") triggering the structural-marker
    #      and policy-echo branches.
    #   2. The model wrapping its ENTIRE answer inside a single <think>
    #      block (markdown reports, tables) — the </think> structural
    #      marker plus content-resembling-policy then fires.
    # Downstream response processing surfaces <think> content as proper
    # Anthropic `thinking` blocks via _THINKING_BLOCK_RE, so stripping
    # here loses no information. Unbalanced/stray </think> without a
    # matching opener is NOT stripped — those remain genuinely malformed.
    if "<think>" in text and "</think>" in text:
        text = _THINKING_BLOCK_RE.sub("", text)
        if not text.strip():
            return False

    # 2026-06-27: Also strip a trailing UNCLOSED <think> (opener present, no
    # matching </think>). Under `--reasoning auto` the model frequently runs out
    # of its token budget mid-reasoning, emitting
    #   "<think> ...let me write files via multiple sandbox calls... args="
    # with no </think>. That is TRUNCATED reasoning, not a malformed tool call —
    # but the balanced-only strip above left it intact, so the meta-tool talk
    # inside it tripped the structural-marker / apology branches below
    # (false-positive malformed_payload that stalled agentic builds, e.g. the
    # Octopus Invaders generation: ~11 false rejections in 40 min). Drop from the
    # first opener to end; KEEP any text before it so a genuine malformed payload
    # preceding the reasoning is still detected.
    if "<think>" in text and "</think>" not in text:
        text = text[: text.index("<think>")]
        if not text.strip():
            return False

    # 2026-05-12: Strip orphan </parameter> and </function> closers that
    # have no matching opener. Qwen3.6 leaks these training residuals
    # after its visible answer when forced into tool_choice='required'
    # with no valid tool to call. Real malformed tool-call attempts retain
    # their opener and still trip the primary_markers check below.
    text = _strip_orphan_tool_xml(text)
    if not text.strip():
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


def _is_empty_maxtokens_response(openai_resp: dict) -> bool:
    """A finish_reason=length turn that produced NO content and NO tool calls —
    the thinking-runaway signature (all budget spent in reasoning_content)."""
    choices = openai_resp.get("choices") or []
    if not choices:
        return False
    choice = choices[0]
    if (choice.get("finish_reason") or "").lower() != "length":
        return False
    msg = choice.get("message") or {}
    if msg.get("tool_calls"):
        return False
    content = msg.get("content")
    text = content if isinstance(content, str) else ""
    return len(text.strip()) == 0


async def _apply_empty_maxtokens_recovery(
    client: httpx.AsyncClient,
    openai_resp: dict,
    openai_body: dict,
    anthropic_body: dict,
    monitor: SessionMonitor,
    session_id: str,
) -> dict:
    """Option 3 backstop: recover an empty finish=length turn by retrying once
    with thinking OFF, so a residual reasoning-runaway yields a usable answer
    instead of an empty response the client blindly re-sends (529 cascade)."""
    if not PROXY_EMPTY_MAXTOKENS_RECOVER:
        return openai_resp
    if not _is_empty_maxtokens_response(openai_resp):
        return openai_resp
    retry_body = dict(openai_body)
    retry_body["enable_thinking"] = False
    ctk = dict(retry_body.get("chat_template_kwargs") or {})
    ctk["enable_thinking"] = False
    retry_body["chat_template_kwargs"] = ctk
    requested = int(openai_body.get("max_tokens") or PROXY_EMPTY_MAXTOKENS_RETRY_MAX_TOKENS)
    retry_body["max_tokens"] = min(requested, PROXY_EMPTY_MAXTOKENS_RETRY_MAX_TOKENS)
    logger.warning(
        "EMPTY-MAX_TOKENS recovery: thinking-runaway (empty finish=length) for "
        "session %s — retrying once with thinking OFF (max_tokens=%d)",
        session_id, retry_body["max_tokens"],
    )
    try:
        retry_resp = await client.post(
            f"{LLAMA_CPP_BASE}/chat/completions",
            json=retry_body,
            headers={"Content-Type": "application/json"},
        )
        if retry_resp.status_code != 200:
            return openai_resp
        retried = retry_resp.json()
        if not _is_empty_maxtokens_response(retried):
            monitor.empty_maxtokens_recoveries += 1
            logger.info(
                "EMPTY-MAX_TOKENS recovery succeeded for session %s (recoveries=%d)",
                session_id, monitor.empty_maxtokens_recoveries,
            )
            return retried
    except Exception as exc:  # noqa: BLE001 — recovery is best-effort
        logger.warning("EMPTY-MAX_TOKENS recovery errored for session %s: %s", session_id, exc)
    return openai_resp


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
            "Do not output prose, markdown, XML tags, or schema snippets. "
            "Do NOT use <think>...</think> blocks or internal reasoning — "
            "emit the tool_call object as the very first token of your response."
        )
    else:
        retry_instruction = (
            "Your previous response had invalid tool-call formatting. "
            "If a tool is needed, emit exactly one valid tool call with strict JSON arguments. "
            "If no tool is needed for this turn, return concise plain text with no protocol tags. "
            "Do NOT use <think>...</think> blocks — start your response directly with "
            "either a tool_call or the plain text answer."
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
            if monitor.attractor_correction_active:
                logger.info(
                    "ATTRACTOR ESCAPE succeeded: session=%s — tool_use emitted, clearing attractor flag",
                    session_id,
                )
                monitor.attractor_correction_active = False
                monitor.last_fault_excerpt_hash = ""
        if repair_count > 0:
            monitor.arg_preflight_repairs += repair_count
            logger.info(
                "TOOL ARG REPAIR: session=%s repaired=%d source=initial",
                session_id,
                repair_count,
            )
        return working_resp

    # Only set last_response_garbled for TRUE degenerate generation, not
    # for responses merely truncated by max_tokens — otherwise the next
    # turn gets hit with the garbled_cap (smaller max_tokens) and the
    # problem compounds.
    if issue.kind != "truncated_tool_args":
        monitor.last_response_garbled = True

    if issue.kind == "malformed_payload":
        monitor.malformed_tool_streak += 1
    elif issue.kind == "invalid_tool_args":
        monitor.invalid_tool_call_streak += 1
        monitor.arg_preflight_rejections += 1

    # Truncation is a max_tokens accident, not the model misbehaving: don't
    # feed it to the forced-tool dampener, which would otherwise relax
    # tool_choice on the very next turn and let the model trail off with
    # text (the exact failure mode that stopped opencode).
    if issue.kind != "truncated_tool_args":
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
    # Attractor detection — hash the normalized fault excerpt so the
    # contamination breaker can recognize the same fixed-point response
    # reappearing across consecutive resets. Whitespace-normalized so trivial
    # rendering differences don't break the match.
    monitor.last_fault_excerpt_hash = _hash_fault_excerpt(excerpt)
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
            # 2026-05-12: Fix #2 — do NOT reset malformed/invalid/miss streaks
            # to 0 on retry-success. Previously, sessions stuck in a
            # malformed→retry-success loop never accumulated enough streak to
            # trigger the forced-tool dampener. Healthy responses with real
            # tool_calls still reset the streak via the upstream no-issue path
            # (~L5655), so genuine recovery still resets counters; only
            # repeated retry-recoveries persist toward the dampener.
            monitor.last_response_garbled = False
            logger.info(
                "TOOL RESPONSE RETRY success: kind=%s attempt=%d/%d malformed_streak=%d",
                current_issue.kind,
                attempt + 1,
                attempts,
                monitor.malformed_tool_streak,
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

        # Truncation on retry is still a max_tokens problem, not a model
        # misbehaviour — don't dampen. The outer retry loop will try again.
        if retry_issue.kind != "truncated_tool_args":
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


def _extract_state_carryover(messages: list[dict], max_files: int = 20) -> str | None:
    """Reconstruct mission state (plan + files written) from a conversation that
    is about to be pruned by the contamination breaker, so the reset does not
    throw away what the build has planned and done.

    The contamination/attractor reset keeps only the first user turn (+ a short
    tail), dropping the middle of the conversation — which is where the TodoWrite
    plan and the file-write actions live. On a huge build that drop destroys
    mission state: the model then re-explores from scratch, regrows the history,
    overflows again, and thrashes. The client's on-disk ledger is not visible to
    the proxy, but the plan and the writes ARE in the message stream, so
    reconstruct a compact carryover from them and re-inject it after the reset.

    Returns a carryover block, or None when no state is found (fresh session).
    """
    write_lower = {w.lower() for w in _WRITE_TOOL_CLASS}
    plan_tools = {
        "todowrite", "taskcreate", "taskupdate", "task_create", "task_update",
        "todo_write", "update_todo_list",
    }
    latest_plan: list[str] = []
    files: list[str] = []
    seen: set[str] = set()
    for m in messages:
        if not isinstance(m, dict) or m.get("role") != "assistant":
            continue
        content = m.get("content")
        if not isinstance(content, list):
            continue
        for block in content:
            if not isinstance(block, dict) or block.get("type") != "tool_use":
                continue
            name = (block.get("name") or "").lower()
            inp = block.get("input") if isinstance(block.get("input"), dict) else {}
            if name in plan_tools:
                todos = inp.get("todos") or inp.get("tasks") or inp.get("items")
                if isinstance(todos, list):
                    rendered = []
                    for t in todos:
                        if not isinstance(t, dict):
                            continue
                        text = (
                            t.get("content") or t.get("title")
                            or t.get("task") or t.get("description") or ""
                        ).strip()
                        if not text:
                            continue
                        status = (t.get("status") or t.get("state") or "").strip().lower()
                        mark = {
                            "completed": "x", "done": "x", "complete": "x",
                            "in_progress": "~", "in-progress": "~", "active": "~",
                        }.get(status, " ")
                        rendered.append(f"  [{mark}] {text}")
                    if rendered:
                        latest_plan = rendered  # keep the MOST RECENT plan only
            elif name in write_lower:
                path = (
                    inp.get("file_path") or inp.get("path")
                    or inp.get("target") or inp.get("filename") or inp.get("task")
                )
                if isinstance(path, str) and path.strip() and path not in seen:
                    seen.add(path)
                    files.append(path.strip())
    if not latest_plan and not files:
        return None
    parts = [
        "[STATE CARRYOVER — preserved across the reset; do NOT restart from "
        "scratch or re-explore what is already done]"
    ]
    if latest_plan:
        parts.append(
            "Your current plan (most recent TodoWrite) — resume the first "
            "unfinished item ([ ] = todo, [~] = in progress, [x] = done):"
        )
        parts.extend(latest_plan[:40])
    if files:
        shown = files[-max_files:]
        omitted = len(files) - len(shown)
        head_note = f" (showing last {len(shown)} of {len(files)})" if omitted > 0 else ""
        parts.append(f"Files you have already written/edited this session{head_note}:")
        parts.extend(f"  - {p}" for p in shown)
    parts.append(
        "Continue the plan from where it stands. Take the next concrete action "
        "toward the first unfinished item now."
    )
    return "\n".join(parts)


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
    #
    # Lower the threshold when an attractor correction has already been
    # applied — if the corrective injection + temp bump didn't break the
    # attractor on the next turn, more resets won't help. Cuts wasted retry
    # budget from 3 resets (~60 min observed) to 2 (~25 min).
    max_contamination_resets = (
        PROXY_ATTRACTOR_FINALIZE_THRESHOLD
        if monitor.attractor_correction_active
        else 3
    )
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
        # Suppress prose->tool_call resurrection on this turn: the model is
        # contaminated and will emit `<function=...>`/`<tool_call>` prose even
        # with tools removed; promoting it back to a structured tool_use would
        # continue the exact loop this finalize is meant to break.
        monitor.suppress_text_tool_extraction = True
        return updated

    messages = anthropic_body.get("messages", [])

    # Attractor detection: if the fault excerpt that triggered this reset
    # hashes to the same value as the *previous* reset's fault excerpt, the
    # model is in a stable output attractor — keep_last reset preserves the
    # priming tail that pulls it back in. Apply a harder reset (system +
    # initial user turn only) plus a corrective injection. Temperature gets
    # bumped UP on the next turn (see _apply_request_sampling) instead of
    # the standard post-contamination drop, to break the deterministic
    # output trajectory.
    attractor_detected = bool(
        PROXY_ATTRACTOR_DETECT
        and monitor.contamination_resets >= 1
        and monitor.last_fault_excerpt_hash
        and monitor.last_fault_excerpt_hash
        == getattr(monitor, "_prev_reset_fault_hash", "")
    )
    monitor._prev_reset_fault_hash = monitor.last_fault_excerpt_hash

    keep_last = max(2, PROXY_SESSION_CONTAMINATION_KEEP_LAST)
    if not attractor_detected and len(messages) <= keep_last + 1:
        monitor.malformed_tool_streak = 0
        monitor.invalid_tool_call_streak = 0
        monitor.required_tool_miss_streak = 0
        monitor.reset_tool_turn_state(reason="contamination_guardrail_soft_reset")
        return anthropic_body

    if attractor_detected:
        # Hard reset: drop the entire trailing context. Keep only the system
        # turn (if present) and the first user turn so the model has the
        # original goal but none of the attractor-priming tail.
        first_user_idx = next(
            (i for i, m in enumerate(messages) if m.get("role") == "user"),
            None,
        )
        if first_user_idx is None:
            head = messages[:1]
        else:
            head = messages[: first_user_idx + 1]
        # Phase 2 (PR #192): stronger, more structured intervention wording.
        # The Phase 1 single-paragraph message + temp 0.95 escaped one
        # production attractor (2026-05-25 02:39:59 fp:1f7e2c95...) but failed
        # to escape another (2026-05-24 19:11 fp:d19b7a44...). Increase the
        # signal-to-noise on the corrective by: (1) splitting MUST/MUST NOT
        # into bullet points the model attends to better, (2) using ALL CAPS
        # on the critical negative ("DO NOT narrate"), (3) explicitly naming
        # the attractor failure mode so the model can recognize and avoid it.
        reset_marker = {
            "role": "user",
            "content": (
                "[ATTRACTOR INTERVENTION — CRITICAL]\n\n"
                "Your previous responses REPEATEDLY emitted prose summaries "
                "instead of tool calls. This is the exact failure mode this "
                "intervention is designed to break. The trailing conversation "
                "has been REMOVED.\n\n"
                "YOUR NEXT RESPONSE MUST:\n"
                "  1. Begin with a tool_use block (no preamble, no thinking)\n"
                "  2. Invoke one of the available tools\n"
                "  3. Take a CONCRETE action toward the original task\n\n"
                "DO NOT:\n"
                "  • Summarize what you have done or plan to do\n"
                "  • Narrate, explain, or describe\n"
                "  • Emit any prose before the tool_use block\n\n"
                "Just call the tool."
            ),
        }
        carry = _extract_state_carryover(messages)
        new_messages = (
            head + [reset_marker, {"role": "user", "content": carry}]
            if carry else head + [reset_marker]
        )
        monitor.attractor_correction_active = True
        log_reason = "attractor"
    else:
        head = messages[:1]
        tail = messages[-keep_last:]
        reset_marker = {
            "role": "user",
            "content": (
                "[SESSION RESET: tool-call quality degraded in earlier turns. "
                "Continue from the recent context and emit valid tool calls with strict JSON arguments only.]"
            ),
        }
        carry = _extract_state_carryover(messages)
        carry_msgs = [{"role": "user", "content": carry}] if carry else []
        new_messages = head + [reset_marker] + carry_msgs + tail
        log_reason = "standard"

    updated_body = dict(anthropic_body)
    updated_body["messages"] = new_messages

    forced_before = monitor.consecutive_forced_count
    required_miss_before = monitor.required_tool_miss_streak
    monitor.contamination_resets += 1
    monitor.malformed_tool_streak = 0
    monitor.invalid_tool_call_streak = 0
    monitor.required_tool_miss_streak = 0
    monitor.no_progress_streak = 0
    monitor.consecutive_forced_count = 0
    monitor.forced_auto_cooldown_turns = 0
    monitor.reset_tool_turn_state(reason=f"contamination_guardrail_reset_{log_reason}")
    if attractor_detected:
        logger.warning(
            "CONTAMINATION ATTRACTOR DETECTED: session=%s hash=%s — hard reset "
            "applied, kept=%d messages (initial intent only), temp override "
            "and finalize threshold lowered to %d",
            session_id,
            monitor.last_fault_excerpt_hash,
            len(updated_body["messages"]),
            PROXY_ATTRACTOR_FINALIZE_THRESHOLD,
        )
    else:
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
    openai_resp: dict,
    anthropic_tools: list[dict] | None = None,
    suppress: bool = False,
) -> dict:
    """Mutate *openai_resp* in-place: if the message has no structured
    ``tool_calls`` but contains tool-call markup in text, extract them
    and promote to real ``tool_calls`` on the message.

    *anthropic_tools* (optional): list of tool definitions from the original
    Anthropic request. Enables schema-matching of bare-args markdown JSON
    blocks emitted by Gemma 4 cold turns (fix D). Without it, bare-args
    blocks pass through as text.

    Returns the (possibly-mutated) response for chaining."""
    # A hard finalize breaker stripped tools this turn to force a terminal
    # text-only end_turn; do not resurrect prose tool-calls (that would defeat
    # the breaker and continue the loop). Carried per-turn on the SessionMonitor.
    if suppress:
        return openai_resp
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
        and "<function=" not in text
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


_THINKING_BLOCK_RE = re.compile(r"<think>(.*?)</think>\s*", re.DOTALL)


def _extract_thinking_block(text: str) -> tuple[str | None, str]:
    """Extract Qwen-style ``<think>...</think>`` blocks from *text*.

    Returns ``(thinking_content, remaining_text)``. If no ``<think>`` tag is
    present, returns ``(None, text)`` unchanged. Multiple thinking blocks
    are concatenated. Trailing whitespace after each block is consumed so
    the remaining text starts cleanly with the model's actual answer.

    Truncated / unclosed ``<think>`` blocks (max_tokens cutting off
    mid-thinking) are also handled: everything from the dangling
    ``<think>`` to end-of-text is treated as partial thinking content,
    and anything before it is preserved as the body. Without this, the
    open tag and the model's partial reasoning would leak into the
    Anthropic-spec ``text`` content block — a 100% Anthropic-compatibility
    violation since real Anthropic responses never embed ``<think>`` in
    ``text``.
    """
    if "<think>" not in text:
        return None, text
    parts: list[str] = []
    def collect(m: re.Match) -> str:
        parts.append(m.group(1).strip())
        return ""
    remaining = _THINKING_BLOCK_RE.sub(collect, text)
    # After stripping balanced pairs, check for a dangling unclosed
    # <think>... open tag and treat it as partial thinking content.
    # First occurrence wins; any further '<think>' substrings in the
    # captured partial are folded into the same partial block.
    if "<think>" in remaining:
        idx = remaining.find("<think>")
        partial = remaining[idx + len("<think>"):].strip()
        if partial:
            parts.append(partial)
        # rstrip mirrors the balanced regex's \s* consumption after </think>:
        # whitespace separating body from thinking is structural, not part of
        # the body.
        remaining = remaining[:idx].rstrip()
    if not parts:
        # Saw "<think>" in original text but no extractable content (e.g.
        # bare "<think>" alone or "<think></think>"). Return cleaned body
        # so the open tag does not leak.
        return None, remaining.lstrip()
    return "\n\n".join(p for p in parts if p), remaining.lstrip()


def openai_to_anthropic_response(
    openai_resp: dict,
    model: str,
    expose_thinking: bool = True,
    suppress_text_tool_extraction: bool = False,
) -> dict:
    """Convert an OpenAI Chat Completions response to Anthropic Messages format.

    *expose_thinking*: when True, surface ``<think>...</think>`` content from
    the upstream as Anthropic ``{"type": "thinking"}`` blocks. When False
    (Anthropic default — client didn't opt in), strip thinking content
    from the response entirely so the client only sees the actual answer.
    Qwen's chat template seeds the model into thinking regardless of the
    ``enable_thinking`` request param, so even thinking-off responses
    typically still contain ``<think>`` blocks; this flag controls whether
    they're surfaced as Anthropic blocks or silently consumed.
    """
    # First: try to recover tool calls trapped in text XML tags
    _maybe_extract_text_tool_calls(openai_resp, suppress=suppress_text_tool_extraction)
    # Second: strip garbled/degenerate tool call arguments
    _sanitize_garbled_tool_calls(openai_resp)

    choice = openai_resp.get("choices", [{}])[0]
    message = choice.get("message", {})
    finish = choice.get("finish_reason", "stop")

    content = []
    # Surface Qwen's <think>...</think> output as Anthropic-style thinking
    # blocks (Anthropic extended-thinking API shape:
    #   {"type": "thinking", "thinking": "...", "signature": ""}).
    # Clients that don't request thinking simply ignore the block; clients
    # that do (Claude Code) render them in the thinking pane.
    raw_text = ""
    if message.get("content"):
        raw_text = (
            message["content"]
            if isinstance(message["content"], str)
            else str(message["content"])
        )
    # Some llama-server builds emit the model's reasoning into a separate
    # `reasoning_content` field instead of inline <think> tags. Surface
    # that too so the proxy is consistent regardless of upstream behaviour.
    inline_thinking, body_text = _extract_thinking_block(raw_text)
    sidecar_thinking = message.get("reasoning_content") or message.get("reasoning")
    thinking_chunks: list[str] = []
    if isinstance(sidecar_thinking, str) and sidecar_thinking.strip():
        thinking_chunks.append(sidecar_thinking.strip())
    if inline_thinking:
        thinking_chunks.append(inline_thinking)
    if thinking_chunks and expose_thinking:
        content.append(
            {
                "type": "thinking",
                "thinking": "\n\n".join(thinking_chunks),
                "signature": "",
            }
        )

    if body_text:
        sanitized_text = _sanitize_tool_call_apology_text(body_text)
        if sanitized_text != body_text:
            logger.warning(
                "SANITIZE: replaced known malformed tool-call apology text in assistant response"
            )
        # Option 1: Strip residual <tool_call> XML that wasn't extracted
        sanitized_text = _strip_residual_tool_call_xml(sanitized_text)
        if sanitized_text != body_text and "<tool_call>" in body_text:
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
        # Normalise IDs to Anthropic spec (toolu_ prefix). Upstream
        # llama-server returns opaque IDs without prefix; clients that
        # validate prefix would reject. Strip-and-restamp here, restore in
        # anthropic_to_openai_messages() when client sends tool_result back.
        upstream_id = tc.get("id", "")
        if upstream_id.startswith("toolu_"):
            tool_use_id = upstream_id
        elif upstream_id:
            tool_use_id = f"toolu_{upstream_id}"
        else:
            tool_use_id = f"toolu_{uuid.uuid4().hex[:24]}"
        content.append(
            {
                "type": "tool_use",
                "id": tool_use_id,
                "name": fn.get("name", ""),
                "input": args,
            }
        )

    # Empty-output guard (no-tool path). Qwen-style models emit their whole
    # response inside a <think> block even with enable_thinking=False; when the
    # client did NOT opt into thinking (expose_thinking=False) the block is
    # consumed and -- if the model produced nothing after </think> -- the
    # response collapses to an empty text block. That empty body is useless to
    # the client and silently breaks downstream consumers (notably the
    # Fusion/Confidence judge, whose escalate call is a no-tool turn -- an empty
    # judge reply makes apply_recipe fall back to the primary, so recipes
    # degrade to single). When there is no text and no tool_use content but we
    # DID capture thinking, surface the de-tagged thinking as the body rather
    # than returning nothing.
    _has_text = any(
        b.get("type") == "text" and (b.get("text") or "").strip() for b in content
    )
    _has_tool_use = any(b.get("type") == "tool_use" for b in content)
    if not _has_text and not _has_tool_use and thinking_chunks:
        content.append({"type": "text", "text": "\n\n".join(thinking_chunks)})
        logger.warning(
            "EMPTY-OUTPUT GUARD: no-tool turn produced only <think> content; "
            "promoted de-tagged thinking to the text body (would otherwise be empty)"
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


async def _maybe_apply_recipe(anthropic_resp, anthropic_body, openai_body, client):
    """Serving-layer recipe runtime (confidence / fusion, signal-selected).
    Default OFF; fails open. call_primary re-runs the cheap primary (llama) for
    fusion breadth; call_judge talks to the stronger escalation backend."""
    if _ce is None or not isinstance(anthropic_resp, dict):
        return anthropic_resp
    try:
        settings = _ce.Settings.from_env()
        if not settings.enabled:
            return anthropic_resp
        model_name = (openai_body or {}).get("model", "default")

        async def call_primary(openai_variant):
            try:
                r = await _post_with_generation_timeout(
                    client,
                    f"{LLAMA_CPP_BASE}/chat/completions",
                    openai_variant,
                    {"Content-Type": "application/json"},
                )
                if getattr(r, "status_code", 0) != 200:
                    return None
                return openai_to_anthropic_response(r.json(), model_name)
            except Exception:
                return None

        async def call_judge(anthropic_payload):
            try:
                url = settings.endpoint.rstrip("/") + "/v1/messages"
                r = await client.post(
                    url,
                    json=anthropic_payload,
                    headers={
                        "Content-Type": "application/json",
                        "x-api-key": settings.api_key,
                        "anthropic-version": "2023-06-01",
                    },
                    timeout=120.0,
                )
                return r.json() if getattr(r, "status_code", 0) == 200 else None
            except Exception:
                return None

        result = await _ce.apply_recipe(
            anthropic_resp,
            anthropic_body,
            openai_body,
            settings,
            _has_tool_definitions(anthropic_body),
            call_primary,
            call_judge,
        )
        if isinstance(result, dict) and result is not anthropic_resp:
            logger.warning(
                "RECIPE applied: recipe=%s signal=%s -> response changed",
                _ce.select_recipe(anthropic_body, settings, _has_tool_definitions(anthropic_body)),
                settings.signal,
            )
        return result if isinstance(result, dict) else anthropic_resp
    except Exception as exc:
        logger.warning("RECIPE: failed (%s); keeping primary answer", exc)
        return anthropic_resp


async def _heartbeat_then_buffered(produce_coro, model: str, input_tokens: int = 0):
    """SSE generator: keep-alive heartbeat wrapper for the guarded-non-stream path.

    Emits an immediate ``message_start`` so the client registers an active
    stream, then ``ping`` events every PROXY_STREAM_HEARTBEAT_SECS while
    ``produce_coro`` (which awaits + guards the buffered upstream response) runs,
    then streams the buffered content. Keeps the connection alive through long
    buffered generations so the client's streaming idle-timeout does not fire.

    ``produce_coro`` resolves to EITHER the finalized Anthropic response dict OR
    a Starlette ``Response`` (the guarded path's error returns). Since the stream
    has already committed to HTTP 200, an error Response is re-emitted as an SSE
    ``error`` event rather than an HTTP status.
    """
    msg_id = f"msg_{uuid.uuid4().hex[:24]}"
    yield (
        f"event: message_start\n"
        f"data: {json.dumps({'type': 'message_start', 'message': {'id': msg_id, 'type': 'message', 'role': 'assistant', 'content': [], 'model': model, 'stop_reason': None, 'stop_sequence': None, 'usage': {'input_tokens': input_tokens, 'output_tokens': 0}}})}\n\n"
    )
    interval = PROXY_STREAM_HEARTBEAT_SECS if PROXY_STREAM_HEARTBEAT_SECS > 0 else 15.0
    task = asyncio.ensure_future(produce_coro)
    try:
        while True:
            try:
                # shield keeps the produce task alive across ping timeouts;
                # only the wait_for wrapper is cancelled on each TimeoutError.
                produced = await asyncio.wait_for(asyncio.shield(task), timeout=interval)
                break
            except asyncio.TimeoutError:
                yield 'event: ping\ndata: {"type": "ping"}\n\n'
    except asyncio.CancelledError:
        # Client disconnected — cancel the in-flight produce AND await its
        # cleanup so httpx returns/closes the upstream connection before we
        # unwind. Without the await, the cancel is merely requested and the
        # socket strands in CLOSE-WAIT (the connection-leak → PoolTimeout 500
        # storm root cause). Shielded + time-boxed so a stuck close can't hang
        # the disconnect path.
        task.cancel()
        try:
            await asyncio.wait_for(asyncio.shield(task), timeout=5.0)
        except (asyncio.CancelledError, asyncio.TimeoutError, Exception):
            pass
        raise
    except Exception as exc:
        logger.error("heartbeat produce failed: %s", exc)
        yield (
            "event: error\n"
            f"data: {json.dumps({'type': 'error', 'error': {'type': 'api_error', 'message': str(exc)[:500]}})}\n\n"
        )
        return

    if isinstance(produced, Response):
        # Guarded path returned an error Response; re-emit as an SSE error event.
        try:
            payload = json.loads(bytes(produced.body).decode("utf-8"))
        except Exception:
            payload = {
                "type": "error",
                "error": {"type": "overloaded_error", "message": "Upstream error"},
            }
        yield f"event: error\ndata: {json.dumps(payload)}\n\n"
        return

    # produced is the finalized Anthropic response dict — stream its content
    # without a second message_start (already sent above).
    async for chunk in stream_anthropic_message(produced, emit_message_start=False):
        yield chunk


async def stream_anthropic_message(anthropic_resp: dict, emit_message_start: bool = True):
    """Stream a finalized Anthropic message as SSE events.

    emit_message_start=False skips the leading message_start event for callers
    (the heartbeat wrapper) that have already emitted one to start the stream.
    """
    if emit_message_start:
        message = {
            "id": anthropic_resp.get("id", f"msg_{uuid.uuid4().hex[:24]}"),
            "type": "message",
            "role": "assistant",
            "content": [],
            "model": anthropic_resp.get("model", "unknown"),
            "stop_reason": None,
            "stop_sequence": None,
            "usage": {
                "input_tokens": int(
                    (anthropic_resp.get("usage", {}) or {}).get("input_tokens", 0)
                    * _count_tokens_scale()
                ),
                "output_tokens": 0,
            },
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

    resp_usage = anthropic_resp.get("usage", {}) or {}
    output_tokens = resp_usage.get("output_tokens", 0)
    scaled_input = int(resp_usage.get("input_tokens", 0) * _count_tokens_scale())
    stop_reason = anthropic_resp.get("stop_reason", "end_turn")
    yield (
        "event: message_delta\n"
        f"data: {json.dumps({'type': 'message_delta', 'delta': {'stop_reason': stop_reason, 'stop_sequence': None}, 'usage': {'input_tokens': scaled_input, 'output_tokens': output_tokens}})}\n\n"
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
    _sr_client = getattr(openai_stream, "_uap_client", None)
    _inflight_inc(_sr_client) if _sr_client is not None else None
    msg_id = f"msg_{uuid.uuid4().hex[:24]}"
    stream_started = time.monotonic()

    # message_start — carries the client's (scaled) input size; a hardcoded 0
    # here blinded clients to their own context usage (compaction never fired).
    yield (
        f"event: message_start\n"
        f"data: {json.dumps({'type': 'message_start', 'message': {'id': msg_id, 'type': 'message', 'role': 'assistant', 'content': [], 'model': model, 'stop_reason': None, 'stop_sequence': None, 'usage': {'input_tokens': _client_input_tokens(monitor), 'output_tokens': 0}}})}\n\n"
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

    # Real token counts from upstream's final usage chunk (llama-server /
    # OpenAI emit it on the last data frame). The per-delta output_tokens
    # counter is a chunk count that misses tool-call deltas entirely; prefer
    # upstream truth for telemetry and the session monitor.
    upstream_usage: dict = {}

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

            if isinstance(chunk.get("usage"), dict):
                upstream_usage = chunk["usage"]

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
        if _sr_client is not None:
            _inflight_dec(_sr_client)
        # Detached close: a bare 'await aclose()' here is itself cancellable
        # when the client disconnected (the common case), leaving the upstream
        # connection un-closed → CLOSE-WAIT leak. Detaching guarantees it runs.
        _detach_aclose(openai_stream)

    # Close any open tool call blocks (skip if XML recovery already emitted them)
    xml_recovered = tool_calls_by_index.pop("_xml_recovered", False)
    if tool_calls_by_index and not xml_recovered:
        for tc in tool_calls_by_index.values():
            if isinstance(tc, dict) and "block_index" in tc:
                # Truncation repair: if the accumulated arguments do not parse
                # (token-limit cut mid-JSON), stream one final fragment that
                # closes the JSON validly — with a visible marker when cut
                # inside a string — so the client can always parse the block.
                # stop_reason still reports max_tokens; the marker makes the
                # truncation visible in whatever the tool writes.
                repair = _json_close_suffix(tc.get("arguments", ""))
                if repair:
                    tc["arguments"] = tc.get("arguments", "") + repair
                    logger.warning(
                        "STREAM TOOL-CALL REPAIR: closed truncated '%s' arguments (+%d chars) — client would otherwise fail to parse",
                        tc.get("name", "?"),
                        len(repair),
                    )
                    yield (
                        f"event: content_block_delta\n"
                        f"data: {json.dumps({'type': 'content_block_delta', 'index': tc['block_index'], 'delta': {'type': 'input_json_delta', 'partial_json': repair}})}\n\n"
                    )
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
    # STUCK-BREAK signals: feed the assistant text + tool args to the monitor.
    try:
        monitor.note_assistant_text(accumulated_text)
        monitor.note_tool_arg_hosts(list(tc_args))
        # DEFERRAL-BREAK signal (Fix A): a no-tool prose turn that defers the
        # work. `tc_names` empty means this turn emitted no tool call.
        monitor.note_deferral_signal(accumulated_text, bool(tc_names))
    except Exception:
        pass

    # -------------------------------------------------------------------
    # Post-stream: recover <tool_call> XML from accumulated text
    # -------------------------------------------------------------------
    if (
        not tool_calls_by_index
        and "<tool_call>" in accumulated_text
        and not monitor.suppress_text_tool_extraction
    ):
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

    # message_delta with final stop reason. Repeats the (scaled) input size so
    # clients that read usage from the delta rather than message_start still
    # see their context usage — the compaction-forcing signal.
    yield (
        f"event: message_delta\n"
        f"data: {json.dumps({'type': 'message_delta', 'delta': {'stop_reason': finish_reason, 'stop_sequence': None}, 'usage': {'input_tokens': _client_input_tokens(monitor), 'output_tokens': output_tokens}})}\n\n"
    )

    # message_stop
    yield f"event: message_stop\ndata: {json.dumps({'type': 'message_stop'})}\n\n"

    # Per-project telemetry for the TRUE streaming path. The only other call
    # sites are on the non-stream / guarded-non-stream paths, so streaming
    # sessions (the client default) wrote no task_outcomes rows and
    # per-project dashboards froze at the last non-stream response.
    # Prefer upstream's real usage: last_input_tokens is a char-based request
    # estimate, and the per-delta counter misses tool-call turns entirely.
    upstream_input = int(upstream_usage.get("prompt_tokens") or 0)
    if upstream_input > 0:
        monitor.last_input_tokens = upstream_input
    final_output = int(upstream_usage.get("completion_tokens") or 0)
    if final_output <= 0:
        # Upstream sent no usable usage (older servers ignore stream_options):
        # estimate from everything actually generated — text, tool-call
        # arguments, and reasoning — at ~4 chars/token, never below the
        # per-delta chunk count.
        generated_chars = (
            sum(len(c) for c in text_chunks)
            # isinstance guard: the XML-recovery path stores a bare sentinel
            # (tool_calls_by_index["_xml_recovered"] = True) in this map.
            + sum(
                len(tc.get("arguments", ""))
                for tc in tool_calls_by_index.values()
                if isinstance(tc, dict)
            )
            + sum(len(c) for c in reasoning_chunks)
        )
        final_output = max(output_tokens, (generated_chars + 3) // 4)
    usage_final = {
        "input_tokens": upstream_input or getattr(monitor, "last_input_tokens", 0) or 0,
        "output_tokens": final_output,
    }
    # After message_stop (never delays the client's final frame; a disconnect
    # parked exactly on that yield skips recording, matching the non-stream
    # "completed responses only" semantics) and off the event loop (a locked
    # analytics DB must not stall token delivery for concurrent sessions).
    try:
        await asyncio.to_thread(
            _record_project_telemetry,
            anthropic_body,
            model,
            usage_final,
            (time.monotonic() - stream_started) * 1000.0,
        )
    except Exception:
        pass


# ===========================================================================
# API Endpoints
# ===========================================================================


def _build_passthrough_headers(request: Request) -> dict | None:
    headers = {
        "Content-Type": "application/json",
        "anthropic-version": request.headers.get("anthropic-version", "2023-06-01"),
    }
    # Claude Code on a Claude Max / Pro plan authenticates with an OAuth *bearer*
    # token (Authorization: Bearer sk-ant-oat...), NOT an API key. When the client
    # sends one, forward it verbatim and do NOT attach x-api-key -- Anthropic
    # rejects requests that carry both credentials. This lets the proxy sit
    # transparently in front of api.anthropic.com for subscription-auth Claude
    # Code sessions (point ANTHROPIC_BASE_URL at the proxy and it just works).
    authorization = request.headers.get("authorization")
    if authorization:
        headers["Authorization"] = authorization
    else:
        api_key = request.headers.get("x-api-key") or ANTHROPIC_API_KEY
        if not api_key:
            return None
        headers["x-api-key"] = api_key
    beta = request.headers.get("anthropic-beta")
    if beta:
        headers["anthropic-beta"] = beta
    return headers


async def _stream_passthrough(resp: httpx.Response):
    _pt_client = getattr(resp, "_uap_client", None)
    if _pt_client is not None:
        _inflight_inc(_pt_client)
    try:
        async for chunk in resp.aiter_bytes():
            yield chunk
    finally:
        if _pt_client is not None:
            _inflight_dec(_pt_client)
        _detach_aclose(resp)


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
    # Bounded timeout so a slow/stuck Anthropic generation can't hang the
    # request (and the single upstream slot) for the full default read timeout.
    pt_timeout = httpx.Timeout(
        connect=10.0, read=PROXY_PASSTHROUGH_TIMEOUT, write=30.0, pool=10.0
    )

    if is_stream:
        resp = await client.send(
            client.build_request("POST", url, json=body, headers=headers, timeout=pt_timeout)
        )
        setattr(resp, "_uap_client", client)
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

    resp = await client.post(url, json=body, headers=headers, timeout=pt_timeout)
    return Response(
        content=resp.content,
        status_code=resp.status_code,
        media_type=resp.headers.get("content-type", "application/json"),
    )


@app.post("/v1/messages/count_tokens")
async def count_tokens(request: Request):
    """Anthropic-compatible token counter.

    Claude Code calls POST /v1/messages/count_tokens to measure a request
    against the context window and decide when to auto-compact. Returning 404
    (unimplemented) blinds the client to the real window, so it sent auto-compact
    `<transcript>` requests LARGER than the window -> single-oversized-message
    overflow wedge. We estimate with the SAME accounting the pruner uses
    (estimate_total_tokens) so the client's view matches the proxy's window math.
    """
    try:
        body = await request.json()
    except Exception:
        return Response(
            content=json.dumps(
                {"type": "error", "error": {"type": "invalid_request_error", "message": "invalid JSON body"}}
            ),
            status_code=400,
            media_type="application/json",
        )
    est = estimate_total_tokens(body)
    scale = _count_tokens_scale()
    if scale > 1.0:
        scaled = int(est * scale)
        # Once per scale value, explain the discrepancy an operator would
        # otherwise chase between this endpoint and the pruner's numbers.
        global _count_scale_logged
        if _count_scale_logged != scale:
            _count_scale_logged = scale
            logger.info(
                "COMPACT FORCING: scaling count_tokens by %.2f "
                "(client assumed window %d, rail %d) — client auto-compact "
                "fires at ~%d real tokens, before the pruner",
                scale,
                PROXY_CLIENT_ASSUMED_WINDOW,
                default_context_window if default_context_window > 0 else PROXY_CONTEXT_WINDOW,
                int(PROXY_CLIENT_ASSUMED_WINDOW * 0.925 / scale),
            )
        return {"input_tokens": scaled}
    return {"input_tokens": est}


_count_scale_logged: float = 0.0


def _count_tokens_scale() -> float:
    """Resolve the count_tokens compaction-forcing scale (>= 1.0; 1.0 = off).

    "auto" derives it from the LIVE rail each call so a rail resize (server
    restart with a different --ctx-size) re-tunes the client's compact point
    without a proxy restart.
    """
    raw = PROXY_COUNT_TOKENS_SCALE.strip().lower()
    if raw in ("", "off", "none", "0", "1", "1.0"):
        return 1.0
    if raw != "auto":
        try:
            return max(1.0, float(raw))
        except ValueError:
            return 1.0
    window = default_context_window if default_context_window > 0 else PROXY_CONTEXT_WINDOW
    if window <= 0:
        return 1.0
    frac = (
        PROXY_COMPACT_TARGET_FRACTION
        if 0 < PROXY_COMPACT_TARGET_FRACTION < 1
        # Auto: land compaction just under the pruner trigger so the client
        # compacts before the proxy ever prunes (pruner = backstop only).
        else min(0.9, PROXY_CONTEXT_PRUNE_THRESHOLD * 0.95)
    )
    target = window * frac
    if target <= 0 or PROXY_CLIENT_ASSUMED_WINDOW <= target:
        # Rail already exceeds the client's own compact point — honest counts
        # are fine, the client compacts before the rail unaided.
        return 1.0
    return PROXY_CLIENT_ASSUMED_WINDOW / target


def _client_input_tokens(monitor) -> int:
    """Input size to REPORT to the client, scaled for compaction forcing.

    Streaming responses historically hardcoded ``input_tokens: 0`` in
    message_start — the client could never see its own context usage, so its
    auto-compaction NEVER fired and sessions ground against the pruner forever
    (the actual root cause of the interactive thrash band; count_tokens
    scaling alone was insufficient because the dominant clients don't call
    it). Reports the PRE-prune estimate — the client's own conversation size,
    which is what its compaction decision is about — times the forcing scale.
    """
    est = (
        getattr(monitor, "pre_prune_input_tokens", 0)
        or getattr(monitor, "last_input_tokens", 0)
        or 0
    )
    return int(est * _count_tokens_scale())


def _scale_client_usage(anthropic_resp: dict) -> dict:
    """Shallow-copy a finalized response with usage.input_tokens scaled for the
    CLIENT. Internal consumers (pruner accounting, telemetry) read the original
    dict's honest numbers — only the wire copy lies, and it lies consistently
    with count_tokens and the streaming frames."""
    scale = _count_tokens_scale()
    usage = anthropic_resp.get("usage")
    if scale <= 1.0 or not isinstance(usage, dict):
        return anthropic_resp
    out = dict(anthropic_resp)
    out["usage"] = {
        **usage,
        "input_tokens": int(usage.get("input_tokens", 0) * scale),
    }
    return out


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

    # Evaluator-verdict marker: clients tag JSON-only completions via header;
    # stage it into the body so build_openai_request can grammar-constrain it.
    if request.headers.get("x-uap-json-response"):
        body["_uap_json_response"] = True

    # Sandboxed sessions (`uap sandbox` / bwrap) set X-Uap-Sandbox:1 via
    # ANTHROPIC_CUSTOM_HEADERS. The sandbox can't reach the claude-in-chrome
    # browser extension, so strip its MCP tools here (before passthrough, so it
    # applies to local AND cloud sessions) — the model then uses WebFetch or
    # local file reads instead of looping on an unreachable browser_batch.
    sandboxed = (request.headers.get("x-uap-sandbox") or "").strip() == "1"
    if sandboxed:
        _stripped = _strip_sandbox_unreachable_tools(body)
        if _stripped and client_id not in _SANDBOX_STRIP_LOGGED:
            if len(_SANDBOX_STRIP_LOGGED) > 512:
                _SANDBOX_STRIP_LOGGED.clear()
            _SANDBOX_STRIP_LOGGED.add(client_id)
            logger.info(
                "SANDBOX: stripping %d unreachable browser MCP tool(s) for %s "
                "(bwrap cannot reach the claude-in-chrome extension; logged once "
                "per session)",
                _stripped,
                client_id,
            )

    # Periodically re-detect context window from upstream (handles server restarts)
    await _maybe_recheck_context_window()
    await _maybe_recheck_vision()

    if _should_passthrough_model(model):
        logger.info("PASSTHROUGH: model=%s -> %s", model, ANTHROPIC_API_BASE)
        return await _passthrough_anthropic_request(request, body, is_stream)
    session_id = resolve_session_id(request, body)
    monitor = get_session_monitor(session_id)
    monitor.sandboxed = sandboxed
    # Per-turn flag: only the turn whose breaker strips tools suppresses the
    # response-side prose->tool_call resurrection. Clear it at request entry so a
    # prior finalize turn never bleeds into the next turn's normal extraction.
    monitor.suppress_text_tool_extraction = False
    last_session_id = session_id
    # Make the session id visible to _ensure_slot_for_session inside
    # _post_with_retry. The /v1/chat/completions handler also reaches this
    # path (it builds a synthetic request and calls messages()), so this
    # single set covers both the Anthropic and OpenAI-passthrough entry
    # points for local llama-server requests.
    _current_request_session.set(session_id)

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

    # --- Compaction-boundary detection: a client-side auto-compact collapses
    # the conversation (observed live 2026-07-10: msgs 61 -> 3) into a fresh
    # epoch whose last assistant message is the text-only SUMMARY. Anti-spin
    # counters accumulated before the boundary (consecutive_forced_count,
    # starvation/no-write streaks, tool-state machine) then misfire on the
    # very first post-compact turn — the starvation breaker stripped tools
    # from a brand-new epoch because the summary "looked like" a text-only
    # stall. A halving-plus collapse of the message count is the boundary
    # signal; reset the per-conversation spin state so the new epoch starts
    # clean. (Token accounting is NOT reset — record_request below re-measures
    # the compacted size naturally.)
    prev_msg_count = getattr(monitor, "last_request_msg_count", 0)
    if prev_msg_count >= 8 and n_messages <= prev_msg_count // 2:
        monitor.reset_tool_turn_state(reason="compaction_boundary")
        monitor.consecutive_forced_count = 0
        monitor.no_progress_streak = 0
        monitor.tool_starvation_streak = 0
        monitor.consecutive_no_write_turns = 0
        logger.info(
            "COMPACTION BOUNDARY: message count collapsed %d -> %d; reset "
            "tool-turn/anti-spin state for the fresh epoch",
            prev_msg_count,
            n_messages,
        )
    monitor.last_request_msg_count = n_messages

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
        # Fix B: preserve the raw incoming size before any pruning rewrites
        # last_input_tokens to the post-prune total, so the loop breaker can
        # see the true blow-up at build_openai_request time.
        monitor.pre_prune_input_tokens = effective_tokens
        # Fix F: track consecutive turns whose raw incoming context is
        # catastrophically over the window (a death spiral the per-request
        # pruner can mask but not cure). build_openai_request acts on this.
        if (
            PROXY_RAW_CTX_FINALIZE_RATIO > 0
            and utilization >= PROXY_RAW_CTX_FINALIZE_RATIO
        ):
            monitor.catastrophic_ctx_streak += 1
        else:
            monitor.catastrophic_ctx_streak = 0
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
                body, ctx_window, monitor=monitor,
                target_fraction=target_frac, keep_last=keep_last,
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
                    body, ctx_window, monitor=monitor,
                    target_fraction=0.35, keep_last=4,
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
        async def _produce_guarded():
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
                await _check_slot_hang(LLAMA_CPP_BASE.replace("/v1", "/slots"))
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
                # Try the Gemma 4 PEG parse-failure recovery first — relax
                # tool_choice='required' so the retry isn't constrained by the
                # strict-grammar that triggered the parse failure.
                relaxed = _is_gemma4_peg_parse_failure(strict_resp.status_code, error_text) and \
                    _relax_tool_choice_for_gemma4_peg_retry(strict_body, "strict-stream")
                if relaxed:
                    try:
                        strict_resp = await _post_with_generation_timeout(
                            client,
                            f"{LLAMA_CPP_BASE}/chat/completions",
                            strict_body,
                            {"Content-Type": "application/json"},
                        )
                    except Exception:
                        pass  # fall through to next handler
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
            _maybe_extract_text_tool_calls(
                openai_resp,
                anthropic_tools=body.get("tools"),
                suppress=monitor.suppress_text_tool_extraction,
            )
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
            openai_resp = await _apply_empty_maxtokens_recovery(
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
                # Tool retries need room for Qwen's mandatory thinking PLUS
                # complete tool-call arguments — 2048 produced truncated JSON.
                retry_body["max_tokens"] = 8192 if has_tools else 2048
                retry_body["temperature"] = 0.1
                retry_body["stream"] = False
                if has_tools:
                    retry_body["tool_choice"] = "required"
                    logger.warning("DEGENERATE RETRY: retrying with tool_choice=required max_tokens=8192")
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
            anthropic_resp = openai_to_anthropic_response(
                openai_resp, model,
                expose_thinking=isinstance(body.get("thinking"), dict)
                    and (body["thinking"].get("type") or "").lower() == "enabled",
                suppress_text_tool_extraction=monitor.suppress_text_tool_extraction,
            )
            _maybe_normalize_toolcall_paths(anthropic_resp, body)
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
            # Off the event loop: the recorder now writes TWO DBs (analytics +
            # dashboard telemetry) with 2s busy timeouts — a lock stall here
            # would block every concurrent session's turn.
            await asyncio.to_thread(
                _record_project_telemetry, body, model, anthropic_resp.get("usage", {})
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

            anthropic_resp = await _maybe_apply_recipe(anthropic_resp, body, openai_body, client)
            return anthropic_resp

        if PROXY_STREAM_HEARTBEAT_SECS > 0:
            return StreamingResponse(
                _heartbeat_then_buffered(_produce_guarded(), model, _client_input_tokens(monitor)),
                media_type="text/event-stream",
                headers={
                    "Cache-Control": "no-cache",
                    "Connection": "keep-alive",
                },
            )
        _produced = await _produce_guarded()
        if isinstance(_produced, Response):
            return _produced
        anthropic_resp = _produced
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
        # Without this, OpenAI-compat upstreams (llama-server included) omit
        # completion_tokens from the final stream chunk — the reason streamed
        # tool-use turns recorded tokensOut=0 in per-project telemetry.
        openai_body["stream_options"] = {"include_usage": True}

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
                setattr(resp, "_uap_client", client)
                # Connection succeeded – break out of retry loop
                last_exc = None
                break
            except _UPSTREAM_RETRY_EXCEPTIONS as exc:
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
            # Gemma 4 PEG parse-failure recovery: relax tool_choice='required'
            # so the retry isn't blocked by the strict-grammar that rejected
            # the model's incomplete tool call.
            if _is_gemma4_peg_parse_failure(resp.status_code, error_text) and \
                    _relax_tool_choice_for_gemma4_peg_retry(openai_body, "stream"):
                resp = await client.send(
                    client.build_request(
                        "POST",
                        f"{LLAMA_CPP_BASE}/chat/completions",
                        json=openai_body,
                        headers={"Content-Type": "application/json"},
                    ),
                    stream=True,
                )
                setattr(resp, "_uap_client", client)
                if resp.status_code == 200:
                    return StreamingResponse(
                        stream_anthropic_response(resp, model, monitor, body),
                        media_type="text/event-stream",
                    )
                # fall through if still failing
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
                setattr(resp, "_uap_client", client)
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
            # Gemma 4 PEG parse-failure recovery (non-stream path).
            relaxed = (
                _is_gemma4_peg_parse_failure(resp.status_code, error_text)
                and _relax_tool_choice_for_gemma4_peg_retry(openai_body, "non-stream")
            )
            if relaxed:
                try:
                    resp = await _post_with_generation_timeout(
                        client,
                        f"{LLAMA_CPP_BASE}/chat/completions",
                        openai_body,
                        {"Content-Type": "application/json"},
                    )
                except Exception:
                    pass  # fall through
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
        _maybe_extract_text_tool_calls(
            openai_resp,
            anthropic_tools=body.get("tools"),
            suppress=monitor.suppress_text_tool_extraction,
        )
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
        openai_resp = await _apply_empty_maxtokens_recovery(
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
            logger.warning("DEGENERATE RETRY (stream): retrying with tool_choice=required max_tokens=8192")
            retry_body = dict(openai_body)
            retry_body["tool_choice"] = "required"
            # See non-stream site: 2048 starves thinking + tool args.
            retry_body["max_tokens"] = 8192
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
        anthropic_resp = openai_to_anthropic_response(
            openai_resp, model,
            expose_thinking=isinstance(body.get("thinking"), dict)
                and (body["thinking"].get("type") or "").lower() == "enabled",
            suppress_text_tool_extraction=monitor.suppress_text_tool_extraction,
        )
        _maybe_normalize_toolcall_paths(anthropic_resp, body)
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

        # Off the event loop — see the guarded-non-stream call site.
        await asyncio.to_thread(
            _record_project_telemetry, body, model, anthropic_resp.get("usage", {})
        )
        # Wire copy only: telemetry above and monitor accounting keep the
        # honest numbers; the client sees the compaction-forcing scale.
        return _scale_client_usage(anthropic_resp)


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
    """Return available model list.

    Advertises Shannon's three canonical Claude model IDs (haiku 4.5,
    sonnet 4.6, opus 4.7) for client compatibility — Anthropic SDKs
    typically check /v1/models for the requested ID before sending a
    Messages request, and failing that check produces a confusing 404 even
    though the proxy itself would happily accept the request.

    Whether requests for those Claude IDs actually round-trip to
    api.anthropic.com depends on ANTHROPIC_PASSTHROUGH_MODELS /
    DEFAULT_PASSTHROUGH_MODEL_PATTERNS. When the local-only sentinel
    ANTHROPIC_PASSTHROUGH_MODELS=__local_only__ is set, all IDs (including
    the Claude ones below) are served by the local llama.cpp backend.
    """
    return {
        "data": [
            {"id": "claude-haiku-4-5-20251001", "object": "model"},
            {"id": "claude-sonnet-4-6", "object": "model"},
            {"id": "claude-sonnet-5-20250514", "object": "model"},
            {"id": "claude-fable-5", "object": "model"},
            {"id": "qwen36-35b-a3b-iq4xs", "object": "model"},
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
