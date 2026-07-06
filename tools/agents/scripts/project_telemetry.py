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

_CREATE_SQL = (
    "CREATE TABLE IF NOT EXISTS task_outcomes ("
    "modelId TEXT, taskType TEXT, complexity TEXT, success INTEGER, "
    "durationMs INTEGER, tokensIn INTEGER, tokensOut INTEGER, cost REAL, "
    "taskId TEXT, timestamp TEXT)"
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


def record_from_request(body: dict, model: str, usage: dict, *, task_id: str = "") -> bool:
    """Proxy hot-path entry point: derive project + record. Never raises."""
    try:
        project_dir = derive_project_dir(body or {})
        if not project_dir:
            return False
        u = usage or {}
        return record_task_outcome(
            project_dir,
            model,
            int(u.get("input_tokens") or 0),
            int(u.get("output_tokens") or 0),
            task_id=task_id,
        )
    except Exception:
        return False
