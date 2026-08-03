#!/usr/bin/env python3
"""workdir-scope enforcer: file-mutating tool calls must stay within the project
working directory (the repo root + its worktrees + a small scratch allow-list).

Creating/writing/moving a path OUTSIDE the workdir is blocked by default — it
requires explicit operator approval. This is the policy-engine enforcement of the
operator rule "never step outside the current path without explicit permission":
agents running with --dangerously-skip-permissions emit absolute paths that can
escape the project (e.g. a sibling at ~/dev, or a garbled `octopusspace-shooter`),
silently creating directories outside the intended workspace.

Allowed targets:
  * anything under the current working tree (UAP_WORKTREE_ROOT) or the main
    checkout (UAP_REPO_ROOT) — worktrees included;
  * relative paths (they resolve under the project root);
  * a scratch allow-list: /tmp, $TMPDIR, ~/.cache/uap, ~/.config/uap,
    ~/.claude/projects and ~/.claude/plans (Claude Code auto-memory, session
    and plan-file storage), plus any colon-separated prefixes in
    UAP_WORKDIR_ALLOW.

Escape hatch: UAP_WORKDIR_SCOPE_OFF=1 allows everything (operator override).
"""
from __future__ import annotations

import os
import re
import shlex
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _common import emit, parse_cli, repo_root, worktree_root  # noqa: E402
from _common import strip_heredoc_bodies  # noqa: E402

# Tools that create/modify a file at an explicit path argument.
PATH_WRITE_OPS = {
    "Write", "Edit", "MultiEdit", "NotebookEdit",
    "write", "edit", "multiedit", "notebookedit",
}
PATH_ARG_KEYS = ("file_path", "path", "notebook_path", "filePath", "target")

# Bash verbs that CREATE/MOVE filesystem entries (pure-read commands are ignored).
_BASH_CREATE = ("mkdir", "touch", "install", "tee")
_BASH_DEST_LAST = ("cp", "mv", "rsync")  # destination is the final argument


def _expand(p: str) -> Path:
    return Path(os.path.expanduser(os.path.expandvars(p)))


def _allowed_roots() -> list[Path]:
    roots: list[Path] = []

    def add(p: Path) -> None:
        try:
            r = p.resolve()
        except Exception:  # noqa: BLE001
            r = p
        if r not in roots:
            roots.append(r)

    add(worktree_root())
    add(repo_root())
    # ~/.claude/projects is the Claude Code harness's own storage (auto-memory
    # topic files, MEMORY.md index, session/transcript data). The harness
    # instructs agents to persist memories there; blocking it silently breaks
    # memory recording (observed on pay2u 2026-07-05).
    #
    # ~/.claude/plans is the same story for plan mode: the harness assigns the
    # agent a plan file under it and ExitPlanMode reads the plan back from
    # there. Blocking it makes plan mode unusable - and since self-protect
    # matches this enforcer's own override env var, that documented escape is
    # unreachable from inside a session too (observed 2026-08-03).
    for p in (
        "/tmp",
        os.environ.get("TMPDIR", "/tmp"),
        "~/.cache/uap",
        "~/.config/uap",
        "~/.claude/projects",
        "~/.claude/plans",
    ):
        add(_expand(p))
    for p in os.environ.get("UAP_WORKDIR_ALLOW", "").split(":"):
        if p.strip():
            add(_expand(p))
    return roots


def _inside(target: Path, roots: list[Path]) -> bool:
    try:
        t = target.resolve()
    except Exception:  # noqa: BLE001
        t = target
    for root in roots:
        try:
            t.relative_to(root)
            return True
        except ValueError:
            continue
    return False


def _is_dev_node(p: Path) -> bool:
    """True for device pseudo-files under /dev (/dev/null, /dev/stderr,
    /dev/stdout, /dev/fd/N, /dev/tty, /dev/zero, ...). Redirecting or writing
    to these never escapes the project workspace — it's universal shell idiom
    (`2>/dev/null`, `>/dev/stdout`) — so they are always in scope."""
    return p == Path("/dev") or str(p).startswith("/dev/")


def _check_path(target: str, roots: list[Path]) -> str:
    """Return the offending absolute path if out of scope, else ''."""
    if not target:
        return ""
    p = _expand(target)
    if not p.is_absolute():
        # Relative paths resolve under the enforcer cwd (the project root).
        return ""
    if _is_dev_node(p):
        # /dev device nodes are not a filesystem escape (e.g. `2>/dev/null`).
        return ""
    return "" if _inside(p, roots) else str(p)


# Shell constructs the quote model above does not represent. Their presence
# means a quoted span may still contain EXECUTING code (command substitution)
# or may not be quoted at all (escaped quote characters), so masking is unsafe.
_UNMODELLED = re.compile(r"\$\(|`|\$'|\\['\"]")


_LINE_CONT = re.compile(r'\\\n')
_REDIR_OP = re.compile(r'(?:\d*>>?|&>)')
# Targets may be tilde- or variable-prefixed: `> ~/x`, `> $HOME/x`. _expand()
# already resolves both before the scope check, but a `/`-anchored pattern
# never handed them over — so they were silently unchecked (confirmed by
# writing outside the project through both forms).
_REDIR_TARGET = re.compile(r'\s*("?)([~/$][^\s"\';|&)]+)\1')


def _risk_view(cmd: str) -> str:
    """`cmd` with SINGLE-quoted spans blanked, for the unmodelled-construct check.

    Single quotes suppress every expansion, so `$(`, a backtick or `$'` inside
    them is inert prose and must not force the conservative raw scan — that is
    how an ordinary `git commit -m '... $(uname) ... > /opt/notes ...'` came
    to be refused. Double-quoted and unquoted occurrences stay visible, because
    those DO execute.
    """
    out = list(cmd)
    in_sq = False
    i = 0
    while i < len(cmd):
        ch = cmd[i]
        if in_sq:
            if ch == "'":
                in_sq = False
            else:
                out[i] = " "
        elif ch == "\\":
            i += 2          # escaped char cannot open a quote
            continue
        elif ch == "'" and not (i and cmd[i - 1] == "$"):
            # $'...' processes escapes, so it is NOT inert — leave it visible.
            in_sq = True
        i += 1
    return "".join(out)


def _mask_quoted(cmd: str) -> tuple[str, bool]:
    """(masked copy, whether a quote was left unterminated).

    Blanks the CONTENT of quoted spans, preserving length so offsets still line
    up with the original and the redirect TARGET can be read from the real
    string.

    Escape-aware, and that is the load-bearing part. A naive quote toggle
    desyncs on an escaped quote and then blanks everything after it — including
    a genuinely unquoted redirect. `: \\" > /root/x` was ALLOWED by exactly
    that bug: a containment gate turned into a bypass, which is strictly worse
    than the false positive the masking was added to fix.

    Shell rules honoured:
      * unquoted `\\X` escapes X, so X can neither open a quote nor be an
        operator (`\\>` is a literal, not a redirect);
      * inside '...' there is NO escaping — the next ' always closes;
      * inside "..." a backslash escapes the following character;
      * $'...' does process escapes, so a backslashed quote does not close it.
    """
    out = list(cmd)
    n = len(cmd)
    quote = None          # None | "'" | '"' | "$'"
    i = 0
    while i < n:
        ch = cmd[i]
        if quote is None:
            if ch == "\\":
                # Escapes the next character: blank it so it cannot be read as an
                # operator, and never let it open a quoted span.
                if i + 1 < n:
                    out[i + 1] = " "
                i += 2
                continue
            if ch == "'":
                # $'...' processes escapes; a bare '...' does not.
                quote = "$'" if i and cmd[i - 1] == "$" else "'"
            elif ch == '"':
                quote = '"'
        elif quote == "'":
            if ch == "'":
                quote = None
            else:
                out[i] = " "
        else:  # '"' or "$'" — both process backslash escapes
            if ch == "\\" and i + 1 < n:
                out[i] = " "
                out[i + 1] = " "
                i += 2
                continue
            if (quote == '"' and ch == '"') or (quote == "$'" and ch == "'"):
                quote = None
            else:
                out[i] = " "
        i += 1
    return "".join(out), quote is not None


def _scan_bash(cmd: str, roots: list[Path]) -> str:
    """Best-effort: flag an out-of-scope absolute path that a CREATE/MOVE command
    would write. Conservative — only inspects the destinations of known
    create/move verbs and output redirections, and ignores read sources."""
    if not cmd:
        return ""
    # A heredoc body is stdin data for the program being run (a Python script,
    # a commit message), not a sequence of shell commands. Scanning it split on
    # newlines flags any path-shaped string inside it. Bodies that could be
    # executed are left in place by the helper.
    cmd = strip_heredoc_bodies(cmd)
    # Bash removes `\\<newline>` before word-splitting. Leaving it in split one
    # logical command across two segments, so a create verb on the first line
    # never met its destination on the second — `mkdir -p \\<newline> /outside`
    # was allowed while bash created the directory.
    cmd = _LINE_CONT.sub(" ", cmd)
    try:
        tokens = shlex.split(cmd, comments=True)
    except ValueError:
        tokens = cmd.split()

    candidates: list[str] = []

    # Output redirections.
    #
    # Operators are located in a QUOTE-MASKED copy, because a redirect
    # operator inside quotes is not a redirect - it is literal text.
    # Scanning the raw string refused a sed range expression, reading the
    # trailing '/p' of `sed -n '/a/,/b/p'` as a write to /p when the range
    # delimiters were angle brackets (observed 2026-08-03, while editing
    # this very enforcer). The TARGET is then read from the ORIGINAL
    # string at that offset, so a legitimately quoted absolute destination
    # is still detected.
    masked, unterminated = _mask_quoted(cmd)
    # Scan the RAW string whenever the quote model cannot be trusted:
    #
    #   * an unterminated quote — the mask is desynced by construction;
    #   * a construct the model does not represent (_UNMODELLED). Command
    #     substitution is the important one: it EXECUTES inside double quotes,
    #     so blanking a quoted span hides a live redirect. Verified with bash —
    #     `echo "$(id > /outside)"` writes the file, and the masked scan saw
    #     nothing. A containment gate must over-block, never under-block, so
    #     these fall back to the conservative scan and accept its false
    #     positives.
    #
    # The sed-range case this masking exists to fix contains none of them, so it
    # still passes.
    untrusted = unterminated or _UNMODELLED.search(_risk_view(cmd)) is not None
    for m in _REDIR_OP.finditer(cmd if untrusted else masked):
        target = _REDIR_TARGET.match(cmd, m.end())
        if target:
            candidates.append(target.group(2))

    # Split into pipeline/sequence segments so we read each command's own verb.
    # Parens are separators too, so the inner command of a process substitution
    # becomes its own segment: `> >(tee /outside)` otherwise hid `tee`'s
    # destination from the verb scan entirely, while bash wrote the file.
    segments = re.split(r'\|\||&&|[;|&\n()]', cmd)
    for seg in segments:
        try:
            parts = shlex.split(seg, comments=True)
        except ValueError:
            parts = seg.split()
        if not parts:
            continue
        verb = os.path.basename(parts[0])
        argv = [a for a in parts[1:] if not a.startswith("-")]
        if verb in _BASH_CREATE:
            candidates.extend(argv)  # all targets are created
        elif verb in _BASH_DEST_LAST and argv:
            candidates.append(argv[-1])  # only the destination is written

    for c in candidates:
        bad = _check_path(c, roots)
        if bad:
            return bad
    return ""


def main() -> None:
    op, args = parse_cli()

    if os.environ.get("UAP_WORKDIR_SCOPE_OFF") == "1":
        emit(True, "UAP_WORKDIR_SCOPE_OFF override set")

    roots = _allowed_roots()

    if op in PATH_WRITE_OPS:
        for key in PATH_ARG_KEYS:
            bad = _check_path(args.get(key) or "", roots)
            if bad:
                _deny(bad)
        emit(True, "target within workdir scope")

    if op in {"Bash", "bash"}:
        bad = _scan_bash(args.get("command") or "", roots)
        if bad:
            _deny(bad, bash=True)
        emit(True, "no out-of-scope write target in command")

    emit(True, "not a path-mutating operation")


def _deny(path: str, bash: bool = False) -> None:
    where = "command writes to" if bash else "target"
    emit(
        False,
        f"workdir-scope: {where} '{path}' is OUTSIDE the project working directory. "
        "Stepping outside the current path requires explicit permission. "
        "Write inside the project, or — if this is intended — re-run with "
        "UAP_WORKDIR_SCOPE_OFF=1 (or add the prefix to UAP_WORKDIR_ALLOW).",
    )


if __name__ == "__main__":
    main()
