#!/usr/bin/env python3
"""evidence-bound-ship enforcer: gate evidence must be bound to the shipped SHA.

Blocks ship actions (same detection as expert-review-required: git commit /
push / merge, gh pr create / merge / ready, pr-ready / signoff) unless
`.uap/evidence/<head-sha>.json` exists AND proves the mission's gates passed
for EXACTLY the commit being shipped:

  - missing artifact          -> BLOCK
  - malformed JSON            -> BLOCK
  - version != 1              -> BLOCK
  - candidateSha != HEAD      -> BLOCK (evidence for a different commit proves
                                nothing about this one — the forgery/staleness
                                case this gate exists to refuse)
  - recordedAt before the commit's own committer time, or older than the
    staleness window (default 24h) -> BLOCK
  - no gate with exitCode 0 + command + timestamp -> BLOCK (empty/forged)

The artifact is written by the deliver CLI (src/delivery/gate-evidence.ts) at
mission completion. `.uap/evidence/` is a self-protect PROTECTED_TARGET with no
agent carve-out, so the enforcer's trust root is "only the tooling could have
written this", same as the review artifacts' waiver dirs.

Fail-CLOSED on anything ambiguous — that is the difference between this gate
and expert-review: review evidence fail-opens on detached/unresolvable HEAD
because a review is a human act; gate evidence is machine-written at deliver
time, so a ship with unverifiable evidence is simply refused. The ONLY
fail-open is when git itself is absent or cwd is not a repo (non-UAP trees are
unaffected).

Local git + fs only: no network, no gh — the enforcer runs in the live policy
chain and must be fast. `gh pr merge <N>` binds to the LOCAL worktree HEAD (the
PR head is not resolvable without gh); ship from the branch you deliver on.

Escape hatch: UAP_EVIDENCE_GATE_OFF=1 in the LAUNCH environment (operator-only;
enforcement-self-protect refuses the inline form, same as UAP_NO_REVIEW).
Staleness window override: UAP_EVIDENCE_MAX_AGE_HOURS (default 24).
"""
from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _common import emit, parse_cli, worktree_root, run  # noqa: E402
# Ship-action detection is SHARED with expert-review-required: one definition,
# so a verb one gate sees can never slip past the other.
from expert_review_required import is_ship_action  # noqa: E402

EVIDENCE_DIR = ".uap/evidence"
DEFAULT_MAX_AGE_HOURS = 24
# A deliver-written artifact is a few KB of gate outcomes. Anything near half a
# megabyte is not evidence, it's a payload — cap the read BEFORE parsing so a
# hostile or corrupt file cannot make the gate parse unbounded input.
MAX_ARTIFACT_BYTES = 512 * 1024
# Clock-skew allowance for the future-dating check: recordedAt may lead the
# gate host's clock by a little on a machine with sloppy NTP; 5 minutes is
# generosity, not a loophole (staleness is measured in hours).
FUTURE_SKEW_SEC = 300


def _max_age_sec() -> int:
    """Staleness window in seconds; a malformed env override falls back to the
    default rather than disabling the check (0) or crashing the gate."""
    try:
        hours = float(os.environ.get("UAP_EVIDENCE_MAX_AGE_HOURS", "") or DEFAULT_MAX_AGE_HOURS)
        return max(0, int(hours * 3600))
    except ValueError:
        return DEFAULT_MAX_AGE_HOURS * 3600


def _parse_iso(value: object) -> float | None:
    """ISO-8601 -> epoch seconds, or None when unparseable. Tolerates a
    trailing 'Z' (the writer emits it; fromisoformat only learned 'Z' in 3.11).
    """
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        dt = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.timestamp()
    except ValueError:
        return None


def _head_sha(root: Path) -> str | None:
    rc, out, _ = run(["git", "rev-parse", "--verify", "HEAD^{commit}"], cwd=root)
    sha = out.strip()
    return sha if rc == 0 and sha else None


def _commit_time(root: Path, sha: str) -> float | None:
    rc, out, _ = run(["git", "show", "-s", "--format=%ct", sha], cwd=root)
    try:
        return float(out.strip()) if rc == 0 else None
    except ValueError:
        return None


def _block(reason: str, fix: str) -> None:
    emit(
        False,
        f"evidence-bound-ship: {reason} {fix} "
        "Operator override: UAP_EVIDENCE_GATE_OFF=1 in the launch environment.",
    )


def main() -> None:
    op, args = parse_cli()

    if os.environ.get("UAP_EVIDENCE_GATE_OFF") == "1":
        emit(True, "UAP_EVIDENCE_GATE_OFF override set")

    if op.lower() != "bash":
        emit(True, "not a ship operation")

    cmd = args.get("command") or args.get("cmd") or ""
    if not is_ship_action(cmd, worktree_root()):
        emit(True, "not a ship action")

    root = worktree_root()

    # Fail-open ONLY when git cannot answer at all (git missing, or cwd is not
    # a repository) — non-UAP trees must be unaffected. Everything else fails
    # closed below.
    rc, out, _ = run(["git", "rev-parse", "--is-inside-work-tree"], cwd=root)
    if rc != 0 or out.strip() != "true":
        emit(True, "not a git repo (or git unavailable) — fail-open")

    sha = _head_sha(root)
    if sha is None:
        _block(
            "HEAD is not resolvable to a commit (unborn branch or corrupt repo),"
            " so no candidate-bound evidence can exist.",
            "Fix: deliver the mission with `uap deliver` on a branch with a real HEAD.",
        )

    artifact = root / EVIDENCE_DIR / f"{sha}.json"
    if not artifact.exists():
        _block(
            f"no gate-evidence artifact at {EVIDENCE_DIR}/{sha[:12]}….json for the current HEAD.",
            "Fix: run `uap deliver` so the mission's gates are recorded against this commit,"
            " then ship.",
        )

    try:
        size = artifact.stat().st_size
    except OSError:
        size = None  # raced away between exists() and stat() — fail closed
    if size is None or size > MAX_ARTIFACT_BYTES:
        _block(
            f"the evidence artifact {EVIDENCE_DIR}/{sha[:12]}….json is oversized or unreadable"
            f" ({size if size is not None else 'stat failed'}; cap {MAX_ARTIFACT_BYTES} bytes)"
            " — a deliver-written artifact is a few KB.",
            "Fix: delete it and re-run `uap deliver` so a well-formed artifact is recorded.",
        )

    try:
        data = json.loads(artifact.read_text())
    except Exception:  # noqa: BLE001
        _block(
            f"the evidence artifact {EVIDENCE_DIR}/{sha[:12]}….json is malformed (not JSON).",
            "Fix: delete it and re-run `uap deliver` so a well-formed artifact is recorded.",
        )

    if not isinstance(data, dict) or data.get("version") != 1:
        _block(
            f"the evidence artifact for {sha[:12]}… has an unsupported schema version.",
            "Fix: re-run `uap deliver` with the current CLI to re-record it (version 1).",
        )

    recorded_sha = data.get("candidateSha")
    if recorded_sha != sha:
        _block(
            f"the evidence artifact covers {str(recorded_sha)[:12]}… but HEAD is {sha[:12]}…"
            " — evidence for a different commit proves nothing about this one.",
            "Fix: re-run `uap deliver` so the gates are recorded against the commit you are shipping.",
        )

    recorded_at = _parse_iso(data.get("recordedAt"))
    if recorded_at is None:
        _block(
            "the evidence artifact has no parseable recordedAt timestamp.",
            "Fix: re-run `uap deliver` to re-record it.",
        )

    # Backdating guard: evidence claiming to predate the commit it binds to is
    # forged — the commit did not exist to be gated yet. The commit time being
    # UNRESOLVABLE is anomalous (the sha resolved but git show failed): fail
    # closed rather than skip the one check that anchors recordedAt to reality.
    committed_at = _commit_time(root, sha)
    if committed_at is None:
        _block(
            f"the commit time of HEAD ({sha[:12]}…) could not be resolved — the sha"
            " resolved but `git show` failed, which is anomalous.",
            "Fix: investigate the repo (corrupt object?), then re-run `uap deliver`.",
        )
    if recorded_at < committed_at:
        _block(
            "the evidence predates the commit it claims to prove"
            f" (recordedAt {data.get('recordedAt')}, commit time {int(committed_at)}).",
            "Fix: re-run `uap deliver` after the candidate commit exists.",
        )

    now = datetime.now(timezone.utc).timestamp()
    if recorded_at > now + FUTURE_SKEW_SEC:
        _block(
            f"the evidence is FUTURE-dated (recordedAt {data.get('recordedAt')}"
            f" is more than {FUTURE_SKEW_SEC}s ahead of now) — forged or a"
            " badly skewed clock.",
            "Fix: fix the clock and re-run `uap deliver`.",
        )

    age = now - recorded_at
    window = _max_age_sec()
    if age > window:
        _block(
            f"the gate evidence is stale ({int(age // 3600)}h old; window"
            f" {window // 3600}h) — the tree may have drifted since the gates ran.",
            "Fix: re-run `uap deliver` to refresh the evidence for this HEAD.",
        )

    gates = data.get("gates")
    passing = [
        g
        for g in (gates if isinstance(gates, list) else [])
        if isinstance(g, dict)
        and g.get("exitCode") == 0
        and isinstance(g.get("command"), str)
        and g["command"].strip()
        and _parse_iso(g.get("at")) is not None
    ]
    if not passing:
        _block(
            "the evidence artifact records no passing gate with a command and"
            " timestamp — an empty or forged artifact is not evidence.",
            "Fix: re-run `uap deliver` so the real gate outcomes are recorded.",
        )

    emit(
        True,
        f"evidence-bound-ship satisfied ({EVIDENCE_DIR}/{sha[:12]}….json,"
        f" {len(passing)} passing gate(s), recorded {data.get('recordedAt')})",
    )


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:  # noqa: BLE001 — the live policy chain must never see a traceback
        _block(f"enforcer error ({type(e).__name__}: {e}); failing closed.", "Fix: report this.")
