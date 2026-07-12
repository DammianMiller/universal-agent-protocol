#!/usr/bin/env python3
"""delivery-enforcement enforcer: route substantive coding through `uap deliver`.

Fires on Edit/Write/MultiEdit to source-code files. The intent is that
non-trivial coding work goes through the `uap deliver` convergence loop (which
drives a model to verified completion against the real gates) rather than
ad-hoc hand edits.

DEFAULT mode is BLOCK: substantive source edits must route through `uap deliver`
(set UAP_ENFORCE_DELIVERY=advisory to relax to a logged nudge). Escape hatches
(UAP_DELIVER_ACTIVE / UAP_DELIVER_BYPASS) are always honored:

  UAP_ENFORCE_DELIVERY=block   # direct source edits outside a deliver context
                               # are blocked (exit 2)

Escape hatches (always honored, even in block mode):
  - UAP_DELIVER_ACTIVE=1   set by the deliver loop for its own subprocesses
  - UAP_DELIVER_BYPASS=1   explicit operator override for a sanctioned manual edit

Exempt by construction: non-source files, docs/configs/scripts/policies, test
files (deliver protects those itself), and tooling dot-dirs.
"""
from __future__ import annotations
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _common import emit, parse_cli, repo_root  # noqa: E402

EDIT_OPS = {"Edit", "Write", "MultiEdit", "edit", "write", "multiedit"}

# Only real implementation code is gated.
SOURCE_EXTS = (
    ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs",
    ".py", ".go", ".rs", ".java", ".rb", ".php", ".cs", ".swift", ".kt",
    ".c", ".cc", ".cpp", ".h", ".hpp",
)

# NOTE: `.worktrees/` is deliberately NOT exempt here. A real `uap deliver` run
# writes into a worktree but sets UAP_DELIVER_ACTIVE=1, which is honored below —
# so legitimate deliver edits still pass. An unconditional `.worktrees/` exemption
# let the model BYPASS deliver entirely by creating a worktree dir and writing
# source straight into it (observed: 24 source files written to
# .worktrees/001-space-shooter/ with no deliver run). Gating it behind the active
# flag closes that hole.
EXEMPT_PREFIXES = (
    ".claude/", ".cursor/", ".opencode/", ".codex/", ".forge/", ".omp/",
    ".uap/", ".policy-tools/",
    "src/policies/", "scripts/", "docs/", "policies/", "test/", "tests/",
)

# Test files are protected by deliver itself; never gate them here. Covers the
# path markers AND a file whose basename IS a test (e.g. a root-level `test.js`,
# `tests.py`, `spec.ts`, `test_foo.py`, `foo.test.tsx`) — those are the fast
# feedback loop and must not each trigger a full deliver cycle.
TEST_MARKERS = (".test.", ".spec.", "_test.", "test_", "/test/", "/tests/", "/__tests__/", "/spec/", "/specs/")
_TEST_BASENAMES = ("test", "tests", "spec", "specs", "conftest")


def _is_test_file(rel_posix: str) -> bool:
    low = rel_posix.lower()
    if any(m in "/" + low for m in TEST_MARKERS):
        return True
    stem = low.rsplit("/", 1)[-1].rsplit(".", 1)[0]
    return stem in _TEST_BASENAMES or stem.startswith("test") or stem.endswith("test") or stem.endswith("spec")


# Trivial-edit fast-path: a tiny change (a one-line tweak, a constant, a typo)
# does not warrant a full deliver decompose→epics→gates cycle — on a slow local
# executor that is ~10+ min per edit. Below this many changed characters the
# edit is allowed directly (advisory nudge only). UAP_DELIVER_FASTPATH=off
# disables; UAP_DELIVER_TRIVIAL_EDIT_CHARS tunes the threshold.
def _fastpath_on() -> bool:
    return os.environ.get("UAP_DELIVER_FASTPATH", "on").lower() not in {"0", "off", "false", "no"}


def _trivial_edit_chars() -> int:
    try:
        return max(0, int(os.environ.get("UAP_DELIVER_TRIVIAL_EDIT_CHARS", "240")))
    except ValueError:
        return 240


def _changed_chars(args: dict) -> int | None:
    """Total changed characters for an Edit/MultiEdit, or None when it can't be
    measured (e.g. a whole-file Write) — None means 'not trivially small'."""
    def pair(o: object, n: object) -> int:
        return len(str(o or "")) + len(str(n or ""))
    if "edits" in args and isinstance(args["edits"], list):
        return sum(
            pair(e.get("old_string") or e.get("oldString"), e.get("new_string") or e.get("newString"))
            for e in args["edits"] if isinstance(e, dict)
        )
    old = args.get("old_string") or args.get("oldString")
    new = args.get("new_string") or args.get("newString")
    if old is not None or new is not None:
        return pair(old, new)
    return None  # Write (full content) — not a trivial edit


def _deliver_lock_holder(root: Path) -> str | None:
    """PID string of a LIVE deliver run holding the project lock, else None."""
    lock = root / ".uap" / "deliver.lock"
    try:
        pid = int((lock.read_text().split("|")[0] or "").strip())
    except (OSError, ValueError):
        return None
    try:
        os.kill(pid, 0)
        return str(pid)
    except OSError:
        return None


def _is_local_model_session() -> bool:
    """True when this session targets a self-hosted/local model endpoint."""
    base = (
        os.environ.get("ANTHROPIC_BASE_URL")
        or os.environ.get("OPENAI_BASE_URL")
        or os.environ.get("UAP_INFERENCE_ENDPOINT")
        or ""
    ).lower()
    return any(h in base for h in ("127.0.0.1", "localhost", "0.0.0.0", "::1"))


# #2/#3a: how a LOCAL-model session is handled under block mode. A plain local
# session deadlocks under strict block (can read, never write -> recon loop,
# observed live). UAP_DELIVER_LOCAL_MODE selects the resolution:
#   advisory (default) -> allow direct writes (fast; the proxy guards the model)
#   deliver            -> keep the block + route:deliver so the change is driven
#                         through `uap deliver` (VERIFIED path; pairs with
#                         UAP_DELIVER_AUTOROUTE)
#   block              -> strict block (no relaxation)
# Back-compat: UAP_DELIVER_LOCAL_ADVISORY=0 maps to "block".
def _local_mode() -> str:
    m = os.environ.get("UAP_DELIVER_LOCAL_MODE", "").lower()
    if m in {"advisory", "deliver", "block"}:
        return m
    adv = os.environ.get("UAP_DELIVER_LOCAL_ADVISORY", "on").lower()
    return "advisory" if adv not in {"0", "off", "false", "no", ""} else "block"


def main() -> None:
    op, args = parse_cli()
    if op not in EDIT_OPS:
        emit(True, "not a file-edit operation")
        return

    # Accept the file-path key under any common agent spelling: file_path
    # (Claude), filePath (opencode), path/target/filename/file (misc tools).
    # Without filePath, opencode Write/Edit calls slipped through unrecognized.
    target = (
        args.get("file_path") or args.get("filePath") or args.get("path")
        or args.get("target") or args.get("filename") or args.get("file") or ""
    )
    if not target:
        emit(True, "no file path in args")
        return

    root = repo_root()
    try:
        rel = str(Path(target).resolve().relative_to(root))
    except ValueError:
        emit(True, "target outside repo")
        return

    rel_posix = rel.replace(os.sep, "/")
    low = rel_posix.lower()

    if not low.endswith(SOURCE_EXTS):
        emit(True, "not source code")
        return
    if any(rel_posix.startswith(p) for p in EXEMPT_PREFIXES):
        emit(True, f"exempt path: {rel_posix}")
        return
    if _is_test_file(rel_posix):
        emit(True, "test file (fast feedback loop; deliver protects it via gates)")
        return

    # Escape hatches.
    if os.environ.get("UAP_DELIVER_ACTIVE") == "1":
        emit(True, "inside a deliver-driven run")
        return
    if os.environ.get("UAP_DELIVER_BYPASS") == "1":
        emit(True, "UAP_DELIVER_BYPASS override set")
        return

    # A — trivial-edit fast-path: allow a tiny change directly (advisory) rather
    # than paying a full deliver cycle for a one-liner.
    if _fastpath_on():
        changed = _changed_chars(args)
        if changed is not None and changed <= _trivial_edit_chars():
            print(
                f"[delivery-enforcement] trivial edit to '{rel_posix}' "
                f"({changed} chars) — allowed directly; route substantive changes through deliver.",
                file=sys.stderr,
            )
            emit(True, f"trivial edit fast-path ({changed} <= {_trivial_edit_chars()} chars)")
            return

    # B — a deliver run is ALREADY working this project. Do NOT launch another
    # (the lock would reject it anyway) and do NOT let the model keep editing/
    # testing the same code underneath it — tell it to WAIT. route:wait so the
    # autoroute stands down instead of enqueuing a duplicate.
    holder = _deliver_lock_holder(root)
    if holder is not None and os.environ.get("UAP_ENFORCE_DELIVERY", "block").lower() == "block":
        emit(
            False,
            f"WAIT: a `uap deliver` run (pid {holder}) is ALREADY in progress for this project and is "
            f"changing the code — do NOT edit '{rel_posix}', and do NOT re-run tests on it yet. "
            "Let that run finish (check: uap deliver --resume latest / its output), THEN re-verify. "
            "Launching or editing now only conflicts with the in-flight run.",
            route="wait",
            deliverHint="",
        )
        return

    # #3-F: terse, imperative, model-parseable. Weak local models otherwise
    # retry the blocked edit or hallucinate completion ("the files exist") when
    # the message is a passive explanation. State the exact next action.
    msg = (
        f"BLOCKED: do not edit '{rel_posix}' directly. "
        "To create or change code, call the `deliver` tool "
        "(or run: uap deliver \"<one-line description of the change>\"). "
        "Deliver writes the files and verifies them against the gates. "
        "Do NOT retry this edit. Do NOT say the file is written until deliver "
        "reports success. "
        "(Sanctioned manual edit only: set UAP_DELIVER_BYPASS=1.)"
    )

    mode = os.environ.get("UAP_ENFORCE_DELIVERY", "block").lower()
    if mode == "block" and _is_local_model_session():
        # #3a: route-through-deliver keeps the block (route:deliver -> autoroute
        # drives the verified deliver loop); advisory unblocks direct writes.
        if _local_mode() == "advisory":
            mode = "advisory"
    if mode == "block":
        # R1: emit a machine-actionable routing signal so a capable harness can
        # auto-route the blocked change INTO `uap deliver` instead of leaving the
        # agent to flail. `route`/`deliverHint` are advisory extra fields; harness
        # adapters that understand them route, others just show `reason`.
        emit(
            False,
            msg,
            route="deliver",
            deliverHint=f'implement the intended change to {rel_posix}',
        )
        return

    # Advisory (opt-out): never blocks. Surface the nudge, then allow.
    print(f"[delivery-enforcement advisory] {msg}", file=sys.stderr)
    emit(True, "advisory: nudge logged (block is the default; UAP_ENFORCE_DELIVERY=advisory relaxes)")


if __name__ == "__main__":
    main()