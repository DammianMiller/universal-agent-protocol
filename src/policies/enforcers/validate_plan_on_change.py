#!/usr/bin/env python3
"""validate-plan-on-change enforcer: ALWAYS validate a plan after creating or
modifying it.

A Write/Edit to a PLAN artifact (anything under a `plans/` directory, or a file
whose name is plan-like: `PLAN.md`, `*-plan.md`, `plan-*.md`, `implementation-plan.md`,
`*.plan.md`) is BLOCKED unless the agent has run the `validate the plan` prompt
recently and recorded it with `uap plan validate`. The block message is the
self-prompt: it tells the agent to validate the plan first, then retry.

"Recently" = within UAP_PLAN_VALIDATE_WINDOW seconds (default 300) of the last
`uap plan validate`, so a burst of edits in one planning session shares a single
validation, but a plan touched after a gap re-validates.

State: `.uap/plan_state.json` {"validated_at": <epoch>}. Escape hatch (justify in
the plan/PR): UAP_PLAN_VALIDATE_OFF=1.
"""
from __future__ import annotations

import json
import os
import re
import time
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).parent))
from _common import emit, parse_cli  # noqa: E402

EDIT_OPS = {"Write", "Edit", "MultiEdit", "write", "edit", "multiedit"}
STATE = Path(os.environ.get("UAP_STATE_DIR", ".uap")) / "plan_state.json"
DEFAULT_WINDOW = 300

# A plan-like filename STEM (the part before `.md`): `plan`, `foo-plan`, `plan-v2`,
# `implementation_plan`, `foo.plan`. Deliberately does NOT match `planning`, `plans`
# (plural handled by the plans/ dir rule), or `explanation`.
PLAN_STEM_RE = re.compile(r"(^|[-_. ])plans?([-_. ]|$)", re.IGNORECASE)


def _target(args: dict) -> str:
    for k in ("file_path", "path", "notebook_path", "filePath", "target"):
        if args.get(k):
            return str(args[k])
    return ""


def _is_plan_file(target: str) -> bool:
    if not target:
        return False
    posix = target.replace(os.sep, "/")
    # Any file inside a plans/ directory.
    if re.search(r"(^|/)plans?/", posix, re.IGNORECASE):
        return True
    name = posix.rsplit("/", 1)[-1]
    if not name.lower().endswith(".md"):
        return False
    stem = name[:-3]
    return bool(PLAN_STEM_RE.search(stem))


def _validated_at() -> float:
    try:
        return float(json.loads(STATE.read_text()).get("validated_at", 0))
    except Exception:  # noqa: BLE001
        return 0.0


def main() -> None:
    op, args = parse_cli()
    if os.environ.get("UAP_PLAN_VALIDATE_OFF") == "1":
        emit(True, "UAP_PLAN_VALIDATE_OFF override set")
    if op not in EDIT_OPS:
        emit(True, "not a file-write operation")

    target = _target(args)
    if not _is_plan_file(target):
        emit(True, "not a plan artifact")

    try:
        window = int(os.environ.get("UAP_PLAN_VALIDATE_WINDOW", DEFAULT_WINDOW))
    except ValueError:
        window = DEFAULT_WINDOW

    age = time.time() - _validated_at()
    if age <= window:
        emit(True, f"plan validated {int(age)}s ago (within {window}s)")

    emit(
        False,
        "validate-plan-on-change: you are creating or modifying a plan "
        f"('{target}') but have NOT validated it. ALWAYS validate a plan after "
        "creating or modifying it.\n"
        "  1. Run the prompt `validate the plan` — review assumptions, gaps, "
        "risks, and whether it still matches the request.\n"
        "  2. Record it: `uap plan validate`.\n"
        "  3. Retry this write.\n"
        "(One validation covers a burst of edits for "
        f"{window}s; override with UAP_PLAN_VALIDATE_OFF=1.)",
        inject_prompt="validate the plan",
    )


if __name__ == "__main__":
    main()
