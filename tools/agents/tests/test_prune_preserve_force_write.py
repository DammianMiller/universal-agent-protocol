"""Tests for the huge-project hands-free fixes:

  #3 FORCE-WRITE: at the hard recon-convergence tier the proxy strips the
     exploration tools (read-only class + escape hatches) and forces
     tool_choice='required' so the model MUST write instead of reading again.
  #2 STATE CARRYOVER: the contamination breaker reconstructs the plan + files
     written from the message stream and re-injects them after the reset, so a
     prune no longer destroys mission state.
"""
import importlib.util
import unittest
from pathlib import Path

proxy_path = Path(__file__).resolve().parents[3] / "tools" / "agents" / "scripts" / "anthropic_proxy.py"
spec = importlib.util.spec_from_file_location("anthropic_proxy", proxy_path)
ap = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ap)


def _tool(name):
    return {"type": "function", "function": {"name": name, "parameters": {}}}


def _names(tools):
    return {(t.get("function", {}) or {}).get("name", "") for t in tools}


class ForceWriteHardTierTest(unittest.TestCase):
    """#3: hard tier removes read/exploration tools and forces a write."""

    def _hard_monitor(self):
        m = ap.SessionMonitor(context_window=132096)
        m.consecutive_no_write_turns = (
            int(ap.PROXY_RECON_HARD_MULTIPLIER * ap.PROXY_RECON_CONVERGENCE_THRESHOLD) + 1
        )
        return m

    def test_strips_reads_and_forces_required(self):
        m = self._hard_monitor()
        tools = [_tool("Read"), _tool("Grep"), _tool("Bash"), _tool("Write"), _tool("Edit")]
        body = {"messages": [{"role": "user", "content": "reading"}], "tools": list(tools)}
        ap._maybe_inject_recon_convergence(body, m, full_tools=tools)
        remaining = _names(body["tools"])
        self.assertNotIn("Read", remaining)
        self.assertNotIn("Grep", remaining)
        self.assertNotIn("Bash", remaining)  # exploration escape hatch also stripped
        self.assertIn("Write", remaining)
        self.assertIn("Edit", remaining)
        self.assertEqual(body.get("tool_choice"), "required")

    def test_keeps_deliver_when_writes_are_gated(self):
        m = self._hard_monitor()
        tools = [_tool("Read"), _tool("Bash"), _tool("deliver")]
        body = {"messages": [{"role": "user", "content": "reading"}], "tools": list(tools)}
        ap._maybe_inject_recon_convergence(body, m, full_tools=tools)
        remaining = _names(body["tools"])
        self.assertIn("deliver", remaining)  # deliver is a write path — survives
        self.assertNotIn("Read", remaining)
        self.assertEqual(body.get("tool_choice"), "required")

    def test_floor_invariant_no_write_path_left_untouched(self):
        """If stripping reads would leave NO write path, do not strip (never
        strand). Falls back to the hard tier's 'auto' release."""
        m = self._hard_monitor()
        tools = [_tool("Read"), _tool("Grep")]  # read-only, no write tool
        body = {"messages": [{"role": "user", "content": "reading"}], "tools": list(tools)}
        ap._maybe_inject_recon_convergence(body, m, full_tools=tools)
        remaining = _names(body["tools"])
        self.assertIn("Read", remaining)  # untouched — no write path to force toward
        self.assertNotEqual(body.get("tool_choice"), "required")

    def test_firm_tier_does_not_force_write(self):
        """The firm tier (below the hard multiplier) must keep reads available."""
        m = ap.SessionMonitor(context_window=132096)
        m.consecutive_no_write_turns = ap.PROXY_RECON_CONVERGENCE_THRESHOLD  # firm
        tools = [_tool("Read"), _tool("Write")]
        body = {"messages": [{"role": "user", "content": "reading"}],
                "tools": list(tools), "tool_choice": "required"}
        ap._maybe_inject_recon_convergence(body, m, full_tools=tools)
        self.assertIn("Read", _names(body["tools"]))  # reads still allowed at firm
        self.assertEqual(body.get("tool_choice"), "auto")


class StateCarryoverExtractTest(unittest.TestCase):
    """#2: _extract_state_carryover reconstructs plan + files from the stream."""

    def _convo(self):
        return [
            {"role": "user", "content": "build the app"},
            {"role": "assistant", "content": [
                {"type": "tool_use", "name": "TodoWrite", "input": {"todos": [
                    {"content": "scaffold project", "status": "completed"},
                    {"content": "add auth", "status": "in_progress"},
                    {"content": "write tests", "status": "pending"},
                ]}},
            ]},
            {"role": "assistant", "content": [
                {"type": "tool_use", "name": "Write", "input": {"file_path": "src/index.ts"}},
            ]},
            {"role": "assistant", "content": [
                {"type": "tool_use", "name": "Edit", "input": {"file_path": "src/auth.ts"}},
            ]},
        ]

    def test_extracts_plan_and_files(self):
        out = ap._extract_state_carryover(self._convo())
        self.assertIsNotNone(out)
        self.assertIn("STATE CARRYOVER", out)
        self.assertIn("scaffold project", out)
        self.assertIn("add auth", out)
        self.assertIn("[x] scaffold project", out)
        self.assertIn("[~] add auth", out)
        self.assertIn("src/index.ts", out)
        self.assertIn("src/auth.ts", out)

    def test_returns_none_on_fresh_session(self):
        convo = [{"role": "user", "content": "hi"},
                 {"role": "assistant", "content": [
                     {"type": "tool_use", "name": "Read", "input": {"file_path": "x"}}]}]
        self.assertIsNone(ap._extract_state_carryover(convo))

    def test_keeps_most_recent_plan_only(self):
        convo = self._convo()
        convo.append({"role": "assistant", "content": [
            {"type": "tool_use", "name": "TodoWrite", "input": {"todos": [
                {"content": "final polish", "status": "pending"}]}}]})
        out = ap._extract_state_carryover(convo)
        self.assertIn("final polish", out)
        self.assertNotIn("scaffold project", out)  # superseded by the later plan


class ContaminationBreakerPreservesStateTest(unittest.TestCase):
    """#2 end-to-end: a standard contamination reset re-injects the carryover."""

    def test_standard_reset_includes_carryover(self):
        m = ap.SessionMonitor(context_window=132096)
        m.malformed_tool_streak = max(1, ap.PROXY_SESSION_CONTAMINATION_THRESHOLD)
        keep = max(2, ap.PROXY_SESSION_CONTAMINATION_KEEP_LAST)
        filler = [{"role": "user", "content": f"m{i}"} for i in range(keep + 4)]
        messages = (
            [{"role": "user", "content": "build the app"}]
            + [{"role": "assistant", "content": [
                {"type": "tool_use", "name": "TodoWrite", "input": {"todos": [
                    {"content": "step one", "status": "completed"},
                    {"content": "step two", "status": "pending"}]}}]}]
            + [{"role": "assistant", "content": [
                {"type": "tool_use", "name": "Write", "input": {"file_path": "app/main.py"}}]}]
            + filler
        )
        body = {"messages": messages, "tools": [_tool("Write")]}
        out = ap._maybe_apply_session_contamination_breaker(body, m, "fp:test")
        blob = "\n".join(
            b if isinstance(b, str) else str(b)
            for msg in out["messages"] for b in [msg.get("content", "")]
        )
        self.assertIn("STATE CARRYOVER", blob)
        self.assertIn("app/main.py", blob)
        self.assertIn("step two", blob)


class PrunerStateCarryoverTest(unittest.TestCase):
    """#2 companion: the CONTEXT PRUNER (not just the contamination breaker)
    must carry the plan + files-written across a drop, or a long build re-reads
    its own output after every prune (observed live: `cat lib.rs` ×16)."""

    def test_prune_marker_carries_written_files(self):
        long = "x " * 800  # ~400 tok each — large middle, small head/tail
        messages = [{"role": "user", "content": "build the org-model crate"}]
        # a WRITE in the middle (will be dropped) — the breadcrumb never
        # captures write actions, only tool_result reads.
        messages.append({"role": "assistant", "content": [
            {"type": "tool_use", "name": "Write",
             "input": {"file_path": "org-model/src/person.rs"}}]})
        for _ in range(6):  # large read results fill the middle
            messages.append({"role": "user", "content": [
                {"type": "tool_result", "content": "read " + long}]})
        for t in ["a", "b", "c", "d"]:  # small recent tail (protected, fits)
            messages.append({"role": "user", "content": t})

        body = {"messages": messages}
        m = ap.SessionMonitor(context_window=4000)
        out = ap.prune_conversation(body, context_window=4000, monitor=m,
                                    target_fraction=0.4, keep_last=4)
        blob = "\n".join(
            b if isinstance(b, str) else str(b)
            for msg in out["messages"] for b in [msg.get("content", "")]
        )
        # the dropped Write action survives as a carryover manifest entry
        self.assertIn("STATE CARRYOVER", blob)
        self.assertIn("org-model/src/person.rs", blob)

    def test_no_carryover_on_fresh_prune_still_prunes(self):
        """A prune with no plan/writes to carry still works (breadcrumb only)."""
        long = "y " * 800
        messages = [{"role": "user", "content": "explore"}]
        for _ in range(6):
            messages.append({"role": "user", "content": [
                {"type": "tool_result", "content": "read " + long}]})
        for t in ["a", "b", "c", "d"]:
            messages.append({"role": "user", "content": t})
        m = ap.SessionMonitor(context_window=4000)
        out = ap.prune_conversation({"messages": messages}, context_window=4000,
                                    monitor=m, target_fraction=0.4, keep_last=4)
        # no crash, and it did drop (fewer messages than input)
        self.assertLess(len(out["messages"]), len(messages))


if __name__ == "__main__":
    unittest.main()
