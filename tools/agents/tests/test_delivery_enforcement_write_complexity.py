#!/usr/bin/env python3
"""A Write should be judged on nature AND complexity, not on being a Write.

Before this, an Edit was judged by how much it changed and a Write was judged
only by being a Write: a 120-character new module and a 9000-character rewrite
got the same answer. Creating one small file therefore cost a full
decompose -> epics -> gates cycle — roughly ten minutes on a local executor —
while an equivalent Edit went straight through. That asymmetry is what made
"route everything through deliver" feel arbitrary to the caller, and a caller
that reads a gate as arbitrary goes looking for ways around it.

Two things make a Write cheap, and BOTH are required: the content is small, and
it does not replace substantial existing content. The second is the load-bearing
half — measuring only the new content would call the most destructive write
(120 characters over 8000) the cheapest one.
"""
import json, os, subprocess, sys, tempfile, unittest
from pathlib import Path

ENF = Path(__file__).resolve().parents[3] / "src" / "policies" / "enforcers" / "delivery_enforcement.py"
BUDGET = 240  # UAP_DELIVER_TRIVIAL_EDIT_CHARS default


def project() -> str:
    root = tempfile.mkdtemp(prefix="uap-writecx-")
    for d in ("src", "docs", "test"):
        os.makedirs(os.path.join(root, d), exist_ok=True)
    Path(root, ".uap.json").write_text("{}")
    os.makedirs(os.path.join(root, ".git"), exist_ok=True)
    return root


def run(root: str, args: dict, op: str = "Write") -> tuple[int, str]:
    e = {**os.environ, "UAP_ENFORCE_DELIVERY": "block", "UAP_REPO_ROOT": root}
    # Same strips as the sibling tests: a local-model session downgrades block
    # to advisory, which would make every block-expecting case here allow.
    for k in ("UAP_DELIVER_ACTIVE", "UAP_DELIVER_BYPASS", "UAP_DELIVER_LOCAL_MODE",
              "UAP_DELIVER_LOCAL_ADVISORY", "UAP_FASTPATH_ROUTED",
              "ANTHROPIC_BASE_URL", "OPENAI_BASE_URL", "UAP_INFERENCE_ENDPOINT"):
        e.pop(k, None)
    p = subprocess.run([sys.executable, str(ENF), "--operation", op, "--args", json.dumps(args)],
                       capture_output=True, text=True, env=e, cwd=root)
    return p.returncode, p.stdout


class WriteComplexityTest(unittest.TestCase):
    def test_small_new_file_is_allowed(self):
        root = project()
        code, out = run(root, {"file_path": os.path.join(root, "src", "tiny.ts"),
                               "content": "x" * 120})
        self.assertEqual(code, 0, out)

    def test_write_at_the_budget_is_allowed(self):
        root = project()
        code, out = run(root, {"file_path": os.path.join(root, "src", "edge.ts"),
                               "content": "x" * BUDGET})
        self.assertEqual(code, 0, out)

    def test_write_just_over_the_budget_is_gated(self):
        root = project()
        code, _ = run(root, {"file_path": os.path.join(root, "src", "edge2.ts"),
                             "content": "x" * (BUDGET + 1)})
        self.assertEqual(code, 2)

    def test_large_new_file_is_gated(self):
        root = project()
        code, _ = run(root, {"file_path": os.path.join(root, "src", "huge.ts"),
                             "content": "x" * 9000})
        self.assertEqual(code, 2)

    def test_growing_a_small_file_is_allowed(self):
        # Not a new file, but nothing substantial is destroyed.
        root = project()
        target = os.path.join(root, "src", "small.ts")
        Path(target).write_text("x" * 100)
        code, out = run(root, {"file_path": target, "content": "x" * 200})
        self.assertEqual(code, 0, out)

    def test_small_write_over_a_substantial_file_is_gated(self):
        # The load-bearing case: judged by what is DESTROYED, not by how little
        # arrives. Measuring only the new content would call this the cheapest
        # write of all, when it is the most destructive.
        root = project()
        target = os.path.join(root, "src", "existing.ts")
        Path(target).write_text("x" * 8000)
        code, _ = run(root, {"file_path": target, "content": "x" * 120})
        self.assertEqual(code, 2)

    def test_edit_behaviour_is_unchanged(self):
        root = project()
        target = os.path.join(root, "src", "thing.ts")
        small = run(root, {"file_path": target, "old_string": "a" * 20, "new_string": "b" * 20}, op="Edit")
        big = run(root, {"file_path": target, "old_string": "a" * 300, "new_string": "b" * 300}, op="Edit")
        self.assertEqual(small[0], 0, small[1])
        self.assertEqual(big[0], 2, big[1])

    def test_nature_exemptions_are_unchanged(self):
        root = project()
        docs = run(root, {"file_path": os.path.join(root, "docs", "n.md"), "content": "x" * 9000})
        tests = run(root, {"file_path": os.path.join(root, "test", "a.test.ts"), "content": "x" * 9000})
        self.assertEqual(docs[0], 0, docs[1])
        self.assertEqual(tests[0], 0, tests[1])

    def test_fastpath_off_gates_the_small_write_too(self):
        # The new allowance rides the SAME switch as the trivial-edit one, so an
        # operator turning the fast-path off gets the strict behaviour back for
        # both rather than only for edits.
        root = project()
        code, _ = run(root, {"file_path": os.path.join(root, "src", "tiny.ts"),
                             "content": "x" * 120})
        self.assertEqual(code, 0)
        e = {"UAP_DELIVER_FASTPATH": "off"}
        p = subprocess.run(
            [sys.executable, str(ENF), "--operation", "Write", "--args",
             json.dumps({"file_path": os.path.join(root, "src", "tiny.ts"), "content": "x" * 120})],
            capture_output=True, text=True, cwd=root,
            env={**{k: v for k, v in os.environ.items()
                    if k not in ("UAP_DELIVER_ACTIVE", "UAP_DELIVER_BYPASS", "UAP_DELIVER_LOCAL_MODE",
                                 "ANTHROPIC_BASE_URL", "OPENAI_BASE_URL", "UAP_INFERENCE_ENDPOINT")},
                 "UAP_ENFORCE_DELIVERY": "block", "UAP_REPO_ROOT": root, **e})
        self.assertEqual(p.returncode, 2, p.stdout)


if __name__ == "__main__":
    unittest.main()
