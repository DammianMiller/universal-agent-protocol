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
    # ANTHROPIC_BASE_URL / OPENAI_BASE_URL must be stripped too: the enforcer
    # downgrades block -> advisory for a local-model session, so a developer
    # with a loopback base URL exported (the normal shape of a local session)
    # sees every block-expecting test here allow instead. CI has them unset, so
    # this is green in CI and red on the developer's machine.
    for k in ("UAP_DELIVER_ACTIVE", "UAP_DELIVER_BYPASS", "UAP_DELIVER_LOCAL_MODE",
              "UAP_DELIVER_LOCAL_ADVISORY", "ANTHROPIC_BASE_URL", "OPENAI_BASE_URL"):
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

    def test_browser_by_ABSOLUTE_PATH_is_blocked(self):
        # The bypass the model actually found: the old regex wanted the browser
        # NAME immediately after the separator, so any path to the binary walked
        # straight through the gate.
        for cmd in (
            "nohup /home/u/.cloakbrowser/chromium-146.0.7213.0/chrome file:///tmp/x.html &",
            "/usr/bin/google-chrome-stable /tmp/a.html",
            "setsid ./bin/firefox /tmp/a.html",
            "cd /tmp && /opt/google/chrome/chrome index.html",
            "(chromium /tmp/a.html)",
        ):
            code, out = run("Bash", {"command": cmd})
            self.assertEqual(code, 2, f"{cmd} must be BLOCKED — got {out}")
            self.assertIn("uap verify", out)

    def test_browser_substring_is_not_blocked(self):
        # `open` is a browser bin on macOS; don't let it swallow openssl/opencode.
        for cmd in ("openssl version", "opencode run --help", "npm run chromedriver:check"):
            code, out = run("Bash", {"command": cmd})
            self.assertEqual(code, 0, f"{cmd} must NOT be blocked — got {out}")

    def test_browser_LOOKUP_is_not_blocked(self):
        # `which firefox` is a capability probe, not a launch — must not false-block.
        code, _ = run("Bash", {"command": "which firefox chromium 2>/dev/null"})
        self.assertEqual(code, 0)

    def test_browser_name_inside_code_and_quotes_is_not_blocked(self):
        # The matcher must read the SHELL SURFACE only — a browser-bin NAME that
        # appears inside a quoted grep pattern, an interpreter payload, an echoed
        # string, or a heredoc body is NOT a launch. These are the real
        # false-positives that repeatedly blocked read-only diagnostics:
        #   - Python's open() builtin: `(open` read as "subshell + open browser".
        #   - a grep pattern containing `\|open`: read as "pipe + open browser".
        for cmd in (
            # Python open() builtin in a -c payload (the .uap/ ledger reads).
            "python3 -c \"import json; d=json.load(open('.uap/completion-ledger.json'))\"",
            # Python open() for writing, inside a heredoc body.
            "python3 - \"$HEAD\" <<'PY'\nopen('.uap/reviews/x.json', 'w').write(s)\nPY",
            # A grep pattern that literally contains browser-bin words.
            "grep -n \"GUI browser\\|open.*browser\\|BROWSER\" src/x.py",
            # Echoed text mentioning a browser is not a launch.
            "echo 'open the browser to check the page'",
            # `open` as a grep pattern arg (not a command at a shell position).
            "cat notes.txt | grep open",
        ):
            code, out = run("Bash", {"command": cmd})
            self.assertEqual(code, 0, f"{cmd!r} must NOT be blocked — got {out}")

    def test_quoted_argument_launch_still_blocked(self):
        # The surface-stripper blanks quoted spans LENGTH-PRESERVINGLY; these
        # only stay blocked because the blanked argument leaves whitespace for
        # the trailing lookahead. If blank() ever returns "" instead of spaces,
        # every quoted-argument launch silently stops being blocked — pin it.
        for cmd in ("firefox '/tmp/a.html'", 'xdg-open "$F"', 'chromium "/tmp/a b.html"'):
            code, out = run("Bash", {"command": cmd})
            self.assertEqual(code, 2, f"{cmd!r} must be BLOCKED — got {out}")

    def test_lookahead_branches_and_alternation_order(self):
        # `chromium` precedes `chromium-browser` in BROWSER_BINS, so the engine
        # must backtrack through the lookahead to reach the longer name.
        # Also covers the bare-bin (`\s*$`) and terminator (`\s*[;&|]`) branches.
        for cmd in ("chromium-browser /tmp/a.html", "google-chrome-stable /tmp/a.html",
                    "firefox", "chromium &"):
            code, out = run("Bash", {"command": cmd})
            self.assertEqual(code, 2, f"{cmd!r} must be BLOCKED — got {out}")

    def test_probe_then_launch_is_blocked(self):
        # A prefix `which` used to disable the ENTIRE browser scan, so the
        # natural probe-then-launch sequence walked straight through.
        for cmd in ("which firefox && firefox /tmp/a.html",
                    "which xdg-open >/dev/null && xdg-open /tmp/app.html"):
            code, out = run("Bash", {"command": cmd})
            self.assertEqual(code, 2, f"{cmd!r} must be BLOCKED — got {out}")
        # A pure lookup is still exempt.
        code, out = run("Bash", {"command": "which firefox chromium 2>/dev/null"})
        self.assertEqual(code, 0, out)

    def test_launch_on_a_later_line_is_blocked(self):
        # `^` only anchored at offset 0, so a launch on line 2+ of a multi-line
        # command was invisible — and agents emit multi-line bash constantly.
        cmd = "cd /tmp/app\npython3 -m http.server 8080 &\nfirefox http://localhost:8080"
        code, out = run("Bash", {"command": cmd})
        self.assertEqual(code, 2, f"multi-line launch must be BLOCKED — got {out}")

    def test_leading_env_assignment_launch_is_blocked(self):
        # `DISPLAY=:0 firefox ...` is the canonical way to put a window on the
        # operator's desktop — precisely what this gate exists to prevent.
        for cmd in ("DISPLAY=:0 firefox /tmp/a.html", "FOO=bar BAZ=1 chromium /tmp/a.html"):
            code, out = run("Bash", {"command": cmd})
            self.assertEqual(code, 2, f"{cmd!r} must be BLOCKED — got {out}")

    def test_escaped_quotes_do_not_hide_a_launch(self):
        # Escaped apostrophes must not pair ACROSS a launch and blank it away.
        cmd = "echo it\\'s done ; firefox /tmp/a.html ; echo that\\'s all"
        code, out = run("Bash", {"command": cmd})
        self.assertEqual(code, 2, f"escaped-quote span must not hide the launch — got {out}")

    def test_launch_inside_a_shell_interpreter_payload_is_blocked(self):
        # A quoted SHELL payload is itself shell, so a launch inside it is real.
        # This gap predated the surface-stripper (the '"' before the bin was
        # never a separator) and is now closed by the interpreter pass.
        for cmd in (
            'bash -c "firefox http://x"',
            "sh -c 'xdg-open /tmp/x.html'",
            'eval "firefox /tmp/a.html"',
            'bash -c "cd /tmp; firefox a.html"',
            'ssh box "pkill x; chromium /tmp/a.html"',
            "zsh -c 'google-chrome /tmp/a.html'",
        ):
            code, out = run("Bash", {"command": cmd})
            self.assertEqual(code, 2, f"{cmd!r} must be BLOCKED — got {out}")

    def test_interpreter_mentioned_as_DATA_is_not_a_launch(self):
        # The interpreter must sit at a real COMMAND POSITION. Matching it
        # anywhere made the enforcer block its own documentation — a commit
        # message or README describing the invocation — with NO escape hatch,
        # because the browser branch runs before the DELIVER_ACTIVE/BYPASS checks.
        for cmd in (
            'git commit -m "fix: stop bash -c \'firefox url\' bypassing the gate"',
            'echo "Blocked: bash -c chromium now fails" >> notes.md',
            "cat > docs/DEBUG.md <<'EOF'\nRun: bash -c \"chromium http://localhost:3000\"\nEOF",
            'ssh-keygen -C "firefox comment"',  # ssh-keygen is not ssh
        ):
            code, out = run("Bash", {"command": cmd})
            self.assertEqual(code, 0, f"{cmd!r} must NOT be blocked — got {out}")

    def test_combined_interpreter_flags_are_blocked(self):
        # `bash -lc` is the canonical login-shell form several agent harnesses
        # emit; `-c` alone missed it entirely.
        for cmd in ('bash -lc "firefox http://localhost:8080"', "sh -xc 'xdg-open /tmp/a.html'"):
            code, out = run("Bash", {"command": cmd})
            self.assertEqual(code, 2, f"{cmd!r} must be BLOCKED — got {out}")

    def test_non_shell_interpreter_payloads_do_not_re_fire(self):
        # python/node payloads are NOT shell — excluding them is exactly what
        # keeps the `open()` builtin false positive from coming back. The last
        # case nests a python payload inside a bash payload.
        for cmd in (
            'python3 -c "import json; d=json.load(open(\'.uap/x.json\'))"',
            "python3 -c \"open(p, 'w').write(s)\"",
            "node -e \"const f = open('a.txt'); void f;\"",
            'bash -c "npm test && echo done"',
            "sh -c 'ls -la'",
            'bash -c "python3 -c \\"json.load(open(1))\\""',
        ):
            code, out = run("Bash", {"command": cmd})
            self.assertEqual(code, 0, f"{cmd!r} must NOT be blocked — got {out}")

    def test_open_function_call_is_not_a_browser_launch(self):
        # `open(` is a function call (Python/JS), never a browser launch; a real
        # `open <url>` launch has a space + argument, not a paren.
        code, out = run("Bash", {"command": "node -e \"const f = open('a.txt'); void f;\""})
        self.assertEqual(code, 0, out)

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
