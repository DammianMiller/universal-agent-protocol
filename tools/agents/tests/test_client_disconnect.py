#!/usr/bin/env python3
"""The proxy must abandon a turn when the downstream client disconnects.

Nothing used to ask whether the caller was still there. Once a turn was
accepted, the guardrail loops kept retrying and re-POSTing upstream on their
own — so when the client died the work carried on regardless. Observed live
(2026-07-29): two `uap deliver` runs were killed, no socket remained on :4000,
and the proxy still drove llama for minutes, generating ~32k tokens per
orphaned turn that nobody would ever read. Only a proxy restart stopped it.
"""

import asyncio
import importlib.util
import unittest
from pathlib import Path


def _load_proxy():
    p = Path(__file__).resolve().parents[1] / "scripts" / "anthropic_proxy.py"
    spec = importlib.util.spec_from_file_location("anthropic_proxy_disc", p)
    assert spec is not None and spec.loader is not None
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


proxy = _load_proxy()


class ClientGoneProbeTest(unittest.TestCase):
    def test_absent_probe_means_client_is_present(self):
        """No probe set (background task, test harness) must not read as gone —
        that would abandon perfectly live turns."""
        proxy._current_client_gone.set(None)
        self.assertFalse(asyncio.run(proxy._client_gone()))

    def test_reports_disconnect(self):
        async def gone() -> bool:
            return True

        proxy._current_client_gone.set(gone)
        self.assertTrue(asyncio.run(proxy._client_gone()))

    def test_reports_connected(self):
        async def here() -> bool:
            return False

        proxy._current_client_gone.set(here)
        self.assertFalse(asyncio.run(proxy._client_gone()))

    def test_a_failing_probe_never_breaks_the_request(self):
        """This check sits in front of every upstream call. A probe that can
        raise would be worse than no probe, so failure means 'still there'."""
        async def broken() -> bool:
            raise RuntimeError("receive channel exploded")

        proxy._current_client_gone.set(broken)
        self.assertFalse(asyncio.run(proxy._client_gone()))


class ClientGoneIsNotSwallowedTest(unittest.TestCase):
    """The unwind only works if no broad handler eats it on the way out.

    `messages()` has eight `except Exception` blocks. Any one of them catching
    ClientGoneError would turn "client left" into a logged error and let the
    turn continue — silently reinstating the bug while every other test passed.
    """

    def test_every_broad_except_in_messages_reraises_first(self):
        src = (
            Path(__file__).resolve().parents[1] / "scripts" / "anthropic_proxy.py"
        ).read_text().split("\n")
        start = next(i for i, l in enumerate(src) if l.startswith("async def messages(request: Request)"))
        end = next(
            (i for i in range(start + 1, len(src)) if src[i].startswith("async def ") or src[i].startswith("@app.")),
            len(src),
        )

        unguarded = []
        for i in range(start, end):
            stripped = src[i].lstrip()
            if not stripped.startswith("except Exception") and not stripped.startswith("except BaseException"):
                continue
            # The two lines above must be the ClientGoneError re-raise.
            prev = [src[i - 2].strip(), src[i - 1].strip()] if i >= 2 else []
            if prev[:1] != ["except ClientGoneError:"] or prev[1:] and not prev[1].startswith("raise"):
                unguarded.append((i + 1, stripped[:60]))

        self.assertEqual(unguarded, [], f"broad handlers that would swallow the disconnect: {unguarded}")

    def test_client_gone_is_an_exception_so_fastapi_can_handle_it(self):
        """Deliberately NOT a BaseException: Starlette's middleware only
        dispatches Exception subclasses, so a BaseException would sail past the
        registered handler and take down the worker instead of answering 499."""
        self.assertTrue(issubclass(proxy.ClientGoneError, Exception))


if __name__ == "__main__":
    unittest.main()
