"""commitment-reserve enforcer: an all-in move with no way back is blocked
until a reserve exists ("never go full" -- commit hard, but hold something back).

The failure class this closes (all observed live on this project):
  - a local model "fixed" gates by DELETING real implementation files into
    stubs (guts-source incident) -- a wholesale overwrite with no backup;
  - destructive git resets / cleans that vaporized uncommitted work the
    session then could not reconstruct;
  - bare force-pushes that rewrote remote history with no local reserve.

The rule is NOT "never do destructive things" -- it is "destructive moves are
allowed only once something is held in reserve". Every block message names the
reserve that unlocks it.

Matching is SEGMENT-ANCHORED: the command is split on ;/&/| into segments,
quoted spans are stripped, and a rule fires only when the segment's leading
verb is git/rm. A `grep "git reset --hard"`, an `echo`, or a commit message
that merely MENTIONS a destructive pattern never trips the gate.

Shell (Bash/run_bash) all-in moves, blocked without a reserve:
  - `git reset --hard`              reserve: `git stash` first (inline counts)
  - forced push (`--force`, `-f`, `+refspec`)  `--force-with-lease` is allowed
    by THIS gate; note the project git-safety hook may still block it -- the
    sanctioned fallback there is a merge commit, not a bigger hammer.
  - `git clean -f...` / `--force`   reserve: `git stash -u` first
  - `git checkout/restore` wholesale discards (final arg `.`/`*`, incl.
    `checkout HEAD -- .` and `restore --worktree .`)
  - recursive+forced delete of a protected source root (src, test, tests,
    lib, tools, scripts, or the policy-definition dir) -- scratch/derived
    dirs (node_modules, dist, /tmp) stay allowed.

Unlocks (verified, not honor-system where possible):
  - an inline reserve-CREATING stash anywhere in the command (`git stash`,
    `git stash push/-u/--include-untracked`). Reserve-destroying or inert
    stash subcommands (drop/clear/pop/list/show/apply/branch) do NOT unlock.
  - `UAP_RESERVE_OK=1` ONLY as a leading env assignment of the destructive
    segment itself (set it only AFTER creating a backup/stash). A mention
    elsewhere in the command (echo, comment, quoted string) does not count.

Write-tool stub overwrites (the guts-source incident), blocked:
  - overwriting an existing source file >= 4 KiB with content < 20% of its
    size. Reserve: a same-day backup under `.uap-backups/<today>/` that is a
    real regular file (not a symlink) of at least half the original's size --
    an empty or unrelated same-named file does not count. Incremental Edit
    operations are never touched by this gate.

Known accepted limits (heuristic gate, fail-open by design): absolute-path
rm targets, `find -delete`, and xargs pipelines are not modeled; the gate's
purpose is stopping reflexive all-in moves, not adversarial evasion.

Operator overrides: UAP_RESERVE_OK=1 or UAP_COMMITMENT_RESERVE_OFF=1 in the
environment. DELIVER_ACTIVE=1 sessions are exempt (the deliver harness keeps
its own snapshot/restore reserve).
"""
import os
import re
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _common import emit, parse_cli, repo_root, worktree_root  # noqa: E402

BASH_OPS = {"Bash", "bash", "run_bash", "shell", "execute_command"}
WRITE_OPS = {"Write", "write", "write_file", "create_file"}

RESERVE_TOKEN = "UAP_RESERVE_OK=1"

# stash CREATE forms hold a reserve; drop/clear/pop destroy or consume one and
# list/show/apply/branch create nothing -- none of those unlock.
_STASH_CREATE = re.compile(
    r"\bgit\s+stash\b(?!\s+(?:drop|clear|pop|list|show|apply|branch)\b)"
)

_QUOTED_SPAN = re.compile(r"'[^']*'|\"[^\"]*\"")
_SEGMENT_SPLIT = re.compile(r"[;|&\n]+")
_ENV_ASSIGN = re.compile(r"[A-Za-z_]\w*=\S*")
_WRAPPERS = {"sudo", "env", "command", "nohup"}
# git global flags that take a separate value token (skip flag + value when
# locating the subcommand: `git -C /x reset --hard`).
_GIT_VALUED_FLAGS = {"-C", "-c", "--git-dir", "--work-tree"}

# Losing these roots loses the work itself. Derived/scratch dirs
# (node_modules, dist, build, coverage, tmp) are reconstructible and
# deliberately NOT protected.
PROTECTED_ROOTS = {"src", "test", "tests", "lib", "policies", "tools", "scripts"}

# Deleting a SCRATCH dir nested under a protected root (rm -rf src/__pycache__)
# is targeted cleanup, not an all-in move -- the reconstructible-dir principle
# applies at any depth.
SCRATCH_NAMES = {
    "__pycache__", "node_modules", "dist", "build", "coverage", ".cache",
    "tmp", ".next", ".turbo", "generated", ".pytest_cache",
}

WHOLESALE_TARGETS = {".", "./", "*", "./*", "/", "..", "../", "~", "~/"}

MSG_PREFIX = "commitment-reserve: all-in move with no way back -- "
MSG_RESET = (
    "`git reset --hard` discards every uncommitted change. Hold a reserve "
    "first: `git stash` (an inline `git stash && ...` also counts), then retry."
)
MSG_PUSH = (
    "forced push rewrites remote history with nothing held back. Prefer "
    "`--force-with-lease`; if the git-safety hook blocks that too, use the "
    "merge-commit fallback instead of forcing."
)
MSG_CLEAN = (
    "`git clean --force` deletes untracked files wholesale. Hold a reserve "
    "first: `git stash -u`, then retry."
)
MSG_DISCARD = (
    "wholesale discard of the working tree. Restore specific files instead, "
    "or `git stash` first so the discarded state stays recoverable."
)


def _segments(cmd: str) -> list[list[str]]:
    """Split a command into per-segment token lists, with line continuations
    joined and quoted spans stripped (so mentions inside strings never match)."""
    flat = cmd.replace("\\\n", " ")
    flat = _QUOTED_SPAN.sub(" ", flat)
    return [seg.split() for seg in _SEGMENT_SPLIT.split(flat) if seg.strip()]


def _strip_prefix(tokens: list[str]) -> tuple[list[str], bool]:
    """Drop leading env assignments / wrappers; report whether the reserve
    marker led the segment."""
    reserve = False
    i = 0
    while i < len(tokens):
        t = tokens[i]
        if _ENV_ASSIGN.fullmatch(t):
            if t == RESERVE_TOKEN:
                reserve = True
            i += 1
            continue
        if t in _WRAPPERS:
            i += 1
            continue
        break
    return tokens[i:], reserve


def _git_subcommand(rest: list[str]) -> tuple[str, list[str]]:
    """Locate the git subcommand, skipping global flags (incl. valued ones)."""
    i = 0
    while i < len(rest):
        t = rest[i]
        if t in _GIT_VALUED_FLAGS:
            i += 2
            continue
        if t.startswith("-"):
            i += 1
            continue
        return t, rest[i + 1 :]
    return "", []


def _rf_flag(tokens: list[str]) -> bool:
    flags = "".join(t.lstrip("-") for t in tokens if t.startswith("-") and not t.startswith("--"))
    long_flags = {t for t in tokens if t.startswith("--")}
    recursive = bool(re.search(r"[rR]", flags)) or "--recursive" in long_flags
    forced = "f" in flags or "--force" in long_flags
    return recursive and forced


def _check_git_segment(sub: str, rest: list[str]) -> str | None:
    if sub == "reset" and "--hard" in rest:
        return MSG_RESET
    if sub == "push":
        for t in rest:
            if t in {"--force", "-f"}:
                return MSG_PUSH
            if t.startswith("+") and len(t) > 1:
                return MSG_PUSH
    if sub == "clean":
        dry = any(
            t == "--dry-run" or (re.fullmatch(r"-[A-Za-z]+", t) and "n" in t)
            for t in rest
        )
        forced = any(t == "--force" or re.fullmatch(r"-[A-Za-z]*f[A-Za-z]*", t) for t in rest)
        if forced and not dry:
            return MSG_CLEAN
    if sub in {"checkout", "restore"}:
        if any(t in {"-f", "--force"} for t in rest):
            return MSG_DISCARD
        positional = [t for t in rest if t == "--" or not t.startswith("-")]
        if any(t in WHOLESALE_TARGETS for t in positional):
            return MSG_DISCARD
    return None


def _check_rm_segment(rest: list[str]) -> str | None:
    if not _rf_flag(rest):
        return None
    for t in rest:
        if t.startswith("-"):
            continue
        if t in WHOLESALE_TARGETS or t.startswith(("..", "~")):
            return t
        norm = t[2:] if t.startswith("./") else t
        if norm.rstrip("/").rsplit("/", 1)[-1] in SCRATCH_NAMES:
            continue
        root = norm.split("/", 1)[0]
        if root in PROTECTED_ROOTS:
            return t
    return None


# Stub-overwrite thresholds: an existing source file this big replaced by
# content this much smaller is a guts-source overwrite, not an edit.
MIN_OLD_BYTES = 4096
SHRINK_RATIO = 0.20
BACKUP_MIN_RATIO = 0.5  # a real reserve is a copy, not a same-named stub

CODE_EXT = {
    ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs",
    ".java", ".rb", ".c", ".h", ".cpp", ".hpp", ".cs", ".sh",
}


def _env_reserve() -> bool:
    return (
        os.environ.get("UAP_RESERVE_OK") == "1"
        or os.environ.get("UAP_COMMITMENT_RESERVE_OFF") == "1"
        or os.environ.get("DELIVER_ACTIVE") == "1"
    )


def _backup_exists_today(target: Path, old_size: int) -> bool:
    """A same-day backup under .uap-backups/<today>/ is the reserve that
    unlocks a stub overwrite (the mandatory-file-backup flow). It must be a
    real regular file of at least half the original's size -- an empty or
    symlinked same-named file is not a reserve."""
    today = date.today().isoformat()
    floor = max(1, int(old_size * BACKUP_MIN_RATIO))
    for root in {worktree_root(), repo_root()}:
        day_dir = root / ".uap-backups" / today
        if not day_dir.is_dir():
            continue
        candidates: list[Path] = []
        try:
            rel = target.relative_to(root)
            mirrored = day_dir / rel
            if mirrored.exists():
                candidates.append(mirrored)
        except ValueError:
            pass
        try:
            candidates.extend(day_dir.rglob(target.name))
        except (OSError, ValueError):
            pass
        for p in candidates:
            try:
                if p.name != target.name or p.is_symlink() or not p.is_file():
                    continue
                if p.stat().st_size >= floor:
                    return True
            except (OSError, ValueError):
                continue
    return False


def _check_bash(cmd: str) -> None:
    stash_reserve = bool(_STASH_CREATE.search(_QUOTED_SPAN.sub(" ", cmd)))
    for tokens in _segments(cmd):
        tokens, seg_reserve = _strip_prefix(tokens)
        if not tokens or seg_reserve or stash_reserve:
            continue
        verb = tokens[0].rsplit("/", 1)[-1]
        if verb == "git":
            sub, rest = _git_subcommand(tokens[1:])
            why = _check_git_segment(sub, rest)
            if why:
                emit(False, MSG_PREFIX + why)
        elif verb == "rm":
            target = _check_rm_segment(tokens[1:])
            if target:
                emit(
                    False,
                    "commitment-reserve: recursive forced delete of a source "
                    f"root ('{target}') removes the work itself, not scratch. "
                    "Delete specific files, or create a backup/stash first.",
                )
    emit(True, "no all-in pattern")


def _check_write(args: dict) -> None:
    raw_path = str(args.get("file_path") or args.get("path") or "")
    if not raw_path:
        emit(True, "no target path")
    try:
        target = Path(raw_path).resolve()
    except (OSError, ValueError, RuntimeError):
        emit(True, "unresolvable path")
    if target.suffix.lower() not in CODE_EXT:
        emit(True, "not a source file")
    try:
        old_size = target.stat().st_size
    except (OSError, ValueError):
        emit(True, "new file")
    if old_size < MIN_OLD_BYTES:
        emit(True, "existing file below stub-overwrite threshold")
    content = args.get("content")
    if content is None:
        content = args.get("contents", args.get("text"))
    if not isinstance(content, str):
        emit(True, "no inline content to compare")
    if len(content.encode("utf-8", "replace")) >= old_size * SHRINK_RATIO:
        emit(True, "overwrite keeps comparable substance")
    if _backup_exists_today(target, old_size):
        emit(True, "reserve exists (.uap-backups backup for today)")
    emit(
        False,
        "commitment-reserve: this overwrite replaces "
        f"{target.name} ({old_size} bytes) with under 20% of its content -- that "
        "is how real implementations get gutted into stubs. Edit incrementally, "
        f"or back the file up to .uap-backups/{date.today().isoformat()}/ first "
        "(that backup is the reserve that unlocks the overwrite).",
    )


def main() -> None:
    operation, args = parse_cli()
    if not isinstance(args, dict):
        emit(True, "non-dict args payload")
    if _env_reserve():
        emit(True, "reserve confirmed via environment")
    if operation in BASH_OPS:
        cmd = str(args.get("command") or "")
        if not cmd:
            emit(True, "no command payload")
        _check_bash(cmd)
    if operation in WRITE_OPS:
        _check_write(args)
    emit(True, "operation out of scope")


if __name__ == "__main__":
    main()
