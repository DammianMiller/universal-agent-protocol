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


# Flags that say "I am going to PARSE this". rtk rewrites output for human
# reading and does not notice these, so the caller gets prose where it asked
# for records. Verified against real git in this repo:
#   worktree list --porcelain  46 entries -> 0 through rtk
#   branch --format=...        55 refs    -> 142 lines, wrong set
#   diff --name-only           3 paths    -> 3 paths + a "--- Changes ---" block
#   status --porcelain         12 lines   -> 11
# `rtk proxy` runs it unfiltered and is byte-exact on every one.
MACHINE_FLAGS = (
    "--porcelain",
    "--format",
    "--pretty",
    "--name-only",
    "--name-status",
    "--numstat",
    "--raw",
    "-z",
)
# NOT --oneline: it is a reading convenience, not a parse signal, and
# test/rtk-wrap.test.ts contracts it as accepted. Anything meaning to parse log
# output uses --format or --pretty, which are covered above. rtk does reformat
# `log --oneline`, so a caller that parses it gets altered text -- a narrow
# residual, accepted rather than taxing one of the most common human git calls.

# Subcommand forms rtk restructures even without one of those flags. Kept to
# what was actually measured rather than guessed, because every entry here is
# friction for a human-readable call that would have been fine.
MACHINE_FORMS = {
    "branch": ("-r", "-a", "--merged", "--no-merged"),
    "worktree": ("list",),
    "stash": ("list",),
}

# rtk's docker handlers only recognise the BARE subcommand. Any flag on
# `docker ps` or `docker logs` makes rtk print "[rtk: parse failed, running
# raw]" ahead of otherwise-correct raw output. The DATA is fine -- but that
# line reads as a tool error, and a model that cannot act on it retries: it
# drove a live ERROR-LOOP on 2026-08-25 ("same failure x3,
# sig='[rtk: parse failed, running raw]'"). `rtk proxy` runs the same command
# unfiltered with no such line, and is still counted in the savings ledger.
#
# Measured against rtk 0.27.0 on 2026-08-25 -- listed rather than guessed,
# because every entry here is friction for a call that would have been fine:
#   docker ps                        ok
#   docker ps -a                     parse failed
#   docker ps --filter name=uap      parse failed
#   docker ps --format '{{.Names}}'  parse failed
#   docker images                    ok
#   docker logs --tail 1 <id>        parse failed
#   docker inspect <id>              ok
# So the trigger is the SUBCOMMAND plus any flag at all, not a specific flag.
DOCKER_FLAG_INTOLERANT = ("ps", "logs")


def docker_wants_proxy(tokens: list[str]) -> bool:
    """Is this a docker call rtk will fail to parse (bare form only)?"""
    args = [t for t in tokens if t.split("/")[-1] != "docker"]
    sub_cmd = next((t for t in args if not t.startswith("-")), "")
    if sub_cmd not in DOCKER_FLAG_INTOLERANT:
        return False
    return any(t.startswith("-") for t in args)


def wants_machine_output(tokens: list[str]) -> bool:
    """Is this git invocation asking for output something will parse?"""
    args = [t for t in tokens if t != "git"]
    for tok in args:
        if tok in MACHINE_FLAGS or tok.split("=")[0] in MACHINE_FLAGS:
            return True
    sub_cmd = next((t for t in args if not t.startswith("-")), "")
    return any(t in MACHINE_FORMS.get(sub_cmd, ()) for t in args)


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

        # A statement led by `rtk` is normally fine: in `rtk git log` the
        # leading binary is rtk and `git` is its argument. One exception --
        # `rtk git <machine-readable>` is the corrupting combination, and
        # skipping every rtk-led statement is what let it through the gate.
        if bin_name == "rtk":
            rest = [t for t in tokens[1:] if not t.startswith("-")]
            if rest[:1] == ["docker"] and docker_wants_proxy(tokens[1:]):
                emit(
                    False,
                    "rtk-wrap: rtk only parses the bare form of this docker "
                    "subcommand; with any flag it prefixes "
                    "'[rtk: parse failed, running raw]' to the output, which "
                    "reads as an error and has driven retry loops. Use: "
                    "rtk proxy " + " ".join(tokens[1:]),
                    bin="rtk",
                )
            if rest[:1] == ["git"] and wants_machine_output(tokens[1:]):
                emit(
                    False,
                    "rtk-wrap: rtk reformats output for reading, so a git command "
                    "that asked for machine-readable output comes back as prose "
                    "(measured: `worktree list --porcelain` returns 0 entries "
                    "through rtk, 46 through git). Use: rtk proxy "
                    + " ".join(tokens[1:]),
                    bin="rtk",
                )
            continue

        if bin_name not in WRAPPED:
            continue

        wrapper = "rtk"
        if bin_name == "git" and wants_machine_output(tokens):
            # Still through rtk, so the call is still tracked -- just unfiltered.
            wrapper = "rtk proxy"
        elif bin_name == "docker" and docker_wants_proxy(tokens):
            wrapper = "rtk proxy"
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
