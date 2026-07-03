#!/usr/bin/env python3
"""deliver-autoroute: R1 follow-up — consume a delivery-enforcement block's
`route:deliver` signal at the harness boundary.

The policy-gate hook pipes a blocked enforcer's JSON output to this helper. When
the block carries route == "deliver", the helper:
  1. Logs the blocked intent to the project's .uap pending-deliver log (so the
     intent is never lost).
  2. If UAP_DELIVER_AUTOROUTE is on, spawns `uap deliver "<hint>"` detached in
     the background (deduped per file so a retrying model does not fan out
     dozens of runs), and annotates the message.
  3. Prints the (possibly annotated) block message on stdout for the hook to
     surface to the agent.

Autoroute is ON by default (UAP_DELIVER_AUTOROUTE=0 to disable): the blocked
intent is logged AND routed. The hook still blocks (exit 2); this only enriches
the block message and kicks off the sanctioned path in the background.
"""
import argparse
import json
import os
import re
import sys
import time
from pathlib import Path

PENDING_LOG = "pending-deliver.jsonl"
SEEN_FILE = "autoroute-seen"
UAP_DIR = ".uap"


def _autoroute_enabled() -> bool:
    # Default ON: a blocked source edit auto-routes into `uap deliver` in the
    # background instead of dead-ending the agent. Opt out with
    # UAP_DELIVER_AUTOROUTE=0/off/false/no.
    v = os.environ.get("UAP_DELIVER_AUTOROUTE", "on").lower()
    return v not in {"0", "off", "false", "no"}


def decide(out: dict, tool: str, args: dict, autoroute_on: bool, seen_files: set) -> dict:
    """Pure decision: what message to show, whether to spawn, and the intent."""
    reason = out.get("reason", "")
    route = out.get("route")
    hint = out.get("deliverHint") or ""
    # Older enforcers emitted a full command line ('uap deliver "..."'); the
    # hint is the INSTRUCTION — unwrap so the mission text isn't a command.
    m = re.fullmatch(r'uap deliver "(.+)"', hint.strip())
    if m:
        hint = m.group(1)
    file_path = args.get("file_path") or args.get("path") or args.get("target") or ""

    if route != "deliver":
        return {"message": reason, "route": route, "spawn": False,
                "file_path": file_path, "hint": hint, "intent": None}

    intent = {"ts": int(time.time()), "tool": tool, "file_path": file_path, "hint": hint}
    spawn = bool(autoroute_on and hint and file_path and file_path not in seen_files)
    message = reason
    if spawn:
        message = reason + " [auto-routed to `uap deliver` — running in the background]"
    elif autoroute_on and file_path in seen_files:
        message = reason + " [already auto-routed to `uap deliver` for this file — see .uap/autoroute.log / pending-deliver.jsonl]"
    return {"message": message, "route": route, "spawn": spawn,
            "file_path": file_path, "hint": hint, "intent": intent}


def _seen_path(root: Path) -> Path:
    return root / UAP_DIR / SEEN_FILE


def _load_seen(root: Path) -> set:
    try:
        return set(l.strip() for l in _seen_path(root).read_text().splitlines() if l.strip())
    except Exception:
        return set()


LOCK_FILE = "autoroute.lock"
LOG_FILE = "autoroute.log"


def _pid_alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
        return True
    except Exception:
        return False


def _acquire_slot(root: Path) -> bool:
    """One in-flight autoroute deliver per repo: a lockfile holding the child
    pid. Stale locks (dead pid) are reclaimed. Best-effort; failure = no slot."""
    lock = root / UAP_DIR / LOCK_FILE
    try:
        if lock.exists():
            pid = int(lock.read_text().strip() or "0")
            if pid and _pid_alive(pid):
                return False
        return True
    except Exception:
        return False


def _spawn_deliver(root: Path, hint: str) -> None:
    """Spawn `uap deliver -- "<hint>"` fully detached. Best-effort; never
    raises. The hint is passed after `--` (a pure operand — no flag smuggling),
    bounded turn budget, output logged to .uap/autoroute.log for visibility."""
    import subprocess
    if hint.startswith("-"):
        return  # never let a hint be parsed as a flag
    if not _acquire_slot(root):
        return  # another autoroute mission is already converging in this repo
    try:
        log = (root / UAP_DIR / LOG_FILE).open("a")
    except Exception:
        log = subprocess.DEVNULL
    try:
        proc = subprocess.Popen(
            ["uap", "deliver", "--max-turns", "5", "--ceiling", "10", "--", hint],
            cwd=str(root),
            stdout=log, stderr=log, stdin=subprocess.DEVNULL,
            start_new_session=True,
        )
        try:
            (root / UAP_DIR / LOCK_FILE).write_text(str(proc.pid))
        except Exception:
            pass
    except Exception:
        pass


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tool", default="")
    ap.add_argument("--args", default="{}")
    ap.add_argument("--root", default=".")
    ap.add_argument("--policy", default="")
    ns = ap.parse_args()

    try:
        out = json.loads(sys.stdin.read() or "{}")
    except Exception:
        out = {}
    try:
        args = json.loads(ns.args or "{}")
    except Exception:
        args = {}

    root = Path(ns.root)
    d = decide(out, ns.tool, args, _autoroute_enabled(), _load_seen(root))

    if d["intent"] is not None:
        try:
            uap_dir = root / UAP_DIR
            uap_dir.mkdir(parents=True, exist_ok=True)
            with (uap_dir / PENDING_LOG).open("a") as f:
                f.write(json.dumps(d["intent"]) + "\n")
        except Exception:
            pass

    if d["spawn"]:
        try:
            with _seen_path(root).open("a") as f:
                f.write(d["file_path"].replace("\n", " ").replace("\r", " ") + "\n")
        except Exception:
            pass
        _spawn_deliver(root, d["hint"])

    prefix = ("[UAP policy blocked: " + ns.policy + "] ") if ns.policy else ""
    sys.stdout.write(prefix + d["message"])


if __name__ == "__main__":
    main()
