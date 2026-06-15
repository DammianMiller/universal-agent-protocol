#!/usr/bin/env python3
"""mcp-router-first enforcer: MCP tools must be loaded on demand."""
from __future__ import annotations
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _common import arg_str, emit, parse_cli  # noqa: E402

BULK_PATTERNS = re.compile(r"(load[-_ ]all|bulk[-_ ]load|all[-_ ]tools|eager)", re.I)


def main() -> None:
    op, args = parse_cli()
    blob = f"{op} {arg_str(args)}"

    if op not in {"ToolSearch", "tool_search", "mcp-router", "mcp_router"}:
        emit(True, "not an MCP-router op")

    query = (args.get("query") or "").strip()
    max_results = int(args.get("max_results") or 5)

    if BULK_PATTERNS.search(blob):
        emit(False, "mcp-router-first: bulk/eager MCP tool load detected; query by specific tool name instead")

    if not query or max_results > 20:
        emit(
            False,
            "mcp-router-first: ToolSearch must use a specific query and max_results<=20",
        )

    emit(True, "scoped MCP router query")


if __name__ == "__main__":
    main()
