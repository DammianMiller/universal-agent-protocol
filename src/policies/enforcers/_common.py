"""Shared helpers for UAP policy enforcers."""
from __future__ import annotations
import argparse
import json
import os
import time
import re
import subprocess
import sys
from pathlib import Path
from typing import Any

# Escape-hatch paths for the expert-review gate — shared so enforcement_self_protect
# (must ALLOW writes here) and expert_review_required (reads/writes here) can never
# drift out of lockstep and silently re-deadlock the two gates.
REVIEW_ARTIFACT_DIR = ".uap/reviews"
REVIEW_WAIVER_DIR = "policies/waivers"


def parse_cli() -> tuple[str, dict[str, Any]]:
    p = argparse.ArgumentParser()
    p.add_argument("--operation", required=True)
    p.add_argument("--args", default="{}")
    ns = p.parse_args()
    try:
        args = json.loads(ns.args)
    except json.JSONDecodeError:
        args = {}
    return ns.operation, args


def emit(allowed: bool, reason: str, **extra: Any) -> None:
    payload: dict[str, Any] = {"allowed": allowed, "reason": reason}
    payload.update(extra)
    json.dump(payload, sys.stdout)
    sys.exit(0 if allowed else 2)


def repo_root() -> Path:
    env = os.environ.get("UAP_REPO_ROOT")
    if env:
        return Path(env)
    cwd = Path.cwd()
    for p in [cwd, *cwd.parents]:
        if (p / ".git").exists():
            return p
    return cwd


def worktree_root() -> Path:
    """Root of the current WORKING TREE for git operations.

    Distinct from repo_root() (the main checkout, where runtime data like
    policies.db lives). git-diff based enforcers must run against the working
    tree — which is the worktree when an operation runs from inside one. The
    policy gate exports UAP_WORKTREE_ROOT; fall back to `git rev-parse` from cwd,
    then to repo_root().
    """
    env = os.environ.get("UAP_WORKTREE_ROOT")
    if env:
        return Path(env)
    try:
        r = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            capture_output=True, text=True, timeout=3, env=_clean_env(),
        )
        if r.returncode == 0 and r.stdout.strip():
            return Path(r.stdout.strip())
    except Exception:  # noqa: BLE001
        pass
    return repo_root()


# git exports repo-context vars (GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, ...)
# into hook environments. An enforcer spawned during a hook would then run its
# own git calls against the HOOK'S repo instead of cwd — silently no-op'ing
# every git-diff based check. Strip them so cwd decides the repo.
_GIT_CONTEXT_VARS = (
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_COMMON_DIR",
    "GIT_OBJECT_DIRECTORY",
    "GIT_PREFIX",
)


def _clean_env() -> dict[str, str]:
    return {k: v for k, v in os.environ.items() if k not in _GIT_CONTEXT_VARS}


def run(cmd: list[str], cwd: Path | None = None, timeout: int = 5) -> tuple[int, str, str]:
    try:
        r = subprocess.run(
            cmd, cwd=cwd, capture_output=True, text=True, timeout=timeout,
            env=_clean_env(),
        )
        return r.returncode, r.stdout, r.stderr
    except Exception as e:  # noqa: BLE001
        return 1, "", str(e)


def arg_str(args: dict[str, Any]) -> str:
    """Flatten args to a single lowercase string for substring checks."""
    try:
        return json.dumps(args, default=str).lower()
    except Exception:  # noqa: BLE001
        return str(args).lower()


# ---------------------------------------------------------------------------
# Command-text scanning
# ---------------------------------------------------------------------------
# Gates match markers ("terraform apply", "gh pr merge") as substrings of a
# Bash command. That also matches those words when they sit inside a DATA
# payload — a quoted prose argument or a heredoc body — so a command that
# merely *mentions* another command gets blocked as if it were one. Observed:
# `uap memory store "...gh pr merge..."` blocked by the IaC merge gate, and a
# `python3 - <<PY` heredoc whose body contained a path-shaped string blocked by
# workdir-scope.
#
# SAFETY: text handed to a shell IS a command, not data. If the command
# contains any shell-exec construct, nothing is stripped — stripping it would
# turn `bash -c "terraform apply"` into a bypass. Likewise a payload
# containing command substitution is left intact.

# `sh -c` / `bash -c` (any -flags form), plus the other ways text becomes code.
_SHELL_EXEC_RE = re.compile(
    r"(?:^|[\s;|&(<])(?:ba|z|k|da|a)?sh\s+(?:-\w+\s+)*-\w*c\b"
    r"|(?:^|[\s;|&(])(?:eval|source|exec|xargs|env)\b"
    r"|(?:^|[\s;|&(])(?:ba|z|k|da|a)?sh\s*(?:<|$)",
    re.I,
)

# Command substitution anywhere in a payload means it can execute.
_SUBST_RE = re.compile(r"\$\(|`|\$\{")


def hands_text_to_shell(cmd: str) -> bool:
    """True if `cmd` can turn argument/heredoc text into executed code.

    When this holds, callers must scan the command verbatim: the payload is
    itself a command.
    """
    return bool(_SHELL_EXEC_RE.search(cmd or ""))


# Gate evidence: records proving a required action actually happened.
#
# Kept OUT of the general .uap/ runtime area because self-protect's Bash scan is
# intentionally permissive there. This subdirectory is listed in self-protect's
# PROTECTED_TARGETS, so an agent cannot append to it from a shell the way it
# could to .uap/read_log.state. Written only by the PostToolUse hook and the
# CLI, neither of which is an agent tool call.
EVIDENCE_DIR = Path(os.environ.get("UAP_STATE_DIR", ".uap")) / "evidence"


def evidence_path(kind: str) -> Path:
    """Path of the append-only log for one kind of evidence."""
    return EVIDENCE_DIR / f"{kind}.log"


def recent_evidence(kind: str, window_sec: int, root: Path | None = None) -> int:
    """How many `kind` records were written within `window_sec`.

    Records are "<epoch>\t<detail>" lines. A malformed or missing line is
    skipped rather than failing the read: evidence is a signal, and a corrupt
    line should not decide whether work proceeds.
    """
    candidates = [evidence_path(kind)]
    if root is not None:
        # The gate pins cwd to MAIN_ROOT, but a direct invocation may not, so
        # the repo-rooted path is checked too.
        candidates.append(root / ".uap" / "evidence" / f"{kind}.log")

    now = time.time()
    seen = 0
    for path in candidates:
        try:
            lines = path.read_text().splitlines()
        except OSError:
            continue
        for line in lines:
            ts, _, _detail = line.partition("\t")
            try:
                if now - float(ts) < window_sec:
                    seen += 1
            except ValueError:
                continue
        if seen:
            break
    return seen


def strip_heredoc_bodies(cmd: str) -> str:
    """`cmd` with heredoc BODIES removed, delimiters kept.

    A heredoc body is data being fed to a program's stdin (a Python script, a
    commit message, a JSON blob). Scanning it line-by-line as if each line were
    a shell command produces false positives. Returns `cmd` unchanged when the
    heredoc could be executed (`bash <<EOF`, or any shell-exec in the command).
    """
    if not cmd or "<<" not in cmd:
        return cmd
    if hands_text_to_shell(cmd):
        return cmd

    out: list[str] = []
    lines = cmd.split("\n")
    i = 0
    while i < len(lines):
        line = lines[i]
        out.append(line)
        # <<EOF | <<-EOF | <<'EOF' | <<"EOF"
        m = re.search(r"<<-?\s*(['\"]?)([A-Za-z_][A-Za-z0-9_]*)\1", line)
        i += 1
        if not m:
            continue
        delim = m.group(2)
        # Drop everything up to (and including) the terminator.
        while i < len(lines) and lines[i].strip() != delim:
            i += 1
        if i < len(lines):
            out.append(lines[i])  # keep the terminator so structure survives
            i += 1
    return "\n".join(out)


def scannable_command(cmd: str) -> str:
    """`cmd` reduced to the parts that are actually COMMANDS.

    Removes data payloads — heredoc bodies, and quoted multi-word blobs — so a
    marker match means the command really does what the marker names. Use for
    marker/substring gates.

    NOT for gates that must inspect quoted arguments (a write destination is
    routinely quoted: `cp x "/etc/passwd"`). Those want
    strip_heredoc_bodies() only.

    Nothing is stripped when the command hands text to a shell, or from a blob
    containing command substitution.
    """
    if not cmd:
        return cmd
    if hands_text_to_shell(cmd):
        return cmd

    cmd = strip_heredoc_bodies(cmd)

    def _blank(m: re.Match[str]) -> str:
        body = m.group(2)
        # Single-word quoted values are ordinary arguments ("--repo", a path,
        # a branch); keep them. Multi-word blobs are prose/data.
        if " " not in body and "\t" not in body:
            return m.group(0)
        if _SUBST_RE.search(body):
            return m.group(0)  # could execute — leave it visible
        return f"{m.group(1)}{m.group(1)}"  # empty quotes, structure preserved

    return re.sub(r"(['\"])(.*?)\1", _blank, cmd, flags=re.S)
