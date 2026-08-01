#!/usr/bin/env python3
"""delivery-enforcement enforcer: route substantive coding through `uap deliver`.

Fires on Edit/Write/MultiEdit to source-code files. The intent is that
non-trivial coding work goes through the `uap deliver` convergence loop (which
drives a model to verified completion against the real gates) rather than
ad-hoc hand edits.

DEFAULT mode is BLOCK: substantive source edits must route through `uap deliver`
(set UAP_ENFORCE_DELIVERY=advisory to relax to a logged nudge). Escape hatches
(UAP_DELIVER_ACTIVE / UAP_DELIVER_BYPASS) are always honored:

  UAP_ENFORCE_DELIVERY=block   # direct source edits outside a deliver context
                               # are blocked (exit 2)

Escape hatches (always honored, even in block mode):
  - UAP_DELIVER_ACTIVE=1   set by the deliver loop for its own subprocesses
  - UAP_DELIVER_BYPASS=1   explicit operator override for a sanctioned manual edit

Exempt by construction: non-source files, docs/configs/scripts/policies, test
files (deliver protects those itself), and tooling dot-dirs.
"""
from __future__ import annotations
import os
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _common import emit, parse_cli, repo_root  # noqa: E402

EDIT_OPS = {"Edit", "Write", "MultiEdit", "edit", "write", "multiedit"}

# Only real implementation code is gated.
# EVERY code type is gated. The rule: if it is interpreted, transpiled, or
# compiled — it is code, it must route through deliver, and it must be TESTED to
# validate correct function. A partial list let whole ecosystems escape: `.html`
# omitted meant a 34KB single-file web app was "not source code" and shipped
# ungated (observed live). Pure data/config (.json/.yaml/.toml/.xml/.md) is
# deliberately NOT here — it has no "correct function" to execute.
SOURCE_EXTS = (
    # JS/TS + transpiled web
    ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs",
    ".vue", ".svelte", ".astro",
    # Web deliverables (render/execute in a browser)
    ".html", ".htm", ".css", ".scss", ".sass", ".less", ".styl",
    # Templates (render to output)
    ".ejs", ".hbs", ".handlebars", ".pug", ".jade", ".twig", ".erb",
    ".njk", ".liquid", ".mustache",
    # C / C++ / CUDA / ObjC
    ".c", ".cc", ".cpp", ".cxx", ".c++", ".h", ".hpp", ".hh", ".hxx", ".h++",
    ".inl", ".ipp", ".tpp", ".cu", ".cuh", ".m", ".mm",
    # Rust / Go / Zig / Nim / Crystal / V / D
    ".rs", ".go", ".zig", ".nim", ".cr", ".d",
    # .NET
    ".cs", ".vb", ".fs", ".fsi", ".fsx", ".razor", ".cshtml", ".vbhtml", ".xaml",
    # JVM
    ".java", ".kt", ".kts", ".scala", ".sc", ".groovy", ".gradle",
    ".clj", ".cljs", ".cljc",
    # Python / Ruby / PHP / Perl / Lua
    ".py", ".pyi", ".pyx", ".rb", ".rake", ".php", ".pl", ".pm", ".lua",
    # Functional / BEAM / ML-family
    ".ex", ".exs", ".erl", ".hrl", ".hs", ".lhs", ".ml", ".mli",
    # Mobile / other compiled
    ".swift", ".dart", ".r", ".jl",
    # Shell / scripting (executes)
    ".sh", ".bash", ".zsh", ".fish", ".ps1", ".psm1", ".bat", ".cmd",
    # Assembly
    ".asm", ".s",
    # Contracts / query / schema-as-code / IaC (all execute or provision)
    ".sol", ".sql", ".proto", ".graphql", ".gql", ".tf", ".hcl",
)

# GUI-browser launchers. A model with no validation tooling in reach tries to
# "check its work" by opening a browser (observed: 11 xdg-open/firefox/chromium
# attempts in 40 min, spawning windows on the operator's desktop) — which proves
# nothing and burns turns. Redirect it to `uap verify`, which renders headlessly
# and runs the real visual + behavioral gates.
BROWSER_BINS = (
    "xdg-open", "firefox", "chromium", "chromium-browser", "google-chrome",
    "google-chrome-stable", "chrome", "sensible-browser", "x-www-browser",
    "microsoft-edge", "open",
)

# NOTE: `.worktrees/` is deliberately NOT exempt here. A real `uap deliver` run
# writes into a worktree but sets UAP_DELIVER_ACTIVE=1, which is honored below —
# so legitimate deliver edits still pass. An unconditional `.worktrees/` exemption
# let the model BYPASS deliver entirely by creating a worktree dir and writing
# source straight into it (observed: 24 source files written to
# .worktrees/001-space-shooter/ with no deliver run). Gating it behind the active
# flag closes that hole.
# What stays exempt, and WHY — each is a deliberate carve-out, not an oversight:
#   * agent/enforcement infrastructure (.claude/ .cursor/ .opencode/ .codex/
#     .forge/ .omp/ .uap/ .policy-tools/): the hooks, plugins and enforcers that
#     RUN the gate. Routing them through deliver is a bootstrap deadlock — an
#     agent repairing a broken hook would need that hook to work. These are
#     guarded by enforcement-self-protect (which blocks WEAKENING them) instead.
#   * src/policies/, policies/: the policy definitions themselves — same
#     self-reference; likewise guarded by self-protect rather than by routing.
#   * test/, tests/: the deliberate fast feedback loop (deliver still verifies
#     them via the gate ladder). _is_test_file() covers test files living outside
#     these dirs.
#
# REMOVED 2026-07-13: "scripts/" and "docs/". Shell/Python/etc. under scripts/
# EXECUTES — it is code, so it must route through deliver and be tested like any
# other source. Exempting it left an entire language (shell) silently ungated:
# a model could put its whole implementation in scripts/ and never be validated.
EXEMPT_PREFIXES = (
    ".claude/", ".cursor/", ".opencode/", ".codex/", ".forge/", ".omp/",
    ".uap/", ".policy-tools/",
    "src/policies/", "policies/", "test/", "tests/",
)

# Test files are protected by deliver itself; never gate them here. Covers the
# path markers AND a file whose basename IS a test (e.g. a root-level `test.js`,
# `tests.py`, `spec.ts`, `test_foo.py`, `foo.test.tsx`) — those are the fast
# feedback loop and must not each trigger a full deliver cycle.
TEST_MARKERS = (".test.", ".spec.", "_test.", "test_", "/test/", "/tests/", "/__tests__/", "/spec/", "/specs/")
_TEST_BASENAMES = ("test", "tests", "spec", "specs", "conftest")


def _is_test_file(rel_posix: str) -> bool:
    low = rel_posix.lower()
    if any(m in "/" + low for m in TEST_MARKERS):
        return True
    stem = low.rsplit("/", 1)[-1].rsplit(".", 1)[0]
    return stem in _TEST_BASENAMES or stem.startswith("test") or stem.endswith("test") or stem.endswith("spec")


# Trivial-edit fast-path: a tiny change (a one-line tweak, a constant, a typo)
# does not warrant a full deliver decompose→epics→gates cycle — on a slow local
# executor that is ~10+ min per edit. Below this many changed characters the
# edit is allowed directly (advisory nudge only). UAP_DELIVER_FASTPATH=off
# disables; UAP_DELIVER_TRIVIAL_EDIT_CHARS tunes the threshold.
def _fastpath_on() -> bool:
    # The policy gate's cumulative fast-path (fastpath_gate.py) sets
    # UAP_FASTPATH_ROUTED=1 when a trivial edit has crossed the per-file
    # cumulative budget and must route through deliver. Honor it — otherwise the
    # enforcer's own trivial allowance would independently re-approve the edit
    # and defeat the budget (death-by-a-thousand-small-edits escape).
    if os.environ.get("UAP_FASTPATH_ROUTED") == "1":
        return False
    return os.environ.get("UAP_DELIVER_FASTPATH", "on").lower() not in {"0", "off", "false", "no"}


def _trivial_edit_chars() -> int:
    try:
        return max(0, int(os.environ.get("UAP_DELIVER_TRIVIAL_EDIT_CHARS", "240")))
    except ValueError:
        return 240


def _changed_chars(args: dict) -> int | None:
    """Total changed characters for an Edit/MultiEdit, or None when it can't be
    measured (e.g. a whole-file Write) — None means 'not trivially small'."""
    def pair(o: object, n: object) -> int:
        return len(str(o or "")) + len(str(n or ""))
    if "edits" in args and isinstance(args["edits"], list):
        return sum(
            pair(e.get("old_string") or e.get("oldString"), e.get("new_string") or e.get("newString"))
            for e in args["edits"] if isinstance(e, dict)
        )
    old = args.get("old_string") or args.get("oldString")
    new = args.get("new_string") or args.get("newString")
    if old is not None or new is not None:
        return pair(old, new)
    return None  # Write (full content) — not a trivial edit


def _deliver_lock_holder(root: Path) -> str | None:
    """PID string of a LIVE deliver run holding the project lock, else None."""
    lock = root / ".uap" / "deliver.lock"
    try:
        pid = int((lock.read_text().split("|")[0] or "").strip())
    except (OSError, ValueError):
        return None
    try:
        os.kill(pid, 0)
        return str(pid)
    except OSError:
        return None


def _is_local_model_session() -> bool:
    """True when this session targets a self-hosted/local model endpoint."""
    base = (
        os.environ.get("ANTHROPIC_BASE_URL")
        or os.environ.get("OPENAI_BASE_URL")
        or os.environ.get("UAP_INFERENCE_ENDPOINT")
        or ""
    ).lower()
    return any(h in base for h in ("127.0.0.1", "localhost", "0.0.0.0", "::1"))


# #2/#3a: how a LOCAL-model session is handled under block mode. A plain local
# session deadlocks under strict block (can read, never write -> recon loop,
# observed live). UAP_DELIVER_LOCAL_MODE selects the resolution:
#   advisory (default) -> allow direct writes (fast; the proxy guards the model)
#   deliver            -> keep the block + route:deliver so the change is driven
#                         through `uap deliver` (VERIFIED path; pairs with
#                         UAP_DELIVER_AUTOROUTE)
#   block              -> strict block (no relaxation)
# Back-compat: UAP_DELIVER_LOCAL_ADVISORY=0 maps to "block".
def _local_mode() -> str:
    m = os.environ.get("UAP_DELIVER_LOCAL_MODE", "").lower()
    if m in {"advisory", "deliver", "block"}:
        return m
    adv = os.environ.get("UAP_DELIVER_LOCAL_ADVISORY", "on").lower()
    return "advisory" if adv not in {"0", "off", "false", "no", ""} else "block"


BASH_OPS = {"Bash", "bash", "run_bash", "shell"}

# The delivery gate's own state. The pending log is the replay queue for
# `uap deliver --pending`; the lock and heartbeat are how an in-flight run is
# found, followed, and reclaimed when wedged.
#
# Guarding only `rm <literal path>` would repeat the mistake this whole change
# exists to fix. `: > .uap/pending-deliver.jsonl` is SHORTER than the command it
# blocks and just as destructive, and `rm -rf .uap` takes all three at once. So
# match any destructive verb (or a truncating redirect) against any path under
# `.uap/` that names deliver state — including the directory itself and globs.
_DELIVER_STATE_PATH = (
    r"(?:pending-deliver\.jsonl|deliver\.lock|deliver\.heartbeat"
    r"|pending-[^\s'\"|;&]*|deliver\.[^\s'\"|;&]*|\*[^\s'\"|;&]*)"
)
_DELIVER_STATE_RM_RE = re.compile(
    r"(?:\b(?:rm|unlink|shred|truncate|mv)\b"
    r"|\bfind\b[^|;&\n]*-(?:delete|exec\s+rm)"
    r"|\bgit\s+clean\b"
    r"|(?<![0-9<>])>(?!>))"
    r"[^|;&\n]*?"
    # The inner path is optional INSIDE the slash group so a bare `.uap/`
    # (trailing slash, nothing after) still matches — `rm -rf .uap/` destroys
    # exactly as much as `rm -rf .uap`.
    r"((?:[^\s'\"|;&]*/)?\.uap(?:/(?:" + _DELIVER_STATE_PATH + r")?)?)(?:\s|$|['\"])"
)

# A bash command that WRITES a source file: `> f.ts`, `>> f.ts`, `tee f.ts`,
# `sed -i ... f.ts`. Without this, Edit/Write gating is trivially bypassable —
# `cat > app.js <<EOF` writes source with no deliver run and no validation.
_EXT_ALT = "|".join(e.lstrip(".") for e in SOURCE_EXTS)
_BASH_WRITE_RE = re.compile(
    r"(?:>>?\s*|tee\s+(?:-a\s+)?|sed\s+-i[^\s]*\s+(?:[^|;&]*\s)?)"
    r"['\"]?([^\s'\"|;&>]+\.(?:" + _EXT_ALT + r"))\b",
    re.IGNORECASE,
)
# A browser LAUNCH (not a lookup: `which firefox` / `command -v chrome` are fine).
# Match the browser by BASENAME anywhere a command word can start, so an absolute
# or relative path reaches it too. Anchoring on "name right after the separator"
# let `nohup /home/u/.cloakbrowser/chromium-146/chrome file:///x.html &` walk
# straight through the gate — the invocation the model actually reaches for.
#
# The trailing lookahead requires the bin to be a real COMMAND: followed by
# whitespace-then-an-argument (a URL/file/flag), or a terminator (`firefox &`),
# or end of input. Without it, `open` — a browser bin on macOS — also matched
# Python's `open()` BUILTIN: `json.load(open('f'))` read as "subshell-paren +
# open browser" and hard-blocked read-only diagnostics. A launch always has a
# space before its argument; `open(` is a function call, so it no longer matches.
# `\n` is a command separator too: without it `^` only anchored at offset 0, so a
# launch on the SECOND-or-later line of a multi-line command was invisible —
# `cd app\npython3 -m http.server &\nfirefox http://localhost:8080` walked
# through. Agents emit multi-line bash constantly, so this was a live bypass.
# `(?:\w+=[^\s]*\s+)*` skips leading env assignments: the path group rejects `=`
# and `:`, so `DISPLAY=:0 firefox /tmp/a.html` — the canonical incantation for
# putting a window on the operator's desktop, i.e. exactly what this gate exists
# to stop — was also walking through.
_BROWSER_RE = re.compile(
    r"(?:^|[;&|(\n]|\|\||&&|\bnohup\b|\bsetsid\b|\bexec\b|\bxargs\b|\benv\b|\bnice\b|\btimeout\b|`|\$\()"
    r"\s*(?:\w+=[^\s]*\s+)*(?:[\w./~+-]*/)?(" + "|".join(BROWSER_BINS) + r")(?=\s+[^\s(]|\s*[;&|]|\s*$)",
    re.IGNORECASE,
)
# A lookup is only exempt when the command is EXCLUSIVELY a lookup. Matching on
# PREFIX alone disabled the whole browser scan for the natural probe-then-launch
# sequence `which firefox && firefox /tmp/a.html` — the most likely real bypass
# in this file, and one an agent reaches for without trying to evade anything.
_LOOKUP_RE = re.compile(r"^\s*(?:which|command\s+-v|type|whereis)\b[^;&|\n]*$", re.IGNORECASE)

# Quoted spans and heredoc bodies — blanked before the browser scan so a browser
# NAME that is really a grep PATTERN, an interpreter payload
# (`python -c "...open(...)"`), echoed text, or a heredoc body is not misread as
# a LAUNCH. This was the other half of the false-positive class: a diagnostic
# like `grep -n "GUI browser\|open.*browser" f.py` matched `|open` as "pipe into
# the open browser". Only the shell SURFACE can express a launch.
# The leading `\\.` alternative CONSUMES a backslash-escaped character before it
# can open a span. A naive `'[^']*'` pairs the two ESCAPED apostrophes in
# `echo it\'s done ; firefox a.html ; echo that\'s all`, blanking straight across
# the launch and hiding it — reachable by accident, not just by an evader. The
# escape token is returned unchanged by the substitution (only real quoted spans
# are blanked); ordering matters, so keep `\\.` first.
_QUOTE_SPAN_RE = re.compile(r"\\.|'(?:\\.|[^'])*'|\"(?:\\.|[^\"])*\"", re.DOTALL)
_HEREDOC_RE = re.compile(r"<<-?\s*(['\"]?)([A-Za-z_]\w*)\1.*?^[ \t]*\2[ \t]*$", re.DOTALL | re.MULTILINE)
# Above this size, skip surface-stripping and scan raw: `_HEREDOC_RE`'s lazy
# `.*?` under DOTALL is O(n) per `<<TAG` with no terminator, so a pathological
# ~100KB command could stall the hook. Scanning raw fails toward BLOCKING.
_SURFACE_MAX = 65536


def _shell_surface(cmd: str) -> str:
    """`cmd` with quoted spans and heredoc bodies replaced by spaces, so the
    browser matcher sees only real shell command words.

    Length-preserving ON PURPOSE (blanks, never deletes): `firefox "$URL"` must
    still read as a launch, and it only does because the blanked argument leaves
    whitespace for the trailing lookahead. Returning "" here would silently stop
    blocking every quoted-argument launch — there are tests pinning this.

    A launch inside a quoted SHELL payload (`bash -c "firefox url"`) is invisible
    here by construction — that is what `_shell_payload_launch` below exists to
    catch, as a separate, narrower pass."""
    if len(cmd) > _SURFACE_MAX or ("'" not in cmd and '"' not in cmd and "<<" not in cmd):
        return cmd
    def blank(m: "re.Match[str]") -> str:
        return " " * (m.end() - m.start())

    def blank_spans(m: "re.Match[str]") -> str:
        # Escape tokens (`\'`) pass through untouched — blanking them is
        # unnecessary and they must not be treated as quote spans.
        return m.group(0) if m.group(0).startswith("\\") else blank(m)

    return _QUOTE_SPAN_RE.sub(blank_spans, _HEREDOC_RE.sub(blank, cmd))


# The quoted payload of a SHELL interpreter is itself shell, so a launch inside
# it is a real launch — `bash -c "firefox url"`, `ssh box "chromium x"`. Only
# shell interpreters are listed: python/node/ruby/perl are deliberately ABSENT
# because their -c/-e payload is NOT shell, and excluding them is precisely what
# keeps `python -c "...json.load(open('f'))..."` from re-firing the false
# positive this matcher was fixed for. (A python payload nested inside a bash
# payload is still safe: the inner text is scanned as shell, where `open(` is a
# function call and fails the launch lookahead.)
#
# The interpreter must sit at a real COMMAND POSITION (same prologue as
# `_BROWSER_RE`). Matching it anywhere in the string made the enforcer block its
# own documentation: `git commit -m "stop bash -c 'firefox url' bypassing"`,
# `echo "bash -c chromium ..." >> notes.md`, a README heredoc showing the
# invocation — all DATA, all previously blocked with no escape hatch, because
# this branch runs before the DELIVER_ACTIVE/BYPASS checks.
#
# `-[a-zA-Z]*c` (not `-c`) so combined flags count: `bash -lc "..."` is the
# canonical login-shell form several agent harnesses emit, and `sh -xc` is
# common. Requiring whitespace right after the interpreter NAME keeps `ssh` from
# matching `ssh-keygen -C "firefox comment"`.
_CMD_POS = (
    r"(?:^|[;&|(\n]|\|\||&&|\bnohup\b|\bsetsid\b|\bexec\b|\bxargs\b|\benv\b|\bnice\b|\btimeout\b|`|\$\()"
    r"\s*(?:\w+=[^\s]*\s+)*(?:[\w./~+-]*/)?"
)
_SHELL_PAYLOAD_RE = re.compile(
    _CMD_POS + r"(?:bash|sh|zsh|dash|ksh)\s[^;&|\n]*?-[a-zA-Z]*c\s*(['\"])(.*?)\1"
    r"|" + _CMD_POS + r"eval\s+(['\"])(.*?)\3"
    r"|" + _CMD_POS + r"ssh\s[^;&|\n]*?\s(['\"])(.*?)\5",
    re.IGNORECASE | re.DOTALL,
)


def _shell_payload_launch(cmd: str) -> bool:
    """True when a quoted SHELL-interpreter payload contains a browser launch.

    Heredoc bodies are blanked first: a body is DATA being written to a file (a
    README showing `bash -c "chromium …"`), never a command position. Quotes are
    KEPT so genuine payloads remain scannable."""
    if len(cmd) > _SURFACE_MAX:
        return False
    scan = cmd
    if "<<" in cmd:
        scan = _HEREDOC_RE.sub(lambda m: " " * (m.end() - m.start()), cmd)
    for m in _SHELL_PAYLOAD_RE.finditer(scan):
        payload = m.group(2) or m.group(4) or m.group(6) or ""
        if payload and _BROWSER_RE.search(payload):
            return True
    return False


def _handle_bash(args: dict) -> None:
    """Gate bash so it can't bypass delivery enforcement (source writes) and so a
    model stops trying to 'verify' by opening a GUI browser."""
    cmd = str(args.get("command") or args.get("cmd") or args.get("script") or "")
    if not cmd.strip():
        emit(True, "bash: empty command")
        return

    # Browser launch → redirect to the real (headless) validation path. Always
    # blocked: opening a window proves nothing and cannot gate a DONE claim.
    if not _LOOKUP_RE.match(cmd) and (
        _BROWSER_RE.search(_shell_surface(cmd)) or _shell_payload_launch(cmd)
    ):
        emit(
            False,
            "BLOCKED: do not open a GUI browser to check your work — it proves nothing "
            "and cannot validate anything. Run `uap verify` instead: it renders the page "
            "headlessly and runs the REAL visual + behavioral gates (screenshots land in "
            ".uap/visual). Use that to see whether the UI actually works.",
        )
        return

    # Source write via shell → same rules as an Edit/Write: route through deliver.
    if os.environ.get("UAP_DELIVER_ACTIVE") == "1":
        emit(True, "bash: inside a deliver-driven run")
        return
    if os.environ.get("UAP_DELIVER_BYPASS") == "1":
        emit(True, "bash: UAP_DELIVER_BYPASS override set")
        return
    # Destroying the gate's own state is not a way out of the gate. Observed
    # live 7x on 2026-07-31 (octopus_invaders_v3), interleaved with kill -9 of
    # the running deliver: the queued edit intents were discarded to escape a
    # block rather than completing the work.
    #
    # deliver's own housekeeping is unaffected twice over: it rewrites the
    # pending log in-process (delivery/pending-intents.ts) rather than shelling
    # out, and its subprocesses carry UAP_DELIVER_ACTIVE=1, which returned
    # above. UAP_DELIVER_BYPASS=1 also returned above — operator-set only, since
    # enforcement_self_protect refuses the inline form.
    #
    # This block is deliberately NOT relaxed by UAP_ENFORCE_DELIVERY=advisory:
    # advisory trades verification for speed on an EDIT, but destroying recorded
    # state is not an edit and has no verified-later equivalent.
    sm = _DELIVER_STATE_RM_RE.search(cmd)
    if sm:
        target = sm.group(1)
        if "pending-" in target:
            what = (
                "that is the queue of edit intents deliver replays; removing it "
                "discards recorded work rather than completing it. To apply what "
                "is already queued, run `uap deliver --pending`"
            )
        else:
            what = (
                "that is the single-flight lock/heartbeat; deleting it starts a "
                "SECOND concurrent run on the same tree. A stale lock is "
                "reclaimed automatically by heartbeat age, so it never needs "
                "deleting"
            )
        emit(
            False,
            f"BLOCKED: do not destroy the delivery gate's own state ('{target}') — "
            f"{what}. If a deliver run is in flight, wait for it (deliver tool "
            "with follow:true, or `uap deliver --await-run`).",
        )
        return

    m = _BASH_WRITE_RE.search(cmd)
    if m:
        target = m.group(1)
        mode = os.environ.get("UAP_ENFORCE_DELIVERY", "block").lower()
        if mode == "block" and _is_local_model_session() and _local_mode() == "advisory":
            mode = "advisory"
        msg = (
            f"BLOCKED: do not write source via the shell ('{target}'). Writing files with "
            "a redirect/heredoc/sed/tee bypasses the delivery gate. To create or change "
            "code, call the `deliver` tool (or run: uap deliver \"<one-line description>\"). "
            "Do NOT retry this command."
        )
        if mode == "block":
            emit(False, msg, route="deliver", deliverHint=f"implement the intended change to {target}")
            return
        print(f"[delivery-enforcement advisory] {msg}", file=sys.stderr)
        emit(True, "bash advisory: source-write nudge logged")
        return

    emit(True, "bash: no source write or browser launch")


def main() -> None:
    op, args = parse_cli()
    if op in BASH_OPS:
        _handle_bash(args)
        return
    if op not in EDIT_OPS:
        emit(True, "not a file-edit operation")
        return

    # Accept the file-path key under any common agent spelling: file_path
    # (Claude), filePath (opencode), path/target/filename/file (misc tools).
    # Without filePath, opencode Write/Edit calls slipped through unrecognized.
    target = (
        args.get("file_path") or args.get("filePath") or args.get("path")
        or args.get("target") or args.get("filename") or args.get("file") or ""
    )
    if not target:
        emit(True, "no file path in args")
        return

    root = repo_root()
    try:
        rel = str(Path(target).resolve().relative_to(root))
    except ValueError:
        emit(True, "target outside repo")
        return

    rel_posix = rel.replace(os.sep, "/")
    low = rel_posix.lower()

    if not low.endswith(SOURCE_EXTS):
        emit(True, "not source code")
        return
    if any(rel_posix.startswith(p) for p in EXEMPT_PREFIXES):
        emit(True, f"exempt path: {rel_posix}")
        return
    if _is_test_file(rel_posix):
        emit(True, "test file (fast feedback loop; deliver protects it via gates)")
        return

    # Escape hatches.
    if os.environ.get("UAP_DELIVER_ACTIVE") == "1":
        emit(True, "inside a deliver-driven run")
        return
    if os.environ.get("UAP_DELIVER_BYPASS") == "1":
        emit(True, "UAP_DELIVER_BYPASS override set")
        return

    # A — trivial-edit fast-path: allow a tiny change directly (advisory) rather
    # than paying a full deliver cycle for a one-liner.
    if _fastpath_on():
        changed = _changed_chars(args)
        if changed is not None and changed <= _trivial_edit_chars():
            print(
                f"[delivery-enforcement] trivial edit to '{rel_posix}' "
                f"({changed} chars) — allowed directly; route substantive changes through deliver.",
                file=sys.stderr,
            )
            emit(True, f"trivial edit fast-path ({changed} <= {_trivial_edit_chars()} chars)")
            return

    # B — a deliver run is ALREADY working this project. Do NOT launch another
    # (the lock would reject it anyway) and do NOT let the model keep editing/
    # testing the same code underneath it — tell it to WAIT. route:wait so the
    # autoroute stands down instead of enqueuing a duplicate.
    holder = _deliver_lock_holder(root)
    if holder is not None and os.environ.get("UAP_ENFORCE_DELIVERY", "block").lower() == "block":
        emit(
            False,
            f"WAIT: a `uap deliver` run (pid {holder}) is ALREADY in progress for this project and is "
            f"changing the code — do NOT edit '{rel_posix}', and do NOT re-run tests on it yet. "
            "Let that run finish — follow it with `uap deliver --await-run`, which waits for it "
            "and reports its result without starting anything. Do NOT use --resume on a live run: "
            "resume CONTINUES a mission and would start a second copy of this one. THEN re-verify. "
            "Launching or editing now only conflicts with the in-flight run.",
            route="wait",
            deliverHint="",
        )
        return

    # #3-F: terse, imperative, model-parseable. Weak local models otherwise
    # retry the blocked edit or hallucinate completion ("the files exist") when
    # the message is a passive explanation. State the exact next action.
    msg = (
        f"BLOCKED: do not edit '{rel_posix}' directly. "
        "To create or change code, call the `deliver` tool "
        "(or run: uap deliver \"<one-line description of the change>\"). "
        "Deliver writes the files and verifies them against the gates. "
        "Do NOT retry this edit. Do NOT say the file is written until deliver "
        "reports success. "
        "(Sanctioned manual edit only: set UAP_DELIVER_BYPASS=1.)"
    )

    mode = os.environ.get("UAP_ENFORCE_DELIVERY", "block").lower()
    if mode == "block" and _is_local_model_session():
        # #3a: route-through-deliver keeps the block (route:deliver -> autoroute
        # drives the verified deliver loop); advisory unblocks direct writes.
        if _local_mode() == "advisory":
            mode = "advisory"
    if mode == "block":
        # R1: emit a machine-actionable routing signal so a capable harness can
        # auto-route the blocked change INTO `uap deliver` instead of leaving the
        # agent to flail. `route`/`deliverHint` are advisory extra fields; harness
        # adapters that understand them route, others just show `reason`.
        # P1 (plan D1): carry the blocked edit's ACTUAL content so the harness
        # can record a replayable intent — a vacuous "implement the intended
        # change" hint spawns a blind model run that knows nothing (observed
        # live 2026-07-13). Apply with `uap deliver --pending <file>`.
        intent_payload = {
            k: v
            for k, v in (
                ("old_string", args.get("old_string")),
                ("new_string", args.get("new_string")),
                ("content", args.get("content")),
            )
            if isinstance(v, str)
        }
        emit(
            False,
            msg,
            route="deliver",
            deliverHint=f'implement the intended change to {rel_posix}',
            editIntent=intent_payload or None,
        )
        return

    # Advisory (opt-out): never blocks. Surface the nudge, then allow.
    print(f"[delivery-enforcement advisory] {msg}", file=sys.stderr)
    emit(True, "advisory: nudge logged (block is the default; UAP_ENFORCE_DELIVERY=advisory relaxes)")


if __name__ == "__main__":
    main()