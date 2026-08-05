#!/usr/bin/env python3
"""Measure the OLD vs NEW self-protect decision on a corpus.

A tightening change is only safe if you know BOTH directions: what it newly
blocks (the point) and what it newly blocks that it shouldn't (the cost). Three
under-detection regressions earlier in this repo were each caught only by
measuring, never by reading the diff.

  python3 patches/169/measure.py <old_enforcer.py> <new_enforcer.py>
"""
from __future__ import annotations

import importlib.util
import sys
import types
from pathlib import Path


def load(path: Path, name: str):
    """Import an enforcer with _common stubbed, so no package install is needed."""
    stub = types.ModuleType("_common")
    stub.emit = lambda *a, **k: None
    stub.parse_cli = lambda: ("Bash", {})
    stub.repo_root = lambda: Path.cwd()
    stub.REVIEW_ARTIFACT_DIR = ".uap/reviews"
    stub.REVIEW_WAIVER_DIR = "policies/waivers"
    sys.modules["_common"] = stub
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


# (command, must_block, label)
CASES = [
    # ---- the bypasses this change exists to close -------------------------
    ("xargs rm -v < orphans.txt", True, "xargs reads targets from a file"),
    ("head -1 orphans.txt | xargs rm", True, "pipeline feeds xargs"),
    ("echo .policy-tools/x.py | xargs rm", True, "path in a different segment"),
    ("cat orphans.txt | xargs -n1 rm -f", True, "cat|xargs"),
    ("rm $(cat orphans.txt)", True, "command substitution from file"),
    ("eval rm .policy-tools/_common.py", True, "eval hides the verb"),
    # ---- must STAY blocked (no regression in the direct form) -------------
    ("rm .policy-tools/_common.py", True, "direct rm"),
    ("rm -rf src/policies/enforcers", True, "direct rm dir"),
    ("echo x >> .uap/evidence/reads.log", True, "direct append to evidence"),
    ("chmod 000 .policy-tools/x.py", True, "direct chmod"),
    ("cp /dev/null .uap.json", True, "direct overwrite of config"),
    # ---- must STAY allowed (ordinary work) --------------------------------
    ("xargs rm < /tmp/harmless-list.txt", False, "xargs over an unrelated list"),
    ("cat notes.md | xargs echo", False, "xargs with no destructive verb"),
    ("rm -rf node_modules", False, "ordinary cleanup"),
    ("rm $TMPDIR/scratch", False, "variable path, unrelated"),
    ("git status --short", False, "read-only git"),
    ("echo 0 > .uap/verify-cadence", False, "runtime state stays writable"),
    ("cat .uap/pending-deliver.jsonl", False, "reading runtime state"),
    ("npm run build", False, "build"),
    ("find . -name '*.ts' | xargs grep -l foo", False, "xargs grep, non-destructive"),
    ("echo 'do not rm .policy-tools/x'", False, "prose mentioning a removal"),
    ("python3 patches/169/apply.py --check", False, "running the patch checker"),
    ("ls -la .policy-tools/", False, "listing is not destructive"),
    ("xargs rm < missing-file-does-not-exist.txt", False, "unreadable source, no marker"),
]


def main() -> int:
    old = load(Path(sys.argv[1]), "enf_old")
    new = load(Path(sys.argv[2]), "enf_new")

    newly_blocked, newly_allowed, wrong = [], [], []
    for cmd, must_block, label in CASES:
        o = old._bash_destructive(cmd)
        n = new._bash_destructive(cmd)
        if n and not o:
            newly_blocked.append((cmd, label))
        if o and not n:
            newly_allowed.append((cmd, label))
        if n != must_block:
            wrong.append((cmd, label, "blocked" if n else "allowed",
                          "block" if must_block else "allow"))

    print(f"corpus: {len(CASES)} commands")
    print(f"newly BLOCKED by this change: {len(newly_blocked)}")
    for c, l in newly_blocked:
        print(f"    + {l}: {c}")
    print(f"newly ALLOWED by this change: {len(newly_allowed)}  (must be 0)")
    for c, l in newly_allowed:
        print(f"    - {l}: {c}")
    print(f"WRONG verdicts under the new code: {len(wrong)}")
    for c, l, got, want in wrong:
        print(f"    ! {l}: got {got}, want {want}  ::  {c}")
    return 1 if (wrong or newly_allowed) else 0


if __name__ == "__main__":
    sys.exit(main())
