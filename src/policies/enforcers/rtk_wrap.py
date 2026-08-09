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


# `rtk npm`/`rtk pnpm`/`rtk yarn` map to `<pm> run` (filtered script output). The
# subcommands below are NOT script runners, so `rtk npm view` would mangle to
# `npm run view`. Route them through `rtk proxy` instead (still tracked).
PM_BUILTINS = {
    "install", "i", "ci", "add", "view", "info", "show", "publish", "pack",
    "audit", "outdated", "ls", "list", "link", "unlink", "dedupe", "prune",
    "exec", "dlx", "init", "create", "ping", "whoami", "login", "logout",
    "version", "deprecate", "dist-tag", "owner", "access", "search", "update",
    "uninstall", "remove", "rm", "rebuild", "root", "bin", "config", "cache",
    "doctor", "fund", "why", "store", "set", "get",
}
PMS = ("npm", "pnpm", "yarn")


# A command is a sequence of STATEMENTS; each one invokes its own binary.
_STATEMENT_SPLIT_RE = re.compile(r"&&|\|\||[;|&\n]")


def _leading_binary(statement: str) -> tuple[str, list[str]] | None:
    """The binary a statement invokes, plus its tokens — or None.

    Skips env assignments (`FOO=bar cmd`) and shell grouping, then reads the
    FIRST real word. That word is what the shell executes; a wrapped CLI
    appearing later is an argument, not an invocation.
    """
    tokens = statement.replace("(", " ").replace("{", " ").split()
    idx = 0
    while idx < len(tokens) and "=" in tokens[idx].split("/")[0]:
        idx += 1  # env assignment prefix
    if idx >= len(tokens):
        return None
    return tokens[idx].split("/")[-1], tokens[idx:]


def main() -> None:
    op, args = parse_cli()
    cmd = (args.get("command") or args.get("cmd") or "").strip()
    if not cmd or op.lower() != "bash":
        emit(True, "not a Bash command")

    # Evaluate each statement on its own.
    #
    # Whole-command matching got this wrong in BOTH directions. It only accepted
    # `rtk` at the very start, so `cd /srv/app && rtk git log` — already wrapped —
    # was refused, with a suggestion that prefixed rtk to the entire line and
    # produced nonsense like `rtk cd /srv/app; git log`. And it scanned only the
    # first three tokens, so `cd /srv/app && git log` slipped through entirely:
    # `git` sat at index 3. That is a bypass, not just noise — any bare invocation
    # could be hidden behind a `cd`. Reading the leading binary of each statement
    # fixes both, because that is what the shell actually runs.
    for raw in _STATEMENT_SPLIT_RE.split(cmd):
        statement = raw.strip()
        if not statement:
            continue
        found = _leading_binary(statement)
        if not found:
            continue
        bin_name, tokens = found

        # A statement led by `rtk` (or anything else outside WRAPPED) is fine:
        # in `rtk git log` the leading binary is rtk and `git` is its argument.
        # No separate rtk check is needed - rtk is simply not a wrapped CLI.
        # Mutation testing flagged the earlier explicit check as equivalent,
        # i.e. dead.
        if bin_name not in WRAPPED:
            continue

        wrapper = "rtk"
        if bin_name in PMS:
            sub = ""
            for nxt in tokens[1:]:
                if not nxt.startswith("-"):
                    sub = nxt.split("/")[-1]
                    break
            if sub in PM_BUILTINS:
                wrapper = "rtk proxy"
        # Suggest fixing THIS statement, not the whole line.
        emit(
            False,
            f"rtk-wrap: '{bin_name}' must be invoked via rtk. "
            f"Use: {wrapper} {statement}",
            bin=bin_name,
        )

    emit(True, "no unwrapped CLI in any statement")


if __name__ == "__main__":
    main()
