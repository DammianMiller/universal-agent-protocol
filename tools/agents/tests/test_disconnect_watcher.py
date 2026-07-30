#!/usr/bin/env python3
"""Pure-ASGI disconnect watcher — the thing that finally made the abort work.

Four attempts failed before this. The measured cause: `@app.middleware("http")`
is Starlette's BaseHTTPMiddleware, which runs the endpoint in a separate anyio
task behind its own receive channel, so request.is_disconnected() in the endpoint
polls a channel that never delivers http.disconnect. Instrumented in production
it returned False 16 times across 30s while the caller was demonstrably gone —
and it worked perfectly in an app with no middleware, which is exactly why three
rounds of isolated testing said the approach was sound.

Two properties are load-bearing and each has a test that fails if it breaks:

  1. ORDER. The watcher must be OUTERMOST. Starlette's add_middleware inserts at
     position 0, so it must be registered LAST. The first implementation
     registered it before auth, putting it inside the very middleware whose
     behaviour it exists to work around.
  2. POLLING. Wrapping receive() is not enough. Once the body is fully read
     nothing calls receive() again, so an http.disconnect sits in the channel
     unobserved. The watcher must take over polling after the final body message.

Verified end to end after these were in place: the llama slot freed within 5s of
the client hanging up, against 30s+ of continued generation before.
"""

import ast
import asyncio
import importlib.util
import unittest
from pathlib import Path

PROXY_PATH = Path(__file__).resolve().parents[1] / "scripts" / "anthropic_proxy.py"


def _load_proxy():
    spec = importlib.util.spec_from_file_location("anthropic_proxy_watcher", PROXY_PATH)
    assert spec is not None and spec.loader is not None
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


proxy = _load_proxy()


class MiddlewareOrderTest(unittest.TestCase):
    def test_the_watcher_is_outermost(self):
        """If it ends up inside BaseHTTPMiddleware it cannot see http.disconnect,
        which is the whole failure this replaced."""
        names = [getattr(mw.cls, "__name__", str(mw.cls)) for mw in proxy.app.user_middleware]
        self.assertTrue(names, "no middleware registered at all")
        self.assertEqual(
            names[0],
            "DisconnectWatcherMiddleware",
            f"watcher is not outermost; stack is {names}",
        )

    def test_auth_middleware_is_still_installed(self):
        """The brief was to leave auth alone. Losing it would silently open the
        LAN token gate — a far worse outcome than the bug being fixed."""
        names = [getattr(mw.cls, "__name__", str(mw.cls)) for mw in proxy.app.user_middleware]
        self.assertIn("BaseHTTPMiddleware", names)

    def test_probe_is_a_flag_read_not_a_starlette_call(self):
        """_client_gone must not call back into the request object: that is the
        path that measured False-forever behind BaseHTTPMiddleware.

        Checked with ast rather than substring matching — the first version of
        this test failed on the word appearing in the function's own docstring,
        which is a false positive, not a finding.
        """
        tree = ast.parse(PROXY_PATH.read_text())
        fn = next(
            n for n in ast.walk(tree)
            if isinstance(n, ast.AsyncFunctionDef) and n.name == "_client_gone"
        )
        attrs = {
            n.attr for n in ast.walk(fn) if isinstance(n, ast.Attribute)
        }
        self.assertNotIn("is_disconnected", attrs)
        # And it must read the holder, so the test fails if the body is gutted.
        self.assertIn("get", attrs)


class WatcherBehaviourTest(unittest.TestCase):
    """Drive the middleware directly with an ASGI receive/send pair."""

    def _run(self, messages, app_body):
        """messages: what receive() yields, in order. app_body: coroutine fn(scope, receive, send)."""
        sent = []
        queue = list(messages)

        async def receive():
            if queue:
                return queue.pop(0)
            await asyncio.sleep(3600)  # channel idle, like a live connection

        async def send(msg):
            sent.append(msg)

        mw = proxy.DisconnectWatcherMiddleware(app_body)
        asyncio.run(mw({"type": "http"}, receive, send))
        return sent

    def test_records_a_disconnect_the_app_itself_reads(self):
        seen = {}

        async def app(scope, receive, send):
            await receive()  # body
            msg = await receive()  # disconnect
            seen["type"] = msg["type"]
            seen["gone"] = await proxy._client_gone()

        self._run(
            [{"type": "http.request", "body": b"{}", "more_body": False},
             {"type": "http.disconnect"}],
            app,
        )
        self.assertEqual(seen["type"], "http.disconnect")
        self.assertTrue(seen["gone"], "watcher did not record the disconnect")

    def test_records_a_disconnect_the_app_NEVER_reads(self):
        """The real case. After the body is consumed the app never calls receive()
        again, so the disconnect is only ever seen by the watcher's own poller.
        Wrapping receive() alone would leave `gone` False here forever."""
        seen = {}

        async def app(scope, receive, send):
            await receive()  # body only — then just "work", like a generation
            for _ in range(40):
                await asyncio.sleep(0.02)
                if await proxy._client_gone():
                    seen["gone"] = True
                    return
            seen["gone"] = False

        self._run(
            [{"type": "http.request", "body": b"{}", "more_body": False},
             {"type": "http.disconnect"}],
            app,
        )
        self.assertTrue(seen.get("gone"), "poller did not observe the unread disconnect")

    def test_a_live_request_is_never_marked_gone(self):
        """A false positive would abort healthy turns — worse than the bug."""
        seen = {}

        async def app(scope, receive, send):
            await receive()
            for _ in range(10):
                await asyncio.sleep(0.02)
            seen["gone"] = await proxy._client_gone()

        self._run([{"type": "http.request", "body": b"{}", "more_body": False}], app)
        self.assertFalse(seen["gone"])

    def test_non_http_scopes_pass_straight_through(self):
        """Lifespan and websocket scopes have no disconnect semantics here and
        must not be wrapped."""
        called = {}

        async def app(scope, receive, send):
            called["type"] = scope["type"]

        async def go():
            mw = proxy.DisconnectWatcherMiddleware(app)
            await mw({"type": "lifespan"}, None, None)

        asyncio.run(go())
        self.assertEqual(called["type"], "lifespan")


if __name__ == "__main__":
    unittest.main()
