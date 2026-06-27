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


if __name__ == "__main__":
    unittest.main()
