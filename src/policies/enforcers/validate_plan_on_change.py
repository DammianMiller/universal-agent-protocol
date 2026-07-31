#!/usr/bin/env python3
"""validate-plan-on-change: the plan gate fires BEFORE a build, not on the write.

The old rule blocked a Write/Edit to a plan artifact unless `uap plan validate`
had run in the last 300 seconds. That asked the agent to validate a plan that did
not exist yet: the review found no artifact (or an older one), recorded itself as
"skipped", stamped anyway, and for the next five minutes any plan content went in
unread — while nothing gated the build at all. The plan that actually got
implemented was never reviewed.

So the gate moved to where it belongs:

  - creating or editing a plan is ALLOWED, and records the plan as pending
  - a BUILD / EXECUTE / DEPLOY command is BLOCKED while any plan is pending, or
    while a plan that WAS validated has since drifted on disk
  - the refusal carries the `validate the plan` self-prompt

State lives in `.uap/plan_state.json` (honouring UAP_STATE_DIR) and is shared
with `uap plan validate` in src/cli/plan.ts:

    pending   { "<repo-relative path>": <epoch seen> }
    validated { "<repo-relative path>": "<sha256 of the reviewed bytes>" }

Keying on CONTENT rather than a clock is the point: "these exact bytes were
reviewed" cannot be satisfied by validating an empty file and then writing the
real plan, which is precisely how the old window was defeated.

Escape hatch (justify in the plan/PR): UAP_PLAN_VALIDATE_OFF=1.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _common import emit, parse_cli, scannable_command  # noqa: E402

EDIT_OPS = {"Write", "Edit", "MultiEdit", "write", "edit", "multiedit"}
BASH_OPS = {"Bash", "bash", "run_bash", "shell"}

# A plan-like filename STEM (the part before `.md`): `plan`, `foo-plan`, `plan-v2`,
# `implementation_plan`, `foo.plan`. Deliberately does NOT match `planning`,
# `plans` (plural handled by the plans/ dir rule), or `explanation`.
PLAN_STEM_RE = re.compile(r"(^|[-_. ])plans?([-_. ]|$)", re.IGNORECASE)

# Commands that IMPLEMENT the plan. Matched anywhere in the command, not just at
# the start: `cd sub && npm run build` is a build, and a gate that only checks
# the prefix is avoidable by prepending anything at all.
#
# Word boundaries keep `make` from matching `cmake` or `makefile`. Everything
# NOT listed here is allowed — there is no second allowlist to keep in sync, and
# tests/linters/reads therefore stay free by construction. That matters: you
# cannot review a plan if you cannot inspect the tree or run its tests.
BUILD_RE = re.compile(
    r"\b("
    r"uap\s+deliver"
    r"|npm\s+run\s+build|npm\s+start"
    r"|(?:yarn|pnpm)\s+(?:run\s+)?build"
    r"|make"
    r"|cargo\s+(?:build|run)"
    r"|go\s+(?:build|run)"
    r"|mvn\s+(?:package|install)"
    r"|gradle\s+build"
    r"|docker\s+build"
    r"|docker[\s-]compose\s+up"
    r"|terraform\s+apply"
    r"|kubectl\s+apply"
    r"|helm\s+(?:install|upgrade)"
    r")\b",
    re.IGNORECASE,
)


def _state_path() -> Path:
    """`.uap/plan_state.json`, honouring UAP_STATE_DIR (absolute or relative)."""
    return Path(os.environ.get("UAP_STATE_DIR", ".uap")) / "plan_state.json"


def _load_state() -> dict:
    try:
        data = json.loads(_state_path().read_text())
        return data if isinstance(data, dict) else {}
    except Exception:  # noqa: BLE001 - unreadable state must not break the tool call
        return {}


def _save_state(state: dict) -> None:
    """Best-effort persist. A gate that crashes on an unwritable dir is worse
    than one that forgets — the write it was recording still happened."""
    try:
        path = _state_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(state, indent=2))
    except Exception:  # noqa: BLE001
        pass


def _target(args: dict) -> str:
    for k in ("file_path", "path", "notebook_path", "filePath", "target"):
        if args.get(k):
            return str(args[k])
    return ""


def _is_plan_file(target: str) -> bool:
    if not target:
        return False
    posix = target.replace(os.sep, "/")
    if re.search(r"(^|/)plans?/", posix, re.IGNORECASE):  # any file under plans/
        return True
    name = posix.rsplit("/", 1)[-1]
    if not name.lower().endswith(".md"):
        return False
    return bool(PLAN_STEM_RE.search(name[:-3]))


def _inside_project(target: str) -> bool:
    """True when `target` resolves to the project root or below it.

    `uap plan validate` refuses any file outside the project directory, so
    recording one creates a pending entry NOTHING can clear: every build in the
    repo blocks, and the remedy the refusal names declines the file. Observed
    live with a memory note under ~/.claude/, matched only because its filename
    contained "plan".

    Fails CLOSED on error (treat as inside, i.e. record it). Failing open here
    would let a transient getcwd() error silently un-gate a plan write.
    """
    try:
        root = os.path.realpath(os.getcwd())
        abs_target = os.path.realpath(os.path.join(root, target))
        return abs_target == root or abs_target.startswith(root + os.sep)
    except Exception:  # noqa: BLE001
        return True


def _prune_unvalidatable(pending: dict) -> tuple[dict, list]:
    """Split pending into (kept, dropped) — OUTSIDE-PROJECT entries only.

    Those can never be cleared: `uap plan validate` refuses them by design, so
    they block every build with a remedy that declines the file. This only
    matters for state recorded before the tracking fix above.

    A MISSING file is deliberately NOT pruned here. `mv PLAN.md PLAN2.md` is not
    an edit op, so no new entry is recorded; auto-forgiving the old key on the
    build path would make a rename a silent, unattended gate bypass with the
    plan content fully intact. A deleted plan is dropped only by an operator
    running `uap plan clear`, which records what it dropped and why.
    """
    kept: dict = {}
    dropped: list = []
    for key, seen in pending.items():
        if not _inside_project(key):
            dropped.append(key)
        else:
            kept[key] = seen
    return kept, dropped


def _key(target: str) -> str:
    """Repo-relative, forward-slashed — the shape `uap plan validate` records."""
    posix = target.replace(os.sep, "/")
    try:
        rel = os.path.relpath(posix, os.getcwd())
        if not rel.startswith(".."):
            posix = rel.replace(os.sep, "/")
    except Exception:  # noqa: BLE001
        pass
    return posix.lstrip("./") if posix.startswith("./") else posix


def _sha(path: str) -> str | None:
    try:
        return hashlib.sha256(Path(path).read_bytes()).hexdigest()
    except Exception:  # noqa: BLE001
        return None


def _refuse(paths: list[str], why: str) -> None:
    listed = ", ".join(sorted(paths))
    emit(
        False,
        f"validate-plan-on-change: {why} ({listed}). A plan must be validated "
        "before the work it describes is built.\n"
        "  1. Run the prompt `validate the plan` — review assumptions, gaps, "
        "risks, and whether it still matches the request.\n"
        f"  2. Record it: `uap plan validate {sorted(paths)[0]}`.\n"
        "  3. Retry this command.\n"
        "(If validation refuses the file — outside the project, or deleted — it can "
        "never clear: `uap plan status` names it and `uap plan clear` drops it.)\n"
        "(Escape hatch, justify in the plan/PR: UAP_PLAN_VALIDATE_OFF=1.)",
        inject_prompt="validate the plan",
    )


def main() -> None:
    op, args = parse_cli()
    if os.environ.get("UAP_PLAN_VALIDATE_OFF") == "1":
        emit(True, "UAP_PLAN_VALIDATE_OFF override set")

    # A plan write is never blocked — it is RECORDED. Blocking here is what made
    # the old gate ask for validation of a file that did not exist.
    if op in EDIT_OPS:
        target = _target(args)
        if not _is_plan_file(target):
            emit(True, "not a plan artifact")
        # Only track what `uap plan validate` can actually validate.
        if not _inside_project(target):
            emit(True, "plan artifact outside the project — not tracked")
        state = _load_state()
        pending = state.get("pending") or {}
        pending[_key(target)] = int(time.time())
        state["pending"] = pending
        _save_state(state)
        emit(True, f"plan write recorded — validation required before a build ({_key(target)})")

    if op not in BASH_OPS:
        emit(True, "not a gated operation")

    command = str(args.get("command") or args.get("cmd") or "")
    # scannable_command strips heredoc bodies and quoted payloads, so a build
    # phrase inside DATA (`echo 'npm run build'`) is not a build.
    if not BUILD_RE.search(scannable_command(command)):
        emit(True, "not a build/execute/deploy command")

    state = _load_state()
    # Drop legacy entries `uap plan validate` can never clear, recording what was
    # dropped so a shrinking blocking set is auditable.
    pending_map = state.get("pending") or {}
    kept, dropped = _prune_unvalidatable(pending_map)
    if dropped:
        state["pending"] = kept
        cleared = list(state.get("cleared") or [])
        cleared.extend(
            {"key": k, "reason": "outside the project directory", "at": int(time.time())}
            for k in dropped
        )
        state["cleared"] = cleared[-50:]
        _save_state(state)
    pending = list(kept.keys())
    if pending:
        _refuse(pending, "these plans were created or modified and never validated")

    drifted = [
        key for key, recorded in (state.get("validated") or {}).items()
        if (_sha(key) is not None and _sha(key) != recorded)
    ]
    if drifted:
        _refuse(drifted, "these plans changed after they were validated")

    emit(True, "no plan is awaiting validation")


if __name__ == "__main__":
    main()
