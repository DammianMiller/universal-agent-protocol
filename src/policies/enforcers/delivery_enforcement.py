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

ESCALATE mode (`delivery.enforcement: escalate`, or `delivery.localMode:
escalate` for a local-model session under block): deliver is an ESCALATION
POINT, not the path every edit is forced through. Ordinary source edits go
straight to disk (the project's own build/test + the verify hooks judge them)
and the gate routes to `uap deliver` only when the evidence says direct editing
is not working or the change is too big to land unverified:

  - failures : >= delivery.escalateAfterFailures (default 2) consecutive
               verification failures since the last green gate
  - churn    : one file edited >= delivery.escalateAfterEdits (default 10)
               times with no green gate in between (thrashing)
  - complex  : a single edit/write above delivery.complexEditChars (default
               6000) or a whole-file rewrite that guts a substantial file

The evidence lives in .uap/escalation-state.json, written by the
escalation_tracker.py hook (uap verify / stop hook / build+test shell results)
and cleared by any green verification or a landed deliver run.

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
    """The per-edit trivial threshold, from the environment or `.uap.json`.

    Reads the SAME setting the fast-path hook reads
    (`delivery.trivialEditChars`), because the two halves of one gate
    disagreeing about how big a trivial edit is would be worse than either
    number: the hook would fast-path an edit this enforcer then refuses.

    Environment first, so an operator override still wins for one session.
    """
    raw = os.environ.get("UAP_DELIVER_TRIVIAL_EDIT_CHARS")
    if raw is not None:
        try:
            return max(0, int(raw))
        except ValueError:
            pass  # malformed override falls through to the config/default
    try:
        import json as _json
        root = os.environ.get("UAP_MAIN_ROOT") or "."
        cfg = _json.loads((Path(root) / ".uap.json").read_text(encoding="utf-8"))
        value = (cfg.get("delivery") or {}).get("trivialEditChars")
        if isinstance(value, bool):
            return 240              # a bool is not a budget
        if isinstance(value, (int, float)):
            return max(0, int(value))
    except Exception:
        pass  # absent/unreadable config is normal, not an error
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


def _write_cost(args: dict, root: Path) -> int | None:
    """Changed characters for a whole-file Write, or None when it is not small.

    A Write used to be judged only by being a Write: a 120-character new file
    and a 9000-character rewrite were the same answer. That is nature without
    complexity, and it is why creating one small module cost a full
    decompose -> epics -> gates cycle (~10 min on a local executor) while an
    equivalent Edit went straight through.

    Two things make a Write cheap, and BOTH are required:

      - the content is small — same budget as an edit, so there is one number
        to reason about and one env var to tune; and
      - it does not REPLACE substantial existing content. Creating a file, or
        growing a small one, risks little. Overwriting 8000 characters with 120
        is the gutting signature, and the size of what is being destroyed is
        the whole point — measuring only the new content would call the most
        destructive write the cheapest.

    None means "not trivially small", which is what every caller already treats
    as "route it through deliver".
    """
    content = args.get("content")
    if content is None:
        content = args.get("new_string") or args.get("newString")
    if content is None:
        return None
    new_len = len(str(content))
    # No size check here on purpose: the caller already compares the returned
    # cost against the same budget, and applying it twice was provably dead —
    # a mutant deleting this check could not be distinguished by any test,
    # because both paths refuse an oversized write. One place to change the
    # threshold is worth more than an early return that saves one stat().
    try:
        prev_len = (root / _rel_of(args)).stat().st_size
    except (OSError, ValueError, TypeError):
        prev_len = 0  # new file: nothing to destroy
    # Shrinking a substantial file is gutting, however small the new content.
    # Thresholds match the executor's own anti-gutting predicate so the two
    # cannot disagree about the same write.
    if prev_len >= 1500 and new_len < prev_len * 0.35:
        return None
    return new_len


def _rel_of(args: dict) -> str:
    """The write target as given, for a best-effort size lookup."""
    p = args.get("file_path") or args.get("filePath") or args.get("path") or ""
    return str(p)


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
    if m in {"advisory", "deliver", "block", "escalate"}:
        return m
    adv = os.environ.get("UAP_DELIVER_LOCAL_ADVISORY", "on").lower()
    return "advisory" if adv not in {"0", "off", "false", "no", ""} else "block"


def _effective_mode() -> str:
    """The gate posture for THIS operation: block | advisory | off | escalate.

    `UAP_ENFORCE_DELIVERY` (config-authoritative via the policy gate) wins. A
    local-model session under `block` is then resolved through
    `UAP_DELIVER_LOCAL_MODE`: advisory -> advisory, escalate -> escalate,
    deliver/block -> block (keep the route-through-deliver block).
    """
    mode = os.environ.get("UAP_ENFORCE_DELIVERY", "block").lower()
    if mode == "block" and _is_local_model_session():
        lm = _local_mode()
        if lm in {"advisory", "escalate"}:
            return lm
    return mode


# ── ESCALATE mode: evidence-driven routing ───────────────────────────────────
ESCALATION_STATE_FILE = ".uap/escalation-state.json"


def _delivery_cfg_int(root: Path, key: str, env: str, default: int) -> int:
    """An integer budget from the environment, else `.uap.json` delivery.<key>."""
    raw = os.environ.get(env)
    if raw is not None:
        try:
            return max(0, int(raw))
        except ValueError:
            pass
    try:
        import json as _json
        cfg_root = Path(os.environ.get("UAP_MAIN_ROOT") or root)
        cfg = _json.loads((cfg_root / ".uap.json").read_text(encoding="utf-8"))
        value = (cfg.get("delivery") or {}).get(key)
        if isinstance(value, bool):
            return default
        if isinstance(value, (int, float)):
            return max(0, int(value))
    except Exception:
        pass
    return default


def _escalation_state(root: Path) -> dict:
    """The tracker's evidence, or an empty record. Evidence older than
    UAP_DELIVER_ESCALATION_TTL_SEC (default 6h) is ignored: yesterday's red
    build must not gate today's first edit."""
    import json as _json
    import time as _time
    empty = {"failures": 0, "edits_since_green": {}, "last_failure": None}
    try:
        st = _json.loads((root / ESCALATION_STATE_FILE).read_text(encoding="utf-8"))
        if not isinstance(st, dict):
            return empty
    except Exception:
        return empty
    try:
        ttl = int(os.environ.get("UAP_DELIVER_ESCALATION_TTL_SEC", "21600"))
    except ValueError:
        ttl = 21600
    # Age the FAILURE evidence by when it was recorded, not by the last edit:
    # `updated` moves on every direct edit, which would keep a two-day-old red
    # gate alive for as long as the agent keeps typing.
    lf = st.get("last_failure") if isinstance(st.get("last_failure"), dict) else None
    anchor = int((lf or {}).get("ts") or st.get("updated") or 0)
    if ttl > 0 and int(_time.time()) - anchor > ttl:
        return empty
    st.setdefault("failures", 0)
    st.setdefault("edits_since_green", {})
    return st


def _record_escalation_edit(root: Path, rel: str) -> None:
    """Count a direct edit against the file's churn budget (best-effort)."""
    import json as _json
    import time as _time
    path = root / ESCALATION_STATE_FILE
    try:
        st = _json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}
        if not isinstance(st, dict):
            st = {}
    except Exception:
        st = {}
    edits = st.get("edits_since_green") if isinstance(st.get("edits_since_green"), dict) else {}
    edits[rel] = int(edits.get(rel, 0)) + 1
    st["edits_since_green"] = edits
    st["edits_total"] = int(st.get("edits_total") or 0) + 1  # attempt counter (tracker reads it)
    st.setdefault("failures", 0)
    st["updated"] = int(_time.time())
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(_json.dumps(st, indent=1), encoding="utf-8")
        os.replace(tmp, path)
    except Exception:
        pass


def _escalation_trigger(root: Path, rel: str, changed: "int | None", *, size_known: bool = True):
    """(kind, human detail) when this edit must escalate to deliver, else None.

    Order matters: a failing build is the strongest evidence, then thrashing on
    one file, then sheer size. `changed is None` with size_known means a
    whole-file rewrite the cost model refused (gutting) -> complex."""
    st = _escalation_state(root)
    n_fail = int(st.get("failures") or 0)
    fail_budget = _delivery_cfg_int(root, "escalateAfterFailures", "UAP_DELIVER_ESCALATE_FAILURES", 2)
    if fail_budget > 0 and n_fail >= fail_budget:
        lf = st.get("last_failure") or {}
        detail = str(lf.get("detail") or "").strip().replace("\n", " | ")[:400]
        src = str(lf.get("source") or "gate")
        return ("failures", f"{n_fail} consecutive verification failure(s) since the last green gate (last: {src}: {detail or 'no detail'})")
    edits = st.get("edits_since_green") or {}
    n_edits = int(edits.get(rel, 0)) if isinstance(edits, dict) else 0
    churn_budget = _delivery_cfg_int(root, "escalateAfterEdits", "UAP_DELIVER_ESCALATE_EDITS", 10)
    if churn_budget > 0 and n_edits >= churn_budget:
        return ("churn", f"'{rel}' has been edited {n_edits} times with no green gate in between")
    if size_known:
        big = _delivery_cfg_int(root, "complexEditChars", "UAP_DELIVER_COMPLEX_EDIT_CHARS", 6000)
        if changed is None:
            return ("complex", "a whole-file rewrite that replaces most of a substantial file")
        if big > 0 and changed > big:
            return ("complex", f"a {changed}-character change (budget {big}) — a whole module's worth")
    return None


def _escalation_block(rel: str, kind: str, detail: str, args: dict) -> None:
    """Refuse the direct edit and hand the agent the deliver escalation, with
    the evidence that triggered it. Terse and imperative on purpose (weak local
    models retry or hallucinate completion on passive prose)."""
    if kind == "failures":
        msg = (
            f"ESCALATE: {detail}. Direct edits are paused: editing '{rel}' again would repeat "
            "what is not working. Call the `deliver` tool NOW with a one-line task that names the "
            "failing gate and the fix (or run: uap deliver \"fix: <the failure>\"). Deliver "
            "converges the change against the real gates; direct edits resume once it lands or "
            "the gates go green. Do NOT retry this edit."
        )
        hint = f"fix the failing verification and make the gates green: {detail[:240]}"
        intent = None
    elif kind == "churn":
        msg = (
            f"ESCALATE: {detail} — you are thrashing. Stop patching it line by line. Call the "
            "`deliver` tool with a one-line description of the INTENDED END STATE of this file "
            "(what it must do, which tests must pass). Direct edits to it resume after a green "
            "gate. Do NOT retry this edit."
        )
        hint = f"bring {rel} to a working state that passes the project gates"
        intent = None
    else:
        msg = (
            f"ESCALATE: this is {detail}. A change this size must land through the `deliver` "
            "tool (or: uap deliver \"<one-line description>\") so it is verified against the "
            "gates, not trusted blind. Your content is recorded as a replayable intent. Do NOT "
            "retry this edit directly."
        )
        hint = f"implement the intended change to {rel}"
        intent = {
            k: v
            for k, v in (
                ("old_string", args.get("old_string", args.get("oldString"))),
                ("new_string", args.get("new_string", args.get("newString"))),
                ("content", args.get("content")),
            )
            if isinstance(v, str)
        } or None
    emit(False, msg, route="deliver", deliverHint=hint, editIntent=intent, escalation=kind)


def _handle_escalate_edit(args: dict, rel: str, root: Path, changed: "int | None") -> None:
    trig = _escalation_trigger(root, rel, changed)
    if trig is not None:
        _escalation_block(rel, trig[0], trig[1], args)
        return
    _record_escalation_edit(root, rel)
    print(
        f"[delivery-enforcement] escalate mode: direct edit to '{rel}' allowed "
        f"({'whole-file' if changed is None else changed} chars). Verify with the project's "
        "build/test; deliver is the escalation point after repeated gate failures or for "
        "large multi-file work.",
        file=sys.stderr,
    )
    emit(True, "escalate mode: direct edit allowed; deliver is the escalation point")


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
    r"(?:pending-deliver\.jsonl|deliver\.lock|deliver\.heartbeat|escalation-state\.json"
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
        mode = _effective_mode()
        if mode == "escalate":
            # Size is unknowable for a shell write; failures/churn still decide.
            root = repo_root()
            trig = _escalation_trigger(root, target, None, size_known=False)
            if trig is not None:
                _escalation_block(target, trig[0], trig[1], {})
                return
            _record_escalation_edit(root, target)
            emit(True, "escalate mode: shell source write allowed; deliver is the escalation point")
            return
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
        if changed is None:
            # Not an Edit — judge the Write on the same two axes rather than
            # refusing it for being a Write.
            changed = _write_cost(args, root)
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
    if holder is not None and os.environ.get("UAP_ENFORCE_DELIVERY", "block").lower() in {"block", "escalate"}:
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

    # ESCALATE: direct edits land unless the evidence (failed gates, churn,
    # size) says this change needs the convergence loop.
    if _effective_mode() == "escalate":
        changed = _changed_chars(args)
        if changed is None:
            changed = _write_cost(args, root)
        _handle_escalate_edit(args, rel_posix, root, changed)
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
                ("old_string", args.get("old_string", args.get("oldString"))),
                ("new_string", args.get("new_string", args.get("newString"))),
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