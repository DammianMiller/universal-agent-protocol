"""The ERROR-LOOP guard must not fire on the harness's own correctives.

Observed live (opencode, 2026-07-31). The delivery executor emits control lines
on an "error" channel:

    [agent r6 error] write-nudge injected after 5 read-only rounds

which is the harness telling the model it has been READING too much and must now
WRITE. `_ERROR_LINE_RE` matched it on the word "error", so the corrective entered
the failure streak; after three repeats the ERROR-LOOP guard injected

    "Do NOT make another edit yet. FIRST re-read the ENTIRE failing file ..."

i.e. it told a model already stuck in a read-only loop to read more, fighting the
very nudge it was reacting to. It fired six times in a row against a run that was
making progress.

The distinction the fix encodes: a CORRECTIVE is the harness talking to the model
about its behaviour; an ERROR is a tool reporting that something did not work.
Only the latter belongs in the streak.

The same guard fired again on 2026-07-31, on the opposite side: deliver's
follow-mode poll returns `{"ok":true, ... "It has not failed — this wait gave up,
the mission did not."}`, and the word "failed", inside the sentence saying it had
NOT failed, produced an error signature. See TestSuccessfulResultsAreNotFailures.

NOTE ON THE TEST RUNNER: these classes MUST subclass unittest.TestCase. CI runs
`npm run test:enforcers`, which is `python3 -m unittest <explicit module list>`,
and unittest collects nothing from a plain pytest-style class — this file
reported "Ran 0 tests / NO TESTS RAN" while appearing to be covered. Adding a
class here without TestCase, or adding a module without listing it in
test:enforcers, produces a test that never runs.
"""

import re
import unittest
from pathlib import Path

PROXY = Path(__file__).resolve().parents[1] / "scripts" / "anthropic_proxy.py"


def _load_signature():
    """Extract _error_signature and its patterns without importing the server.

    Takes ONE contiguous slice, from the first pattern through the end of
    _error_signature, rather than cherry-picking names. The previous version
    exec'd a hardcoded list of regexes, so adding a helper to the proxy left the
    test raising NameError against its own source -- the loader had to be edited
    in lockstep with any new dependency."""
    src = PROXY.read_text()
    ns = {"re": re}
    start = src.index("_ERROR_LINE_RE = re.compile(")
    end = src.index("\n# ---", src.index("def _error_signature"))
    exec(src[start:end], ns)  # noqa: S102 - reading our own source, not input
    return ns["_error_signature"]


_error_signature = _load_signature()


class TestHarnessCorrectivesAreNotFailures(unittest.TestCase):
    def test_write_nudge_does_not_enter_the_failure_streak(self):
        # The exact line from the incident.
        assert _error_signature("[agent r6 error] write-nudge injected after 5 read-only rounds") == ""

    def test_other_correctives_are_ignored_too(self):
        for line in (
            "[agent r9 error] forced-write round engaged",
            "[agent r4 error] nudge injected after 5 read-only rounds",
            "deferral-break: model deferred instead of acting",
            "cycle-break engaged",
        ):
            assert _error_signature(line) == "", line

    def test_a_corrective_repeated_never_builds_a_streak(self):
        # The streak is what arms the guard; an empty signature can never match
        # the previous one, so repetition alone cannot fire it.
        line = "[agent r7 error] write-nudge injected after 5 read-only rounds"
        assert {_error_signature(line) for _ in range(6)} == {""}


class TestRealFailuresStillTracked(unittest.TestCase):
    def test_tool_errors_still_produce_a_signature(self):
        for line in (
            "ERROR: TypeError: x is not a function at /a/b.js:12",
            "FAILED tests/foo.test.ts > it works",
            "SyntaxError: Unexpected token",
            "bash: command not found: pytest",
        ):
            assert _error_signature(line) != "", line

    def test_the_same_failure_still_produces_a_stable_signature(self):
        # Edit-invariance is the whole point of the signature: the same failure
        # must match across turns even as line numbers and paths move.
        a = _error_signature("ERROR: TypeError: x is not a function at /src/a.js:12")
        b = _error_signature("ERROR: TypeError: x is not a function at /lib/b.js:940")
        assert a == b != ""

    def test_a_passing_result_resets_the_streak(self):
        assert _error_signature("all tests passed") == ""

    def test_a_corrective_wrapped_around_a_REAL_error_still_counts(self):
        # Only the matched line is inspected, so a genuine failure elsewhere in
        # the same payload must still register — otherwise the exclusion would
        # become a way to hide real errors behind a nudge.
        text = "ERROR: ReferenceError: foo is not defined\n[agent r6 error] write-nudge injected"
        assert _error_signature(text) != ""


# The follow-mode incident, 2026-07-31.
FOLLOW_POLL = (
    '{"ok":true,"dryRun":false,"exitCode":0,"note":"The deliver run (pid 774213) is '
    "STILL RUNNING after 45s. It has not failed — this wait gave up, the mission did "
    "not. This is the NORMAL answer for a mission that takes longer than one poll, and "
    "the run is healthy. Call deliver again with follow:true to keep waiting. Do NOT "
    'kill the deliver process."}'
)


class TestSuccessfulResultsAreNotFailures(unittest.TestCase):
    def test_the_healthy_follow_poll_produces_no_signature(self):
        # Reproduces the incident exactly: "failed", inside the sentence saying
        # it had NOT failed, made a healthy poll look like a failure.
        assert _error_signature(FOLLOW_POLL) == ""

    def test_three_identical_healthy_polls_cannot_arm_the_guard(self):
        # Three was the threshold. This is the whole bug: waiting patiently, as
        # instructed, was what tripped the loop guard.
        assert {_error_signature(FOLLOW_POLL) for _ in range(3)} == {""}

    def test_ok_true_beats_failure_words_anywhere_in_the_note(self):
        assert _error_signature('{"ok":true,"note":"0 tests failed, no errors"}') == ""

    def test_a_populated_error_field_still_counts_despite_ok_true(self):
        # A partial success that still reports an error is one the model needs
        # to see; ok:true must not become a way to launder real failures.
        text = '{"ok":true,"error":"ENOENT: cannot find module foo"}'
        assert _error_signature(text) != ""

    def test_an_empty_error_field_does_not_count(self):
        assert _error_signature('{"ok":true,"error":null,"note":"nothing failed"}') == ""
        assert _error_signature('{"ok":true,"error":"","note":"nothing failed"}') == ""

    def test_ok_false_is_still_a_failure(self):
        text = '{"ok":false,"error":"a deliver run is already in progress"}'
        assert _error_signature(text) != ""


class TestDeniedFailuresInPlainProse(unittest.TestCase):
    def test_a_denial_of_failure_is_not_a_failure(self):
        # No ok:true envelope to consult — the prose itself has to be read.
        for line in (
            "The build has not failed; it is still compiling.",
            "The run did not fail — it is waiting on the model.",
            "Completed with no errors.",
            "Finished without errors.",
        ):
            assert _error_signature(line) == "", line

    def test_a_plain_assertion_of_failure_still_counts(self):
        for line in (
            "The build failed.",
            "ERROR: the run failed after 3 retries",
            "2 tests failed",
        ):
            assert _error_signature(line) != "", line
