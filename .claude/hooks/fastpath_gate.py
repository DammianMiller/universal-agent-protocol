#!/usr/bin/env python3
"""Edit fast-path decider with CUMULATIVE accounting.

The policy gate lets test-file edits and TRIVIAL source edits (<= TRIVIAL chars
changed) through directly, so iteration on a slow local executor stays fast
instead of paying a full deliver cycle per keystroke. But an unbounded per-edit
threshold is an escape hatch: a weak model can assemble a whole (broken) feature
out of dozens of sub-threshold edits, none of which ever routes to deliver or
gets validated ("death by a thousand small edits").

This decider keeps the fast-path for genuinely small changes but BOUNDS how much
un-routed change can accumulate per file. It tallies trivial-edit chars/count per
file in .uap/fastpath-accum.json; once a file crosses CUM_CHARS total chars OR
CUM_EDITS edits since it last routed, the NEXT edit is NOT fast-pathed — it falls
through to the deliver-routing gate (which writes + validates), and the file's
tally resets. So un-validated drift per file is bounded to ~CUM_CHARS.

stdin: the tool_input JSON. exit 0 = fast-path (allow directly); exit 1 = route
through deliver. On any parse/IO trouble it fails toward ROUTING (safe).

Budgets come from `.uap.json` (`delivery.trivialEditChars`,
`delivery.cumulativeChars`, `delivery.cumulativeEdits`) so sizing them is a
committed, reviewable project decision rather than something only the launching
operator can set. The environment still wins where it is set: TRIVIAL,
CUM_CHARS, CUM_EDITS (defaults 240 / 800 / 6). UAP_MAIN_ROOT names the project
root holding .uap/ (default cwd). Test files always fast-path and never
accumulate.
"""
import json
import os
import sys
from pathlib import Path


def _configured(key: str, env_name: str, default: int) -> int:
    """A budget, from the environment or the project's committed config.

    These budgets decide how much un-routed change a file may accumulate, which
    is a PROJECT decision — how big the work is, how much the local executor
    costs per cycle. Env-only meant only whoever launched the agent could size
    them, and the choice left no trace in the repo. `.uap.json` makes it a
    committed, reviewable setting.

    Environment still wins, so an operator can override a project's value for
    one session without editing the repo.
    """
    raw = os.environ.get(env_name)
    if raw is not None:
        try:
            return max(0, int(raw))
        except ValueError:
            pass  # a malformed override falls through to the config/default
    root = os.environ.get("UAP_MAIN_ROOT") or "."
    try:
        cfg = json.loads((Path(root) / ".uap.json").read_text())
        value = (cfg.get("delivery") or {}).get(key)
        if isinstance(value, bool):
            return default          # a bool is not a budget
        if isinstance(value, (int, float)):
            return max(0, int(value))
    except Exception:
        pass  # unreadable/absent config is not an error — fall back to default
    return default


TEST_MARKERS = (
    ".test.", ".spec.", "_test.", "test_", "/test/", "/tests/",
    "/__tests__/", "/spec/", "/specs/",
)


def _is_test(target: str) -> bool:
    base = target.rsplit("/", 1)[-1]
    stem = base.rsplit(".", 1)[0]
    return (
        any(m in "/" + target for m in TEST_MARKERS)
        or stem in ("test", "tests", "spec", "specs", "conftest")
        or stem.startswith("test")
        or stem.endswith("test")
        or stem.endswith("spec")
    )


def _changed_chars(a: dict):
    """Total chars touched by this edit, or None when the shape carries no diff
    (e.g. a whole-file Write) — None => never trivial => route."""
    edits = a.get("edits")
    if isinstance(edits, list):
        return sum(
            len(str(e.get("old_string") or e.get("oldString") or ""))
            + len(str(e.get("new_string") or e.get("newString") or ""))
            for e in edits
            if isinstance(e, dict)
        )
    o = a.get("old_string") or a.get("oldString")
    n = a.get("new_string") or a.get("newString")
    if o is None and n is None:
        return None
    return len(str(o or "")) + len(str(n or ""))


def main() -> int:
    try:
        a = json.loads(sys.stdin.read() or "{}")
    except Exception:
        return 1  # unparseable → route (safe)

    target = (
        a.get("file_path") or a.get("filePath") or a.get("path")
        or a.get("target") or a.get("filename") or a.get("file") or ""
    ).lower()
    if not target:
        return 1

    if _is_test(target):
        return 0  # test files always fast-path, no accounting

    c = _changed_chars(a)
    trivial_threshold = _configured("trivialEditChars", "TRIVIAL", 240)
    if c is None or c > trivial_threshold:
        return 1  # non-trivial (or no diff info) → route

    # Trivial source edit: allow only while cumulative drift stays under budget.
    cum_chars = _configured("cumulativeChars", "CUM_CHARS", 800)
    cum_edits = _configured("cumulativeEdits", "CUM_EDITS", 6)
    root = os.environ.get("UAP_MAIN_ROOT") or "."
    accum_file = Path(root) / ".uap" / "fastpath-accum.json"
    try:
        accum = json.loads(accum_file.read_text())
        if not isinstance(accum, dict):
            accum = {}
    except Exception:
        accum = {}

    rec = accum.get(target) or {}
    new_chars = int(rec.get("chars", 0)) + c
    new_edits = int(rec.get("edits", 0)) + 1

    if new_chars > cum_chars or new_edits > cum_edits:
        # Budget crossed: this edit routes through deliver (which validates the
        # accumulated change), and the file's tally resets for the next batch.
        accum[target] = {"chars": 0, "edits": 0}
        decision = 1
    else:
        accum[target] = {"chars": new_chars, "edits": new_edits}
        decision = 0

    try:
        accum_file.parent.mkdir(parents=True, exist_ok=True)
        accum_file.write_text(json.dumps(accum))
    except Exception:
        pass  # best-effort; a write failure must not change the verdict

    return decision


if __name__ == "__main__":
    sys.exit(main())
