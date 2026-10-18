#!/usr/bin/env python3
"""Loop-steer signature quality: the ledger classes the guards mis-sighted.

Built from the loop-incident ledger after the v2.33/v2.34 uplift on this branch:
  - 2026-09-25: three distinct bash failures shared the content-free
    "Traceback (most recent call last):" signature and escalated to a hard
    stop that never named the real error.
  - 2026-10-08: a worktree status listing whose slug contains "error"
    ("openobserve-error-scan") became the signature of a healthy progress
    report.
  - 2026-10-17: reading a shell script containing a die() helper entered the
    failure streak -- a client that never sends is_error made file CONTENT
    look like a tool failure.
  - 2026-10-18: different execute failures shared the content-free
    "error: command failed (exit code: #)" wrapper and manufactured a
    lockstep streak of 4 across distinct calls.

The ladder these tests pin: a traceback anchors on its decisive line; a real
error line anchors the signature; a wrapper-only result anchors on its first
meaningful line; and a failure that cannot be named yields "" -- DOUBLING-DOWN
owns that shape, not a signature streak.
"""
import importlib.util
import unittest
from pathlib import Path


def _load_proxy_module():
    proxy_path = Path(__file__).resolve().parents[1] / "scripts" / "anthropic_proxy.py"
    spec = importlib.util.spec_from_file_location("anthropic_proxy", proxy_path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


proxy = _load_proxy_module()

TRACEBACK_FULL = (
    "Traceback (most recent call last):\n"
    '  File "/app/run.py", line 3, in <module>\n'
    "    raise ValueError('boom')\n"
    "ValueError: boom"
)
WRAPPER_ONLY = "error: command failed (exit code: 1)"
WRAPPER_WITH_STDERR = (
    "error: command failed (exit code: 1)\n"
    'psql: error: connection to server at "plane-db" (10.5.0.2), port 5432 '
    "failed: fe_sendauth: no password supplied"
)
WRAPPER_WITH_OUTPUT = "error: command failed (exit code: 1)\nCompiling main.c"
WORKTREE_STATUS = (
    "wt-3 in_progress | worktree: openobserve-error-scan "
    "(feature/263-stuck-break-hard)"
)
SHELL_SOURCE_READ = "die() { printf 'fatal: %s\\n' \"$*\" >&2; exit 1; }\n"


class TracebackAnchoringTests(unittest.TestCase):
    def test_decisive_line_anchors_not_the_header(self):
        sig = proxy._error_signature(TRACEBACK_FULL)
        self.assertEqual(sig, "valueerror: boom")
        self.assertNotIn("traceback", sig)

    def test_decisive_line_found_when_not_keyword_shaped(self):
        # SystemExit is a real decisive line but carries no _ERROR_LINE_RE
        # token, so only traceback anchoring can find it.
        text = (
            "Traceback (most recent call last):\n"
            '  File "/app/x.py", line 7, in <module>\n'
            "SystemExit: 1"
        )
        self.assertEqual(proxy._error_signature(text), "systemexit: #")

    def test_truncated_traceback_anchors_on_last_visible_frame(self):
        # Token-limit cut-off before the exception line: the frames still
        # identify the failing call, which is all a streak needs. (The path
        # normalizer swallowing the trailing quote+comma is pre-existing and
        # stable, so the signature remains edit-invariant.)
        text = (
            "Traceback (most recent call last):\n"
            '  File "/app/x.py", line 3, in main\n'
        )
        self.assertEqual(proxy._error_signature(text), 'file "<path> line #, in main')

    def test_header_alone_names_nothing(self):
        self.assertEqual(
            proxy._error_signature("Traceback (most recent call last):"), ""
        )

    def test_mid_payload_traceback_still_anchors(self):
        # code-quality review 2026-10-18: without re.MULTILINE on the header
        # regex, ^ never matched after leading output and the decisive ladder
        # was skipped for every mid-payload traceback.
        text = (
            "building frontend...\n"
            "ok\n"
            "Traceback (most recent call last):\n"
            '  File "/app/run.py", line 3, in <module>\n'
            "    raise KeyError('x')\n"
            "KeyError: 'x'"
        )
        self.assertEqual(proxy._error_signature(text), "keyerror: 'x'")

    def test_mid_payload_truncated_traceback_anchors_on_last_frame(self):
        text = (
            "starting\n"
            "Traceback (most recent call last):\n"
            '  File "/app/x.py", line 3, in main\n'
        )
        self.assertEqual(
            proxy._error_signature(text), 'file "<path> line #, in main'
        )

    def test_chained_traceback_names_the_final_exception(self):
        # Each traceback opens with its own header, which resets the decisive
        # line, so the LAST traceback's exception is the signature.
        text = (
            "Traceback (most recent call last):\n"
            '  File "/app/run.py", line 3, in <module>\n'
            "    raise KeyError('x')\n"
            "KeyError: 'x'\n"
            "\n"
            "During handling of the above exception, another exception "
            "occurred:\n"
            "\n"
            "Traceback (most recent call last):\n"
            '  File "/app/handle.py", line 9, in recover\n'
            "TypeError: cannot convert\n"
        )
        self.assertEqual(
            proxy._error_signature(text), "typeerror: cannot convert"
        )

    def test_trailing_wrapper_exception_cannot_hijack_the_signature(self):
        # code-quality review 2026-10-18: the last-decisive-wins overwrite let
        # a trailing "...RetryError:" rename a KeyError failure.
        text = TRACEBACK_FULL + "\nrequests.exceptions.RetryError: retrying"
        self.assertEqual(proxy._error_signature(text), "valueerror: boom")


class ContentFreeWrapperTests(unittest.TestCase):
    def test_wrapper_alone_names_nothing(self):
        self.assertEqual(proxy._error_signature(WRAPPER_ONLY), "")
        self.assertEqual(proxy._error_signature("Exit code 1"), "")

    def test_wrapper_with_stderr_anchors_on_stderr(self):
        sig = proxy._error_signature(WRAPPER_WITH_STDERR)
        self.assertTrue(sig.startswith("psql: "))
        self.assertIn("fe_sendauth", sig)

    def test_wrapper_with_only_output_anchors_on_first_line(self):
        self.assertEqual(
            proxy._error_signature(WRAPPER_WITH_OUTPUT), "compiling main.c"
        )

    def test_unrelated_wrapper_failures_stop_sharing_a_signature(self):
        # The 2026-10-18 incident: distinct failures manufactured one streak.
        a = proxy._error_signature(WRAPPER_WITH_OUTPUT)
        b = proxy._error_signature(
            "error: command failed (exit code: 1)\nLinking libfoo.so"
        )
        self.assertNotEqual(a, b)
        # ...while the identical failing call keeps a stable one, so LOCKSTEP
        # stays armed for real lockstep loops.
        self.assertEqual(
            proxy._error_signature(WRAPPER_WITH_OUTPUT),
            proxy._error_signature(WRAPPER_WITH_OUTPUT),
        )


class EmbeddedTokenTests(unittest.TestCase):
    def test_status_listing_with_error_slug_is_not_a_failure(self):
        # The exact shape of the 2026-10-08 incident.
        self.assertEqual(proxy._error_signature(WORKTREE_STATUS), "")

    def test_real_error_lines_survive_the_embedded_filter(self):
        combined = (
            WORKTREE_STATUS
            + "\npsql: error: connection to server failed: fe_sendauth: "
            "no password supplied"
        )
        self.assertTrue(proxy._error_signature(combined).startswith("psql: "))
        self.assertNotEqual(
            proxy._error_signature("FATAL: password authentication failed"), ""
        )
        self.assertNotEqual(
            proxy._error_signature("error: relation does not exist"), ""
        )


class ReadOnlyContentTests(unittest.TestCase):
    """A read whose client never declared is_error is file CONTENT (ledger
    2026-10-17: a shell script's die() helper made a healthy Read fail)."""

    def test_read_source_without_flag_forms_no_signature(self):
        m = proxy.SessionMonitor()
        for _ in range(4):
            m.note_tool_result_error(SHELL_SOURCE_READ, None, tool_names=["read"])
        self.assertEqual(m.error_signature_streak, 0)
        self.assertEqual(m.last_error_signature, "")

    def test_declared_error_on_read_still_counts(self):
        m = proxy.SessionMonitor()
        m.note_tool_result_error(SHELL_SOURCE_READ, True, tool_names=["read"])
        self.assertEqual(m.error_signature_streak, 1)

    def test_bash_without_flag_keeps_heuristics(self):
        m = proxy.SessionMonitor()
        m.note_tool_result_error(SHELL_SOURCE_READ, None, tool_names=["bash"])
        self.assertEqual(m.error_signature_streak, 1)

    def test_unknown_tool_name_keeps_heuristics(self):
        # A result whose producing tool cannot be named behaves as before.
        m = proxy.SessionMonitor()
        m.note_tool_result_error(SHELL_SOURCE_READ, None, tool_names=[""])
        self.assertEqual(m.error_signature_streak, 1)

    def test_ledger_read_incident_never_arms_the_guard(self):
        m = proxy.SessionMonitor()
        for _ in range(4):
            m.note_tool_result_error(SHELL_SOURCE_READ, None, tool_names=["read"])
        body = {"messages": [{"role": "user", "content": "go"}], "tool_choice": "auto"}
        proxy._maybe_inject_error_loop_break(body, m)
        self.assertEqual(m.error_loop_fires, 0)
        self.assertEqual(len(body["messages"]), 1)


class KnownFixCoverageTests(unittest.TestCase):
    """The uncovered ledger classes now carry a KNOWN FIX."""

    def test_page_not_found(self):
        fix = proxy.loop_class_fix('{"error": "page not found."}')
        self.assertIn("404", fix)
        self.assertIn("CANNOT work", fix)

    def test_psql_no_password(self):
        fix = proxy.loop_class_fix(WRAPPER_WITH_STDERR)
        self.assertIn("CANNOT work", fix)
        self.assertIn("Do NOT guess passwords", fix)

    def test_missing_pgcrypto(self):
        fix = proxy.loop_class_fix(
            "error: function gen_random_bytes(integer) does not exist"
        )
        self.assertIn("pgcrypto", fix)

    def test_decisive_traceback_signature_gets_no_invented_fix(self):
        self.assertEqual(proxy.loop_class_fix("valueerror: boom"), "")

    def test_original_classes_still_covered(self):
        self.assertIn(
            "byte-for-byte",
            proxy.loop_class_fix(
                "error: edit could not find oldstring in the file. it must match"
            ),
        )
        self.assertIn(
            "does not exist",
            proxy.loop_class_fix(
                'skill "uap-router__react" not found. available skills: adapt'
            ),
        )


class SecretRedactionTests(unittest.TestCase):
    """Signatures flow into ledger records and tail directives the model
    reads, and error text is UNTRUSTED tool output: credential-shaped
    material must be redacted before it can anchor a signature (security
    review 2026-10-18)."""

    def test_key_value_secret_never_survives(self):
        sig = proxy._error_signature("error: password=hunter2 rejected")
        self.assertNotIn("hunter2", sig)
        self.assertIn("<secret>", sig)

    def test_aws_access_key_never_survives(self):
        # Built at runtime: the AWS-docs example key must not sit as one whole
        # literal in the source or the repo's own secret scanner flags the
        # test itself (prepass [aws-access-key], 2026-10-18).
        aws_key = "AKIA" + "IOSFODNN7EXAMPLE"
        sig = proxy._error_signature("error: invalid access key " + aws_key)
        self.assertNotIn(aws_key.lower(), sig)
        self.assertIn("<secret>", sig)

    def test_url_credentials_never_survive(self):
        sig = proxy._error_signature(
            "fatal: https://admin:hunter2@db.internal:5432 refused"
        )
        self.assertNotIn("hunter2", sig)
        self.assertNotIn("admin", sig)

    def test_high_entropy_token_never_survives(self):
        token = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"
        sig = proxy._error_signature("auth failed: bearer " + token)
        self.assertNotIn(token.lower(), sig)
        self.assertIn("<secret>", sig)


class ClockBannerTests(unittest.TestCase):
    """A clock-banner prefix normalizes to a shared "#:#:#" shape that
    unrelated runs would collide on; _first_meaningful_signature strips it
    rather than keying on it (code-quality review 2026-10-18)."""

    def test_banner_prefix_is_stripped_not_keyed_on(self):
        sig = proxy._first_meaningful_signature(
            "[12:34:56] error: command failed (exit code: 1)\n"
            "[12:34:57] connection refused by peer"
        )
        self.assertEqual(sig, "connection refused by peer")

    def test_a_line_that_is_only_a_banner_names_nothing(self):
        self.assertEqual(proxy._first_meaningful_signature("[12:34:56]"), "")
        self.assertEqual(proxy._first_meaningful_signature("12:34:56.789"), "")


class DeclaredFlagWrapperTests(unittest.TestCase):
    """The flagged-path fallback must route through the same first-meaningful
    ladder: a declared wrapper-only failure is unnameable and must NOT
    re-manufacture a content-free signature (code-quality review 2026-10-18,
    probed live)."""

    def test_declared_flag_on_wrapper_only_forms_no_signature(self):
        m = proxy.SessionMonitor()
        m.note_tool_result_error(WRAPPER_ONLY, True, tool_names=["bash"])
        self.assertEqual(m.error_signature_streak, 0)
        self.assertEqual(m.last_error_signature, "")

    def test_declared_flag_on_wrapper_with_stderr_anchors_on_stderr(self):
        m = proxy.SessionMonitor()
        m.note_tool_result_error(WRAPPER_WITH_STDERR, True, tool_names=["read"])
        self.assertEqual(m.error_signature_streak, 1)
        self.assertTrue(m.last_error_signature.startswith("psql: "))

    def test_declared_flag_on_wrapper_with_output_anchors_on_output(self):
        m = proxy.SessionMonitor()
        m.note_tool_result_error(WRAPPER_WITH_OUTPUT, True, tool_names=["bash"])
        self.assertEqual(m.last_error_signature, "compiling main.c")

    def test_declared_unnameable_failure_is_still_owned_by_doubling(self):
        # No signature streak is correct -- but the identical-call shape must
        # stay counted somewhere (architect review 2026-10-18).
        m = proxy.SessionMonitor()
        m.note_doubling_signal("Bash:abcd1234", WRAPPER_ONLY, result_error=True)
        m.note_doubling_signal("Bash:abcd1234", WRAPPER_ONLY, result_error=True)
        self.assertEqual(m.doubling_streak, 2)


if __name__ == "__main__":
    unittest.main()
