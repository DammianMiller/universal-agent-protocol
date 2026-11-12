#!/usr/bin/env python3
"""Render the LCB-Droid smoke-10 problem workdirs (Phase 1, arm 2).

For each of the first 10 ids in vendor/GVS5H/escalation/lcb100_hardest_v6.json:

- problem.md   — GVS5H's exact build_code_prompt text (verbatim; the smoke
                 must show the agent the same problem text GVS5H's workers
                 saw).
- public_tests/ — tests.json (machine) + test_NN.in / test_NN.out (visible).
- run_gate.sh + gate.py — the completion gate: runs ONLY the public tests
                 (stdin-style: subprocess with piped input; LeetCode-style:
                 imports solution.py and calls the Solution method with the
                 eval'd argument literals). Line-normalized compare with
                 float tolerance, mirroring LCB's public-test semantics.
- AGENTS.md    — the UAP operating protocol, extracted VERBATIM from
                 benchmarks/terminal_bench/uap_droid_agent.py AGENTS_MD.
- task.txt     — the droid exec task prompt.

Must run with the scoring venv (needs lcb_runner + datasets):
    <venv-lcb>/bin/python render_tasks.py

Writes under the gitignored artifact dir: problems/<id>/ + manifest.json.
"""

import ast
import json
import re
import sys
from pathlib import Path

# --- fixed locations ---------------------------------------------------------
HERE = Path(__file__).resolve().parent
VENDOR = HERE / "vendor" / "GVS5H" / "escalation"
IDS_FILE = VENDOR / "lcb100_hardest_v6.json"
AGENTS_MD_SRC = HERE.parent / "terminal_bench" / "uap_droid_agent.py"
ART = (
    HERE.parent.parent
    / "benchmark-results"
    / "lcb-droid-smoke-20261025-175708"
)
PROBLEMS_ROOT = ART / "problems"
N_SMOKE = 10

# --- GVS5H build_code_prompt, VERBATIM (vendor run_bench.py) ------------------
_FMT_STARTER = (
    "You will use the following starter code to write the solution to the "
    "problem and enclose your code within delimiters."
)
_FMT_STDIN = (
    "Read the inputs from stdin solve the problem and write the answer to stdout "
    "(do not directly test on the sample inputs). Enclose your code within "
    "delimiters as follows. Ensure that when the python program runs, it reads "
    "the inputs, runs the algorithm and writes output to STDOUT."
)


def build_code_prompt(problem) -> str:
    p = f"### Question\n{problem.question_content}\n\n"
    if problem.starter_code:
        p += f"### Format: {_FMT_STARTER}\n"
        p += f"```python\n{problem.starter_code}\n```\n\n"
    else:
        p += f"### Format: {_FMT_STDIN}\n\n"
    return p


def agents_md_verbatim() -> str:
    """Extract the AGENTS_MD string literal from uap_droid_agent.py."""
    tree = ast.parse(AGENTS_MD_SRC.read_text())
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign):
            for t in node.targets:
                if isinstance(t, ast.Name) and t.id == "AGENTS_MD":
                    return ast.literal_eval(node.value)
    sys.exit("AGENTS_MD not found in uap_droid_agent.py")


TASK_TMPL = """Solve the competitive programming problem in problem.md.

Write the complete, self-contained Python program to a file named
solution.py in this directory ({style_note}).
Note: problem.md's "enclose your code within delimiters" wording refers to
the final program itself — in this harness the program goes in solution.py.

The public sample tests are in public_tests/. The completion gate is:

    bash run_gate.sh

It runs ONLY those public tests. When it exits 0 the gates are green and,
per AGENTS.md, you are then DONE: stop immediately.

You may run the gate as many times as you need while iterating. Do not
modify problem.md, public_tests/, run_gate.sh, or gate.py.
"""

STYLE_STDIN = (
    "read the inputs from stdin and write the answer to stdout, exactly as "
    "the Format section in problem.md specifies"
)
STYLE_LEET = (
    "define the class and method from the starter code in problem.md with "
    "the exact same names — the gate imports solution.py and calls the "
    "method with each test's arguments"
)

GATE_RUN_SH = """#!/bin/bash
# Completion gate: run ONLY the public tests in public_tests/.
# Exit 0 = all public tests pass.
cd "$(dirname "$0")"
exec python3 gate.py
"""

GATE_COMMON_COMPARE = '''
def _close(a, b):
    """LCB-style comparison: numeric tolerance, else exact equality."""
    try:
        fa, fb = float(a), float(b)
        return abs(fa - fb) <= 1e-6 * max(1.0, abs(fa), abs(fb))
    except (TypeError, ValueError):
        return False


def _norm(line):
    return line.strip()


def outputs_match(got: str, want: str) -> bool:
    g = [_norm(x) for x in (got or "").splitlines() if _norm(x)]
    w = [_norm(x) for x in (want or "").splitlines() if _norm(x)]
    if len(g) != len(w):
        return False
    for a, b in zip(g, w):
        if a == b or _close(a, b):
            continue
        return False
    return True
'''

GATE_STDIN = (
    GATE_COMMON_COMPARE
    + '''
import json
import subprocess
import sys

CASES = json.load(open("public_tests/tests.json"))
fails = []
for idx, case in enumerate(CASES):
    r = subprocess.run(
        [sys.executable, "solution.py"],
        input=case["input"],
        capture_output=True,
        text=True,
        timeout=120,
    )
    if r.returncode != 0:
        fails.append((idx, f"exit code {r.returncode}", r.stderr[-400:]))
        continue
    if not outputs_match(r.stdout, case["output"]):
        fails.append((idx, "output mismatch", f"got {r.stdout[:200]!r}"))
if fails:
    for idx, why, detail in fails:
        print(f"PUBLIC TEST {idx + 1} FAILED: {why}")
        if detail:
            print(f"  {detail}")
    print(f"GATE FAILED ({len(CASES) - len(fails)}/{len(CASES)} public tests passed)")
    sys.exit(1)
print(f"GATE PASSED ({len(CASES)}/{len(CASES)} public tests passed)")
'''
)

GATE_LEET_TMPL = (
    GATE_COMMON_COMPARE
    + '''
import json
import importlib.util
import sys

METHOD = @@METHOD@@
CASES = json.load(open("public_tests/tests.json"))

try:
    spec = importlib.util.spec_from_file_location("solution", "solution.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    sol = mod.Solution()
except FileNotFoundError:
    print("GATE FAILED: solution.py does not exist yet — write it first.")
    sys.exit(1)
except Exception as e:
    print(f"GATE FAILED: solution.py could not be imported ({type(e).__name__}: {e})")
    sys.exit(1)

fails = []
for idx, case in enumerate(CASES):
    try:
        args = [eval(line) for line in case["input"].split("\\n") if line.strip()]
        got = getattr(sol, METHOD)(*args)
        want = eval(case["output"])
    except Exception as e:
        fails.append((idx, f"{type(e).__name__}: {e}"))
        continue
    ok = got == want or _close(got, want)
    if not ok:
        fails.append((idx, f"got {got!r}, want {want!r}"))
if fails:
    for idx, detail in fails:
        print(f"PUBLIC TEST {idx + 1} FAILED: {detail}")
    print(f"GATE FAILED ({len(CASES) - len(fails)}/{len(CASES)} public tests passed)")
    sys.exit(1)
print(f"GATE PASSED ({len(CASES)}/{len(CASES)} public tests passed)")
'''
)


def render(problem) -> dict:
    wid = PROBLEMS_ROOT / problem.question_id
    wid.mkdir(parents=True, exist_ok=True)
    starter = bool(problem.starter_code)
    (wid / "problem.md").write_text(build_code_prompt(problem))
    (wid / "AGENTS.md").write_text(agents_md_verbatim())
    style = "stdin" if not starter else "leetcode"
    (wid / "task.txt").write_text(
        TASK_TMPL.format(
            style_note=STYLE_STDIN if not starter else STYLE_LEET
        )
    )
    pub = wid / "public_tests"
    pub.mkdir(exist_ok=True)
    cases = []
    for n, t in enumerate(problem.public_test_cases, 1):
        cases.append({"input": t.input, "output": t.output})
        (pub / f"test_{n:02d}.in").write_text(t.input)
        (pub / f"test_{n:02d}.out").write_text(t.output)
    (pub / "tests.json").write_text(json.dumps(cases, indent=1))
    (wid / "run_gate.sh").write_text(GATE_RUN_SH)
    if starter:
        m = re.search(r"def\s+(\w+)\s*\(", problem.starter_code)
        if not m:
            sys.exit(f"no method name in starter code of {problem.question_id}")
        (wid / "gate.py").write_text(
            GATE_LEET_TMPL.replace("@@METHOD@@", repr(m.group(1)))
        )
    else:
        (wid / "gate.py").write_text(GATE_STDIN)
    return {
        "question_id": problem.question_id,
        "difficulty": problem.difficulty.value,
        "style": style,
        "n_public": len(problem.public_test_cases),
        "problem_md_chars": len(build_code_prompt(problem)),
        "workdir": str(wid),
    }


def main():
    sys.path.insert(0, str(ART.parent))  # keep importable side effects local
    from lcb_runner.benchmarks.code_generation import (
        load_code_generation_dataset,
    )

    ids = json.loads(IDS_FILE.read_text())[:N_SMOKE]
    dataset = load_code_generation_dataset(release_version="release_v6")
    by_id = {p.question_id: p for p in dataset}
    missing = [i for i in ids if i not in by_id]
    if missing:
        sys.exit(f"missing ids in release_v6: {missing}")
    manifest = []
    for i in ids:
        rec = render(by_id[i])
        manifest.append(rec)
        print(
            f"rendered {rec['question_id']}: {rec['style']}, "
            f"{rec['n_public']} public tests, problem.md {rec['problem_md_chars']} chars"
        )
    (PROBLEMS_ROOT / "manifest.json").write_text(json.dumps(manifest, indent=1))
    print(f"manifest: {PROBLEMS_ROOT / 'manifest.json'} ({len(manifest)} problems)")


if __name__ == "__main__":
    main()
