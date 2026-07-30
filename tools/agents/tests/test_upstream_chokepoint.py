#!/usr/bin/env python3
"""Every upstream call must pass the disconnect check — structurally, not by claim.

This test exists because of a specific mistake. Two releases (v1.172.11,
v1.172.12) guarded ONE call site while the commit message asserted that "every
upstream call funnels through _post_with_retry, so one check covers them all".
There are fourteen upstream call sites, and the guardrail loops that caused the
incident — malformed-tool retry, completion-contract, empty-max-tokens recovery,
unexpected-end-turn, recipe — call the model DIRECTLY. Both releases were
therefore near-no-ops for the workload they were written for, and every unit
test still passed.

The fix was to move the check somewhere it cannot be missed: httpx routes every
high-level method (post, stream, request) through send(), so DisconnectAwareClient
overrides send() and the coverage becomes a property of the client rather than a
property of remembering.

These tests pin that property. A future call site added anywhere in the proxy is
covered automatically; a future *client* constructed bare would not be, and that
is exactly what the enumeration below fails on.
"""

import ast
import asyncio
import importlib.util
import re
import unittest
from pathlib import Path

PROXY_PATH = Path(__file__).resolve().parents[1] / "scripts" / "anthropic_proxy.py"


def _load_proxy():
    spec = importlib.util.spec_from_file_location("anthropic_proxy_choke", PROXY_PATH)
    assert spec is not None and spec.loader is not None
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


proxy = _load_proxy()
SRC = PROXY_PATH.read_text()


class ChokePointEnumerationTest(unittest.TestCase):
    def test_no_bare_httpx_client_is_ever_constructed(self):
        """The invariant. A bare httpx.AsyncClient bypasses the override, so its
        calls silently go unwatched — which is precisely how the first two
        attempts failed, one call site at a time."""
        bare = [
            (i + 1, l.strip())
            for i, l in enumerate(SRC.split("\n"))
            if re.search(r"httpx\.AsyncClient\s*\(", l) and "class " not in l
        ]
        self.assertEqual(
            bare, [], f"these construct an unwatched client: {bare}"
        )

    def test_the_client_actually_subclasses_httpx(self):
        """Guards the reverse mistake: a wrapper that no longer IS an httpx
        client would break every caller rather than fail this suite loudly."""
        import httpx

        self.assertTrue(issubclass(proxy.DisconnectAwareClient, httpx.AsyncClient))

    def test_send_is_overridden_on_the_client_itself(self):
        """send() is the funnel. If a refactor moves the logic off send() onto,
        say, post(), then stream() and request() silently lose their guard."""
        self.assertIn("send", vars(proxy.DisconnectAwareClient))

    def test_every_upstream_call_site_is_reachable_through_send(self):
        """Inventory, so the count cannot quietly drift.

        Any client.post / client.stream / client.send in the proxy is covered by
        the override — that is the point of a choke point. This asserts the call
        sites still exist in numbers consistent with the audit (they were the
        thing miscounted), and that none of them re-implements its own transport.
        """
        calls = re.findall(r"client\.(post|send|stream)\s*\(", SRC)
        self.assertGreaterEqual(
            len(calls), 10, "upstream call sites vanished — was transport re-implemented?"
        )
        # No call site may build its own client inline and slip the override.
        self.assertNotRegex(SRC, r"await\s+httpx\.AsyncClient\s*\(")


class ChokePointBehaviourTest(unittest.TestCase):
    """The override must do the job, not merely exist."""

    class _Req:
        pass

    def setUp(self):
        proxy.PROXY_DISCONNECT_POLL_SECS = 0.05

    def _client_with_send(self, behaviour):
        """A DisconnectAwareClient whose SUPERCLASS send is stubbed, so the
        override under test runs for real."""
        import httpx

        state = {"cancelled": False}

        async def fake_send(self, request, **kwargs):
            if behaviour == "fast":
                return "RESPONSE"
            try:
                await asyncio.sleep(3600)
            except asyncio.CancelledError:
                state["cancelled"] = True
                raise

        original = httpx.AsyncClient.send
        httpx.AsyncClient.send = fake_send  # type: ignore[assignment]
        client = proxy.DisconnectAwareClient()
        return client, state, (lambda: setattr(httpx.AsyncClient, "send", original))

    def _set_probe(self, gone: bool):
        # The guard now reads a shared mutable holder published by the ASGI
        # watcher, rather than calling back into the request object.
        proxy._disconnect_holder.set({"gone": gone})

    def test_cancels_upstream_when_the_caller_leaves(self):
        client, state, restore = self._client_with_send("never")
        try:
            self._set_probe(True)

            async def run():
                with self.assertRaises(proxy.ClientGoneError):
                    await client.send(self._Req())

            asyncio.run(run())
            self.assertTrue(state["cancelled"], "upstream call was not cancelled")
        finally:
            restore()

    def test_leaves_a_live_call_alone(self):
        client, state, restore = self._client_with_send("fast")
        try:
            self._set_probe(False)
            self.assertEqual(asyncio.run(client.send(self._Req())), "RESPONSE")
            self.assertFalse(state["cancelled"])
        finally:
            restore()

    def test_no_probe_means_unwatched(self):
        """Health checks and background tasks have no request context and must
        keep working rather than acquiring surprise cancellation."""
        client, state, restore = self._client_with_send("fast")
        try:
            proxy._disconnect_holder.set(None)
            self.assertEqual(asyncio.run(client.send(self._Req())), "RESPONSE")
        finally:
            restore()

    def test_a_slow_but_live_call_is_left_pending(self):
        """Mistaking 'slow' for 'gone' would be worse than the bug being fixed."""
        client, state, restore = self._client_with_send("never")
        try:
            self._set_probe(False)

            async def run():
                task = asyncio.ensure_future(client.send(self._Req()))
                await asyncio.sleep(0.4)  # ~8 poll intervals
                still = not task.done()
                task.cancel()
                try:
                    await task
                except (asyncio.CancelledError, Exception):
                    pass
                return still

            self.assertTrue(asyncio.run(run()), "a live-but-slow call was ended early")
        finally:
            restore()


if __name__ == "__main__":
    unittest.main()
