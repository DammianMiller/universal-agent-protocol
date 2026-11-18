#!/usr/bin/env python3
"""Session-admission control: cap the number of DISTINCT hot sessions to <= the
slot count so they don't evict each other's KV.

The per-request semaphore limits CONCURRENT REQUESTS; admission limits DISTINCT
SESSIONS. A new session over the limit queues until an admitted session goes
idle (TTL) and is pruned, instead of barging in and evicting a hot session
(every eviction = a full reprocess on the SSM model). Admission is sticky across
a session's turns; on a wait-timeout it force-admits (graceful degrade).

The synchronous core `_try_admit_session` / `_prune_idle_admissions` is pure
given `now`, so it's tested directly. The async wrapper is tested for the
no-op-when-disabled and force-admit-on-timeout paths.
"""

import asyncio
import importlib.util
import unittest
from pathlib import Path


def _load():
    p = Path(__file__).resolve().parents[1] / "scripts" / "anthropic_proxy.py"
    spec = importlib.util.spec_from_file_location("anthropic_proxy", p)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


proxy = _load()


class TestAdmissionCore(unittest.TestCase):
    def setUp(self):
        proxy._admitted_sessions.clear()
        proxy.PROXY_SESSION_ADMISSION_LIMIT = 2
        proxy.PROXY_SESSION_ADMISSION_IDLE_TTL = 90.0

    def test_admit_up_to_limit_then_full(self):
        self.assertTrue(proxy._try_admit_session("s1", now=0))
        self.assertTrue(proxy._try_admit_session("s2", now=1))
        # 3rd distinct session: hot set full -> rejected
        self.assertFalse(proxy._try_admit_session("s3", now=2))
        self.assertEqual(set(proxy._admitted_sessions), {"s1", "s2"})

    def test_already_hot_session_refreshes_and_is_admitted(self):
        proxy._try_admit_session("s1", now=0)
        proxy._try_admit_session("s2", now=1)
        # s1 returns — must stay admitted (no eviction of itself) and refresh ts
        self.assertTrue(proxy._try_admit_session("s1", now=50))
        self.assertEqual(proxy._admitted_sessions["s1"], 50)

    def test_idle_session_pruned_after_ttl_frees_a_slot(self):
        proxy._try_admit_session("s1", now=0)
        proxy._try_admit_session("s2", now=1)
        self.assertFalse(proxy._try_admit_session("s3", now=2))  # full
        # advance past TTL: s1 (ts0) and s2 (ts1) are now idle > 90s -> pruned,
        # s3 admits into the freed slot
        self.assertTrue(proxy._try_admit_session("s3", now=200))
        self.assertIn("s3", proxy._admitted_sessions)
        self.assertNotIn("s1", proxy._admitted_sessions)

    def test_zero_ttl_disables_idle_pruning(self):
        proxy.PROXY_SESSION_ADMISSION_IDLE_TTL = 0.0
        proxy._try_admit_session("s1", now=0)
        proxy._try_admit_session("s2", now=1)
        # even far in the future, no idle prune -> s3 stays blocked
        self.assertFalse(proxy._try_admit_session("s3", now=10_000))

    def test_lru_is_front_of_ordereddict(self):
        proxy._try_admit_session("s1", now=0)
        proxy._try_admit_session("s2", now=1)
        proxy._try_admit_session("s1", now=5)  # refresh moves s1 to back
        # s2 is now the LRU (front) -> first to be force-evicted
        self.assertEqual(next(iter(proxy._admitted_sessions)), "s2")


class TestAdmissionAsync(unittest.TestCase):
    def setUp(self):
        proxy._admitted_sessions.clear()
        proxy._admission_cond = None

    def test_noop_when_disabled(self):
        proxy.PROXY_SESSION_ADMISSION = False
        asyncio.run(proxy._ensure_session_admitted("anything"))
        self.assertEqual(len(proxy._admitted_sessions), 0)  # never tracked

    def test_noop_when_no_session_id(self):
        proxy.PROXY_SESSION_ADMISSION = True
        asyncio.run(proxy._ensure_session_admitted(None))
        self.assertEqual(len(proxy._admitted_sessions), 0)

    def test_admits_when_room(self):
        proxy.PROXY_SESSION_ADMISSION = True
        proxy.PROXY_SESSION_ADMISSION_LIMIT = 2
        asyncio.run(proxy._ensure_session_admitted("s1"))
        self.assertIn("s1", proxy._admitted_sessions)

    def test_force_admit_on_wait_timeout(self):
        # Over-subscribed + no idle prune + ~0 wait timeout -> force-admit,
        # evicting the LRU (graceful degrade, never hard-stalls).
        proxy.PROXY_SESSION_ADMISSION = True
        proxy.PROXY_SESSION_ADMISSION_LIMIT = 1
        proxy.PROXY_SESSION_ADMISSION_IDLE_TTL = 0.0   # never prune
        proxy.PROXY_SESSION_ADMISSION_WAIT_TIMEOUT = 0.01
        proxy.PROXY_SESSION_ADMISSION_POLL = 0.01

        async def run():
            await proxy._ensure_session_admitted("hot")     # fills the 1 slot
            await proxy._ensure_session_admitted("waiter")  # times out -> force
        asyncio.run(run())
        self.assertIn("waiter", proxy._admitted_sessions)
        self.assertNotIn("hot", proxy._admitted_sessions)   # LRU evicted


class TestAdmissionFairness(unittest.TestCase):
    """2026-11-16 guard: a session with a LIVE request is never the victim.

    The LRU is ordered by last-request-arrival, so a mid-turn session sits at
    the eviction front BY CONSTRUCTION. Under over-subscription, force-admits
    evicted exactly those sessions seconds after admission (zero turn progress
    while 4 deliver sessions cycled the single hot slot — live-observed
    2026-11-16 10:29-10:34). These cases pin the victim-selection contract:
    busy sessions are skipped, the oldest IDLE session is preferred, and only
    an all-busy hot set falls back to the plain LRU front.
    """

    def setUp(self):
        proxy._admitted_sessions.clear()
        proxy._admitted_busy.clear()
        proxy._admission_cond = None
        proxy.PROXY_SESSION_ADMISSION = True
        proxy.PROXY_SESSION_ADMISSION_LIMIT = 2
        proxy.PROXY_SESSION_ADMISSION_IDLE_TTL = 0.0        # never idle-prune
        proxy.PROXY_SESSION_ADMISSION_WAIT_TIMEOUT = 0.01   # force-admit fast
        proxy.PROXY_SESSION_ADMISSION_POLL = 0.01

    def tearDown(self):
        proxy._admitted_sessions.clear()
        proxy._admitted_busy.clear()

    def _force_admit(self, waiter):
        asyncio.run(proxy._ensure_session_admitted(waiter))

    def test_busy_session_is_never_the_victim(self):
        # Two admitted sessions; s1 is OLDER (LRU front) but has a live
        # request. The force-admit MUST take the idle s2 instead.
        proxy._admitted_sessions["s1"] = 100.0
        proxy._admitted_sessions["s2"] = 110.0
        proxy._mark_admitted_busy("s1")
        self._force_admit("s3")
        self.assertIn("s1", proxy._admitted_sessions)   # protected
        self.assertNotIn("s2", proxy._admitted_sessions)  # idle victim taken
        self.assertIn("s3", proxy._admitted_sessions)

    def test_oldest_idle_session_is_preferred_victim(self):
        # Both idle: the OLDER one (s1, admitted first) is the victim.
        proxy._admitted_sessions["s1"] = 100.0
        proxy._admitted_sessions["s2"] = 110.0
        self._force_admit("s3")
        self.assertNotIn("s1", proxy._admitted_sessions)
        self.assertIn("s2", proxy._admitted_sessions)

    def test_older_idle_beats_newer_even_when_front_is_busy(self):
        # Front (s1) is busy, so the next-oldest IDLE session (s2) goes —
        # NOT the LRU front, and not the busy one.
        proxy._admitted_sessions["s1"] = 100.0
        proxy._admitted_sessions["s2"] = 110.0
        proxy._admitted_sessions["s3"] = 120.0
        proxy._mark_admitted_busy("s1")
        self._force_admit("s4")
        self.assertIn("s1", proxy._admitted_sessions)
        self.assertNotIn("s2", proxy._admitted_sessions)
        self.assertIn("s3", proxy._admitted_sessions)

    def test_all_busy_falls_back_to_plain_lru_front(self):
        # No idle victim exists: take the LRU front anyway so the waiter
        # still makes progress (bounded by its generation timeout).
        proxy._admitted_sessions["s1"] = 100.0
        proxy._admitted_sessions["s2"] = 110.0
        proxy._mark_admitted_busy("s1")
        proxy._mark_admitted_busy("s2")
        self._force_admit("s3")
        self.assertNotIn("s1", proxy._admitted_sessions)  # LRU front taken
        self.assertIn("s2", proxy._admitted_sessions)

    def test_admission_success_marks_the_session_busy(self):
        # The waiter that gets in is protected from the NEXT waiter's
        # force-admit for the life of its turn.
        proxy._admitted_sessions["s1"] = 100.0
        self._force_admit("s2")
        self.assertEqual(proxy._admitted_busy.get("s2"), 1)

    def test_busy_holds_are_counted_and_released(self):
        # One session, several concurrent funnel frames: mark/mark, then
        # release both — the busy entry is forgotten at zero, never negative.
        proxy._mark_admitted_busy("s1")
        proxy._mark_admitted_busy("s1")
        self.assertEqual(proxy._admitted_busy["s1"], 2)
        proxy._release_admitted_busy("s1")
        self.assertEqual(proxy._admitted_busy["s1"], 1)
        proxy._release_admitted_busy("s1")
        self.assertNotIn("s1", proxy._admitted_busy)
        # A release past zero (defensive) must not create a negative count.
        proxy._release_admitted_busy("s1")
        self.assertNotIn("s1", proxy._admitted_busy)
        # None session ids are no-ops on both sides.
        proxy._mark_admitted_busy(None)
        proxy._release_admitted_busy(None)
        self.assertEqual(proxy._admitted_busy, {})

    def test_try_admit_ignores_busy_state(self):
        # The synchronous core stays PURE: busy-holds only steer the
        # force-evict victim, never admission itself.
        proxy._mark_admitted_busy("s1")
        self.assertTrue(proxy._try_admit_session("s1", now=0))
        self.assertTrue(proxy._try_admit_session("s2", now=1))
        self.assertFalse(proxy._try_admit_session("s3", now=2))


if __name__ == "__main__":
    unittest.main()
