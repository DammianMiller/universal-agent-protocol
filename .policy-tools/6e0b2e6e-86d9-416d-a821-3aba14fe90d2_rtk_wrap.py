#!/usr/bin/env python3
"""rtk-wrap enforcer: heavy CLIs must be invoked via rtk."""
from __future__ import annotations
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _common import emit, parse_cli  # noqa: E402

WRAPPED = ("git", "kubectl", "docker", "docker-compose", "npm", "pnpm", "yarn", "helm", "terraform")
RTK_META = re.compile(r"^\s*rtk\s+(gain|discover|proxy|--version|-V|--help)\b")
ALREADY_WRAPPED = re.compile(r"^\s*rtk\s+\S+")


def main() -> None:
    op, args = parse_cli()
    cmd = (args.get("command") or args.get("cmd") or "").strip()
    if not cmd or op.lower() != "bash":
        emit(True, "not a Bash command")

    first = cmd.split(maxsplit=1)[0].lstrip("(").lstrip("{")
    if first == "rtk" and RTK_META.search(cmd):
        emit(True, "rtk meta command")
    if ALREADY_WRAPPED.match(cmd):
        emit(True, "already wrapped")

    # Inspect tokens (ignore env assignments like FOO=bar cmd)
    tokens = [t for t in cmd.split() if "=" not in t.split("/")[0]]
    for tok in tokens[:3]:
        bin_name = tok.split("/")[-1]
        if bin_name in WRAPPED:
            emit(
                False,
                f"rtk-wrap: '{bin_name}' must be invoked via rtk. "
                f"Use: rtk {cmd}",
                bin=bin_name,
            )

    emit(True, "no wrapped CLI in command")


if __name__ == "__main__":
    main()
