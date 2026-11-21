#!/usr/bin/env python3
"""escalation-tracker: the evidence store behind the `escalate` delivery mode.

Under `delivery.enforcement: escalate` (or `delivery.localMode: escalate`) a
coding agent makes ordinary source edits DIRECTLY and `uap deliver` becomes an
ESCALATION POINT instead of the path every edit is forced through. The gate
(delivery_enforcement.py) decides *when* to escalate from the state kept here:

  .uap/escalation-state.json
    failures           consecutive verification failures since the last green
    last_failure       {ts, source, detail}  — what failed, shown to the agent
    last_green         ts of the last passing verification
    edits_since_green  {relpath: n}  — per-file churn with no green in between
    updated            ts of the last write

Writers (all best-effort, never block):
  escalation_tracker.py fail  --source verify|bash|stop --detail "<text>"
  escalation_tracker.py pass  --source verify|bash|stop
  escalation_tracker.py edit  --file <path>          (the gate records this itself)
  escalation_tracker.py reset                        (after a deliver run lands)
  escalation_tracker.py status [--json]
  escalation_tracker.py classify-bash --command "<cmd>" --output "<text>"
      -> prints pass|fail|none for a build/test command's output, and records it

The project root is UAP_MAIN_ROOT (the checkout holding .uap/), else cwd.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from pathlib import Path

STATE_FILE = "escalation-state.json"
DETAIL_MAX = 1200

# Behavioral verification gates (tests, runtime/e2e/uap verify) prove the code
# actually works at runtime. Compile-only gates (build, tsc, lint, clippy) only
# prove syntax/types — they must NEVER wipe per-file edit churn counters.
_BEHAVIORAL_GATE_RE = re.compile(
    r"(?:^|[;&|]\s*)(?:"
    r"cargo\s+test\b"
    r"|npm\s+(?:run\s+)?test(?::[\w-]+)?\b"
    r"|(?:pnpm|yarn|bun)\s+(?:run\s+)?test(?::[\w-]+)?\b"
    r"|(?:npx\s+)?(?:vitest|jest|mocha|playwright|cypress)\b"
    r"|(?:python3?\s+-m\s+)?(?:pytest|unittest)\b"
    r"|go\s+test\b"
    r"|make\s+test\b"
    r"|mvn\s+(?:test|verify)\b"
    r"|gradle(?:w)?\s+test\b"
    r"|dotnet\s+test\b"
    r"|uap\s+verify\b"
    r")",
    re.IGNORECASE,
)

_COMPILE_GATE_RE = re.compile(
    r"(?:^|[;&|]\s*)(?:"
    r"cargo\s+(?:build|check|clippy)\b"
    r"|npm\s+(?:run\s+)?(?:build|lint|typecheck|check)\b"
    r"|(?:pnpm|yarn|bun)\s+(?:run\s+)?(?:build|lint|typecheck|check)\b"
    r"|(?:npx\s+)?(?:tsc|eslint)\b"
    r"|go\s+(?:build|vet)\b"
    r"|make(?:\s+(?:build|check|all))?\s*(?:$|[;&|])"
    r"|mvn\s+(?:package|compile)\b"
    r"|gradle(?:w)?\s+(?:build|check)\b"
    r"|dotnet\s+build\b"
    r")",
    re.IGNORECASE,
)

# Back-compat combined pattern for any callers importing _BUILD_TEST_RE directly.
_BUILD_TEST_RE = re.compile(
    f"(?:{_BEHAVIORAL_GATE_RE.pattern})|(?:{_COMPILE_GATE_RE.pattern})",
    re.IGNORECASE,
)
_FAIL_MARKERS = (
    "error[e",                     # rustc
    "could not compile",
    "test result: failed",
    "failed to compile",
    "npm err!",
    "error ts",                    # tsc: error TS2345
    "assertionerror",
    "traceback (most recent call last)",
    "build failed",
    "fatal error",
    "compilation failed",
    "panicked at",
    "exit status 1",
    "exit code 1",
)
_PASS_MARKERS = (
    "test result: ok",
    "finished `dev`", "finished `release`", "finished dev", "finished release",
    "tests passed", "passed", "all tests passed",
    "compiled successfully", "build succeeded", "build successful",
    "0 errors", "no errors", "ok\n", " ok ",
    "runtime gate: pass", "all gates pass", "verify: pass",
)


def root_dir() -> Path:
    """The MAIN checkout's root — the same anchor the policy gate uses.

    The gate resolves MAIN_ROOT by stripping `/.worktrees/NNN-slug` and points
    the enforcer there, so evidence written from a session that runs INSIDE a
    worktree must land in the same place or the trigger never fires."""
    p = str(Path(os.environ.get("UAP_MAIN_ROOT") or ".").resolve())
    if "/.worktrees/" in p:
        p = p.split("/.worktrees/", 1)[0]
    return Path(p)


def state_path(root: Path | None = None) -> Path:
    return (root or root_dir()) / ".uap" / STATE_FILE


def load_state(root: Path | None = None) -> dict:
    try:
        data = json.loads(state_path(root).read_text(encoding="utf-8"))
        if isinstance(data, dict):
            data.setdefault("failures", 0)
            data.setdefault("edits_since_green", {})
            return data
    except Exception:
        pass
    return {"failures": 0, "edits_since_green": {}, "last_failure": None,
            "last_green": None, "updated": 0}


def save_state(state: dict, root: Path | None = None) -> None:
    p = state_path(root)
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        state["updated"] = int(time.time())
        tmp = p.with_suffix(".tmp")
        tmp.write_text(json.dumps(state, indent=1), encoding="utf-8")
        os.replace(tmp, p)
    except Exception:
        pass  # evidence is best-effort; never wedge the hook that records it


_SIG_LINE_RE = re.compile(
    r"(error\[E\d+\]|^error(?:\[|:)|panicked at|^\s*FAIL\b|test result: FAILED|AssertionError|Traceback|"
    r"\bfailed\b.*\bassert|^E\s{2,}|error TS\d+|\bERROR\b)",
    re.IGNORECASE | re.MULTILINE,
)


def failure_signature(detail: str) -> str:
    """A stable fingerprint of WHAT failed, so two red runs can be told apart.

    The first diagnostic line (rustc error code, panic site, failing test
    name, tsc code, traceback) with volatile bits — thread ids, pids,
    timestamps, hex addresses, durations — stripped. Falls back to the first
    non-empty line. Same signature twice = the same wall; a different one =
    the agent moved the problem, which is progress, not a streak."""
    text = detail or ""
    line = ""
    for raw in text.splitlines():
        if _SIG_LINE_RE.search(raw):
            line = raw
            break
    if not line:
        for raw in text.splitlines():
            if raw.strip():
                line = raw
                break
    line = re.sub(r"\(\d+\)", "", line)                      # thread/pid ids
    line = re.sub(r"0x[0-9a-fA-F]+", "0x", line)               # addresses
    line = re.sub(r"\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}\S*", "", line)
    line = re.sub(r"\b\d+(?:\.\d+)?\s*(?:ms|s|secs?|seconds?)\b", "", line)
    line = re.sub(r"\s+", " ", line).strip()
    return line[:200]


def record_fail(
    source: str,
    detail: str,
    root: Path | None = None,
    kind: str = "behavioral",
) -> dict:
    """Count a red verification toward the escalation threshold.

    CONSECUTIVE means "the same failure keeps coming back". A red run whose
    signature differs from the previous one is the agent making progress on a
    different problem (observed live: overflow at hash.rs:130 after fixing a
    pgrx-gated test, both counted, a one-line fix escalated to a 75-minute
    deliver loop that did not land). Such a failure restarts the streak at 1
    instead of extending it."""
    st = load_state(root)
    sig = failure_signature(detail)
    prev = st.get("last_failure") if isinstance(st.get("last_failure"), dict) else None
    prev_sig = (prev or {}).get("sig")
    edits_total = int(st.get("edits_total") or 0)
    _ep = (prev or {}).get("edits_total")
    edits_at_prev = int(_ep) if isinstance(_ep, (int, float)) else -1  # 0 is a real value
    if prev_sig and sig and sig != prev_sig:
        st["failures"] = 1
        st["streak_reset"] = {"ts": int(time.time()), "from": prev_sig[:120], "to": sig[:120]}
    elif prev_sig and sig == prev_sig and edits_total == edits_at_prev:
        # The SAME failure observed again with no edit in between (idle/stop
        # verify hooks re-run the gates every time the session pauses). That is
        # a re-observation, not another failed attempt — the streak must not
        # grow while the agent has not tried anything. Observed live: 4 "failures"
        # from one red user-path test across four idle pauses.
        st["reobserved"] = int(st.get("reobserved") or 0) + 1
    else:
        st["failures"] = int(st.get("failures") or 0) + 1
    st["last_failure"] = {
        "ts": int(time.time()),
        "source": source or "unknown",
        "kind": kind or "behavioral",
        "detail": (detail or "")[-DETAIL_MAX:],
        "sig": sig,
        "edits_total": edits_total,
    }
    save_state(st, root)
    return st


def record_pass(source: str, root: Path | None = None, kind: str = "behavioral") -> dict:
    """Record a green gate.

    `kind == "compile"` (build / tsc / lint / clippy) clears ONLY compile-class
    failures and NEVER clears `edits_since_green` or `recent_edit_files` —
    running `npm run build` between 20 edits to one file must never reset the
    thrash detector. `kind == "behavioral"` (tests / uap verify / stop) resets
    failures, per-file edit churn, and recent edit history.
    """
    st = load_state(root)
    now = int(time.time())
    if kind == "compile":
        st["last_compile_green"] = {"ts": now, "source": source or "unknown"}
        lf = st.get("last_failure") if isinstance(st.get("last_failure"), dict) else None
        lf_src = str((lf or {}).get("source") or "")
        lf_kind = str((lf or {}).get("kind") or "")
        if lf_src not in {"stop", "verify"} and lf_kind != "behavioral":
            st["failures"] = 0
            st["last_failure"] = None
        save_state(st, root)
        return st

    st["failures"] = 0
    st["edits_since_green"] = {}
    st["recent_edit_files"] = []
    st["last_green"] = {"ts": now, "source": source or "unknown"}
    st["last_failure"] = None
    save_state(st, root)
    return st


def record_edit(rel: str, root: Path | None = None) -> dict:
    st = load_state(root)
    edits = st.get("edits_since_green") or {}
    edits[rel] = int(edits.get(rel, 0)) + 1
    st["edits_since_green"] = edits
    recent = st.get("recent_edit_files") if isinstance(st.get("recent_edit_files"), list) else []
    recent.append(rel)
    st["recent_edit_files"] = recent[-12:]
    st["edits_total"] = int(st.get("edits_total") or 0) + 1  # monotonic: "an attempt happened"
    save_state(st, root)
    return st


def reset(root: Path | None = None) -> dict:
    st = {"failures": 0, "edits_since_green": {}, "recent_edit_files": [], "last_failure": None,
          "last_green": {"ts": int(time.time()), "source": "reset"}, "updated": 0}
    save_state(st, root)
    return st


def classify_gate_kind(command: str) -> str:
    """Return 'behavioral' | 'compile' | 'none' for a shell command.

    Checks behavioral patterns first so chained commands like
    `npm run build && npm test` count as behavioral verification.
    """
    if not command:
        return "none"
    if _BEHAVIORAL_GATE_RE.search(command):
        return "behavioral"
    if _COMPILE_GATE_RE.search(command):
        return "compile"
    return "none"


def is_gate_command(command: str) -> bool:
    return classify_gate_kind(command) != "none"


def classify_output(command: str, output: str, exit_code: int | None = None) -> str:
    """pass | fail | none for a shell command's outcome.

    The exit code is authoritative when the harness supplies one. Without it
    (opencode's after-hook exposes text only) fall back to markers, and to
    `none` when the text says nothing either way — silence is not evidence.
    """
    if not is_gate_command(command):
        return "none"
    if exit_code is not None:
        return "pass" if exit_code == 0 else "fail"
    low = (output or "").lower()
    if not low.strip():
        return "none"
    # A non-zero failure COUNT ("2 failed", "1 failures", "3 errors") or a
    # specific failure marker. A bare "failed" substring is deliberately NOT a
    # marker: `test_failed_login PASSED` and `--- PASS: TestFailedAuth` are green.
    if any(m in low for m in _FAIL_MARKERS) or re.search(r"\b[1-9]\d* (?:failed|failures?|errors?)\b", low):
        return "fail"
    if any(m in low for m in _PASS_MARKERS) or re.search(r"(?m)^ok\b|--- pass:|\b\d+ passed\b", low):
        return "pass"
    return "none"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="escalation_tracker.py")
    sub = ap.add_subparsers(dest="cmd", required=True)
    f = sub.add_parser("fail"); f.add_argument("--source", default="verify"); f.add_argument("--detail", default=""); f.add_argument("--kind", default="behavioral")
    p = sub.add_parser("pass"); p.add_argument("--source", default="verify"); p.add_argument("--detail", default=""); p.add_argument("--kind", default="behavioral")
    e = sub.add_parser("edit"); e.add_argument("--file", required=True)
    sub.add_parser("reset")
    s = sub.add_parser("status"); s.add_argument("--json", action="store_true")
    c = sub.add_parser("classify-bash")
    c.add_argument("--command", required=True); c.add_argument("--output", default="")
    c.add_argument("--exit-code", type=int, default=None); c.add_argument("--dry-run", action="store_true")
    raw = list(sys.argv[1:] if argv is None else argv)
    folded: list[str] = []
    k = 0
    while k < len(raw):
        tok = raw[k]
        if tok in ("--detail", "--output", "--command") and k + 1 < len(raw):
            folded.append(f"{tok}={raw[k + 1]}")
            k += 2
            continue
        folded.append(tok)
        k += 1
    a = ap.parse_args(folded)

    if a.cmd == "fail":
        detail = a.detail
        if detail == "-":
            detail = sys.stdin.read()
        st = record_fail(a.source, detail, kind=a.kind)
        print(f"escalation: {st['failures']} consecutive failure(s) recorded ({a.source})")
    elif a.cmd == "pass":
        record_pass(a.source, kind=a.kind)
        if a.kind == "compile":
            print(f"escalation: compile green ({a.source}) — edit churn retained until behavioral pass")
        else:
            print(f"escalation: green ({a.source}) — counters reset")
    elif a.cmd == "edit":
        record_edit(a.file)
    elif a.cmd == "reset":
        reset()
        print("escalation: state reset")
    elif a.cmd == "status":
        st = load_state()
        if a.json:
            print(json.dumps(st))
        else:
            lf = st.get("last_failure") or {}
            print(f"failures={st.get('failures', 0)} files_churning={len(st.get('edits_since_green') or {})}"
                  + (f" last_failure=({lf.get('source')}) {str(lf.get('detail',''))[:120]!r}" if lf else ""))
    elif a.cmd == "classify-bash":
        output = a.output
        if output == "-":
            output = sys.stdin.read()
        verdict = classify_output(a.command, output, a.exit_code)
        gate_kind = classify_gate_kind(a.command)
        if not a.dry_run:
            if verdict == "fail":
                record_fail("bash", f"$ {a.command[:200]}\n{output[-DETAIL_MAX:]}", kind=gate_kind)
            elif verdict == "pass":
                record_pass("bash", kind=gate_kind)
        print(verdict)
    return 0


if __name__ == "__main__":
    sys.exit(main())
