#!/usr/bin/env python3
"""validate-plan-before-build enforcer.

On the first mutating tool call after a plan is marked ready, block and require
the agent to run the `validate the plan` prompt. State tracked in .uap/plan_state.json.
"""
from __future__ import annotations
import json
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _common import emit, parse_cli  # noqa: E402

STATE = Path(os.environ.get("UAP_STATE_DIR", ".uap")) / "plan_state.json"
MUTATING_OPS = {"Edit", "Write", "MultiEdit", "edit", "write", "multiedit"}
BUILD_BASH_RE = (
    "git commit",
    "git push",
    "kubectl apply",
    "helm upgrade",
    "helm install",
    "terraform apply",
    "npm run build",
    "pnpm build",
)


def load_state() -> dict:
    if not STATE.exists():
        return {}
    try:
        return json.loads(STATE.read_text())
    except json.JSONDecodeError:
        return {}


def save_state(s: dict) -> None:
    STATE.parent.mkdir(parents=True, exist_ok=True)
    STATE.write_text(json.dumps(s))


def main() -> None:
    op, args = parse_cli()
    state = load_state()

    # Mutating?
    cmd = (args.get("command") or "").lower()
    mutating = op in MUTATING_OPS or any(p in cmd for p in BUILD_BASH_RE)
    if not mutating:
        emit(True, "not a build/mutation op")

    plan_ready = bool(state.get("plan_ready"))
    validated_at = float(state.get("validated_at", 0))
    ready_at = float(state.get("ready_at", 0))

    if not plan_ready:
        emit(True, "no active plan-ready marker")

    if validated_at and validated_at >= ready_at:
        emit(True, "plan validated since marking ready")

    emit(
        False,
        "validate-plan-before-build: plan is ready but not validated. "
        "Run the prompt `validate the plan` before making changes. "
        "After a pass, write {\"validated_at\": <epoch>} to .uap/plan_state.json.",
        inject_prompt="validate the plan",
    )


if __name__ == "__main__":
    main()
