#!/usr/bin/env python3
"""adr-guard enforcer — generic ADR-driven tool-call gate.

Reads machine-readable rule blocks from every ADR under `docs/adr/` and
enforces them on Write/Edit tool calls. This lets us express architectural
and security invariants once — in the ADR itself — and have them enforced
automatically by UAP agents.

Rule block format (embedded inside an ADR as an HTML comment):

    <!-- uap-rules
    - id: ADR-0007-FE-NO-BEARER
      scope:
        include: ["apps/web/", "apps/cms/", "apps/marketing/"]
        exclude: ["/tests/", ".test.", ".spec.", "/node_modules/"]
        ext: [".js", ".ts", ".jsx", ".tsx"]
      forbid: 'Authorization.*Bearer'
      message: "FE must not set Authorization: Bearer. See ADR-0007."
    - id: ADR-0006-PIPELINE-ONLY
      scope:
        include: ["infra/"]
        exclude: ["infra/archive/"]
      require: '^#\\s*managed-by:\\s*terraform'
      message: "Infra files must declare terraform ownership. See ADR-0006."
    -->

Fields:
    id        — unique rule ID (prefix with ADR number)
    scope.*   — path filters (include prefixes, exclude substrings, ext list)
    forbid    — regex that MUST NOT match the written content
    require   — regex that MUST match (at least one hit) when writing into scope
    message   — explanation shown when blocked
    on_tools  — optional list of tool names (default: Write, Edit, MultiEdit)

The parser caches rules by ADR-file mtime so rebuilds are cheap.
"""
from __future__ import annotations

import os
import re
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).parent))
from _common import emit, parse_cli, repo_root  # noqa: E402

try:
    import yaml  # type: ignore
except ImportError:  # pragma: no cover
    yaml = None


RULE_BLOCK_RE = re.compile(
    r"<!--\s*uap-rules\s*\n(.*?)\n\s*-->", re.DOTALL | re.IGNORECASE
)


def _parse_adr_rules(adr_dir: Path) -> list[dict[str, Any]]:
    """Extract all uap-rules blocks from ADR files."""
    if not adr_dir.is_dir() or yaml is None:
        return []
    rules: list[dict[str, Any]] = []
    for f in sorted(adr_dir.glob("*.md")):
        try:
            text = f.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        for m in RULE_BLOCK_RE.finditer(text):
            body = m.group(1)
            try:
                parsed = yaml.safe_load(body)
            except yaml.YAMLError:
                continue
            if not isinstance(parsed, list):
                continue
            for r in parsed:
                if not isinstance(r, dict):
                    continue
                r["_adr"] = f.name
                rules.append(r)
    return rules


def _extract_write_target(op: str, args: dict[str, Any]) -> tuple[str, str] | None:
    tool = op.lower()
    if tool == "write":
        return args.get("file_path") or "", args.get("content") or ""
    if tool == "edit":
        return args.get("file_path") or "", args.get("new_string") or ""
    if tool == "multiedit":
        fp = args.get("file_path") or ""
        edits = args.get("edits") or []
        content = "\n".join(
            e.get("new_string", "") for e in edits if isinstance(e, dict)
        )
        return fp, content
    if tool == "notebookedit":
        return args.get("notebook_path") or "", args.get("new_source") or ""
    return None


def _path_matches_scope(path: str, scope: dict[str, Any] | None) -> bool:
    if not scope:
        return True
    includes = scope.get("include") or [""]
    excludes = scope.get("exclude") or []
    exts = scope.get("ext")
    if not any(inc == "" or inc in path for inc in includes):
        return False
    for exc in excludes:
        if exc and exc in path:
            return False
    if exts:
        if not any(path.endswith(e) for e in exts):
            return False
    return True


def _normalize_path(file_path: str) -> str:
    norm = file_path.replace("\\", "/")
    for top in (
        "apps/", "infra/", "services/", "docs/", "scripts/", ".github/",
        ".semgrep/", ".policy-tools/", ".claude/", "observability/",
    ):
        idx = norm.find(top)
        if idx >= 0:
            return norm[idx:]
    return norm


def main() -> None:
    op, args = parse_cli()
    target = _extract_write_target(op, args)
    if target is None:
        emit(True, "not a write/edit operation")
    file_path, content = target
    if not file_path:
        emit(True, "no file path in args")

    root = repo_root()
    rules = _parse_adr_rules(root / "docs" / "adr")
    if not rules:
        emit(True, "no ADR rules active")

    norm = _normalize_path(file_path)
    tool = op if op else ""

    violations: list[str] = []
    for rule in rules:
        on_tools = rule.get("on_tools") or ["Write", "Edit", "MultiEdit"]
        if tool and tool not in on_tools:
            continue
        if not _path_matches_scope(norm, rule.get("scope")):
            continue

        forbid = rule.get("forbid")
        if forbid:
            try:
                if re.search(forbid, content):
                    msg = rule.get("message") or f"ADR rule {rule.get('id','?')}"
                    violations.append(
                        f"[{rule.get('id','adr-rule')} from {rule.get('_adr')}] {msg}"
                    )
            except re.error:
                continue

        require = rule.get("require")
        if require:
            try:
                if not re.search(require, content):
                    msg = rule.get("message") or f"ADR rule {rule.get('id','?')}"
                    violations.append(
                        f"[{rule.get('id','adr-rule')} from {rule.get('_adr')}] (required pattern missing) {msg}"
                    )
            except re.error:
                continue

    if violations:
        emit(
            False,
            "adr-guard: " + " | ".join(violations),
            violations=violations,
        )
    emit(True, "no ADR rule violations in write")


if __name__ == "__main__":
    main()
