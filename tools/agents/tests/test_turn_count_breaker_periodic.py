#!/usr/bin/env python3
"""The TURN-COUNT FINALIZE BREAKER must fire PERIODICALLY, not on every turn once
the ceiling is first crossed.

`_count_agent_tool_turns` is derived from the (only-growing) conversation, so the
naive `count >= ceiling` check re-fires on every request past the first crossing —
permanently stripping tools and stalling a legitimately long agentic task (observed
live: msgs 206→208→…→214, breaker every turn, then the client gives up). Gating on
`count >= last_hard_finalize_turn_count + ceiling` makes it fire at ceiling, 2x,
3x… with tools restored in between.
"""

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
CEILING = 80


def _fire_turns(counts):
    """Replay the breaker's gating decision (as in build_openai_request) over a
    sequence of cumulative tool-turn counts; return the counts at which it fired."""
    m = proxy.SessionMonitor(context_window=100000)
    fired = []
    for count in counts:
        if count >= m.last_hard_finalize_turn_count + CEILING:
            m.last_hard_finalize_turn_count = count
            fired.append(count)
    return fired


class TestTurnCountBreakerPeriodic(unittest.TestCase):
    def test_monitor_has_the_field_defaulting_zero(self):
        m = proxy.SessionMonitor(context_window=100000)
        self.assertEqual(m.last_hard_finalize_turn_count, 0)

    def test_fires_periodically_not_every_turn(self):
        # cumulative tool turns 1..244 (grows by 1 each request)
        fired = _fire_turns(range(1, 245))
        # periodic at the ceiling multiples — NOT every turn past 80
        self.assertEqual(fired, [80, 160, 240])

    def test_does_not_refire_between_crossings(self):
        # turns 80..159 -> fires once at 80, then silent until 160
        fired = _fire_turns(range(80, 160))
        self.assertEqual(fired, [80])

    def test_first_fire_at_ceiling(self):
        self.assertEqual(_fire_turns(range(1, 81)), [80])
        self.assertEqual(_fire_turns(range(1, 80)), [])  # never reaches ceiling


if __name__ == "__main__":
    unittest.main()
