#!/usr/bin/env python3
"""Every finding from the 5-droid review, as an executable check.

  python3 patches/169/verify2.py <enforcer.py>

Each case is a command plus the verdict it MUST get. The false-positive half
matters as much as the bypass half: the first implementation caught six real
bypasses and broke six ordinary commands doing it.
"""
from __future__ import annotations

import importlib.util
import os
import sys
import tempfile
import types
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]


def load(path: Path):
    sys.path.insert(0, str(REPO / "src" / "policies" / "enforcers"))
    spec = importlib.util.spec_from_file_location("enf_under_test", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


# (command, must_block, label)
def cases():
    return [
        # ── false positives found by the review: MUST be allowed ────────────
        ("cp package.json /tmp/x-$(date +%s).json", False, "FP cp package.json"),
        ("cp .gitignore /tmp/g.bak", False, "FP cp .gitignore"),
        ("cp CHANGELOG.md /tmp/c.md", False, "FP cp CHANGELOG.md"),
        ('git commit -m "fix: block xargs rm against .policy-tools/"', False,
         "FP commit message naming the path"),
        ("grep -rl policies/ docs/ | xargs sed -i s/a/b/", False,
         "FP xargs sed refactor (grep output unknowable)"),
        ("find docs -name '*.md' | xargs grep -l .uap.json", False,
         "FP read-only find|xargs grep"),
        ('echo "do not rm .policy-tools/x $(date)"', False, "FP prose with subst"),
        ("npm test 2>&1 | tee /tmp/t.log", False, "FP tee pipeline"),
        # ── bypasses: MUST be blocked ───────────────────────────────────────
        ("xargs rm -v < LIST", True, "targets from a file"),
        ("cat LIST | xargs -n1 rm -f", True, "cat|xargs"),
        ("head -1 LIST | xargs rm", True, "head|xargs"),
        ("rm $(cat LIST)", True, "command substitution"),
        ("echo .policy-tools/x.py | xargs rm", True, "echo|xargs"),
        ("eval rm .policy-tools/_common.py", True, "eval"),
        ("xargs rm < POISONED", True, "G-1 exempt line must not dilute"),
        ('bash -c "rm .policy-tools/_common.py"', True, "bash -c wrapper"),
        ('sh -c "rm .policy-tools/_common.py"', True, "sh -c wrapper"),
        ("env rm .policy-tools/_common.py", True, "env wrapper"),
        ("xargs --arg-file=LIST rm", True, "--arg-file= form"),
        ("xargs -a LIST rm", True, "-a form"),
        ("cd .policy-tools && rm -f _common.py", True, "cd then rm"),
        ('echo hi > "$(cat TARGET)"', True, "redirect target via $(cat)"),
        ("xargs rm < PADDED", True, "oversized list must not skip"),
        # ── direct forms must stay blocked ──────────────────────────────────
        ("rm .policy-tools/_common.py", True, "direct rm"),
        ("rm -rf src/policies/enforcers", True, "direct rm dir"),
        ("echo x >> .uap/evidence/reads.log", True, "direct append to evidence"),
        ("rm -rf .policy-tools # policies/waivers", True, "exempt comment must not dilute"),
        ("chmod 000 .policy-tools/x.py", True, "direct chmod"),
        # ── ordinary work must stay allowed ─────────────────────────────────
        ("rm -rf node_modules", False, "cleanup"),
        ("rm $TMPDIR/scratch", False, "variable path (accepted residual)"),
        ("npm run build", False, "build"),
        ("echo 0 > .uap/verify-cadence", False, "runtime state stays writable"),
        ("cat .uap/pending-deliver.jsonl", False, "reading runtime state"),
        ("xargs rm < HARMLESS", False, "unrelated list"),
        ("xargs rm < MISSING", False, "unreadable source"),
        ("git status --short", False, "read-only git"),
    ]


def main() -> int:
    mod = load(Path(sys.argv[1]))
    tmp = tempfile.mkdtemp()
    os.chdir(tmp)
    Path(".policy-tools").mkdir()
    Path("LIST").write_text(".policy-tools/_common.py\n")
    Path("POISONED").write_text(".policy-tools/_common.py\npolicies/waivers/ok\n")
    Path("TARGET").write_text(".uap/evidence/reads.log\n")
    Path("HARMLESS").write_text("/tmp/a.log\n/tmp/b.log\n")
    Path("PADDED").write_text(".policy-tools/_common.py\n" + ("x" * 200_000))
    for name in ("package.json", ".gitignore", "CHANGELOG.md"):
        Path(name).write_text("mentions src/policies/schemas and .policy-tools/ here\n")

    bad = []
    for cmd, must_block, label in cases():
        got = mod._bash_destructive(cmd)
        if got != must_block:
            bad.append((label, cmd, "blocked" if got else "allowed",
                        "block" if must_block else "allow"))

    total = len(cases())
    print(f"cases: {total}   wrong: {len(bad)}")
    for label, cmd, got, want in bad:
        print(f"  ! {label}\n      {cmd}\n      got {got}, want {want}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
