#!/usr/bin/env python3
"""The run script must cold-start the proxy against engines without /slots.

Regression (miller-tech-prime, 2026-11-21): run-anthropic-proxy-continuity.sh
runs 'set -euo pipefail', and its context-window probe was a bare

    CTX=$(curl -sf .../slots | python3 -c '...json.load...[0]["n_ctx"]...')

assignment. Against the YASAKANI arms (both tiers) /slots 404s, curl -f exits
22, pipefail fails the assignment, and set -e aborted the WHOLE script ~2s in.
The 60s retry/fallback loop below it was dead code, so:

  - 'uap proxy start/ensure' (health wait 15s) reported
    'proxy could not be started on :4000' on EVERY attempt, and
  - a live opencode session on qwen-fleet/yasakani-27b was stranded with
    ECONNREFUSED after the proxy's last registered client released
    (ses_e046d7dc, 11:51-11:52) with no way to bring :4000 back while a
    YASAKANI arm served :8080.

The fix guards every probe ('|| CTX=""') and adds a /health
max_context_tokens fallback (YASAKANI 0.2.0 answers /health while still
loading — it also wins the race against the /slots retry loop). These tests
drive the REAL shipped script against a fake upstream:

  1. YASAKANI shape — /slots 404, /health max_context_tokens=32768: the
     script must survive (the old one exits ~2s in), detect the window from
     /health, and leave a HEALTHY proxy listening on its port.
  2. llama.cpp shape — /slots [{n_ctx: 262144}]: /slots stays primary.
  3. The old bare-probe pattern is pinned as fatal under 'set -euo pipefail'
     against a 404 /slots — documents WHY the guards must stay.
  4. Infernix shape (2026-11-21, second same-day regression) — /slots 404,
     /health a minimal {"status":"ok"} with NO max_context_tokens, and the
     window only on /v1/models (max_model_len): the guarded two-source loop
     survives but burns ALL 30 iterations (~60s) while the CLI's 15s health
     wait expires and kills the script — 'proxy could not be started' —
     and a survivor pins the wrong 131072 default. The /v1/models third
     source must win on iteration 1.

The assertions deliberately do not assert absolute token literals beyond the
fake upstream's own answers (32768 / 262144 are what the fakes publish).
"""

import http.server
import json
import os
import signal
import socket
import subprocess
import threading
import time
import unittest
from pathlib import Path

TESTS_DIR = Path(__file__).resolve().parent
UAP_ROOT = TESTS_DIR.parents[2]  # tools/agents/tests -> tools/agents -> package
RUN_SCRIPT = UAP_ROOT / "scripts" / "run-anthropic-proxy-continuity.sh"


def _free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


class _FakeUpstream:
    """Loopback server impersonating an engine's /slots + /health surfaces."""

    def __init__(self, mode: str):
        self.mode = mode
        outer = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                if self.path == "/slots":
                    if outer.mode in ("yasakani", "infernix"):
                        body = {"error": {"message": "not found", "type": "not_found", "code": 404}}
                        self._send(404, body)
                    else:
                        self._send(200, [{"id": 0, "n_ctx": 262144}])
                    return
                if self.path == "/health":
                    if outer.mode == "yasakani":
                        self._send(
                            200,
                            {
                                "status": "ok",
                                "version": "0.2.0",
                                "model": "qwen3.8-27b",
                                "max_context_tokens": 32768,
                                "thinking_budget": 0,
                            },
                        )
                    else:
                        self._send(200, {"status": "ok"})
                    return
                if self.path == "/v1/models":
                    entry = {
                        "id": "qwen3.8-flash-next-test",
                        "object": "model",
                        "max_model_len": 262144,
                        "meta": {"n_ctx": 262144},
                    }
                    self._send(200, {"data": [entry], "models": [entry]})
                    return
                self._send(404, {"error": {"message": "not found"}})

            def _send(self, code, body):
                payload = json.dumps(body).encode()
                self.send_response(code)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, fmt, *args):  # keep test output quiet
                pass

        self.httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.port = self.httpd.server_address[1]
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *exc):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=5)


def _poll_http_ok(port: int, timeout: float = 20.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=1) as s:
                s.sendall(b"GET /health HTTP/1.0\r\nhost: localhost\r\n\r\n")
                data = s.recv(4096)
            if b"200" in data.split(b"\r\n", 1)[0]:
                return True
        except OSError:
            pass
        time.sleep(0.25)
    return False


class TestProxyColdstartContextDetect(unittest.TestCase):
    maxDiff = None

    def _run_script(self, upstream_port: int):
        proxy_port = _free_port()
        ollama_port = _free_port()
        env = dict(os.environ)
        env.update(
            {
                "LLAMA_CPP_BASE": f"http://127.0.0.1:{upstream_port}/v1",
                "PROXY_PORT": str(proxy_port),
                "PROXY_OLLAMA_PORT": str(ollama_port),
                "PROXY_LOG_LEVEL": "ERROR",
                "PROXY_SLOT_SAVE_RESTORE": "off",
                "UAP_PROXY_ENV_AUTOLOAD": "0",
            }
        )
        proc = subprocess.Popen(
            ["bash", str(RUN_SCRIPT)],
            env=env,
            cwd=str(UAP_ROOT),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )
        return proc, proxy_port

    def _stop(self, proc):
        try:
            os.killpg(proc.pid, signal.SIGTERM)
        except (ProcessLookupError, PermissionError):
            pass
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
            proc.wait(timeout=10)

    def test_yasakani_shape_cold_starts_via_health_fallback(self):
        """404 /slots + /health max_context_tokens: script survives + proxy healthy.

        The pre-fix script aborted ~2s in (set -e + pipefail on the curl -f
        404) and never bound its port; this case fails on that version.
        """
        with _FakeUpstream("yasakani") as upstream:
            proc, proxy_port = self._run_script(upstream.port)
            try:
                self.assertTrue(
                    _poll_http_ok(proxy_port),
                    "proxy never became healthy on :%d — the script likely "
                    "aborted during context detection (the 2026-11-21 "
                    "regression)" % proxy_port,
                )
            finally:
                self._stop(proc)
            # The banner is on the captured fd; the pipe closes after SIGTERM
            # and wait(), so this reads everything the script ever printed.
            out = proc.stdout.read().decode(errors="replace")
            proc.stdout.close()
        self.assertIn("Auto-detected context window (health): 32768 tokens", out)
        self.assertNotIn("Could not detect context", out)

    def test_llama_shape_keeps_slots_primary(self):
        """/slots answering: primary source, unchanged behavior."""
        with _FakeUpstream("llama") as upstream:
            proc, proxy_port = self._run_script(upstream.port)
            try:
                self.assertTrue(_poll_http_ok(proxy_port), "proxy never became healthy")
            finally:
                self._stop(proc)
            out = proc.stdout.read().decode(errors="replace")
            proc.stdout.close()
        self.assertIn("Auto-detected context window (slots): 262144 tokens", out)

    def test_infernix_shape_cold_starts_via_models_fallback(self):
        """/slots 404 + minimal /health: the /v1/models source must win fast.

        The two-source loop survives the 404 but finds nothing on the minimal
        /health body, so pre-models-fallback it burned the full 30x2s loop
        (~60s) — past the CLI ensure's 15s health wait ('proxy could not be
        started on :4000', the miller-tech-prime Infernix incident
        2026-11-21 13:57) — and pinned 131072 instead of the real rail. The
        health-poll window below (20s) inherits that race: a slow loop fails.
        """
        with _FakeUpstream("infernix") as upstream:
            proc, proxy_port = self._run_script(upstream.port)
            try:
                self.assertTrue(
                    _poll_http_ok(proxy_port),
                    "proxy never became healthy on :%d — detection likely "
                    "burned the full retry loop (60s) against the minimal "
                    "/health and lost the CLI 15s race" % proxy_port,
                )
            finally:
                self._stop(proc)
            out = proc.stdout.read().decode(errors="replace")
            proc.stdout.close()
        self.assertIn("Auto-detected context window (models): 262144 tokens", out)
        self.assertNotIn("Could not detect context", out)

    def test_old_bare_probe_pattern_is_fatal_under_set_e(self):
        """Pins WHY the guards exist: the pre-fix probe aborts a set -e script.

        Not a behavior we want anywhere — this documents the failure mode the
        guarded probes in the run script must never regress to.
        """
        with _FakeUpstream("yasakani") as upstream:
            snippet = (
                "set -euo pipefail; "
                "CTX=$(curl -sf --max-time 2 http://127.0.0.1:%d/slots 2>/dev/null "
                "| python3 -c \"import sys,json; print(json.load(sys.stdin)[0]['n_ctx'])\" "
                "2>/dev/null); echo SURVIVED"
                % upstream.port
            )
            r = subprocess.run(
                ["bash", "-c", snippet],
                capture_output=True,
                text=True,
                timeout=15,
            )
        self.assertNotEqual(r.returncode, 0, "the bare probe must fail against a 404 /slots")
        self.assertNotIn("SURVIVED", r.stdout, "set -e must abort before the next statement")


if __name__ == "__main__":
    unittest.main()
