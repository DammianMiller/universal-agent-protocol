#!/usr/bin/env python3
"""Compaction forcing must be computed against the SESSION's window, not the rail.

Regression (2026-09-20). The local server moved to `-np 2 -c 229376` with
`--kv-unified`, which makes 229376 a SHARED pool: /slots reports it for both
slots and either rail may address all of it. Sessions are therefore capped
below the detected rail by a model profile's `context_window`.

`_count_tokens_scale()` resolved its window from `_effective_context_window()`
— the process-wide value detected from /slots — so the two numbers disagreed
and only one of them actually bounded the session:

    detected rail   229376
    profile cap     114688   <- the real bound
    compact fires   123060   computed from the RAIL, so ABOVE the cap
    prune fires      80282   computed from the CAP

Compaction became unreachable and the pruner permanently replaced it. Those
are not equivalent: compaction writes an LLM summary, a prune drops the
messages and leaves a breadcrumb list. The proxy env's own comment states the
intent — "land compaction just under the pruner trigger so the client compacts
before the proxy ever prunes (pruner = backstop only)".
"""

import importlib.util
import unittest
from pathlib import Path


def _load_proxy_module():
    proxy_path = Path(__file__).resolve().parents[1] / "scripts" / "anthropic_proxy.py"
    spec = importlib.util.spec_from_file_location("anthropic_proxy", proxy_path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


PROXY = _load_proxy_module()

# The live geometry this regression came from.
SHARED_POOL = 229_376
SESSION_CAP = 114_688


class CountTokensScalePerSession(unittest.TestCase):
    def setUp(self):
        self._saved = (
            PROXY.PROXY_COUNT_TOKENS_SCALE,
            PROXY.PROXY_CLIENT_ASSUMED_WINDOW,
            PROXY.PROXY_COMPACT_TARGET_FRACTION,
            PROXY.default_context_window,
        )
        PROXY.PROXY_COUNT_TOKENS_SCALE = "auto"
        PROXY.PROXY_CLIENT_ASSUMED_WINDOW = 200_000
        PROXY.PROXY_COMPACT_TARGET_FRACTION = 0.58
        # The process default is the whole shared pool, as /slots reports it.
        PROXY.default_context_window = SHARED_POOL

    def tearDown(self):
        (
            PROXY.PROXY_COUNT_TOKENS_SCALE,
            PROXY.PROXY_CLIENT_ASSUMED_WINDOW,
            PROXY.PROXY_COMPACT_TARGET_FRACTION,
            PROXY.default_context_window,
        ) = self._saved
        PROXY.session_monitors.clear()

    def _compact_trigger(self, scale: float) -> float:
        """Real tokens at which the client's auto-compact fires."""
        return PROXY.PROXY_CLIENT_ASSUMED_WINDOW * 0.925 / scale

    def test_override_uses_the_session_window_not_the_pool(self):
        scale = PROXY._count_tokens_scale(SESSION_CAP)
        pool_scale = PROXY._count_tokens_scale(0)
        self.assertGreater(
            scale, pool_scale,
            "a capped session must be scaled harder than the shared pool",
        )

    def test_compaction_fires_before_the_pruner_for_a_capped_session(self):
        """The whole point: compact must precede prune, or prune is all there is."""
        scale = PROXY._count_tokens_scale(SESSION_CAP)
        compact_at = self._compact_trigger(scale)
        prune_at = SESSION_CAP * PROXY.PROXY_CONTEXT_PRUNE_THRESHOLD
        self.assertLess(
            compact_at, prune_at,
            f"compaction at {compact_at:,.0f} must fire before the pruner at "
            f"{prune_at:,.0f}; the pruner is a backstop, not the mechanism",
        )

    def test_the_unfixed_behaviour_would_be_unreachable(self):
        """Pin the bug itself, so a revert to the pool-wide window is loud."""
        pool_scale = PROXY._count_tokens_scale(0)   # resolves the shared pool
        compact_at = self._compact_trigger(pool_scale)
        self.assertGreater(
            compact_at, SESSION_CAP,
            "sanity: computed from the pool, the compact point IS above the "
            "session cap — this is the condition the fix exists to avoid",
        )

    def test_session_window_is_picked_up_from_the_request_contextvar(self):
        """Paths with no explicit override still resolve the session's window."""
        sid = "test-session-capped"
        monitor = PROXY.SessionMonitor(context_window=SESSION_CAP)
        PROXY.session_monitors[sid] = monitor
        token = PROXY._current_request_session.set(sid)
        try:
            self.assertEqual(PROXY._scale_window(), SESSION_CAP)
            scale = PROXY._count_tokens_scale()
            compact_at = self._compact_trigger(scale)
            self.assertLess(compact_at, SESSION_CAP * PROXY.PROXY_CONTEXT_PRUNE_THRESHOLD)
        finally:
            PROXY._current_request_session.reset(token)

    def test_falls_back_to_the_process_window_with_no_session(self):
        PROXY.session_monitors.clear()
        self.assertEqual(PROXY._scale_window(), SHARED_POOL)

    def test_scale_stays_disabled_when_turned_off(self):
        PROXY.PROXY_COUNT_TOKENS_SCALE = "off"
        self.assertEqual(PROXY._count_tokens_scale(SESSION_CAP), 1.0)


if __name__ == "__main__":
    unittest.main()
