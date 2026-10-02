#!/usr/bin/env python3
"""plane-admin-protect enforcer: agents must not reset/override the Plane admin
account credentials unless the owner explicitly approved via a waiver file.

Observed (2026-09-24 and 2026-09-30): agents independently ran
`docker exec plane-app-api-1 python manage.py ... set_password admin@pay2u.com.au`
and overwrote the owner's password TWICE. The owner had to ask for a reset.
UAP memory stores a PROTECT note; this enforcer makes that note mechanical.

Scope (Bash/bash/run_bash/shell operations only):
  - Any shell command that targets the Plane stack (plane-app-api-1, plane-app,
    134.199.173.65, /opt/plane, plane-db) AND performs a credential mutation
    (reset_password / set_password / changepassword / createsuperuser / passwd)
    is refused.

Escape hatch (owner approval, mirrors the policies/waivers convention used by
the expert-review gate): write `policies/waivers/plane-admin-reset` containing
a line `expires: YYYY-MM-DD` (today or later), then retry. The waiver is a
file the OWNER writes; an agent writing it without an explicit owner request
in the current session violates the policy even though the gate would pass.

Known limits. This is a text gate over a language with unbounded ways to say
the same thing. It scans the command with `scannable_command()`, which strips
heredoc bodies and multi-word quoted blobs so a command that merely NAMES a
credential verb in prose (a commit message, a `uap memory store`, a script fed
over a heredoc) is not refused. The observed incident — `docker exec ...
changepassword ...` — is caught because `exec` hands text to a shell, so
`scannable_command` leaves that payload intact. A mutation quoted inside a
plain `ssh host "..."` with no shell-exec token, or routed through `eval`/
base64, evades every text rule by construction. Treat this as raising the cost,
not as a boundary.
"""
from __future__ import annotations

import re
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _common import emit, parse_cli, repo_root, scannable_command  # noqa: E402

WAIVER_PATH = "policies/waivers/plane-admin-reset"

SHELL_OPS = {"bash", "run_bash", "shell", "execute_command", "terminal"}

# Substring match, so `plane-app` already covers plane-app-api-1/-worker/-beat;
# the specific spellings are listed for documentation, not because they match
# anything the generic one would not.
TARGETS = (
    "plane-app",
    "134.199.173.65",
    "/opt/plane",
    "plane-db",
)

MUTATIONS = (
    "reset_password",
    "set_password",
    "changepassword",
    "createsuperuser",
    "passwd",
)


def _waiver_expiry(waiver: Path) -> tuple[bool, str]:
    """(valid, detail) for a waiver file that exists.

    A waiver is only honoured when it parses an `expires: YYYY-MM-DD` line that
    is today or later. An unreadable file is NOT treated as absent — the gate
    fails closed rather than crashing, so a permission problem cannot be used to
    slip past it (or to mask it as an internal error).
    """
    try:
        text = waiver.read_text()
    except OSError as e:
        return False, f"waiver file exists but could not be read ({e.strerror or e})"
    m = re.search(r"expires:\s*(\d{4}-\d{2}-\d{2})", text)
    if not m:
        return False, "waiver file is missing an 'expires: YYYY-MM-DD' line"
    try:
        expires = date.fromisoformat(m.group(1))
    except ValueError:
        return False, f"waiver 'expires: {m.group(1)}' is not a valid date"
    if expires >= date.today():
        return True, f"owner waiver valid until {m.group(1)}"
    return False, f"waiver expired on {m.group(1)}"


def main() -> None:
    operation, args = parse_cli()
    if operation.lower() not in SHELL_OPS:
        emit(True, "plane-admin-protect: not a shell operation")

    raw = str(args.get("command") or "")
    if not raw:
        emit(True, "plane-admin-protect: no command payload")
    cmd = scannable_command(raw).lower()

    if not any(t in cmd for t in TARGETS):
        emit(True, "plane-admin-protect: command does not target the Plane stack")

    verb = next((v for v in MUTATIONS if v in cmd), None)
    if verb is None:
        emit(True, "plane-admin-protect: no credential mutation verb")

    waiver = repo_root() / WAIVER_PATH
    if waiver.exists():
        valid, detail = _waiver_expiry(waiver)
        if valid:
            emit(True, f"plane-admin-protect: {detail}")
        emit(
            False,
            f"plane-admin-protect: {detail} — refresh it with the owner's approval.",
            route="owner-waiver",
            waiverHint=f"owner writes {WAIVER_PATH} with a line 'expires: YYYY-MM-DD'",
        )

    emit(
        False,
        "plane-admin-protect: refusing credential mutation on the Plane stack "
        f"(matched target + verb {verb!r}). The Plane admin account "
        "admin@pay2u.com.au (droplet 134.199.173.65, /opt/plane/plane-app) must "
        "NOT be reset/overridden unless the owner explicitly asks. Owner "
        "approval: write policies/waivers/plane-admin-reset with a line "
        "'expires: YYYY-MM-DD' and retry.",
        route="owner-waiver",
        waiverHint=f"owner writes {WAIVER_PATH} with a line 'expires: YYYY-MM-DD'",
    )


if __name__ == "__main__":
    main()