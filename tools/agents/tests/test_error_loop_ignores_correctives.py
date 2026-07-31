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
"""

import re
from pathlib import Path

PROXY = Path(__file__).resolve().parents[1] / "scripts" / "anthropic_proxy.py"


def _load_signature():
    """Extract _error_signature and its patterns without importing the server."""
    src = PROXY.read_text()
    ns = {"re": re}
    for name in ("_ERROR_LINE_RE", "_HARNESS_CORRECTIVE_RE"):
        start = src.index(f"{name} = re.compile(")
        end = src.index(")\n", src.index("re.", start + 20)) + 1
        exec(src[start:end], ns)  # noqa: S102 - reading our own source, not input
    start = src.index("def _error_signature")
    end = src.index("\n# ---", start)
    exec(src[start:end], ns)  # noqa: S102
    return ns["_error_signature"]


_error_signature = _load_signature()


class TestHarnessCorrectivesAreNotFailures:
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


class TestRealFailuresStillTracked:
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
