#!/usr/bin/env python3
"""deliver-autoroute: R1 follow-up — consume a delivery-enforcement block's
`route:deliver` signal at the harness boundary.

The policy-gate hook pipes a blocked enforcer's JSON output to this helper. When
the block carries route == "deliver", the helper:
  1. Logs the blocked intent to the project's .uap pending-deliver log (so the
     intent is never lost).
  2. If the intent is REPLAYABLE (plan D1 recorded the blocked edit's exact
     content) and UAP_DELIVER_PENDING_REPLAY is on (default), spawns
     `uap deliver --pending <file>` detached — a DETERMINISTIC replay that
     writes the content to disk (no model) and runs the gates once. This is what
     actually lands the blocked write; without it the recorded intent is never
     applied and the model re-emits it forever (0 files change).
  3. Else, if UAP_DELIVER_AUTOROUTE is on, spawns `uap deliver "<hint>"` detached
     in the background (deduped per file so a retrying model does not fan out
     dozens of runs), and annotates the message.
  4. Prints the (possibly annotated) block message on stdout for the hook to
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
    # Default OFF (P0, 2026-07-13): the auto-spawned deliver run carries only a
    # vacuous "implement the intended change to <file>" hint — the blocked
    # edit's actual content is not plumbed through yet (plan D1) — so a blind
    # background model run is spawned per blocked file. Blind fan-out mangles
    # shared worktrees; the recorded intent + block message let the agent run
    # `uap deliver` itself with the real spec. Opt IN with
    # UAP_DELIVER_AUTOROUTE=1/on/true/yes.
    v = os.environ.get("UAP_DELIVER_AUTOROUTE", "off").lower()
    return v in {"1", "on", "true", "yes"}


def decide(out: dict, tool: str, args: dict, autoroute_on: bool, seen_files: set,
           replay_on: bool = True) -> dict:
    """Pure decision: what message to show, whether to spawn, and the intent."""
    reason = out.get("reason", "")
    route = out.get("route")
    hint = out.get("deliverHint") or ""
    # Older enforcers emitted a full command line ('uap deliver "..."'); the
    # hint is the INSTRUCTION — unwrap so the mission text isn't a command.
    m = re.fullmatch(r'uap deliver "(.+)"', hint.strip())
    if m:
        hint = m.group(1)
    # Accept the file-path key under ANY agent spelling. The enforcer was fixed
    # for this long ago; autoroute was not — so for opencode (which sends
    # `filePath`) file_path was always "", `spawn` was always False, and autoroute
    # was INERT: the gate blocked the edit, logged the intent, told the model to
    # call deliver… and deliver never ran. Observed live: 3 routed intents, 0
    # deliver runs, 0 files changed — work blocked but never delivered.
    file_path = (
        args.get("file_path") or args.get("filePath") or args.get("path")
        or args.get("target") or args.get("filename") or args.get("file") or ""
    )

    if route != "deliver":
        return {"message": reason, "route": route, "spawn": False, "replay": False,
                "file_path": file_path, "hint": hint, "dedup_key": "", "intent": None}

    intent = {"ts": int(time.time()), "tool": tool, "file_path": file_path, "hint": hint}
    # Dedup on the file when we have one, else on the hint itself. Requiring a
    # file_path made an entire class unspawnable: a BASH-routed source-write
    # (`cat > app.js <<EOF`) carries a `command`, not a path — so those intents
    # were blocked and then silently dropped. The hint is what deliver actually
    # runs, so it is the correct spawn key.
    dedup_key = file_path or hint
    # P1 (plan D1): persist the blocked edit's actual old/new content (from the
    # enforcer's editIntent, falling back to the raw tool args) so the intent
    # is REPLAYABLE via `uap deliver --pending <file>` instead of a blind hint.
    edit_intent = out.get("editIntent") or {
        k: v
        for k, v in (
            ("old_string", args.get("old_string")),
            ("new_string", args.get("new_string")),
            ("content", args.get("content")),
        )
        if isinstance(v, str)
    }
    if edit_intent:
        intent["edit"] = edit_intent
    # A REPLAYABLE intent (plan D1) carries the blocked edit's exact content, so
    # it can be applied to disk DETERMINISTICALLY via `uap deliver --pending`
    # (writeFileSync of the captured content — no model, no blind fan-out). This
    # is what actually LANDS the blocked write. Without it the intent is recorded
    # but never applied: the model re-emits the same write forever, the gate
    # re-blocks it every time, and 0 files change (observed 2026-07-16,
    # octopus_invaders_v3 — every deliver run frozen at phase 0 with an empty
    # project). Prefer replay over the model-spawn autoroute whenever available.
    replayable = bool(
        file_path
        and edit_intent
        and (isinstance(edit_intent.get("content"), str)
             or isinstance(edit_intent.get("old_string"), str))
    )
    # Deduped like a spawn (per change), so a retrying model does not re-run
    # `uap deliver --pending` for an identical edit — the lock only guards
    # CONCURRENT runs, the seen-set guards repeats. `replay_on` lets an operator
    # fall back to the model-spawn autoroute (UAP_DELIVER_PENDING_REPLAY=off).
    unseen = bool(dedup_key and dedup_key not in seen_files)
    replay = bool(replayable and replay_on and unseen)
    spawn = bool(autoroute_on and not replay and hint and unseen)
    message = reason
    if replay:
        message = reason + " [intent recorded to .uap/pending-deliver.jsonl — auto-applying to disk via deterministic `uap deliver --pending` replay]"
    elif spawn:
        message = reason + " [auto-routed to `uap deliver` — running in the background]"
    elif dedup_key and dedup_key in seen_files and (replayable or autoroute_on):
        message = reason + " [already auto-routed/applied for this change — see .uap/autoroute.log / pending-deliver.jsonl]"
    elif file_path:
        message = reason + (
            " [intent recorded to .uap/pending-deliver.jsonl — apply it yourself by running"
            " `uap deliver` with the exact intended change as the instruction]"
        )
    return {"message": message, "route": route, "spawn": spawn, "replay": replay,
            "file_path": file_path, "hint": hint, "dedup_key": dedup_key, "intent": intent}


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
        # Budget: --max-turns 5 / --ceiling 10 was too tight for a routed deliver to
        # BUILD the change and then get it through the gate ladder — especially on a
        # slow local model, where a single build+verify cycle eats several turns.
        # (It was doubly starved while the agent could still spelunk .uap/ internals,
        # which burned half the budget; that hole is closed separately.) Raised so a
        # routed change has room to converge. UAP_AUTOROUTE_MAX_TURNS /
        # UAP_AUTOROUTE_CEILING override.
        max_turns = os.environ.get("UAP_AUTOROUTE_MAX_TURNS", "12")
        ceiling = os.environ.get("UAP_AUTOROUTE_CEILING", "25")
        proc = subprocess.Popen(
            ["uap", "deliver", "--max-turns", max_turns, "--ceiling", ceiling, "--", hint],
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


def _replay_enabled() -> bool:
    # Deterministic pending-intent replay is safe — it writes the recorded
    # content to disk and runs the gate ladder once, with no model and no blind
    # background fan-out (the exact hazard that keeps model autoroute OFF by
    # default). ON by default; UAP_DELIVER_PENDING_REPLAY=0/off/false to disable.
    v = os.environ.get("UAP_DELIVER_PENDING_REPLAY", "on").lower()
    return v in {"1", "on", "true", "yes"}


def _spawn_pending_replay(root: Path, file_arg: str) -> None:
    """Spawn `uap deliver --pending <file>` detached: DETERMINISTICALLY replay
    the recorded edit intent(s) for this file to disk (writeFileSync of the
    captured content — no model), then run the required gates once. This is the
    plan-D1 path that actually lands the blocked write. Serialized behind the
    same one-in-flight lock as _spawn_deliver so concurrent blocked writes do
    not pile up runs; the model's retry of any still-unwritten file re-triggers
    a replay once the lock frees. Best-effort; never raises."""
    import subprocess
    if not file_arg or file_arg.startswith("-"):
        return  # need a path, and never let one be parsed as a flag
    if not _acquire_slot(root):
        return  # a replay/deliver is already converging in this repo
    try:
        log = (root / UAP_DIR / LOG_FILE).open("a")
    except Exception:
        log = subprocess.DEVNULL
    try:
        proc = subprocess.Popen(
            ["uap", "deliver", "--pending", file_arg],
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
    d = decide(out, ns.tool, args, _autoroute_enabled(), _load_seen(root), _replay_enabled())

    if d["intent"] is not None:
        try:
            uap_dir = root / UAP_DIR
            uap_dir.mkdir(parents=True, exist_ok=True)
            with (uap_dir / PENDING_LOG).open("a") as f:
                f.write(json.dumps(d["intent"]) + "\n")
        except Exception:
            pass

    if d["replay"] or d["spawn"]:
        try:
            # Dedup on the SAME key `decide` gated on (file when present, else the
            # hint) — writing file_path here would record "" for a bash-routed
            # intent and never dedup it. Both paths (deterministic replay and the
            # model-spawn autoroute) mark the change seen so a retry does not
            # double-run.
            key = d.get("dedup_key") or d["file_path"] or d["hint"]
            with _seen_path(root).open("a") as f:
                f.write(key.replace("\n", " ").replace("\r", " ") + "\n")
        except Exception:
            pass
        if d["replay"]:
            # Deterministic path: the blocked write's content is recorded, so
            # replay it to disk exactly (no model). This is what makes the block
            # productive instead of an infinite record-and-re-block loop.
            _spawn_pending_replay(root, d["file_path"])
        else:
            _spawn_deliver(root, d["hint"])

    prefix = ("[UAP policy blocked: " + ns.policy + "] ") if ns.policy else ""
    sys.stdout.write(prefix + d["message"])


if __name__ == "__main__":
    main()
