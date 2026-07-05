#!/usr/bin/env python3
"""ship-loop-gate enforcer.

A task may not be marked `completed` until evidence exists for all four
ship-loop phases. Enforcement point: `TaskUpdate` operations that set
`status` to `completed` (and `TaskCreate` calls that try to land in
`completed` directly).

Required evidence keys (under `metadata.shipped`):
  - merged    : PR URL or merge commit SHA. The change is on `main`.
  - deployed  : deploy run URL / artifact ID. The change is in production.
  - monitored : log/metric query window + result. The change isn't
                producing new errors / regressions.
  - verified  : behavioural assertion against the deployed change
                (URL probed, golden-path replayed, etc.). The change
                produces the intended user-visible outcome.

Anything else (string content) is fine — the gate just checks each key
has a non-empty value, putting the burden on the engineer to write it
down. The values land in task metadata and become the audit trail.

Why this gate exists
--------------------
Multiple incidents in the last quarter where work was reported as
"done" once a PR merged, but the deploy regressed silently or the
behaviour was never verified. The mere act of having to write down
*proof of deploy + monitor + verify* eliminates the most common
class of "done" lies.

Bypass
------
Set the `metadata.shipped.bypass_reason` to a non-empty justification
when a task legitimately cannot be verified end-to-end (docs-only PR,
research spike, internal refactor with no deployable surface). The
bypass still persists into task metadata so the audit trail captures
*why* the gate was waived. Do not use bypass to dodge real verification
on changes with a deployable surface.
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from _common import emit, parse_cli  # noqa: E402

REQUIRED_EVIDENCE_KEYS = ("merged", "deployed", "monitored", "verified")


def _example_payload() -> str:
    return (
        "  metadata = {\n"
        '    "shipped": {\n'
        '      "merged":    "PR #1234 merged at SHA abc1234",\n'
        '      "deployed":  "cd-frontend-multicloud run 25281634698 success",\n'
        '      "monitored": "OO logs 14:00-14:15 UTC: 0 new errors on app.pay2u.com.au",\n'
        '      "verified":  "curl https://app.pay2u.com.au/feature returned 200 with expected payload"\n'
        "    }\n"
        "  }"
    )


def main() -> None:
    op, args = parse_cli()

    # Only fire on attempts to mark a task `completed`.
    if op not in {"TaskUpdate", "TaskCreate"}:
        emit(True, "ship-loop-gate: not a task-status operation")

    status = (args.get("status") or "").lower()
    if status != "completed":
        emit(True, "ship-loop-gate: not a completion update")

    metadata = args.get("metadata") or {}
    if not isinstance(metadata, dict):
        emit(False, "ship-loop-gate: metadata must be an object containing `shipped` evidence")

    shipped = metadata.get("shipped")
    if not isinstance(shipped, dict):
        emit(
            False,
            (
                "ship-loop-gate: cannot mark task completed — no `metadata.shipped` "
                "evidence block. Add proof of merge + deploy + monitor + verify before "
                "claiming Done. Example:\n"
                f"{_example_payload()}"
            ),
        )

    bypass = (shipped.get("bypass_reason") or "").strip()
    if bypass:
        emit(True, f"ship-loop-gate: bypassed with reason: {bypass}")

    missing = [k for k in REQUIRED_EVIDENCE_KEYS if not str(shipped.get(k) or "").strip()]
    if missing:
        emit(
            False,
            (
                "ship-loop-gate: cannot mark task completed — missing evidence for: "
                f"{', '.join(missing)}. Each key under metadata.shipped must be a "
                "non-empty string describing what happened in that phase. Use "
                "`metadata.shipped.bypass_reason` only when the task has no "
                "deployable surface (docs / research / pure refactor). Example:\n"
                f"{_example_payload()}"
            ),
        )

    emit(True, "ship-loop-gate: all four phases (merged, deployed, monitored, verified) attested")


if __name__ == "__main__":
    main()
