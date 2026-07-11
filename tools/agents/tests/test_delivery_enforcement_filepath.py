#!/usr/bin/env python3
"""delivery-enforcement must recognize opencode's `filePath` arg key (not just
Claude's `file_path`), else opencode Write/Edit calls slip through ungated."""
import json, os, subprocess, sys, unittest
from pathlib import Path

ENF = Path(__file__).resolve().parents[3] / "src" / "policies" / "enforcers" / "delivery_enforcement.py"


def run(args, env=None):
    e = {**os.environ, "UAP_ENFORCE_DELIVERY": "block", "UAP_INFERENCE_ENDPOINT": "http://172.17.0.1:8080/v1"}
    for k in ("UAP_DELIVER_ACTIVE", "UAP_DELIVER_BYPASS", "UAP_DELIVER_LOCAL_MODE", "UAP_DELIVER_LOCAL_ADVISORY"):
        e.pop(k, None)
    if env:
        e.update(env)
    p = subprocess.run([sys.executable, str(ENF), "--operation", "Write", "--args", json.dumps(args)],
                       capture_output=True, text=True, env=e, cwd=str(ENF.parents[3]))
    return p.returncode, p.stdout


class FilePathKeyTest(unittest.TestCase):
    def test_opencode_filePath_is_gated(self):
        code, out = run({"filePath": "src/newfeature.ts", "content": "export const x=1;"})
        self.assertEqual(code, 2, out)
        self.assertIn("route", out)

    def test_claude_file_path_still_gated(self):
        code, _ = run({"file_path": "src/newfeature.ts", "content": "x"})
        self.assertEqual(code, 2)

    def test_test_file_allowed(self):
        code, _ = run({"filePath": "src/x.test.ts", "content": "x"})
        self.assertEqual(code, 0)


if __name__ == "__main__":
    unittest.main()
