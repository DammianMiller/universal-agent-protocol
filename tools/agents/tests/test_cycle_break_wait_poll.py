"""A tool that BLOCKS on a long job must not be loop-broken for repeating.

Incident (2026-08-17): an agent was following a healthy `deliver` run — heartbeat
8s old, run checkpoint advancing, genuinely compiling a Rust crate. `deliver` in
follow mode blocks up to its wait budget and returns "still running", so the
correct behaviour is to call it again; every poll therefore carries identical
arguments and an identical fingerprint.

Three separate guards read those repeats as a spin:

  1. should_force_stuck_break  — fires FIRST, at 4 identical calls, judged on
     the fingerprint alone, and injects "STOP ... do NOT repeat it".
  2. the cycle path            — enters review, increments review cycles, and
     at the review-cycle limit forces a "wrap up" finalize turn.
  3. cycle-break narrowing     — excluded the deliver tool outright, after which
     the agent could no longer observe the work it was waiting on and fell
     through to Bash, cycling on THAT instead. Median turn spacing collapsed
     from the 45s poll interval to 5s.

Unlike a cycling Bash ("vary the command"), there is no different argument to
vary toward: the job is simply not finished yet. The wait is bounded by the job.
"""
import importlib.util
import os
import unittest
from pathlib import Path

proxy_path = Path(__file__).resolve().parents[1] / "scripts" / "anthropic_proxy.py"


def load_proxy(wait_tools=None):
    # Explicit, so a project .uap/proxy.env cannot inject PROXY_WAIT_POLL_TOOLS
    # and silently invalidate the default-list assertions when this module is
    # run directly rather than through the npm script.
    os.environ["UAP_PROXY_ENV_AUTOLOAD"] = "0"
    if wait_tools is None:
        os.environ.pop("PROXY_WAIT_POLL_TOOLS", None)
    else:
        os.environ["PROXY_WAIT_POLL_TOOLS"] = wait_tools
    spec = importlib.util.spec_from_file_location("anthropic_proxy_waitpoll", proxy_path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def tool(name):
    return {"type": "function", "function": {"name": name, "parameters": {}}}


# The toolset from the live incident, trimmed to the relevant members.
TOOLS = [tool(n) for n in ("uap-router_deliver", "bash", "read", "edit", "glob")]


_PRIOR_AUTOLOAD = os.environ.get("UAP_PROXY_ENV_AUTOLOAD")


def tearDownModule():
    # Restore rather than leak into any module loaded later in this process —
    # cross-test env leakage from files like this one has caused
    # order-dependent failures before.
    if _PRIOR_AUTOLOAD is None:
        os.environ.pop("UAP_PROXY_ENV_AUTOLOAD", None)
    else:
        os.environ["UAP_PROXY_ENV_AUTOLOAD"] = _PRIOR_AUTOLOAD


class _Base(unittest.TestCase):
    def tearDown(self):
        os.environ.pop("PROXY_WAIT_POLL_TOOLS", None)

    @staticmethod
    def _names(tools):
        return [t["function"]["name"] for t in tools]


class WaitPollNotNarrowedTest(_Base):
    def test_the_polled_tool_survives_the_cycle_break(self):
        ap = load_proxy()
        narrowed, _ = ap._narrow_tools_for_cycle_break(TOOLS, ["uap-router_deliver"], [])
        self.assertIn("uap-router_deliver", self._names(narrowed))

    def test_a_genuinely_spinning_tool_is_still_narrowed(self):
        ap = load_proxy()
        narrowed, _ = ap._narrow_tools_for_cycle_break(TOOLS, ["edit"], [])
        self.assertNotIn("edit", self._names(narrowed))

    def test_matching_is_exact_not_substring(self):
        # A tool whose name merely CONTAINS an exempt name must still be
        # narrowed — otherwise the exemption silently widens to anything
        # someone names "deliver_report".
        ap = load_proxy()
        tools = [tool("deliver_report"), tool("bash"), tool("edit")]
        narrowed, _ = ap._narrow_tools_for_cycle_break(tools, ["deliver_report"], [])
        self.assertNotIn("deliver_report", self._names(narrowed))

    def test_the_polled_tool_is_never_auto_banned(self):
        ap = load_proxy()
        self.assertFalse(ap._should_auto_ban("uap-router_deliver", cycle_count=99, ban_at=3))
        self.assertTrue(ap._should_auto_ban("edit", cycle_count=99, ban_at=3))

    def test_an_explicit_session_ban_is_still_honoured(self):
        ap = load_proxy()
        narrowed, _ = ap._narrow_tools_for_cycle_break(TOOLS, [], ["uap-router_deliver"])
        self.assertNotIn("uap-router_deliver", self._names(narrowed))

    def test_the_set_is_configurable(self):
        ap = load_proxy(wait_tools="my_wait_tool")
        self.assertIn("my_wait_tool", ap._WAIT_POLL_TOOLS)
        narrowed, _ = ap._narrow_tools_for_cycle_break(
            [tool("my_wait_tool"), tool("edit")], ["my_wait_tool"], []
        )
        self.assertIn("my_wait_tool", self._names(narrowed))

    def test_matching_is_case_insensitive(self):
        ap = load_proxy()
        narrowed, _ = ap._narrow_tools_for_cycle_break(
            [tool("UAP-Router_Deliver"), tool("edit")], ["UAP-Router_Deliver"], []
        )
        self.assertIn("UAP-Router_Deliver", self._names(narrowed))

    def test_exploration_hatch_still_exempt(self):
        ap = load_proxy()
        narrowed, _ = ap._narrow_tools_for_cycle_break(TOOLS, ["bash"], [])
        self.assertIn("bash", self._names(narrowed))


class DeliverWireNamesTest(_Base):
    def test_both_mcp_config_keys_are_covered(self):
        # Names arrive prefixed with the MCP server's CONFIG KEY, and this repo
        # ships two: `uap-router` (.mcp.json / opencode.json) and `router`
        # (setup-mcp-router.ts, used by `uap setup`). Covering one exempts only
        # half the fleet.
        ap = load_proxy()
        for name in ("uap-router_deliver", "mcp__uap-router__deliver",
                     "router_deliver", "mcp__router__deliver", "deliver"):
            self.assertIn(name, ap._WAIT_POLL_TOOLS, name)

    def test_deliver_counts_as_a_write_under_every_wire_name(self):
        # _WRITE_TOOL_CLASS with only the bare name let the no-write streak
        # climb through a healthy delivery, escalating recon-convergence
        # mid-wait ("write your deliverable now") while the deliverable was
        # being written by the run being waited on.
        ap = load_proxy()
        for name in ap._DELIVER_TOOL_NAMES:
            self.assertIn(name, ap._WRITE_TOOL_CLASS, name)

    def test_wait_poll_and_write_classes_deliberately_overlap(self):
        # Other tool classes in this module are pairwise disjoint; this pair is
        # not, and the intent is pinned here rather than left implicit.
        ap = load_proxy()
        self.assertTrue(ap._WAIT_POLL_TOOLS & ap._WRITE_TOOL_CLASS)


class StuckBreakTest(_Base):
    """The guard that fires FIRST — 4 identical calls, outcome-blind."""

    @staticmethod
    def _monitor(ap, history):
        m = ap.SessionMonitor(context_window=131072)
        m.tool_call_history = list(history)
        return m

    def test_a_healthy_poll_does_not_force_a_stuck_break(self):
        ap = load_proxy()
        m = self._monitor(ap, ["uap-router_deliver:abc"] * 8)
        forced, reason = m.should_force_stuck_break()
        self.assertFalse(forced, reason)

    def test_a_genuinely_repeated_call_still_forces_a_break(self):
        # The 44-turn `git diff --stat` loop this guard exists for.
        ap = load_proxy()
        m = self._monitor(ap, ["bash:diffstat"] * 8)
        forced, _ = m.should_force_stuck_break()
        self.assertTrue(forced)

    def test_a_wait_mixed_with_a_spin_still_breaks(self):
        # all-not-any: a turn calling deliver alongside a spinning tool is
        # still a spin and must stay breakable.
        ap = load_proxy()
        m = self._monitor(ap, ["uap-router_deliver:abc|bash:x"] * 8)
        forced, _ = m.should_force_stuck_break()
        self.assertTrue(forced)


class StateMachineEndToEndTest(_Base):
    """Drive real polls through the state machine — the test that catches the
    guard the helper-level tests miss.

    The first cut of this fix exempted narrowing, the stuck-break and the cycle
    trip, and STILL force-finalized a healthy wait: the stagnation signal is
    keyed on repeats (`latest_fingerprint == last_fingerprint`) and its only
    reset needs a turn WITHOUT a tool_result, which a poll always has. It
    climbed one per poll, entered review at 9, and hit the review-cycle limit at
    16 with "wrap up ... what is blocking further progress" — mid-build.
    """

    FP = "uap-router_deliver:abc"

    @staticmethod
    def _poll(ap, monitor, fingerprint, msgs):
        """One agent turn: record the call, then run the state machine.

        `msgs` GROWS across turns. A constant-length message list reads as a
        compaction boundary ("message count collapsed"), which resets all
        anti-spin state every turn and would make this harness silently prove
        nothing.
        """
        monitor.record_tool_calls(["deliver"], fingerprint=fingerprint)
        ap._update_tool_state_stagnation(
            monitor, latest_tool_fingerprint=fingerprint, last_user_has_tool_result=True
        )
        msgs.append({"role": "assistant", "content": "calling"})
        msgs.append({"role": "user", "content": "STILL RUNNING"})
        body = {"messages": list(msgs), "tools": [tool("uap-router_deliver")]}
        # A poll always carries the previous poll's "still running" tool_result,
        # which is precisely why the stagnation reset never fires for it.
        return ap._resolve_state_machine_tool_choice(
            body, monitor, has_tool_results=True, last_user_has_tool_result=True
        )

    def test_a_healthy_wait_is_never_force_finalized(self):
        ap = load_proxy()
        m = ap.SessionMonitor(context_window=131072)
        msgs = [{"role": "user", "content": "start"}]
        for i in range(30):
            self._poll(ap, m, self.FP, msgs)
            self.assertNotEqual(
                m.tool_turn_phase, "finalize",
                f"forced a finalize on poll {i + 1} of a healthy wait",
            )
        self.assertEqual(m.tool_state_stagnation_streak, 0)
        self.assertEqual(m.tool_state_review_cycles, 0)

    def test_a_wedged_job_is_still_bounded(self):
        # The exemption is call-side and outcome-blind, so it MUST be capped:
        # a dead run polled forever would otherwise be bounded only by the
        # client's own timeout.
        ap = load_proxy()
        ap.PROXY_WAIT_POLL_MAX_STREAK = 5
        m = ap.SessionMonitor(context_window=131072)
        msgs = [{"role": "user", "content": "start"}]
        for _ in range(40):
            self._poll(ap, m, self.FP, msgs)
        self.assertGreater(
            m.tool_state_stagnation_streak, 0,
            "past the cap the normal guards must resume",
        )

    def test_a_real_spin_still_stagnates(self):
        ap = load_proxy()
        m = ap.SessionMonitor(context_window=131072)
        msgs = [{"role": "user", "content": "start"}]
        for _ in range(10):
            self._poll(ap, m, "bash:samecmd", msgs)
        self.assertGreater(m.tool_state_stagnation_streak, 0)

    def test_the_streak_resets_when_the_agent_does_something_else(self):
        ap = load_proxy()
        m = ap.SessionMonitor(context_window=131072)
        msgs = [{"role": "user", "content": "start"}]
        for _ in range(5):
            self._poll(ap, m, self.FP, msgs)
        self.assertEqual(m.wait_poll_streak, 5)
        self._poll(ap, m, "edit:file", msgs)
        self.assertEqual(m.wait_poll_streak, 0)


class HelperTest(_Base):
    def test_fingerprint_names_are_unpacked(self):
        ap = load_proxy()
        self.assertEqual(
            ap._fingerprint_tool_names("uap-router_deliver:abc123|bash:def"),
            {"uap-router_deliver", "bash"},
        )

    def test_is_wait_poll_only_requires_all(self):
        ap = load_proxy()
        self.assertTrue(ap._is_wait_poll_only({"uap-router_deliver"}))
        self.assertFalse(ap._is_wait_poll_only({"uap-router_deliver", "bash"}))
        self.assertFalse(ap._is_wait_poll_only(set()))

    def test_hint_names_drop_wait_tools_but_keep_spinners(self):
        # The load-bearing mixed case: the hint must still fire, naming only
        # the tool that is actually spinning.
        ap = load_proxy()
        self.assertEqual(
            ap._spinning_cycling_names(["uap-router_deliver", "read"]), ["read"]
        )
        self.assertEqual(ap._spinning_cycling_names(["uap-router_deliver"]), [])


if __name__ == "__main__":
    unittest.main()
