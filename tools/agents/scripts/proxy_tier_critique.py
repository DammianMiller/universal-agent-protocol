"""U-J: live quality-tier bars for multimodal critique turns.

The proxy's VISUAL & SYSTEMIC CRITIQUE checklist (anthropic_proxy.py) teaches
the model HOW to look at an artifact, but it is static: it cannot know the
numeric bar the project actually resolved. The UAP tier store carries exactly
that — the fleet store (UAP_TIER_STORE, else ~/.uap/quality/tiers.json) and
the project store (.uap/quality/tiers.json, walked up from CWD to the repo
root) hold per-axis thresholds harvested from frontier exemplars or published
from the built-in class priors (src/quality/class-priors.ts).

This module renders the resolved tiers (project over fleet — the same
precedence as src/quality/tiers.ts) into a compact per-turn directive the
proxy appends to the trailing user message alongside the checklist. The model
then holds its OWN current capture to the numeric bar and gets the exact
self-measure command — every visual critique turn becomes a self-measuring
loop, with no reference media needed at request time.

Pure read-only work: two small JSON files, mtime-cached. Every entry point
fails open to "" (no digest); a missing, corrupt, or empty store injects
nothing at all.

Env:
  PROXY_TIER_CRITIQUE=on            master switch (honored here and in the proxy)
  PROXY_TIER_CRITIQUE_MAX_TIERS=4   cap on tiers rendered per directive
  UAP_TIER_STORE=<path>             fleet-store override
  HOME=<path>                       fleet-store default anchor
"""
from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Mapping

_OFF_VALUES = {"0", "false", "off", "no"}

_HEADER = (
    "LIVE QUALITY BARS (resolved UAP tier store — hold YOUR OWN artifact to "
    "these numbers; no reference media required):"
)
_FOOTER = (
    "Self-measure after every capture/build: `uap quality gap --file <artifact> "
    "--tier <key>` — iterate worst-first until every axis passes."
)

# mtime cache: rebuild only when a store file appears, disappears, or changes.
_cache: dict[str, Any] = {"sig": None, "text": ""}


def _enabled(env: Mapping[str, str]) -> bool:
    return str(env.get("PROXY_TIER_CRITIQUE", "on")).strip().lower() not in _OFF_VALUES


def _max_tiers(env: Mapping[str, str]) -> int:
    try:
        return max(1, int(env.get("PROXY_TIER_CRITIQUE_MAX_TIERS", "4")))
    except (TypeError, ValueError):
        return 4


def fleet_store_path(env: Mapping[str, str]) -> Path:
    """The fleet-global tier store: UAP_TIER_STORE, else ~/.uap/quality/tiers.json."""
    override = env.get("UAP_TIER_STORE")
    if override:
        return Path(override)
    home = env.get("HOME") or os.path.expanduser("~")
    return Path(home) / ".uap" / "quality" / "tiers.json"


def _git_common_root(git_file: Path) -> Path | None:
    """Resolve a worktree `.git` FILE to its main-checkout root (fails open to None)."""
    try:
        line = git_file.read_text(encoding="utf-8", errors="replace").strip()
        if not line.startswith("gitdir:"):
            return None
        gitdir = Path(line.split(":", 1)[1].strip())
        if not gitdir.is_absolute():
            gitdir = (git_file.parent / gitdir).resolve()
        # <main>/.git/worktrees/<name> → <main> (three levels up from the leaf)
        if gitdir.parent.name == "worktrees":
            return gitdir.parent.parent.parent
        # a direct pointer at <main>/.git
        if gitdir.name == ".git":
            return gitdir.parent
        return None
    except OSError:
        return None


def discover_project_store(cwd: Path | None = None) -> Path | None:
    """Walk up from CWD looking for .uap/quality/tiers.json, stopping at the repo root.

    Mirrors the proxy.env walker's trust rules: a real repository root (.git
    DIR) ends the walk; a worktree (.git FILE) is the same repository and the
    same trust domain — follow it to the main checkout, check there, and stop.
    """
    base = Path.cwd() if cwd is None else Path(cwd)
    for candidate_root in [base, *base.parents]:
        store = candidate_root / ".uap" / "quality" / "tiers.json"
        if store.is_file():
            return store
        git = candidate_root / ".git"
        if git.is_dir():
            return None
        if git.is_file():
            main_root = _git_common_root(git)
            if main_root is not None:
                store = main_root / ".uap" / "quality" / "tiers.json"
                if store.is_file():
                    return store
            return None
    return None


def load_store_file(path: Path | None) -> dict[str, Any]:
    """Read one tier-store file; fails open to {} on missing or corrupt input."""
    if path is None:
        return {}
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    tiers = raw.get("tiers") if isinstance(raw, dict) else None
    return tiers if isinstance(tiers, dict) else {}


def resolve_tiers(env: Mapping[str, str], cwd: Path | None = None) -> dict[str, Any]:
    """The effective tiers: the fleet store overridden by the project store."""
    merged = dict(load_store_file(fleet_store_path(env)))
    merged.update(load_store_file(discover_project_store(cwd)))
    return merged


def format_rule(rule: Any) -> str | None:
    """Render one axis threshold: '>=min', '<=max', or 'in [min,max]' (None if unusable)."""
    if not isinstance(rule, dict):
        return None
    lo = rule.get("min")
    hi = rule.get("max")
    lo = lo if isinstance(lo, (int, float)) and not isinstance(lo, bool) else None
    hi = hi if isinstance(hi, (int, float)) and not isinstance(hi, bool) else None
    if lo is not None and hi is not None:
        return f"in [{lo:.5g},{hi:.5g}]"
    if lo is not None:
        return f">={lo:.5g}"
    if hi is not None:
        return f"<={hi:.5g}"
    return None


def render_tier(key: str, profile: Any) -> str | None:
    """One tier as a directive line; None when the profile carries no usable threshold."""
    thresholds = profile.get("thresholds") if isinstance(profile, dict) else None
    if not isinstance(thresholds, dict):
        return None
    parts = []
    for axis, rule in thresholds.items():
        rendered = format_rule(rule)
        if rendered:
            parts.append(f"{axis} {rendered}")
    if not parts:
        return None
    return f"- {key}: " + "; ".join(parts) + "."


def _mtime(path: Path | None) -> float:
    if path is None:
        return -1.0
    try:
        return path.stat().st_mtime
    except OSError:
        return -1.0


def build_digest(env: Mapping[str, str] | None = None, cwd: Path | None = None) -> str:
    """The live tier-bars directive for this turn; "" when off, unresolved, or on error."""
    environ = os.environ if env is None else env
    if not _enabled(environ):
        return ""
    try:
        fleet = fleet_store_path(environ)
        project = discover_project_store(cwd)
        sig = (str(fleet), str(project), _mtime(fleet), _mtime(project), _max_tiers(environ))
        if _cache["sig"] == sig:
            return _cache["text"]
        tiers = resolve_tiers(environ, cwd)
        lines = []
        for key in sorted(tiers)[: _max_tiers(environ)]:
            line = render_tier(key, tiers[key])
            if line:
                lines.append(line)
        text = "\n".join([_HEADER, *lines, _FOOTER]) if lines else ""
        _cache["sig"] = sig
        _cache["text"] = text
        return text
    except Exception:  # pragma: no cover - advisory path, fails open
        return ""
