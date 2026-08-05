#!/usr/bin/env python3
"""Measure the OLD vs NEW SEC_SENSITIVE verdict embedded in the gate script.

SEC_SENSITIVE decides whether a broken enforcer FAILS CLOSED. It never turns a
block into an allow, so widening it can only tighten -- but it also disables the
deliver fastpath, so it should not fire on ordinary work either.

  python3 patches/169/measure_gate.py <old_gate.sh> <new_gate.sh>
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

START = 'SEC_SENSITIVE="$(printf \'%s\' "$ARGS" | TOOL="$TOOL" python3 -c \''
END = "' 2>/dev/null || echo 1)\""


def snippet(gate: Path) -> str:
    text = gate.read_text()
    i = text.index(START) + len(START)
    j = text.index(END, i)
    return text[i:j]


def verdict(code: str, args: dict, tool: str) -> str:
    p = subprocess.run([sys.executable, "-c", code], input=json.dumps(args),
                       capture_output=True, text=True, env={"TOOL": tool, "PATH": "/usr/bin:/bin"})
    return (p.stdout or "").strip() or "ERR"


# (tool, args, must_be_sensitive, label)
CASES = [
    ("Bash", {"command": "rm .policy-tools/_common.py"}, True, "shell rm of an enforcer"),
    ("Bash", {"command": "echo x >> .uap/evidence/reads.log"}, True, "shell append to evidence"),
    ("Bash", {"command": "cp /dev/null .uap.json"}, True, "shell overwrite of config"),
    ("Bash", {"command": "vi .claude/hooks/uap-policy-gate.sh"}, True, "shell edit of the gate"),
    ("Bash", {"command": "sed -i s/x/y/ src/policies/enforcers/a.py"}, True, "shell sed on an enforcer"),
    ("Bash", {"command": "UAP_SELF_PROTECT_OFF=1 rm x"}, True, "bypass flag (already caught)"),
    ("Edit", {"file_path": "/repo/src/policies/enforcers/a.py"}, True, "edit path (already caught)"),
    # ordinary work must stay non-sensitive
    ("Bash", {"command": "npm run build"}, False, "build"),
    ("Bash", {"command": "git status --short"}, False, "git status"),
    ("Bash", {"command": "rm -rf node_modules"}, False, "cleanup"),
    ("Bash", {"command": "ls -la"}, False, "ls"),
    ("Edit", {"file_path": "/repo/src/cli/memory.ts"}, False, "ordinary source edit"),
]


def main() -> int:
    old, new = snippet(Path(sys.argv[1])), snippet(Path(sys.argv[2]))
    gained, lost, wrong = [], [], []
    for tool, args, want, label in CASES:
        o, n = verdict(old, args, tool), verdict(new, args, tool)
        if n == "1" and o != "1":
            gained.append(label)
        if o == "1" and n != "1":
            lost.append(label)
        if n != ("1" if want else "0"):
            wrong.append((label, n, "1" if want else "0"))
    print(f"cases: {len(CASES)}")
    print(f"newly SENSITIVE (fail-closed now covers): {len(gained)}")
    for g in gained:
        print(f"    + {g}")
    print(f"lost coverage: {len(lost)}  (must be 0)")
    for l in lost:
        print(f"    - {l}")
    print(f"WRONG: {len(wrong)}")
    for lab, got, want in wrong:
        print(f"    ! {lab}: got {got}, want {want}")
    return 1 if (wrong or lost) else 0


if __name__ == "__main__":
    sys.exit(main())
