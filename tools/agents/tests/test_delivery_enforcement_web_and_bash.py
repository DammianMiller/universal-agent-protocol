#!/usr/bin/env python3
"""delivery-enforcement must gate WEB source (.html/.css/...) and BASH.

Two live escapes this closes:
 1. `.html` was not in SOURCE_EXTS, so a single-file web app — the actual
    deliverable — returned "not source code" and was allowed: zero routing, zero
    deliver, zero validation (observed: a 34KB rubiks-cube.html built ungated).
 2. Bash was ungated entirely, so `cat > app.js <<EOF` bypassed the whole gate;
    and a model with no validation tooling in reach kept launching a GUI browser
    (xdg-open/firefox) to "check its work", which proves nothing.
"""
import json, os, subprocess, sys, unittest
from pathlib import Path

ENF = Path(__file__).resolve().parents[3] / "src" / "policies" / "enforcers" / "delivery_enforcement.py"


def run(op, args, env=None):
    e = {**os.environ, "UAP_ENFORCE_DELIVERY": "block", "UAP_INFERENCE_ENDPOINT": "http://172.17.0.1:8080/v1"}
    for k in ("UAP_DELIVER_ACTIVE", "UAP_DELIVER_BYPASS", "UAP_DELIVER_LOCAL_MODE", "UAP_DELIVER_LOCAL_ADVISORY"):
        e.pop(k, None)
    if env:
        e.update(env)
    p = subprocess.run([sys.executable, str(ENF), "--operation", op, "--args", json.dumps(args)],
                       capture_output=True, text=True, env=e, cwd=str(ENF.parents[3]))
    return p.returncode, p.stdout + p.stderr


class WebSourceTest(unittest.TestCase):
    def test_html_is_source_and_routes(self):
        code, out = run("Write", {"file_path": "app.html", "content": "<html>" + "x" * 2000})
        self.assertEqual(code, 2, out)          # blocked
        self.assertIn("route", out)             # → deliver

    def test_css_is_source(self):
        code, _ = run("Write", {"file_path": "src/app.css", "content": "a{}" * 500})
        self.assertEqual(code, 2)

    def test_vue_svelte_are_source(self):
        for f in ("src/App.vue", "src/App.svelte"):
            code, _ = run("Write", {"file_path": f, "content": "x" * 1000})
            self.assertEqual(code, 2, f)

    def test_non_source_still_allowed(self):
        code, out = run("Write", {"file_path": "notes.md", "content": "hello"})
        self.assertEqual(code, 0, out)


class BashGateTest(unittest.TestCase):
    def test_gui_browser_launch_is_blocked_and_redirected_to_verify(self):
        code, out = run("Bash", {"command": "xdg-open /tmp/app.html"})
        self.assertEqual(code, 2, out)
        self.assertIn("uap verify", out)  # redirected to the real validation path

    def test_firefox_launch_blocked(self):
        code, _ = run("Bash", {"command": "nohup firefox /tmp/a.html &"})
        self.assertEqual(code, 2)

    def test_browser_LOOKUP_is_not_blocked(self):
        # `which firefox` is a capability probe, not a launch — must not false-block.
        code, _ = run("Bash", {"command": "which firefox chromium 2>/dev/null"})
        self.assertEqual(code, 0)

    def test_bash_source_write_routes_to_deliver(self):
        code, out = run("Bash", {"command": "cat > src/app.js <<EOF\nconsole.log(1)\nEOF"})
        self.assertEqual(code, 2, out)
        self.assertIn("route", out)

    def test_sed_inplace_on_source_blocked(self):
        code, _ = run("Bash", {"command": "sed -i s/a/b/ src/main.ts"})
        self.assertEqual(code, 2)

    def test_benign_bash_allowed(self):
        code, out = run("Bash", {"command": "ls -la && npm test"})
        self.assertEqual(code, 0, out)

    def test_deliver_active_bypasses_bash_gate(self):
        code, _ = run("Bash", {"command": "cat > src/app.js <<EOF\nx\nEOF"},
                      env={"UAP_DELIVER_ACTIVE": "1"})
        self.assertEqual(code, 0)  # deliver's own shell writes must pass


if __name__ == "__main__":
    unittest.main()
