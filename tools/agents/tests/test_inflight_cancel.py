#!/usr/bin/env python3
"""Cancel the upstream generation when the caller hangs up mid-turn.

Checking only BEFORE each upstream call (v1.172.11) stops the retry loops, but
does nothing for a generation already in flight: a single turn is ONE post, so
there is no next call to block and the model runs to completion — up to
PROXY_TOOL_TURN_MAX_TOKENS (32k, ~13 minutes on this box) for a client that has
already gone.

That gap was caught by an end-to-end test, not by reasoning: the abandon simply
never fired for a single long request. These tests pin the closing behaviour so
it cannot silently regress to the pre-check-only version.

Cancelling matters rather than merely returning: closing the upstream connection
is what makes llama.cpp release the slot (verified against the running server —
slots went 2 -> 0 within 15s of a raw socket close).
"""

import asyncio
import importlib.util
import unittest
from pathlib import Path


def _load_proxy():
    p = Path(__file__).resolve().parents[1] / "scripts" / "anthropic_proxy.py"
    spec = importlib.util.spec_from_file_location("anthropic_proxy_inflight", p)
    assert spec is not None and spec.loader is not None
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


proxy = _load_proxy()


class _Client:
    """Stands in for httpx.AsyncClient.post.

    `never` models the real failure: the model is generating, so the POST is
    neither erroring nor returning — it is simply not done yet.
    """

    def __init__(self, mode: str):
        self.mode = mode
        self.cancelled = False

    async def post(self, url, json=None, headers=None):  # noqa: A002
        if self.mode == "fast":
            return "RESPONSE"
        try:
            await asyncio.sleep(3600)
        except asyncio.CancelledError:
            self.cancelled = True
            raise
        return "RESPONSE"


def _set_probe(gone: bool):
    async def probe() -> bool:
        return gone
    proxy._current_client_gone.set(probe)


class InflightCancelTest(unittest.TestCase):
    def setUp(self):
        proxy.PROXY_DISCONNECT_POLL_SECS = 0.05  # keep the tests quick

    def test_cancels_the_upstream_call_when_the_caller_leaves(self):
        client = _Client("never")
        _set_probe(True)

        async def run():
            with self.assertRaises(proxy.ClientGoneError):
                await proxy._post_watching_client(client, "u", {}, {})

        asyncio.run(run())
        # The cancellation is the whole point: it closes the connection, which is
        # what frees the llama slot. Returning early without it would leave the
        # model generating exactly as before.
        self.assertTrue(client.cancelled, "upstream POST was not cancelled")

    def test_leaves_a_live_turn_completely_alone(self):
        client = _Client("fast")
        _set_probe(False)
        self.assertEqual(asyncio.run(proxy._post_watching_client(client, "u", {}, {})), "RESPONSE")
        self.assertFalse(client.cancelled)

    def test_no_probe_means_a_plain_await(self):
        """Background tasks and tests have no request context. They must keep
        working, unwatched, rather than acquiring surprise cancellation."""
        client = _Client("fast")
        proxy._current_client_gone.set(None)
        self.assertEqual(asyncio.run(proxy._post_watching_client(client, "u", {}, {})), "RESPONSE")

    def test_a_slow_but_live_turn_is_left_pending(self):
        """The poll must not mistake 'slow' for 'gone' — long generations are
        normal, and cancelling them would be a far worse bug than the one fixed.

        Asserted by letting it poll many times and checking it is STILL running.
        (Wrapping it in wait_for would prove nothing: a wait_for timeout is the
        caller giving up, and the cleanup correctly cancels upstream then — which
        is how the first version of this test fooled itself.)
        """
        client = _Client("never")
        _set_probe(False)

        async def run():
            task = asyncio.ensure_future(proxy._post_watching_client(client, "u", {}, {}))
            await asyncio.sleep(0.4)  # ~8 poll intervals
            still_running = not task.done()
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):
                pass
            return still_running

        self.assertTrue(asyncio.run(run()), "a live-but-slow turn was ended early")

    def test_poll_interval_has_a_floor(self):
        """A zero/negative interval would spin the event loop."""
        self.assertGreaterEqual(proxy.PROXY_DISCONNECT_POLL_SECS, 0.0)
        mod = _load_proxy()
        self.assertGreaterEqual(mod.PROXY_DISCONNECT_POLL_SECS, 0.5)


if __name__ == "__main__":
    unittest.main()
