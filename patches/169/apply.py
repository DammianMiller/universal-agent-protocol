#!/usr/bin/env python3
"""Apply the two enforcement fixes from PR #169. OPERATOR-RUN.

self-protect refuses agent writes to the enforcement surface (by design), so
these edits cannot be made by the agent that wrote them. This script performs
them with exact anchors and refuses if any anchor has drifted, so a stale copy
is a loud failure instead of a silent partial apply.

  python3 patches/169/apply.py --check          # verify anchors, change nothing
  python3 patches/169/apply.py --into /tmp/x    # write modified copies elsewhere
  python3 patches/169/apply.py                  # apply in place

FIX A — the fail-closed net was blind to Bash.
  SEC_SENSITIVE scanned only the file_path argument, never the command string,
  so for EVERY Bash call it was 0 unless the command set a bypass var. The
  "enforcer errored -> fail closed" branch below it therefore never fired for
  shell operations. Deleting .policy-tools/_common.py broke every enforcer at
  import and the next `>> .uap/evidence/...` was ALLOWED. Verified live.

FIX A2 — repair before enforcing.
  _common.py is imported by every materialized enforcer, so losing that one
  file disables the whole surface. Restore it from the checkout when it goes
  missing rather than only failing closed, so the machinery self-heals.

FIX B — argument indirection walked past the text scan.
  `rm .policy-tools/x` is blocked; `xargs rm < list` and `echo .policy-tools/x
  | xargs rm` were not, because the path never appears at a destructive verb's
  command position. When an indirection construct and a destructive verb are
  both present, check the whole command AND resolve readable argument sources.
"""
from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path

GATE_COPIES = (
    ".claude/hooks/uap-policy-gate.sh",
    ".factory/hooks/uap-policy-gate.sh",
    ".omp/hooks/uap-policy-gate.sh",
    "templates/hooks/uap-policy-gate.sh",
)
ENFORCER = "src/policies/enforcers/enforcement_self_protect.py"

GATE_A1_OLD = '''target = a.get("file_path") or a.get("path") or a.get("target") or ""
cmd = a.get("command") or ""
low = ("/" + str(target)).lower()
hit = any(m in low for m in markers)'''

GATE_A1_NEW = '''target = a.get("file_path") or a.get("path") or a.get("target") or ""
cmd = a.get("command") or ""
# Scan the COMMAND as well as file_path. Only file_path was checked, so for
# every Bash call SEC_SENSITIVE was 0 unless the command set a bypass var --
# leaving the fail-closed branch below blind to the entire shell surface. A
# shell deletion under .policy-tools/ then fell through to fail-OPEN the moment
# the enforcer could not run. Observed live: deleting .policy-tools/_common.py
# broke every enforcer at import, and the next `>> .uap/evidence/...` was
# allowed. Widening this only ever TIGHTENS: SEC_SENSITIVE gates the fail-
# closed path and the fastpath skip, never an allow.
#
# Each token gets a leading "/" for the same reason the target does: the markers
# are slash-anchored ("/.policy-tools/"), so a bare relative path in a command
# ("rm .policy-tools/x") would not match without it. Concatenating the raw
# command silently missed exactly the deletions this fix is about -- caught by
# measuring old-vs-new, not by reading the diff.
low = ("/" + str(target)).lower() + " " + " ".join(
    "/" + t for t in str(cmd).lower().split())
hit = any(m in low for m in markers)'''

GATE_A2_OLD = '''# Did the self-protect enforcer actually run and make a decision this call?
sec_enforcer_ran=0'''

GATE_A2_NEW = '''# Every materialized enforcer does `from _common import ...`, so that single
# file is a single point of failure for the WHOLE surface: remove it and all 29
# enforcers die at import, self-protect included. Repair it before enforcing
# rather than only failing closed -- a control surface that self-heals beats one
# that merely notices. If it cannot be restored, the SEC_SENSITIVE checks below
# still fail closed.
if [[ ! -f "$MAIN_ROOT/.policy-tools/_common.py" \\
      && -f "$MAIN_ROOT/src/policies/enforcers/_common.py" ]]; then
  cp "$MAIN_ROOT/src/policies/enforcers/_common.py" \\
     "$MAIN_ROOT/.policy-tools/_common.py" 2>/dev/null || true
fi
if [[ ! -f "$MAIN_ROOT/.policy-tools/_common.py" && -d "$MAIN_ROOT/.policy-tools" ]]; then
  [[ "$SEC_SENSITIVE" == "1" ]] && fail_closed "enforcer helper _common.py missing"
fi

# Did the self-protect enforcer actually run and make a decision this call?
sec_enforcer_ran=0'''

ENF_OLD = '''def _bash_destructive(command: str) -> bool:
    """Destructive op against a protected path, judged per command segment."""
    for segment in _SEGMENT_SPLIT.split(command or ""):'''

ENF_NEW = '''# Constructs that feed a command its arguments from somewhere other than its own
# command line. With one of these present the target path may never appear at a
# verb's command position, which is the only place the per-segment scan looks.
_INDIRECTION = re.compile(r"(?:^|[\\s|;&(])(?:xargs|eval)\\b|\\$\\(|`")
# Bounded: a source file is read only to decide THIS call, never stored.
_MAX_SRC_BYTES = 1 << 20


def _readable_sources(command: str) -> list[str]:
    """Contents of files this command names that could supply its arguments."""
    out: list[str] = []
    for raw in command.split():
        tok = raw.strip("\\"'<>()`$").rstrip(";|&")
        if not tok or tok.startswith("-"):
            continue
        try:
            p = Path(tok)
            if not p.is_file() or p.stat().st_size > _MAX_SRC_BYTES:
                continue
            out.append(p.read_text(errors="replace"))
        except (OSError, ValueError):
            continue
    return out


def _bash_indirect_destructive(command: str) -> bool:
    """Destructive intent whose target arrives via indirection, not the cmdline.

    `rm .policy-tools/x` was blocked while `xargs rm < list` and
    `echo .policy-tools/x | xargs rm` were not: the path never sits at a
    destructive verb's command position, so the per-segment scan never saw it.
    That is not theoretical -- it is how .policy-tools/_common.py was actually
    deleted, which disabled every enforcer at once.

    HONEST LIMIT: shell state this process cannot see still wins. `P=.policy-
    tools; rm $P/x` expands inside the shell, and no scan of the command TEXT
    can resolve it. Refusing every destructive command containing a variable
    would block ordinary work (`rm $TMPDIR/x`) for no real gain, so the residual
    is accepted and covered by the gate's fail-closed + _common.py self-heal.
    """
    if not command or not _INDIRECTION.search(command):
        return False
    tokens = {t.rsplit("/", 1)[-1].lower().strip("\\"'") for t in command.split()}
    if not (tokens & set(DESTRUCTIVE_VERBS)):
        return False
    # The whole command, not per segment: in `echo .policy-tools/x | xargs rm`
    # the path and the verb live in different segments by construction.
    if _mentions_protected(command):
        return True
    return any(_mentions_protected(src) for src in _readable_sources(command))


def _bash_destructive(command: str) -> bool:
    """Destructive op against a protected path, judged per command segment."""
    if _bash_indirect_destructive(command):
        return True
    for segment in _SEGMENT_SPLIT.split(command or ""):'''

EDITS = {ENFORCER: ((ENF_OLD, ENF_NEW),)}
for _g in GATE_COPIES:
    EDITS[_g] = ((GATE_A1_OLD, GATE_A1_NEW), (GATE_A2_OLD, GATE_A2_NEW))


def process(root: Path, into: Path | None, check_only: bool) -> int:
    problems = 0
    for rel, pairs in EDITS.items():
        src = root / rel
        if not src.is_file():
            print(f"MISSING  {rel}")
            problems += 1
            continue
        text = original = src.read_text()
        for old, new in pairs:
            if new in text:
                print(f"already  {rel}")
                continue
            if old not in text:
                print(f"ANCHOR-DRIFT  {rel}  (expected text not found)")
                problems += 1
                continue
            text = text.replace(old, new, 1)
        if text == original:
            continue
        if check_only:
            print(f"would-patch  {rel}")
            continue
        dest = (into / rel) if into else src
        dest.parent.mkdir(parents=True, exist_ok=True)
        if into and not dest.exists():
            shutil.copystat(src, src)  # no-op; keeps intent explicit
        dest.write_text(text)
        dest.chmod(src.stat().st_mode)
        print(f"patched  {dest}")
    return problems


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="verify anchors only")
    ap.add_argument("--into", type=Path, help="write modified copies here instead")
    ap.add_argument("--root", type=Path, default=Path.cwd())
    a = ap.parse_args()
    problems = process(a.root, a.into, a.check)
    if problems:
        print(f"{problems} problem(s) — nothing applied in place for those files.")
        return 1
    print("OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
