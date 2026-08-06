#!/usr/bin/env python3
"""Round-3 cases: the pre-existing holes the re-review found, plus the
false-positive guards that must survive closing them.

  python3 patches/169/verify3.py <enforcer.py>

Every "must block" case here was verified to be ALLOWED by master as well, so
none of them is a regression this PR introduced — they are closed because they
are the naive direct forms the enforcer exists to catch.
"""
from __future__ import annotations

import importlib.util
import os
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]

MUST_BLOCK = [
    ("nohup rm -rf .policy-tools", "N2 launcher: nohup"),
    ("timeout 5 rm -rf .policy-tools", "N2 launcher: timeout + numeric arg"),
    ("sudo rm -rf .policy-tools", "N2 launcher: sudo"),
    ("command rm -rf .policy-tools", "N2 launcher: command"),
    ("'rm' -rf .policy-tools", "N2 quoted verb"),
    ("rm -rf .uap/", "N3 directory with trailing slash"),
    ("rm -rf .uap/*", "N3 directory glob"),
    ("rm -rf policies/waivers/../../.policy-tools", "N8 traversal through exempt"),
    ('bash -c "$(cat SCRIPT)"', "P1 verb and target both in the source"),
    ("cat SCRIPT | bash", "P1 pipe into a shell"),
    ("python3 -c 'print(\".policy-tools/x\")' | xargs rm -f", "N1 agent-chosen producer"),
    ("perl -e 'print \".policy-tools/x\"' | xargs rm", "N1 chosen producer (perl)"),
    # round-2 coverage must survive
    ("xargs rm -v < LIST", "r2 targets from a file"),
    ('bash -c "rm .policy-tools/_common.py"', "r2 shell wrapper"),
    ("cd .policy-tools && rm -f _common.py", "r2 cd then rm"),
    ("rm .policy-tools/_common.py", "direct form"),
]

MUST_ALLOW = [
    ("grep -rl policies/ docs/ | xargs sed -i s/a/b/", "search producer stays unknowable"),
    ("find docs -name '*.md' | xargs grep -l .uap.json", "read-only find|xargs grep"),
    ("git ls-files | xargs wc -l", "git producer"),
    ("rg -l policies/ src/ | xargs sed -i s/x/y/", "rg producer"),
    ("echo 0 > .uap/verify-cadence", "deep .uap path stays writable"),
    ("cat .uap/pending-deliver.jsonl", "reading runtime state"),
    ("cp package.json /tmp/x-$(date +%s).json", "FP cp package.json"),
    ("cp .gitignore /tmp/g.bak", "FP cp .gitignore"),
    ('git commit -m "fix: block xargs rm against .policy-tools/"', "FP commit message"),
    ("rm -rf node_modules", "cleanup"),
    ("npm run build", "build"),
    ("timeout 30 npm test", "launcher + benign command"),
    ("nohup npm run dev", "launcher + benign command"),
    ("sudo systemctl restart nginx", "launcher + unrelated"),
    ("git status --short", "read-only git"),
    ("rm $TMPDIR/scratch", "accepted residual: shell variable"),
    ("xargs rm < HARMLESS", "unrelated list"),
]


def main() -> int:
    sys.path.insert(0, str(REPO / "src" / "policies" / "enforcers"))
    spec = importlib.util.spec_from_file_location("enf3", Path(sys.argv[1]))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)

    tmp = tempfile.mkdtemp()
    os.chdir(tmp)
    Path(".policy-tools").mkdir()
    Path("policies/waivers").mkdir(parents=True)
    Path("LIST").write_text(".policy-tools/_common.py\n")
    Path("SCRIPT").write_text("rm .policy-tools/_common.py\n")
    Path("HARMLESS").write_text("/tmp/a.log\n")
    Path("package.json").write_text("names src/policies/ and .policy-tools/\n")
    Path(".gitignore").write_text(".policy-tools/\n")

    bad = []
    for cmd, label in MUST_BLOCK:
        if not mod._bash_destructive(cmd):
            bad.append(("allowed, want BLOCK", label, cmd))
    for cmd, label in MUST_ALLOW:
        if mod._bash_destructive(cmd):
            bad.append(("BLOCKED, want allow", label, cmd))

    print(f"must-block: {len(MUST_BLOCK)}   must-allow: {len(MUST_ALLOW)}   wrong: {len(bad)}")
    for got, label, cmd in bad:
        print(f"  ! {label}: {got}\n      {cmd}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
