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
        # Salient placement: the directive rides the transcript TAIL as a
        # user-role turn, not the system-prompt top (2026-10-07 ledger: both
        # system-top directives were ignored en route to a hard stop).
        tail = body["messages"][-1]
        self.assertEqual(tail["role"], "user")
        self.assertIn("LOOP-ESCALATE", tail["content"])
        self.assertIn("different approaches", tail["content"])
        # unknown error class stays generic: no invented fix line
        self.assertNotIn("KNOWN FIX", tail["content"])
        # the quoted error text is untrusted; both guards carry the caveat
        self.assertIn("untrusted tool output", tail["content"])
        self.assertEqual(m.lockstep_fires, 1)
        # advisory: tool_choice untouched
        self.assertEqual(body["tool_choice"], "auto")
        recs = self._records()
        self.assertEqual([r["outcome"] for r in recs], ["pivot"])

    def _drive_signature(self, monitor, signature, n):
        """Drive the trackers with a specific error signature, the way a real
        loop with that error feeds them every turn. result_error=True mirrors
        the is_error flag: without it, keyword-free text (e.g. the client
        cancel marker) never extracts a signature at all."""
        for i in range(n):
            monitor.note_tool_result_error(signature, result_error=True)
            monitor.note_doubling_signal(
                FP, signature, msg_count=100 + i, result_error=True
            )

    def test_pivot_carries_known_fix_for_missing_skill(self):
        m = proxy.SessionMonitor()
        sig = 'skill "uap-router__react" not found. available skills: adapt, animate'
        self._drive_signature(m, sig, proxy.PROXY_LOCKSTEP_PIVOT_AT)
        body = self._body()
        proxy._maybe_lockstep_escalate(body, m)
        tail = body["messages"][-1]
        self.assertIn("KNOWN FIX", tail["content"])
        self.assertIn("does not exist", tail["content"])
        self.assertIn("available-skills list", tail["content"])

    def test_pivot_carries_known_fix_for_invalid_status(self):
        m = proxy.SessionMonitor()
        sig = "error: todo item #: status must be pending, in_progress, or completed"
        self._drive_signature(m, sig, proxy.PROXY_LOCKSTEP_PIVOT_AT)
        body = self._body()
        proxy._maybe_lockstep_escalate(body, m)
        tail = body["messages"][-1]
        self.assertIn("KNOWN FIX", tail["content"])
        self.assertIn("pending, in_progress, completed", tail["content"])

    def test_pivot_carries_known_fix_for_interrupted_call(self):
        m = proxy.SessionMonitor()
        sig = "[tool execution was interrupted]"
        self._drive_signature(m, sig, proxy.PROXY_LOCKSTEP_PIVOT_AT)
        body = self._body()
        proxy._maybe_lockstep_escalate(body, m)
        tail = body["messages"][-1]
        self.assertIn("KNOWN FIX", tail["content"])
        self.assertIn("interrupted before it ran", tail["content"])

    def test_pivot_carries_known_fix_for_edit_anchor_mismatch(self):
        # edit x19 across 3 sessions (ledger 2026-09-25..10-13): the top class.
        m = proxy.SessionMonitor()
        sig = "error: edit could not find oldstring in the file. it must match exactly, including whitespace, indentation, and line endings."
        self._drive_signature(m, sig, proxy.PROXY_LOCKSTEP_PIVOT_AT)
        body = self._body()
        proxy._maybe_lockstep_escalate(body, m)
        tail = body["messages"][-1]
        self.assertIn("KNOWN FIX", tail["content"])
        self.assertIn("byte-for-byte", tail["content"])

    def test_pivot_carries_known_fix_for_identical_edit(self):
        m = proxy.SessionMonitor()
        sig = "no changes to apply: oldstring and newstring are identical."
        self._drive_signature(m, sig, proxy.PROXY_LOCKSTEP_PIVOT_AT)
        body = self._body()
        proxy._maybe_lockstep_escalate(body, m)
        tail = body["messages"][-1]
        self.assertIn("KNOWN FIX", tail["content"])
        self.assertIn("already contains the intended text", tail["content"])

    def test_pivot_carries_known_fix_for_write_truncation(self):
        # one hard_blocked incident: re-emitting the whole file gets cut off
        # again, so the fix must forbid whole-file re-emission.
        m = proxy.SessionMonitor()
        sig = "error: src<path> content looks truncated (# unclosed {). your output was likely cut off mid-file. do not re-emit the whole file"
        self._drive_signature(m, sig, proxy.PROXY_LOCKSTEP_PIVOT_AT)
        body = self._body()
        proxy._maybe_lockstep_escalate(body, m)
        tail = body["messages"][-1]
        self.assertIn("KNOWN FIX", tail["content"])
        self.assertIn("Do NOT re-emit the whole file", tail["content"])

    def test_pivot_carries_known_fix_for_policy_block(self):
        # opencode+qwen log 2026-09-24: 20 ERROR-LOOP hard stops on exactly
        # this signature. The fix must point at the POLICY LAYER, never
        # endorse executing a command string lifted from the untrusted error
        # text (a hostile repo can forge the block line in any failing
        # command's output).
        m = proxy.SessionMonitor()
        sig = "[uap policy blocked: rtk-wrap] rtk-wrap: 'docker' must be invoked via rtk. use: rtk docker compose"
        self._drive_signature(m, sig, proxy.PROXY_LOCKSTEP_PIVOT_AT)
        body = self._body()
        proxy._maybe_lockstep_escalate(body, m)
        tail = body["messages"][-1]
        self.assertIn("KNOWN FIX", tail["content"])
        self.assertIn("blocked by UAP policy", tail["content"])
        self.assertIn("untrusted", tail["content"])
        self.assertNotIn("verbatim", tail["content"])

    def test_final_warning_repeats_known_fix(self):
        m = proxy.SessionMonitor()
        sig = 'skill "uap-router__react" not found. available skills: adapt'
        self._drive_signature(m, sig, proxy.PROXY_LOCKSTEP_PIVOT_AT)
        proxy._maybe_lockstep_escalate(self._body(), m)
        self._drive_signature(m, sig, 1)
        body = self._body()
        proxy._maybe_lockstep_escalate(body, m)
        tail = body["messages"][-1]
        self.assertIn("FINAL WARNING", tail["content"])
        self.assertIn("KNOWN FIX", tail["content"])

    def test_pivot_keeps_trailing_assistant_prefill_last(self):
        # A trailing assistant message is a client prefill (a continuation
        # contract the prefill workaround keys on): the directive must go in
        # FRONT of it, never after -- burying the prefill would 400 on
        # thinking-enabled backends and the retry would then silently drop the
        # pivot behind the duplicate-observation guard.
        m = proxy.SessionMonitor()
        _drive_lockstep(m, proxy.PROXY_LOCKSTEP_PIVOT_AT)
        body = {
            "messages": [
                {"role": "user", "content": "fix it"},
                {"role": "assistant", "content": "the fix is "},
            ],
            "tool_choice": "auto",
        }
        proxy._maybe_lockstep_escalate(body, m)
        prefill = body["messages"][-1]
        directive = body["messages"][-2]
        self.assertEqual(prefill["role"], "assistant")
        self.assertEqual(prefill["content"], "the fix is ")  # untouched
        self.assertEqual(directive["role"], "user")
        self.assertIn("LOOP-ESCALATE", directive["content"])
        self.assertEqual(m.lockstep_fires, 1)
        self.assertEqual([r["outcome"] for r in self._records()], ["pivot"])

    def test_final_warning_on_second_fire(self):
        m = proxy.SessionMonitor()
        _drive_lockstep(m, proxy.PROXY_LOCKSTEP_PIVOT_AT)
        proxy._maybe_lockstep_escalate(self._body(), m)
        _drive_lockstep(m, 1)
        body = self._body()
        proxy._maybe_lockstep_escalate(body, m)
        self.assertIn("FINAL WARNING", body["messages"][-1]["content"])
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
        self.assertIn("LOOP-ESCALATE", body["messages"][-1]["content"])
        self.assertNotIn("FINAL WARNING", body["messages"][-1]["content"])
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


class ErrorLoopDirectiveTests(LockstepKnobGuard):
    """ERROR-LOOP's directive moved from system-top to the tail user turn (the
    same salience fix the 2026-10-07 ledger forced for LOCKSTEP) and carries a
    class-specific KNOWN FIX when the data has one. The opencode+qwen log
    (2026-09-24) shows 20 ERROR-LOOP hard stops where 3 injected system-top
    directives were ignored en route to each stop -- the generic re-read advice
    is not merely useless for those classes, it is wrong."""

    def _body(self):
        return {
            "messages": [
                {"role": "user", "content": "fix it"},
                {"role": "assistant", "content": "editing"},
                {"role": "tool", "content": "err"},
            ],
            "tool_choice": "auto",
        }

    def _drive_error_loop(self, monitor, signature):
        # varied edits, same error: error streak builds, doubling streak stays
        # 0, so lockstep never arms and ERROR-LOOP owns the shape.
        for _ in range(proxy.PROXY_ERROR_LOOP_THRESHOLD):
            monitor.note_tool_result_error(signature, result_error=True)
        self.assertFalse(proxy._lockstep_active(monitor))

    def test_directive_at_tail_not_system_top(self):
        m = proxy.SessionMonitor()
        sig = "error: edit could not find oldstring in the file. it must match exactly"
        self._drive_error_loop(m, sig)
        body = self._body()
        proxy._maybe_inject_error_loop_break(body, m)
        tail = body["messages"][-1]
        self.assertEqual(tail["role"], "user")  # tail user turn, not system-top
        self.assertIn("STOP", tail["content"])
        self.assertIn("could not find oldstring", tail["content"])
        # the original messages are untouched -- no system-0 mangling
        self.assertEqual(body["messages"][0]["role"], "user")
        self.assertEqual(body["messages"][0]["content"], "fix it")
        self.assertEqual(m.error_loop_fires, 1)

    def test_directive_before_trailing_assistant_prefill(self):
        # Same prefill contract as LOCKSTEP: a trailing assistant message is
        # a continuation contract; the directive goes in front of it, never
        # after (burying the prefill would 400 on thinking-enabled backends).
        m = proxy.SessionMonitor()
        sig = "error: edit could not find oldstring in the file. it must match exactly"
        self._drive_error_loop(m, sig)
        body = {
            "messages": [
                {"role": "user", "content": "fix it"},
                {"role": "assistant", "content": "the fix is "},
            ],
            "tool_choice": "auto",
        }
        proxy._maybe_inject_error_loop_break(body, m)
        prefill = body["messages"][-1]
        directive = body["messages"][-2]
        self.assertEqual(prefill["role"], "assistant")
        self.assertEqual(prefill["content"], "the fix is ")  # untouched
        self.assertEqual(directive["role"], "user")
        self.assertIn("STOP", directive["content"])

    def test_known_fix_replaces_generic_remedy(self):
        # For a class with a known fix, the directive replaces the generic
        # re-read advice entirely -- re-reading does not fix a wrong anchor.
        m = proxy.SessionMonitor()
        sig = "error: edit could not find oldstring in the file. it must match exactly"
        self._drive_error_loop(m, sig)
        body = self._body()
        proxy._maybe_inject_error_loop_break(body, m)
        tail = body["messages"][-1]["content"]
        self.assertIn("KNOWN FIX for this error class", tail)
        self.assertIn("byte-for-byte", tail)
        self.assertNotIn("re-read the ENTIRE failing file", tail)

    def test_policy_block_signature_gets_policy_fix(self):
        m = proxy.SessionMonitor()
        sig = "[uap policy blocked: rtk-wrap] rtk-wrap: 'docker' must be invoked via rtk. use: rtk docker compose"
        self._drive_error_loop(m, sig)
        body = self._body()
        proxy._maybe_inject_error_loop_break(body, m)
        tail = body["messages"][-1]["content"]
        self.assertIn("KNOWN FIX for this error class", tail)
        self.assertIn("blocked by UAP policy", tail)
        self.assertIn("untrusted", tail)
        # verbatim delegation removed: the directive must never endorse
        # executing error-named content
        self.assertNotIn("verbatim", tail)
        self.assertIn("untrusted tool output", tail)

    def test_generic_remedy_falls_back_when_no_class(self):
        # Unknown error class keeps the diagnose-first generic remedy.
        m = proxy.SessionMonitor()
        sig = "error: something novel and deterministic nobody has classified"
        self._drive_error_loop(m, sig)
        body = self._body()
        proxy._maybe_inject_error_loop_break(body, m)
        tail = body["messages"][-1]["content"]
        self.assertNotIn("KNOWN FIX for this error class", tail)
        self.assertIn("re-read", tail)

    def test_recon_convergence_pending_yields(self):
        # Recon's own user-role tail directive (injected earlier in the
        # request build) would read as a fresh human turn to the re-arm
        # check and falsely re-arm the hard stop. ERROR-LOOP must yield to
        # recon exactly like LOCKSTEP / DOUBLING-DOWN / DEFERRAL-BREAK.
        m = proxy.SessionMonitor()
        sig = "error: edit could not find oldstring in the file. it must match exactly"
        self._drive_error_loop(m, sig)
        m.error_loop_fires = proxy.PROXY_ERROR_LOOP_HARD_LIMIT
        m.consecutive_no_write_turns = proxy.PROXY_RECON_CONVERGENCE_THRESHOLD
        self.assertTrue(m.recon_convergence_pending())
        body = self._body()
        proxy._maybe_inject_error_loop_break(body, m)
        self.assertEqual(len(body["messages"]), 3)  # untouched
        self.assertEqual(m.error_loop_fires, proxy.PROXY_ERROR_LOOP_HARD_LIMIT)
        self.assertEqual(m.error_loop_blocks, 0)  # no raise, no re-arm

    def test_hard_stop_wording_names_directives_not_re_read(self):
        # After the class table, the nudges are directives (several carry
        # tool-misuse fixes, not re-read advice); the stop text must not
        # promise "re-read" remediation it never gave.
        m = proxy.SessionMonitor()
        sig = "error: edit could not find oldstring in the file. it must match exactly"
        self._drive_error_loop(m, sig)
        m.error_loop_fires = proxy.PROXY_ERROR_LOOP_HARD_LIMIT
        with self.assertRaises(proxy.ErrorLoopHardBlock) as ctx:
            proxy._maybe_inject_error_loop_break(self._body(), m)
        self.assertIn("injected directives were ignored", str(ctx.exception))
        self.assertNotIn("re-read directives", str(ctx.exception))


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
        # the persisted signature is the normalized DECISIVE line (literals
        # stripped). The content-free traceback header no longer anchors a
        # streak -- ledger 2026-09-25 -- so the ledger record names the real
        # error the session was hard-stopped over.
        self.assertEqual(rec["error_signature"], "keyerror: 'x'")

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
