#!/usr/bin/env python3
"""Verbatim decision compaction (uplift 1.2).

The proxy's context-pressure path used to drop a contiguous oldest-middle
block and replace it with a one-line breadcrumb summary — LOSSY: dropped
findings evaporate. `verbatim_compact_conversation` sits AHEAD of that path
and makes per-tool-call keep/truncate/drop decisions:

  stage 1: drop pure-noise tool pairs (acks, superseded reads, repeats)
  stage 2: truncate large kept tool results in place (verbatim head + note)
  stage 3: return None -> fall back to the contiguous breadcrumb pruner

Hard invariants pinned here:
  - kept content is VERBATIM (no summarization of retained messages);
  - PAIRING INTEGRITY: a tool_use and its tool_result are an atomic pair —
    no orphan tool_result, no dangling tool_use; any integrity failure or
    insufficient reduction fails CLOSED to the old path (returns None);
  - PROXY_VERBATIM_COMPACT=off restores the old path entirely;
  - on a noise-bearing oversized fixture the verbatim path reduces at least
    as much as the lossy pruner.
"""

import copy
import importlib.util
import unittest
from pathlib import Path

proxy_path = Path(__file__).resolve().parents[1] / "scripts" / "anthropic_proxy.py"
spec = importlib.util.spec_from_file_location("anthropic_proxy", proxy_path)
ap = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ap)


BIG = 1400  # chars per large tool result (~400 tokens at 3.5 chars/token)


def _pad(prefix, char):
    return prefix + char * max(0, BIG - len(prefix))


def _assistant_call(idx, name, tool_input, text=None):
    blocks = []
    if text:
        blocks.append({"type": "text", "text": text})
    blocks.append(
        {"type": "tool_use", "id": f"toolu_{idx}", "name": name, "input": tool_input}
    )
    return {"role": "assistant", "content": blocks}


def _user_result(idx, text):
    return {
        "role": "user",
        "content": [
            {"type": "tool_result", "tool_use_id": f"toolu_{idx}", "content": text}
        ],
    }


def _pair(idx, name, tool_input, result_text, assistant_text=None):
    return [
        _assistant_call(idx, name, tool_input, text=assistant_text),
        _user_result(idx, result_text),
    ]


def _noise_fixture():
    """Oversized conversation whose middle mixes pure-noise pairs with
    unique signal pairs. Window 8000 x 0.50 -> 4000-token message budget;
    the middle alone is ~4800 tokens, ~45% of it pure noise, so stage 1
    alone brings the conversation under budget without stage-2 truncation."""
    messages = [{"role": "user", "content": "recon: map the auth flow"}]
    idx = 0

    def add(name, tool_input, result_text):
        nonlocal idx
        messages.extend(_pair(idx, name, tool_input, result_text))
        idx += 1

    add("Read", {"file_path": "/src/dupC.py"}, _pad("DUPC-OLD ", "e"))  # superseded below
    add("Read", {"file_path": "/src/dupA.py"}, _pad("DUPA-OLD ", "a"))  # superseded below
    add("Write", {"file_path": "/src/out1.py"},
        "File created successfully at: /src/out1.py")  # ack (toolu_2)
    add("Read", {"file_path": "/src/sig1.py"}, _pad("SIG1 ", "1"))  # signal
    add("Bash", {"command": "git status"},
        "On branch master\nnothing to commit, working tree clean")  # repeat below
    add("Read", {"file_path": "/src/dupB.py"}, _pad("DUPB-OLD ", "b"))  # superseded below
    add("Read", {"file_path": "/src/sig2.py"}, _pad("SIG2 ", "2"))  # signal
    add("Read", {"file_path": "/src/dupA.py"}, _pad("DUPA-NEW ", "c"))  # freshest A
    add("Write", {"file_path": "/src/out2.py"},
        "File created successfully at: /src/out2.py")  # ack
    add("Read", {"file_path": "/src/sig3.py"}, _pad("SIG3 ", "3"))  # signal
    add("Bash", {"command": "git status"},
        "On branch master\nnothing to commit, working tree clean")  # freshest repeat
    add("Read", {"file_path": "/src/dupB.py"}, _pad("DUPB-NEW ", "d"))  # freshest B
    add("Read", {"file_path": "/src/dupD.py"}, _pad("DUPD-OLD ", "g"))  # superseded below
    add("Read", {"file_path": "/src/dupD.py"}, _pad("DUPD-NEW ", "h"))  # freshest D
    add("Read", {"file_path": "/src/dupC.py"}, _pad("DUPC-NEW ", "f"))  # freshest C
    add("Read", {"file_path": "/src/sig4.py"}, _pad("SIG4 ", "4"))  # signal
    for tail in ("t0", "t1", "t2", "t3"):
        messages.append({"role": "user", "content": tail})
    return {"messages": messages}


def _big_signal_fixture(n_pairs=6, result_chars=3000):
    """Oversized conversation with NO noise: every pair is a unique read of
    a unique path with a large unique result."""
    messages = [{"role": "user", "content": "analyze everything"}]
    for i in range(n_pairs):
        messages.extend(
            _pair(
                i,
                "Read",
                {"file_path": f"/src/uniq{i}.py"},
                f"HEAD{i} " + (f"u{i}" * (result_chars // 2)) + f" TAIL{i}",
            )
        )
    for tail in ("t0", "t1", "t2", "t3"):
        messages.append({"role": "user", "content": tail})
    return {"messages": messages}


def _all_text(body):
    out = []
    for msg in body["messages"]:
        content = msg.get("content", "")
        if isinstance(content, str):
            out.append(content)
        elif isinstance(content, list):
            for block in content:
                if isinstance(block, dict):
                    if block.get("type") == "text":
                        out.append(block.get("text", ""))
                    elif block.get("type") == "tool_result":
                        out.append(ap._extract_text(block.get("content", "")))
    return "\n".join(out)


class TestStage1KeepDropDecisions(unittest.TestCase):
    def test_drops_pure_noise_keeps_signal_verbatim(self):
        body = _noise_fixture()
        original_total = ap.estimate_total_tokens(body)
        out = ap.verbatim_compact_conversation(
            copy.deepcopy(body), 8000, target_fraction=0.50, keep_last=4
        )
        self.assertIsNotNone(out)
        blob = _all_text(out)
        # noise gone: superseded first reads, ack writes, the repeated call
        self.assertNotIn("DUPA-OLD", blob)
        self.assertNotIn("DUPB-OLD", blob)
        self.assertNotIn("DUPC-OLD", blob)
        self.assertNotIn("DUPD-OLD", blob)
        self.assertNotIn("File created successfully", blob)
        self.assertEqual(blob.count("working tree clean"), 1)  # freshest kept
        # signal kept VERBATIM — the full untruncated result text
        self.assertIn(_pad("SIG1 ", "1"), blob)
        self.assertIn(_pad("SIG4 ", "4"), blob)
        self.assertIn(_pad("DUPA-NEW ", "c"), blob)
        self.assertIn(_pad("DUPD-NEW ", "h"), blob)
        self.assertIn(_pad("DUPC-NEW ", "f"), blob)
        # no breadcrumb summary anywhere — verbatim path never summarizes
        self.assertNotIn("CONTEXT PRUNED", blob)
        # stage 1 sufficed — nothing was truncated
        self.assertNotIn("[… truncated ~", blob)
        # head and tail pinned
        self.assertEqual(out["messages"][0]["content"], "recon: map the auth flow")
        self.assertEqual([m["content"] for m in out["messages"][-4:]], ["t0", "t1", "t2", "t3"])
        # actually reduced
        self.assertLess(ap.estimate_total_tokens(out), original_total)

    def test_ack_pair_with_meaningful_prose_is_kept(self):
        """When in doubt, keep: an ack result riding on an assistant message
        with real prose is not pure noise."""
        body = _noise_fixture()
        # give the first Write pair's (toolu_2) assistant message meaningful text
        for msg in body["messages"]:
            content = msg.get("content", [])
            if isinstance(content, list) and any(
                isinstance(b, dict) and b.get("id") == "toolu_2" for b in content
            ):
                content.insert(
                    0, {"type": "text", "text": "Now writing the entrypoint module."}
                )
                break
        out = ap.verbatim_compact_conversation(
            copy.deepcopy(body), 8000, target_fraction=0.50, keep_last=4
        )
        self.assertIsNotNone(out)
        blob = _all_text(out)
        self.assertIn("Now writing the entrypoint module.", blob)
        self.assertIn("File created successfully at: /src/out1.py", blob)

    def test_survivors_keep_original_relative_order(self):
        """KV doctrine: never reshuffle — surviving middle messages appear in
        their original order."""
        body = _noise_fixture()
        original = list(body["messages"])
        out = ap.verbatim_compact_conversation(
            copy.deepcopy(body), 8000, target_fraction=0.50, keep_last=4
        )
        self.assertIsNotNone(out)
        idxs = [
            i
            for msg in out["messages"]
            for i, orig in enumerate(original)
            if msg is not orig and msg == orig
        ]
        self.assertEqual(idxs, sorted(idxs))


class TestStage2Truncation(unittest.TestCase):
    def test_truncates_oldest_first_keeps_head_verbatim(self):
        body = _big_signal_fixture()
        original_texts = [
            ap._extract_text(m["content"][0].get("content", ""))
            for m in body["messages"]
            if m.get("role") == "user"
            and isinstance(m.get("content"), list)
        ]
        out = ap.verbatim_compact_conversation(
            copy.deepcopy(body), 8000, target_fraction=0.50, keep_last=4
        )
        self.assertIsNotNone(out)
        budget = int(8000 * 0.50)
        total = sum(ap.estimate_message_tokens(m) for m in out["messages"])
        self.assertLessEqual(total, budget)

        result_texts = [
            ap._extract_text(m["content"][0].get("content", ""))
            for m in out["messages"]
            if m.get("role") == "user" and isinstance(m.get("content"), list)
        ]
        truncated = [t for t in result_texts if "[… truncated ~" in t]
        untouched = [t for t in result_texts if "[… truncated ~" not in t]
        self.assertTrue(truncated, "expected at least one truncated result")
        for orig, now in zip(original_texts, result_texts):
            if "[… truncated ~" in now:
                # head kept VERBATIM, then the note
                self.assertTrue(now.startswith(orig[: ap._VERBATIM_TRUNCATE_HEAD_CHARS]))
                self.assertLess(len(now), len(orig))
            else:
                self.assertEqual(now, orig)  # untouched stays byte-identical
        # oldest-first: the newest middle results survive untruncated
        self.assertTrue(any(t == original_texts[-1] for t in untouched))

    def test_truncation_preserves_pairing(self):
        body = _big_signal_fixture()
        out = ap.verbatim_compact_conversation(
            copy.deepcopy(body), 8000, target_fraction=0.50, keep_last=4
        )
        self.assertIsNotNone(out)
        self.assertTrue(ap._tool_pairing_intact(out["messages"]))
        # every surviving tool_use id still has its tool_result and vice versa
        use_ids = {
            b["id"]
            for m in out["messages"]
            for b in ap._iter_tool_use_blocks(m)
        }
        result_ids = {
            b["tool_use_id"]
            for m in out["messages"]
            for b in ap._iter_tool_result_blocks(m)
        }
        self.assertEqual(use_ids, result_ids)


class TestPairingIntegrityValidation(unittest.TestCase):
    def test_valid_paired_conversation(self):
        body = _noise_fixture()
        self.assertTrue(ap._tool_pairing_intact(body["messages"]))

    def test_orphan_tool_result_rejected(self):
        messages = [
            {"role": "user", "content": [
                {"type": "tool_result", "tool_use_id": "toolu_x", "content": "data"}]},
            {"role": "user", "content": "next"},
        ]
        self.assertFalse(ap._tool_pairing_intact(messages))

    def test_dangling_tool_use_mid_conversation_rejected(self):
        messages = [
            {"role": "user", "content": "go"},
            _assistant_call(0, "Read", {"file_path": "/a"}),
            {"role": "user", "content": "no result for that call"},
        ]
        self.assertFalse(ap._tool_pairing_intact(messages))

    def test_final_assistant_prefill_is_allowed(self):
        messages = [
            {"role": "user", "content": "go"},
            _assistant_call(0, "Read", {"file_path": "/a"}),
        ]
        self.assertTrue(ap._tool_pairing_intact(messages))

    def test_partial_result_coverage_rejected(self):
        pair = _assistant_call(0, "Read", {"file_path": "/a"})
        pair["content"].append(
            {"type": "tool_use", "id": "toolu_99", "name": "Read",
             "input": {"file_path": "/b"}}
        )
        messages = [
            {"role": "user", "content": "go"},
            pair,
            _user_result(0, "only one of two answered"),
        ]
        self.assertFalse(ap._tool_pairing_intact(messages))

    def test_unfixable_input_pairing_fails_closed(self):
        """A conversation whose pairing is ALREADY broken (orphan result) can
        be stage-1 reduced but never validated — the verbatim path must fail
        closed (None) rather than ship the broken pairing."""
        body = _noise_fixture()
        # inject an orphan tool_result into the middle
        body["messages"].insert(
            5,
            {"role": "user", "content": [
                {"type": "tool_result", "tool_use_id": "toolu_orphan",
                 "content": "orphaned"}]},
        )
        out = ap.verbatim_compact_conversation(
            copy.deepcopy(body), 8000, target_fraction=0.50, keep_last=4
        )
        self.assertIsNone(out)


class TestFallbacks(unittest.TestCase):
    def test_none_when_stages_cannot_reach_budget(self):
        """All-signal conversation far over budget: even truncating every
        result to its head cannot fit — stage 3 fails closed."""
        body = _big_signal_fixture(n_pairs=8, result_chars=3000)
        out = ap.verbatim_compact_conversation(
            copy.deepcopy(body), 4000, target_fraction=0.25, keep_last=4
        )
        self.assertIsNone(out)

    def test_none_when_nothing_to_do(self):
        body = _big_signal_fixture(n_pairs=2, result_chars=200)
        out = ap.verbatim_compact_conversation(
            copy.deepcopy(body), 128000, target_fraction=0.65, keep_last=4
        )
        self.assertIsNone(out)

    def test_none_on_few_message_body(self):
        body = {"messages": [{"role": "user", "content": "x" * 900000}]}
        self.assertIsNone(
            ap.verbatim_compact_conversation(body, 100000, target_fraction=0.5)
        )

    def test_callers_body_is_pristine_after_fallback(self):
        """The verbatim path works on a copy: a fallback must leave the
        original body untouched for the lossy pruner."""
        body = _big_signal_fixture(n_pairs=8, result_chars=3000)
        snapshot = copy.deepcopy(body)
        out = ap.verbatim_compact_conversation(
            body, 4000, target_fraction=0.25, keep_last=4
        )
        self.assertIsNone(out)
        self.assertEqual(body, snapshot)


class TestEscapeHatchAndWiring(unittest.TestCase):
    def test_env_off_restores_old_path_entirely(self):
        body = _noise_fixture()
        expected = ap.prune_conversation(
            copy.deepcopy(body), 8000,
            monitor=ap.SessionMonitor(context_window=8000),
            target_fraction=0.50, keep_last=4,
        )
        old = ap.PROXY_VERBATIM_COMPACT
        try:
            ap.PROXY_VERBATIM_COMPACT = "off"
            got = ap._compact_conversation(
                copy.deepcopy(body), 8000,
                monitor=ap.SessionMonitor(context_window=8000),
                target_fraction=0.50, keep_last=4,
            )
        finally:
            ap.PROXY_VERBATIM_COMPACT = old
        self.assertEqual(got["messages"], expected["messages"])
        self.assertIn("CONTEXT PRUNED", _all_text(got))

    def test_wiring_prefers_verbatim_and_skips_drop_boundary(self):
        """With compaction on, the wrapper returns the verbatim result and
        does NOT advance the fallback's monotonic prune_drop_count."""
        monitor = ap.SessionMonitor(context_window=8000)
        out = ap._compact_conversation(
            _noise_fixture(), 8000,
            monitor=monitor, target_fraction=0.50, keep_last=4,
        )
        blob = _all_text(out)
        self.assertNotIn("CONTEXT PRUNED", blob)
        self.assertIn(_pad("SIG1 ", "1"), blob)
        self.assertEqual(monitor.prune_drop_count, 0)

    def test_wiring_fails_closed_on_exception(self):
        """ANY exception in the verbatim path falls back to the known-good
        pruner with the caller's body intact."""
        old_fn = ap.verbatim_compact_conversation

        def _boom(*args, **kwargs):
            raise RuntimeError("classifier exploded")

        ap.verbatim_compact_conversation = _boom
        try:
            out = ap._compact_conversation(
                _noise_fixture(), 8000,
                monitor=ap.SessionMonitor(context_window=8000),
                target_fraction=0.50, keep_last=4,
            )
        finally:
            ap.verbatim_compact_conversation = old_fn
        self.assertIn("CONTEXT PRUNED", _all_text(out))


class TestReductionComparison(unittest.TestCase):
    def test_verbatim_reduces_at_least_as_much_as_lossy_prune(self):
        """On the same oversized noise-bearing fixture, the verbatim path's
        context reduction is >= the old pruner's — it removes only noise and
        adds no breadcrumb/carryover marker back."""
        body = _noise_fixture()
        before = ap.estimate_total_tokens(body)
        verbatim = ap.verbatim_compact_conversation(
            copy.deepcopy(body), 8000, target_fraction=0.50, keep_last=4
        )
        lossy = ap.prune_conversation(
            copy.deepcopy(body), 8000,
            monitor=ap.SessionMonitor(context_window=8000),
            target_fraction=0.50, keep_last=4,
        )
        self.assertIsNotNone(verbatim)
        v_reduction = before - ap.estimate_total_tokens(verbatim)
        l_reduction = before - ap.estimate_total_tokens(lossy)
        self.assertGreaterEqual(v_reduction, l_reduction)
        # and the verbatim result fits the same budget the pruner targets
        budget = int(8000 * 0.50)
        self.assertLessEqual(
            sum(ap.estimate_message_tokens(m) for m in verbatim["messages"]),
            budget,
        )


def _custom_fixture(middle_messages):
    """Head + given middle + 4-message tail, matching the keep_last=4 shape."""
    return {
        "messages": [{"role": "user", "content": "task"}]
        + middle_messages
        + [{"role": "user", "content": t} for t in ("t0", "t1", "t2", "t3")]
    }


def _padding_pairs(start_idx, n, result_chars=3000):
    """n unique signal Read pairs (never noise) to push a fixture over budget."""
    msgs = []
    for i in range(start_idx, start_idx + n):
        msgs.extend(
            _pair(i, "Read", {"file_path": f"/src/pad{i}.py"},
                  f"PAD{i} " + (f"p{i}" * (result_chars // 2)))
        )
    return msgs


class TestTruncateBandRegression(unittest.TestCase):
    def test_1300_char_band_block_untouched(self):
        """A text in the (MIN=1200, HEAD=1500 + note] band would GROW by the
        note with nothing cut — it must be skipped entirely."""
        pair = _pair(0, "Read", {"file_path": "/a"}, "B" * 1300)
        removed = ap._truncate_pair(pair)
        self.assertEqual(removed, 0)
        self.assertEqual(pair[1]["content"][0]["content"], "B" * 1300)

    def test_truncate_text_block_band_boundaries(self):
        self.assertEqual(ap._truncate_text_block("x" * 1300), ("x" * 1300, 0))
        big = "y" * 5000
        new_text, removed = ap._truncate_text_block(big)
        self.assertGreater(removed, 0)
        self.assertTrue(new_text.startswith("y" * ap._VERBATIM_TRUNCATE_HEAD_CHARS))
        self.assertIn("[… truncated ~", new_text)
        self.assertLess(len(new_text), len(big))


class TestRepeatedCallResultEquality(unittest.TestCase):
    def test_earlier_error_result_is_not_dropped(self):
        """A repeated call whose EARLIER result was an error must not vanish
        because the later identical call succeeded blandly."""
        middle = _pair(0, "Bash", {"command": "probe"}, "Error: connection refused")
        middle[1]["content"][0]["is_error"] = True
        middle += _pair(1, "Bash", {"command": "probe"}, "probe ok")
        middle += _padding_pairs(10, 6)
        body = _custom_fixture(middle)
        out = ap.verbatim_compact_conversation(
            copy.deepcopy(body), 8000, target_fraction=0.50, keep_last=4
        )
        self.assertIsNotNone(out)
        self.assertIn("Error: connection refused", _all_text(out))

    def test_identical_bland_repeat_is_dropped(self):
        middle = _pair(0, "Bash", {"command": "probe"}, "probe ok")
        middle += _pair(1, "Bash", {"command": "probe"}, "probe ok")
        middle += _padding_pairs(10, 6)
        body = _custom_fixture(middle)
        out = ap.verbatim_compact_conversation(
            copy.deepcopy(body), 8000, target_fraction=0.50, keep_last=4
        )
        self.assertIsNotNone(out)
        self.assertEqual(_all_text(out).count("probe ok"), 1)  # freshest kept

    def test_ack_phrase_with_real_payload_is_not_ack(self):
        self.assertFalse(ap._is_ack_result("ok, here are the 3 failing tests"))
        self.assertTrue(ap._is_ack_result("OK."))
        self.assertTrue(
            ap._is_ack_result("File created successfully at: /src/out.py")
        )


class TestDropBreadcrumb(unittest.TestCase):
    def test_breadcrumb_present_bounded_and_lists_tools(self):
        body = _noise_fixture()
        out = ap.verbatim_compact_conversation(
            copy.deepcopy(body), 8000, target_fraction=0.50, keep_last=4
        )
        self.assertIsNotNone(out)
        crumbs = [
            m["content"]
            for m in out["messages"]
            if isinstance(m.get("content"), str) and m["content"].startswith("[compaction:")
        ]
        self.assertEqual(len(crumbs), 1)  # exactly one note, at the first drop
        crumb = crumbs[0]
        self.assertLessEqual(len(crumb), 300)
        self.assertIn("noise tool pairs elided", crumb)
        self.assertIn("read /src/", crumb)  # names tools + paths
        self.assertIn("write /src/", crumb)


class TestSupersededReadDoctrine(unittest.TestCase):
    def test_intervening_write_keeps_first_read(self):
        """Read A -> Write A -> Read A: the first read is the before/after
        record — NOT superseded."""
        middle = _pair(0, "Read", {"file_path": "/src/state.py"}, _pad("OLD-A ", "o"))
        middle += _pair(1, "Write", {"file_path": "/src/state.py"},
                        "File created successfully at: /src/state.py")
        middle += _pair(2, "Read", {"file_path": "/src/state.py"}, _pad("NEW-A ", "n"))
        middle += _padding_pairs(10, 6)
        body = _custom_fixture(middle)
        out = ap.verbatim_compact_conversation(
            copy.deepcopy(body), 8000, target_fraction=0.50, keep_last=4
        )
        self.assertIsNotNone(out)
        blob = _all_text(out)
        self.assertIn(_pad("OLD-A ", "o"), blob)  # before-record kept
        self.assertIn(_pad("NEW-A ", "n"), blob)

    def test_later_errored_read_does_not_supersede(self):
        middle = _pair(0, "Read", {"file_path": "/src/x.py"}, _pad("GOOD-READ ", "g"))
        middle += _pair(1, "Read", {"file_path": "/src/x.py"}, "Error: boom")
        middle[3]["content"][0]["is_error"] = True  # second read errored
        middle += _padding_pairs(10, 6)
        body = _custom_fixture(middle)
        out = ap.verbatim_compact_conversation(
            copy.deepcopy(body), 8000, target_fraction=0.50, keep_last=4
        )
        self.assertIsNotNone(out)
        self.assertIn(_pad("GOOD-READ ", "g"), _all_text(out))


class TestStage2WritePayloadImmunity(unittest.TestCase):
    def test_write_pair_input_survives_stage2_verbatim(self):
        """Stage 2 truncates the Write pair's RESULT but never its input —
        the input payload is the model's own action history."""
        write_input = {"file_path": "/src/big.py", "content": "W" * 3000}
        middle = _pair(0, "Write", write_input, "WRITE-RESULT " + "r" * 3000)
        middle += _padding_pairs(10, 5)
        body = _custom_fixture(middle)
        out = ap.verbatim_compact_conversation(
            copy.deepcopy(body), 8000, target_fraction=0.50, keep_last=4
        )
        self.assertIsNotNone(out)
        write_use = next(
            b
            for m in out["messages"]
            for b in ap._iter_tool_use_blocks(m)
            if b.get("name") == "Write"
        )
        self.assertEqual(write_use["input"]["content"], "W" * 3000)  # intact
        write_result = next(
            b
            for m in out["messages"]
            for b in ap._iter_tool_result_blocks(m)
            if b.get("tool_use_id") == "toolu_0"
        )
        self.assertIn("[… truncated ~", ap._extract_text(write_result["content"]))


class TestMonitorBoundaryReset(unittest.TestCase):
    def test_prune_drop_count_reset_on_verbatim_success(self):
        """The verbatim path re-indexes the middle — a stale legacy boundary
        would force-drop kept signal on a later fallback turn."""
        monitor = ap.SessionMonitor(context_window=8000)
        monitor.prune_drop_count = 7
        out = ap.verbatim_compact_conversation(
            _noise_fixture(), 8000, monitor=monitor,
            target_fraction=0.50, keep_last=4,
        )
        self.assertIsNotNone(out)
        self.assertEqual(monitor.prune_drop_count, 0)


class TestWideFixturePerformance(unittest.TestCase):
    def test_2000_pair_fixture_completes_fast(self):
        """Guards the occurrence-index complexity: 1000 unique calls, each
        repeated once (all stage-1 noise), must not go quadratic."""
        import time

        middle = []
        for i in range(1000):
            middle += _pair(2 * i, "Bash", {"command": f"cmd{i}"}, f"out{i} bland")
            middle += _pair(2 * i + 1, "Bash", {"command": f"cmd{i}"}, f"out{i} bland")
        body = _custom_fixture(middle)
        start = time.monotonic()
        out = ap.verbatim_compact_conversation(
            copy.deepcopy(body), 40000, target_fraction=0.50, keep_last=4
        )
        elapsed = time.monotonic() - start
        self.assertIsNotNone(out)  # stage 1 drops the 1000 older repeats
        self.assertLess(elapsed, 5.0)


if __name__ == "__main__":
    unittest.main()
