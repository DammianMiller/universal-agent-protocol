"""Per-project routing/cost telemetry for the shared UAP anthropic proxy.

The proxy is a shared singleton that serves *every* project, so per-project
dashboards (which read ``<project>/agents/data/memory/model_analytics.db`` ->
``task_outcomes``) never see the model calls the proxy actually makes. This
module closes that gap: after each completed response the proxy calls
``record_from_request`` with the request body + model + usage; we derive the
project directory from absolute paths echoed in the request and append one
``task_outcomes`` row to that project's analytics DB.

Design constraints (it runs in the hot path of a live proxy):
  * fully fail-open — never raise into the caller;
  * bounded work — scans a capped slice of the request, does a few fs stat calls;
  * schema-compatible with src/models/analytics.ts so the existing dashboard
    reads it with no change. Local models are zero-cost, so ``cost=0`` and the
    dashboard computes the counterfactual-vs-frontier saving itself.
"""

from __future__ import annotations

import json
import os
import re
import sqlite3
from datetime import datetime, timezone

# A UAP project root is identifiable by one of these child markers.
_PROJECT_MARKERS = ("agents/data/memory", ".uap", ".git")
_ABS_PATH_RE = re.compile(r"/(?:[\w.\-]+/){2,}[\w.\-]*")
# Bounds so a huge request can never stall the proxy hot path.
_MAX_SCAN_CHARS = 24_000
_MAX_CANDIDATE_PATHS = 40
_MAX_WALK_UP = 8

# Must match src/models/analytics.ts exactly (esp. the `id` PK) — the dashboard's
# getModelData reads `ORDER BY id`, which errors on an id-less table. For an
# existing project the TS side already created this (CREATE IF NOT EXISTS no-ops);
# this shape matters only when the proxy creates the table first for a fresh project.
_CREATE_SQL = (
    "CREATE TABLE IF NOT EXISTS task_outcomes ("
    "id INTEGER PRIMARY KEY AUTOINCREMENT, "
    "modelId TEXT NOT NULL, taskType TEXT NOT NULL, complexity TEXT NOT NULL, "
    "success INTEGER NOT NULL, durationMs INTEGER NOT NULL, "
    "tokensIn INTEGER NOT NULL DEFAULT 0, tokensOut INTEGER NOT NULL DEFAULT 0, "
    "cost REAL NOT NULL DEFAULT 0, taskId TEXT, timestamp TEXT NOT NULL)"
)


def _iter_text(body: dict):
    """Yield string fragments from an Anthropic request body, capped in total."""
    budget = _MAX_SCAN_CHARS
    msgs = body.get("messages") or []
    # Newest messages first — the current workdir shows up in recent tool output.
    for msg in reversed(msgs):
        content = msg.get("content") if isinstance(msg, dict) else None
        if isinstance(content, str):
            frag = content[:budget]
            budget -= len(frag)
            yield frag
        elif isinstance(content, list):
            for block in content:
                if not isinstance(block, dict):
                    continue
                for key in ("text", "content", "input"):
                    val = block.get(key)
                    if isinstance(val, str):
                        frag = val[:budget]
                        budget -= len(frag)
                        yield frag
                    elif isinstance(val, (dict, list)):
                        frag = str(val)[:budget]
                        budget -= len(frag)
                        yield frag
                if budget <= 0:
                    return
        if budget <= 0:
            return


def _project_root_for(path: str) -> str | None:
    """Walk up from ``path`` to the nearest dir carrying a UAP project marker."""
    d = path if os.path.isdir(path) else os.path.dirname(path)
    for _ in range(_MAX_WALK_UP):
        if not d or d == "/":
            break
        for marker in _PROJECT_MARKERS:
            if os.path.exists(os.path.join(d, marker)):
                return d
        d = os.path.dirname(d)
    return None


def derive_project_dir(body: dict) -> str | None:
    """Best-effort project directory for a request, or None. Never raises."""
    try:
        counts: dict[str, int] = {}
        seen = 0
        for frag in _iter_text(body):
            for m in _ABS_PATH_RE.finditer(frag):
                if seen >= _MAX_CANDIDATE_PATHS:
                    break
                seen += 1
                root = _project_root_for(m.group(0))
                if root:
                    counts[root] = counts.get(root, 0) + 1
            if seen >= _MAX_CANDIDATE_PATHS:
                break
        if not counts:
            return None
        # Most-referenced project root wins; tie-break to the deepest path.
        return max(counts.items(), key=lambda kv: (kv[1], len(kv[0])))[0]
    except Exception:
        return None


def _analytics_db_path(project_dir: str) -> str:
    return os.path.join(project_dir, "agents", "data", "memory", "model_analytics.db")


def record_task_outcome(
    project_dir: str,
    model: str,
    tokens_in: int,
    tokens_out: int,
    *,
    duration_ms: int = 0,
    cost: float = 0.0,
    task_id: str = "",
    task_type: str = "proxy",
    complexity: str = "medium",
    success: bool = True,
) -> bool:
    """Append one task_outcomes row to a project's analytics DB. Never raises.

    Returns True on write, False if skipped (no dir, no tokens, or error).
    """
    try:
        if not project_dir:
            return False
        db_dir = os.path.join(project_dir, "agents", "data", "memory")
        if not os.path.isdir(db_dir):
            # Only record where the project already has a memory dir — do not
            # scaffold analytics into arbitrary derived directories.
            return False
        if (tokens_in or 0) <= 0 and (tokens_out or 0) <= 0:
            return False
        conn = sqlite3.connect(_analytics_db_path(project_dir), timeout=1.0)
        try:
            conn.execute(_CREATE_SQL)
            conn.execute(
                "INSERT INTO task_outcomes (modelId, taskType, complexity, success, "
                "durationMs, tokensIn, tokensOut, cost, taskId, timestamp) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    str(model or "unknown"),
                    task_type,
                    complexity,
                    1 if success else 0,
                    int(duration_ms or 0),
                    int(tokens_in or 0),
                    int(tokens_out or 0),
                    float(cost or 0.0),
                    str(task_id or ""),
                    datetime.now(timezone.utc).isoformat(),
                ),
            )
            conn.commit()
        finally:
            conn.close()
        return True
    except Exception:
        return False


# ── dashboard live-feed (telemetry.db) ─────────────────────────────────────
# The Live Events / Performance panels read <project>/agents/data/memory/
# telemetry.db, which is otherwise written only by the TS producers
# (mcp-router/executor). Plain claude+proxy sessions never run those, so the
# panels stayed empty forever. The proxy is the one process that sees every
# turn — mirror the turn into the same store. Compression stats are NOT
# fabricated here: the proxy does no compression, that panel is honestly
# empty for plain sessions.
#
# DDL matches src/utils/telemetry-store.ts exactly (CREATE IF NOT EXISTS
# no-ops when the TS side created the tables first; the shape only matters
# when the proxy creates them for a fresh project).
_TELEMETRY_CREATE_SQL = """
CREATE TABLE IF NOT EXISTS perf_samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  metric TEXT NOT NULL,
  duration_ms REAL NOT NULL,
  ts TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_perf_samples_metric ON perf_samples(metric);
CREATE TABLE IF NOT EXISTS dashboard_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL DEFAULT (datetime('now')),
  category TEXT NOT NULL,
  type TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info',
  title TEXT NOT NULL,
  detail TEXT,
  metadata TEXT
);
"""

# NOTE: the TS side trims events harder (MAX_PERSISTED_EVENTS = 500); this
# looser cap only matters for proxy-only projects where no TS producer runs.
_EVENTS_KEEP = 5000
_PERF_KEEP_PER_METRIC = 1000  # mirrors telemetry-store.ts PERF_SAMPLES_PER_METRIC
# Best-effort trim trigger: global across projects and not thread-safe, so a
# given DB trims roughly every 50*N-projects inserts — overshoot is bounded
# by the DELETEs themselves, precision is not needed here.
_trim_counter = 0


def record_dashboard_turn(
    project_dir: str,
    model: str,
    tokens_in: int,
    tokens_out: int,
    duration_ms: float = 0.0,
) -> bool:
    """Mirror one completed proxy turn into the project's telemetry.db so the
    dashboard's Live Events and Performance panels move for plain
    claude+proxy sessions. Never raises; a dropped event is strictly better
    than a stalled turn."""
    global _trim_counter
    try:
        db_dir = os.path.join(project_dir, "agents", "data", "memory")
        if not os.path.isdir(db_dir):
            return False
        conn = sqlite3.connect(os.path.join(db_dir, "telemetry.db"), timeout=1.0)
        try:
            # Match the TS producers' settings so cross-process writes don't
            # silently drop under lock contention (busy_timeout 2000: telemetry
            # must never stall the hot path).
            conn.execute("PRAGMA journal_mode = WAL")
            conn.execute("PRAGMA synchronous = NORMAL")
            conn.execute("PRAGMA busy_timeout = 2000")
            conn.executescript(_TELEMETRY_CREATE_SQL)
            conn.execute(
                "INSERT INTO dashboard_events (category, type, severity, title, metadata) "
                "VALUES ('model', 'turn', 'info', ?, ?)",
                (
                    f"{model}: {int(tokens_out or 0)} tok out / {int(tokens_in or 0)} in",
                    json.dumps(
                        {
                            "model": str(model or "unknown"),
                            "tokensIn": int(tokens_in or 0),
                            "tokensOut": int(tokens_out or 0),
                            "durationMs": round(float(duration_ms or 0), 1),
                        }
                    ),
                ),
            )
            if duration_ms and duration_ms > 0:
                conn.execute(
                    "INSERT INTO perf_samples (metric, duration_ms) VALUES ('proxy_turn_ms', ?)",
                    (float(duration_ms),),
                )
            _trim_counter += 1
            if _trim_counter % 50 == 0:
                conn.execute(
                    "DELETE FROM dashboard_events WHERE id NOT IN "
                    "(SELECT id FROM dashboard_events ORDER BY id DESC LIMIT ?)",
                    (_EVENTS_KEEP,),
                )
                conn.execute(
                    "DELETE FROM perf_samples WHERE metric = 'proxy_turn_ms' AND id NOT IN "
                    "(SELECT id FROM perf_samples WHERE metric = 'proxy_turn_ms' "
                    "ORDER BY id DESC LIMIT ?)",
                    (_PERF_KEEP_PER_METRIC,),
                )
            conn.commit()
        finally:
            conn.close()
        return True
    except Exception:
        return False


def record_from_request(
    body: dict, model: str, usage: dict, *, task_id: str = "", duration_ms: float = 0.0
) -> bool:
    """Proxy hot-path entry point: derive project + record. Never raises."""
    try:
        project_dir = derive_project_dir(body or {})
        if not project_dir:
            return False
        u = usage or {}
        tokens_in = int(u.get("input_tokens") or 0)
        tokens_out = int(u.get("output_tokens") or 0)
        wrote = record_task_outcome(
            project_dir,
            model,
            tokens_in,
            tokens_out,
            duration_ms=int(duration_ms or 0),
            task_id=task_id,
        )
        if wrote:
            record_dashboard_turn(project_dir, model, tokens_in, tokens_out, duration_ms)
        return wrote
    except Exception:
        return False
