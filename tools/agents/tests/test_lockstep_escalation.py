#!/usr/bin/env python3
"""LOCKSTEP ESCALATION guardrail: the SAME tool call failing with the SAME
error, over and over. The older guards split this case against themselves --
DOUBLING-DOWN yielded to ERROR-LOOP, whose re-read remedy assumes a failing
file and is wrong for tool-misuse loops (observed live 2026-09-25: one ssh
call re-issued 27 times before the hard stop). Lockstep owns the case with a
decisive ladder: pivot directive -> final warning -> hard stop + a JSONL
loop-incident record for `uap loops`.
"""
import importlib.util
import json
import os
import tempfile
import unittest
from pathlib import Path


def _load_proxy_module():
    proxy_path = Path(__file__).resolve().parents[1] / "scripts" / "anthropic_proxy.py"
    spec = importlib.util.spec_from_file_location("anthropic_proxy", proxy_path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


proxy = _load_proxy_module()

# Built through the production fingerprinter so the tests pin the format the
# ledger actually sees ("name:md5[:8]"), not a hand-rolled stand-in.
FP = proxy._tool_call_fingerprint(
    {"name": "bash", "input": {"command": 'ssh host "docker exec c python3 -c ..."'}}
)
ERR = "Traceback (most recent call last):\n  File \"<string>\", line 3\nKeyError: 'x'"


def _drive_lockstep(monitor, n):
    """Feed n consecutive identical-failing-call observations, the way the
    request path feeds both trackers each turn."""
    for i in range(n):
        monitor.note_tool_result_error(ERR)
        monitor.note_doubling_signal(FP, ERR, msg_count=100 + i, result_error=True)


class LockstepKnobGuard(unittest.TestCase):
    """Module globals are read at call time; restore whatever a test patches."""

    def setUp(self):
        self._saved = {
            name: getattr(proxy, name)
            for name in (
                "PROXY_LOCKSTEP_BREAK",
                "PROXY_LOCKSTEP_PIVOT_AT",
                "PROXY_LOCKSTEP_HARD_AT",
                "UAP_LOOP_INCIDENTS",
            )
        }
        self._tmp = tempfile.TemporaryDirectory()
        proxy.UAP_LOOP_INCIDENTS = os.path.join(self._tmp.name, "incidents.jsonl")

    def tearDown(self):
        for name, value in self._saved.items():
            setattr(proxy, name, value)
        self._tmp.cleanup()

    def _records(self):
        if not os.path.exists(proxy.UAP_LOOP_INCIDENTS):
            return []
        with open(proxy.UAP_LOOP_INCIDENTS, encoding="utf-8") as fh:
            return [json.loads(line) for line in fh if line.strip()]


class StreakMathTests(LockstepKnobGuard):
    def test_single_signal_does_not_arm(self):
        m = proxy.SessionMonitor()
        for _ in range(4):
            m.note_tool_result_error(ERR)
        self.assertEqual(proxy._lockstep_streak(m), 0)  # error only
        m2 = proxy.SessionMonitor()
        for i in range(4):
            m2.note_doubling_signal(FP, ERR, msg_count=i, result_error=True)
        self.assertEqual(proxy._lockstep_streak(m2), 0)  # identical call only

    def test_lockstep_is_the_shallower_streak(self):
        m = proxy.SessionMonitor()
        _drive_lockstep(m, 3)
        self.assertEqual(proxy._lockstep_streak(m), 3)
        # a different error restarts the signature streak at 1 -> the lockstep
        # drops to the shallower side even though the call streak survives
        m.note_tool_result_error("Error: something else entirely\n at y:9")
        self.assertEqual(proxy._lockstep_streak(m), 1)
        # a clean result zeroes the signature side -> lockstep fully broken
        m.note_tool_result_error("ok, all green")
        self.assertEqual(proxy._lockstep_streak(m), 0)

    def test_disabled_globally(self):
        proxy.PROXY_LOCKSTEP_BREAK = False
        m = proxy.SessionMonitor()
        _drive_lockstep(m, 5)
        self.assertEqual(proxy._lockstep_streak(m), 0)
        self.assertFalse(proxy._lockstep_active(m))


class LadderTests(LockstepKnobGuard):
    def _body(self):
        # Ends in a tool result, the way an unattended tool loop looks on the
        # wire; a trailing user-text message is the human re-arm signal.
        return {
            "messages": [
                {"role": "user", "content": "fix it"},
                {"role": "assistant", "content": "retrying"},
                {"role": "tool", "content": ERR},
            ],
            "tool_choice": "auto",
        }

    def test_pivot_directive_at_threshold(self):
        m = proxy.SessionMonitor()
        _drive_lockstep(m, proxy.PROXY_LOCKSTEP_PIVOT_AT)
        body = self._body()
        proxy._maybe_lockstep_escalate(body, m)
        sysmsg = body["messages"][0]
        self.assertEqual(sysmsg["role"], "system")
        self.assertIn("LOOP-ESCALATE", sysmsg["content"])
        self.assertIn("different approaches", sysmsg["content"])
        self.assertEqual(m.lockstep_fires, 1)
        # advisory: tool_choice untouched
        self.assertEqual(body["tool_choice"], "auto")
        recs = self._records()
        self.assertEqual([r["outcome"] for r in recs], ["pivot"])

    def test_final_warning_on_second_fire(self):
        m = proxy.SessionMonitor()
        _drive_lockstep(m, proxy.PROXY_LOCKSTEP_PIVOT_AT)
        proxy._maybe_lockstep_escalate(self._body(), m)
        _drive_lockstep(m, 1)
        body = self._body()
        proxy._maybe_lockstep_escalate(body, m)
        self.assertIn("FINAL WARNING", body["messages"][0]["content"])
        self.assertEqual(m.lockstep_fires, 2)
        self.assertEqual(
            [r["outcome"] for r in self._records()], ["pivot", "final_warning"]
        )

    def test_hard_stop_at_hard_at(self):
        m = proxy.SessionMonitor()
        _drive_lockstep(m, proxy.PROXY_LOCKSTEP_HARD_AT)
        m.lockstep_fires = 2  # both directives already ignored
        with self.assertRaises(proxy.LockstepHardBlock) as ctx:
            proxy._maybe_lockstep_escalate(self._body(), m)
        # the distinct subclass still flows through the single 400 handler
        self.assertIsInstance(ctx.exception, proxy.ErrorLoopHardBlock)
        self.assertIn("LOOP-ESCALATE hard stop", str(ctx.exception))
        self.assertIn("uap loops", str(ctx.exception))
        self.assertEqual(m.lockstep_blocks, 1)
        recs = self._records()
        self.assertEqual(recs[-1]["outcome"], "hard_blocked")
        self.assertEqual(recs[-1]["blocks"], 1)

    def test_hard_stop_requires_ignored_directives(self):
        # streak deep but directives never injected (e.g. knob flipped on
        # mid-loop): escalate through the ladder instead of jumping to a 400.
        m = proxy.SessionMonitor()
        _drive_lockstep(m, proxy.PROXY_LOCKSTEP_HARD_AT + 2)
        body = self._body()
        proxy._maybe_lockstep_escalate(body, m)
        self.assertEqual(m.lockstep_fires, 1)
        self.assertEqual(m.lockstep_blocks, 0)

    def test_resent_transcript_does_not_refire_or_spam_ledger(self):
        # A client retry (5xx / stream abort) resends the SAME trailing
        # transcript: the streak does not advance, so no new directive and no
        # new ledger record.
        m = proxy.SessionMonitor()
        _drive_lockstep(m, proxy.PROXY_LOCKSTEP_PIVOT_AT)
        proxy._maybe_lockstep_escalate(self._body(), m)
        self.assertEqual(m.lockstep_fires, 1)
        proxy._maybe_lockstep_escalate(self._body(), m)  # the retry
        self.assertEqual(m.lockstep_fires, 1)
        self.assertEqual(len(self._records()), 1)

    def test_hard_stop_retry_refuses_without_duplicate_record(self):
        m = proxy.SessionMonitor()
        _drive_lockstep(m, proxy.PROXY_LOCKSTEP_HARD_AT)
        m.lockstep_fires = 2
        m.lockstep_last_fire_streak = proxy.PROXY_LOCKSTEP_HARD_AT - 1
        with self.assertRaises(proxy.ErrorLoopHardBlock):
            proxy._maybe_lockstep_escalate(self._body(), m)
        with self.assertRaises(proxy.ErrorLoopHardBlock):
            proxy._maybe_lockstep_escalate(self._body(), m)  # client retry
        self.assertEqual(m.lockstep_blocks, 2)  # every retry refused
        hard = [r for r in self._records() if r["outcome"] == "hard_blocked"]
        self.assertEqual(len(hard), 1)  # but recorded once

    def test_fresh_user_turn_rearms(self):
        m = proxy.SessionMonitor()
        _drive_lockstep(m, proxy.PROXY_LOCKSTEP_HARD_AT)
        m.lockstep_fires = 2
        m.lockstep_last_fire_streak = proxy.PROXY_LOCKSTEP_HARD_AT
        body = {
            "messages": [
                {"role": "user", "content": "tool result..."},
                {"role": "user", "content": "human stepping in"},
            ]
        }
        proxy._maybe_lockstep_escalate(body, m)  # must NOT raise
        self.assertEqual(m.lockstep_fires, 0)
        self.assertEqual(m.lockstep_last_fire_streak, 0)
        self.assertEqual(m.lockstep_blocks, 0)

    def test_second_loop_climbs_the_full_ladder(self):
        # A resolved loop must not leak its ladder position into the next one:
        # the second loop gets its own pivot and final warning before any stop.
        m = proxy.SessionMonitor()
        _drive_lockstep(m, proxy.PROXY_LOCKSTEP_PIVOT_AT)
        proxy._maybe_lockstep_escalate(self._body(), m)
        _drive_lockstep(m, 1)
        proxy._maybe_lockstep_escalate(self._body(), m)
        self.assertEqual(m.lockstep_fires, 2)
        # loop A resolves: clean result + a different (or no) call
        m.note_tool_result_error("ok, all green")
        m.note_doubling_signal("", "ok, all green", msg_count=900, result_error=False)
        proxy._maybe_lockstep_escalate(self._body(), m)  # streak 0 -> ladder reset
        self.assertEqual(m.lockstep_fires, 0)
        self.assertEqual(m.lockstep_last_fire_streak, 0)
        # loop B (a different failing call) climbs from the pivot tier again
        fp_b = proxy._tool_call_fingerprint(
            {"name": "edit", "input": {"path": "/x.py", "old": "a", "new": "b"}}
        )
        for i in range(proxy.PROXY_LOCKSTEP_PIVOT_AT):
            m.note_tool_result_error("Error: EACCES permission denied\n at x:1")
            m.note_doubling_signal(fp_b, "Error: EACCES", msg_count=1000 + i, result_error=True)
        body = self._body()
        proxy._maybe_lockstep_escalate(body, m)
        self.assertIn("LOOP-ESCALATE", body["messages"][0]["content"])
        self.assertNotIn("FINAL WARNING", body["messages"][0]["content"])
        self.assertEqual(m.lockstep_fires, 1)
        self.assertEqual(
            [r["outcome"] for r in self._records()],
            ["pivot", "final_warning", "pivot"],
        )


class YieldTests(LockstepKnobGuard):
    def test_error_loop_and_doubling_yield_to_lockstep(self):
        m = proxy.SessionMonitor()
        _drive_lockstep(m, max(proxy.PROXY_ERROR_LOOP_THRESHOLD, proxy.PROXY_DOUBLING_THRESHOLD))
        self.assertTrue(proxy._lockstep_active(m))
        body = {"messages": [{"role": "user", "content": "go"}], "tool_choice": "required"}
        proxy._maybe_inject_error_loop_break(body, m)
        proxy._maybe_inject_doubling_break(body, m)
        self.assertEqual(m.error_loop_fires, 0)
        self.assertEqual(m.doubling_break_fires, 0)
        self.assertEqual(len(body["messages"]), 1)  # neither injected

    def test_error_loop_still_fires_off_lockstep(self):
        # varied edits, same error: doubling streak stays 0, so the lockstep
        # never arms and ERROR-LOOP keeps owning this shape.
        m = proxy.SessionMonitor()
        for _ in range(proxy.PROXY_ERROR_LOOP_THRESHOLD):
            m.note_tool_result_error(ERR)
        self.assertFalse(proxy._lockstep_active(m))
        body = {"messages": [{"role": "user", "content": "go"}]}
        proxy._maybe_inject_error_loop_break(body, m)
        self.assertEqual(m.error_loop_fires, 1)


class IncidentRecordTests(LockstepKnobGuard):
    def test_record_shape_and_arg_redaction(self):
        m = proxy.SessionMonitor()
        m.session_id = "sess-123"
        _drive_lockstep(m, proxy.PROXY_LOCKSTEP_PIVOT_AT)
        proxy._maybe_lockstep_escalate(
            {"messages": [{"role": "user", "content": "go"}]}, m
        )
        (rec,) = self._records()
        self.assertEqual(rec["v"], 1)
        self.assertEqual(rec["guard"], "lockstep")
        self.assertEqual(rec["outcome"], "pivot")
        self.assertEqual(rec["session"], "sess-123")
        self.assertEqual(rec["tool"], "bash")
        self.assertTrue(rec["fingerprint"])
        self.assertNotIn(FP, json.dumps(rec))  # raw args never persisted
        self.assertNotIn("ssh host", json.dumps(rec))
        # the persisted signature is the normalized one (literals stripped)
        self.assertIn("traceback", rec["error_signature"])

    def test_ledger_disabled_by_empty_path(self):
        proxy.UAP_LOOP_INCIDENTS = ""
        m = proxy.SessionMonitor()
        _drive_lockstep(m, proxy.PROXY_LOCKSTEP_PIVOT_AT)
        proxy._maybe_lockstep_escalate(
            {"messages": [{"role": "user", "content": "go"}]}, m
        )
        self.assertEqual(self._records(), [])

    def test_ledger_created_owner_only(self):
        m = proxy.SessionMonitor()
        _drive_lockstep(m, proxy.PROXY_LOCKSTEP_PIVOT_AT)
        proxy._maybe_lockstep_escalate(
            {"messages": [{"role": "user", "content": "go"}]}, m
        )
        import stat

        mode = stat.S_IMODE(os.stat(proxy.UAP_LOOP_INCIDENTS).st_mode)
        self.assertEqual(mode, 0o600)

    def test_symlink_ledger_refused(self):
        target = os.path.join(self._tmp.name, "target.jsonl")
        link = os.path.join(self._tmp.name, "link.jsonl")
        with open(target, "w", encoding="utf-8") as fh:
            fh.write("")
        os.symlink(target, link)
        proxy.UAP_LOOP_INCIDENTS = link
        m = proxy.SessionMonitor()
        _drive_lockstep(m, proxy.PROXY_LOCKSTEP_PIVOT_AT)
        proxy._maybe_lockstep_escalate(
            {"messages": [{"role": "user", "content": "go"}]}, m
        )
        with open(target, encoding="utf-8") as fh:
            self.assertEqual(fh.read(), "")  # untouched


if __name__ == "__main__":
    unittest.main()
