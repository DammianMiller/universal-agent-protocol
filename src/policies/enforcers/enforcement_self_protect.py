"""enforcement-self-protect enforcer: the model must not be able to disable
the delivery gate.

A weak local model that hits the delivery-enforcement block tends to try to
ESCAPE it — observed live (qwen <think>): "set enforcement to advisory mode",
"just use UAP_DELIVER_BYPASS=1". A single shell `export` does not persist across
tool calls, so the only way to actually weaken the gate is to PERSIST a bypass:
write it into a config/env file, or edit the policy/enforcer itself. This
enforcer blocks exactly those persistence paths.

Scope:
  - Edit/Write/MultiEdit to the enforcement control surface (policy md/enforcers,
    .policy-tools/, .uap.json, proxy env, the policy-gate hook scripts).
  - Bash commands that set/export UAP_DELIVER_BYPASS or relax UAP_ENFORCE_DELIVERY,
    write those to a file, or delete/chmod a policy enforcer.

There is intentionally NO model-reachable bypass: honoring UAP_DELIVER_BYPASS here
would reopen the hole (the model would just set it). Operator override is
out-of-band only: UAP_SELF_PROTECT_OFF=1 in the trusted launch env.
"""
import json
import os
import posixpath
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _common import (  # noqa: E402
    emit, parse_cli, repo_root, REVIEW_ARTIFACT_DIR, REVIEW_WAIVER_DIR,
    hands_text_to_shell, scannable_command,
)

EDIT_OPS = {"Edit", "Write", "MultiEdit", "edit", "write", "multiedit"}

# Path substrings that control delivery enforcement. A write touching any of
# these can weaken the gate, so it is protected regardless of file extension.
PROTECTED_MARKERS = (
    "/.policy-tools/",
    "/src/policies/",
    "/policies/",            # the policy-definition markdown dir
    # The policies DB the gates read. Compliance artifact paths are carved out
    # below, so without this the enforcement registry itself was the soft spot:
    # rewrite the DB and every downstream gate grades a forgery (the pay2u
    # inversion the operator patch fixed out-of-tree).
    "/agents/data/memory/policies.db",
    "/.uap.json",
    "/.uap/",
    "anthropic-proxy.env",
    "uap-policy-gate.sh",
    "uap-reactor-prompt.sh",
    "pre-tool-use",
)

# Bash patterns that persist a bypass or relax enforcement.
BYPASS_PATTERNS = (
    re.compile(r"UAP_DELIVER_BYPASS\s*=\s*['\"]?1", re.I),
    re.compile(r"UAP_ENFORCE_DELIVERY\s*=\s*['\"]?(advisory|off|0|false|no)", re.I),
    re.compile(r"UAP_SELF_PROTECT_OFF\s*=\s*['\"]?1", re.I),
    re.compile(r"UAP_NO_WORKTREE\s*=\s*['\"]?1", re.I),
    re.compile(r"UAP_WORKDIR_SCOPE_OFF\s*=\s*['\"]?1", re.I),
    # infra-protect's hatch is environment-only by design; an inline assignment
    # would be self-grantable, so refuse it here with a clear message rather than
    # letting it look like it worked.
    re.compile(r"UAP_INFRA_PROTECT_OFF\s*=\s*['\"]?1", re.I),
    # expert-review's override is environment-only too, for the same reason: the
    # agent writes its own command strings, so an inline form waives its own
    # review. Refuse it here so the attempt is visible rather than silent.
    re.compile(r"UAP_NO_REVIEW\s*=\s*['\"]?1", re.I),
    # quality-metrics gate hatch, same operator-only shape: the enforcer reads
    # the launch env, so the only agent-reachable move is PERSISTING the flag
    # (rc files, proxy env) — which is exactly what this pattern refuses.
    re.compile(r"UAP_QUALITY_GATE_OFF\s*=\s*['\"]?1", re.I),
    re.compile(r"UAP_USER_VALIDATION\s*=\s*['\"]?0", re.I),
    # Single-flight is a DATA-SAFETY control, not a policy preference: deliver
    # runs each candidate in a git worktree, and two runs against one repo are
    # not safe together. Disabling it cost real work — observed live
    # (octopus_invaders_v3, 2026-07-31): the agent ran
    # `UAP_DELIVER_NO_LOCK=1 uap deliver ...`, two runs overlapped for seven
    # minutes, and the untracked space-shooter/ tree they were both building
    # disappeared. It had never been committed, so nothing could recover it.
    #
    # The env var stays a real operator hatch; only the INLINE form is refused,
    # because a switch the constrained party writes into its own command line is
    # not an override — it is an off switch, the same reasoning as every entry
    # above it.
    re.compile(r"UAP_DELIVER_NO_LOCK\s*=\s*['\"]?1", re.I),
    # The gateless-root refusal exists BECAUSE an agent-driven launch does not
    # honour a warning: the warning shipped, fired, named the right root, and
    # the run went ahead at the gateless root anyway, then spent 34 minutes
    # taking a crate from 1 failing test to 3 while reporting "100% of gates".
    # A hatch the constrained party can write into its own command line is not
    # an override, it is an off switch — same reasoning as every entry above.
    # The CLI-flag spelling is just as self-grantable, but it is matched
    # separately below: a bare flag NAME appears in ordinary prose (docs,
    # commit messages, `grep`), so scanning the raw command for it refused
    # honest work. It runs against `scannable_command`, which blanks quoted
    # blobs, instead.
    re.compile(r"UAP_ALLOW_GATELESS_ROOT\s*=\s*['\"]?1", re.I),
    # Oracle-consistency is the BEHAVIORAL control: the model must not be able
    # to disable the consistency check that ensures its outputs match the
    # acceptance criteria. An inline assignment would let the agent waive its
    # own consistency requirement, so refuse it here.
    re.compile(r"UAP_ORACLE_CONSISTENCY\s*=\s*['\"]?0", re.I),
    # schema-diff's re-entry guard. It exists so a nested gate skips its own
    # inline checker run rather than recursing, and it no longer allows
    # anything on its own -- but it still WEAKENS the gate to its fallback
    # layer, and every other switch of that shape is listed here. An inline
    # assignment is written by the constrained party into its own command
    # line, which is an off switch rather than an override.
    re.compile(r"UAP_SCHEMA_DIFF_INLINE\s*=\s*['\"]?1", re.I),
)

# The gateless-root override in its CLI-flag spelling. Anchored on both sides
# so a longer option that merely starts the same way does not collide, and
# case-sensitive because commander does not accept an upper-case spelling.
GATELESS_FLAG_RE = re.compile(r"(?:^|\s)--allow-gateless-root(?:[=\s]|$)")
# Only a deliver invocation can be bypassed by the flag. `\b` keeps this off
# `src/delivery/`, which merely starts with the same letters.
DELIVER_INVOCATION_RE = re.compile(r"\bdeliver\b")
# Destructive ops against the enforcer/policy surface.
#
# HONEST SCOPE: this is a NUDGE, not a boundary. An agent that can write a file
# and then run it (`Write tmp.sh` + `bash tmp.sh`), or use `python3 -c`, or hide
# a path in a variable, walks straight past anything a regex over shell text can
# see. What this catches is the naive, direct form — which is what was actually
# observed in the wild. The real control is that a missing manifest FAILS under
# max fidelity (see interaction-gate: skipped verdicts block when fidelity.max),
# so deleting the acceptance criteria is not rewarded with a pass.
#
# Matched at COMMAND POSITION, never in prose: `echo "do not rm .uap/x"` is a
# string, not a removal. This repo has already paid for that distinction once
# (5e26c66, "gates must match commands, not prose that mentions them").
DESTRUCTIVE_VERBS = (
    "rm", "unlink", "shred", "truncate", "mv", "chmod", "chown", "chattr",
    "dd", "cp", "tee", "install", "sed", "find", "ln",
)


# Verbs from that list that only mutate under a FLAG. Without one they are
# stdout filters, exactly like `awk` and `grep` -- which this enforcer already
# allows against a protected path, because READING one is not tampering.
#
# Measured on this enforcer (2026-08-20): of six read-only ways to inspect a
# protected file, five were refused -- `sed -n '1,5p'`, `sed 's/a/b/'`, the same
# piped to `wc`, `find <dir> -name '*.py'` and `find <dir> -type f` -- while
# `cat`, `grep`, `head`, `wc` and `awk` were allowed. Those refusals protected
# nothing and cost real work: in one session they blocked READING this file
# twice, blocked `cp <protected> /tmp/` (a read FROM a protected path), and
# blocked a `gh pr close --comment` whose comment text merely quoted a path.
#
# Each predicate answers one question -- "does THIS invocation write?" -- and
# fails CLOSED: an unrecognised short-flag cluster containing `i` counts as a
# write, and any -exec-family action counts as a write, because what it runs
# cannot be judged from the flag alone. A verb NOT listed here is unchanged:
# still unconditionally destructive.
def _sed_writes(tokens) -> bool:
    """GNU sed mutates only with -i / --in-place (optionally suffixed)."""
    for t in tokens:
        if t.startswith("--"):
            if t.startswith("--in-place"):
                return True
            continue
        if t.startswith("-") and len(t) > 1:
            # Short-flag cluster: -i, -i.bak, -ni, -Ei all carry the write.
            # Anything after the first '.' is the backup suffix, not flags.
            if "i" in t[1:].split(".", 1)[0]:
                return True
    return False


def _find_writes(tokens) -> bool:
    """`find` mutates via -delete, an -exec-family action, or an -f* writer."""
    mutating = {"-delete", "-exec", "-execdir", "-ok", "-okdir",
                "-fprint", "-fprint0", "-fprintf", "-fls"}
    return any(t in mutating for t in tokens)


CONDITIONAL_VERBS = {"sed": _sed_writes, "find": _find_writes}

# Paths inside a protected tree that the agent legitimately writes. Without
# these the enforcer deadlocks the workflows it exists to support: the
# expert-review gate REQUIRES writing .uap/reviews/<branch>.json, and the visual
# and interaction gates write their own screenshots and evidence.
PROTECTED_EXEMPT = (
    ".uap/interaction/evidence",
    "policies/waivers",
    # The STOP file is a SIGNAL, not state. It lives under deliver-runs/ and so
    # inherited that directory's protection, which made it un-removable — and a
    # stop request you cannot withdraw is a trap: an unconsumed STOP ends the
    # NEXT run at its first turn boundary, wasting a launch, with no way to
    # clear it by hand.
    #
    # Seen live on 2026-08-10: an agent created one at 20:46:38 and its own
    # `rm -f .uap/deliver-runs/STOP` three seconds later was refused. It cleared
    # only because a run happened to start and consume it. That was luck.
    #
    # Removing it destroys nothing: the checkpoints are the run DIRECTORIES,
    # which stay protected, and writing the file is already allowed — a remedy
    # you can request but not withdraw is half a remedy.
    ".uap/deliver-runs/stop",
)

# Deliberately NARROW inside .uap/: that directory is mostly runtime state the
# tooling writes constantly (verify-cadence, pending-deliver.jsonl, autoroute.log,
# visual screenshots, deliver logs) — the repo's own hook templates do
# `echo 0 > .uap/verify-cadence`. Guarding the whole tree would block the
# project's own plumbing while adding nothing: what must survive is the
# ACCEPTANCE CRITERIA and the project config, not the scratch state.
PROTECTED_TARGETS = (
    ".policy-tools",
    "src/policies",
    "policies/",
    ".uap/interaction",
    # Gate evidence. The rest of .uap/ stays permissive on purpose (the tooling
    # writes runtime state there constantly), but these records are what the
    # plan-time gates accept as proof a required action happened. Leaving them
    # shell-writable meant a single append could satisfy a gate — which is
    # exactly how one was satisfied during development.
    ".uap/evidence",
    # Delivery COORDINATION state. Same argument as the evidence records, and
    # listed individually for the same reason rather than by widening .uap/:
    # the rest of that directory really is scratch the tooling rewrites
    # constantly, but these two are mechanisms, not logs.
    #
    # `deliver.lock` is the single-flight guard. Removing it puts a second
    # mission on the same tree - not hypothetical: two runs on nested roots
    # overwrote each other's edits to src/cooccurrence.rs on 2026-08-08 until
    # it stopped compiling, each one's gate failing on damage the other had
    # just done. On 2026-08-10 an agent ran
    #     rm -f .uap/deliver.lock && uap deliver "<reworded instruction>"
    # to force a relaunch past the guard.
    #
    # `deliver-runs` holds every run's checkpoint - the resumable work itself.
    # Removing that directory was allowed and would discard all of it.
    #
    # Neither ever needs deleting by hand: a lock whose holder is dead or
    # wedged is reclaimed automatically on the next launch, and a run is
    # stopped with the STOP file, which leaves the checkpoint intact.
    ".uap/deliver.lock",
    ".uap/deliver-runs",
    # The heartbeat is part of the SAME guard, and leaving it out left the
    # bypass open one file over. `isDeliverLockAbandoned` treats a MISSING
    # heartbeat plus a lock older than the wedge timeout as abandoned, so
    # deleting it makes a live holder look dead and the next launch reclaims
    # its lock. Verified: with the heartbeat present a two-hour-old lock held
    # by a live pid is abandoned=False; delete it and the same lock is
    # abandoned=True.
    ".uap/deliver.heartbeat",
    # NOT `.uap/pending-deliver.jsonl`, though the delivery-enforcement policy
    # names it alongside these. It is an APPEND-ONLY queue the tooling writes
    # constantly, and the destructive check treats every redirect alike, so
    # protecting it here refuses `echo x >> .uap/pending-deliver.jsonl` — the
    # ordinary way the queue is filled. Caught by the Python enforcer suite
    # (test_gate_evidence), which asserts that exact append stays allowed.
    # Guarding it needs a rule that tells `>>` from `>`; blocking the queue's
    # own writes to protect it is not that rule.
    #
    # The policies DB the gates READ. The inversion this closes: compliance
    # artifact paths (.uap/reviews/) were agent-locked while the DB that
    # decides what is enforced sat unprotected — an agent could delete or
    # rewrite the policy registry instead of complying with it (pay2u operator
    # patch uap-policy-fix-APPLY.sh, upstreamed here). The CLI's own writes go
    # through the `uap policy` process, not agent Edit/Write tools, so policy
    # management is unaffected; what this refuses is the agent deleting or
    # editing the DB directly.
    "agents/data/memory/policies.db",
    ".uap.json",
    "anthropic-proxy.env",
    # F3 (deliver-hardening 2026-07-13): the signed operator-override file.
    # Edit/Write to it is already refused via the "/.uap/" marker, but the
    # destructive check treats every redirect alike and this directory is
    # otherwise permissive — `echo '{deliverBypass:true…}' >
    # .uap/operator-overrides.json` would self-mint the bypass the file exists
    # to restrict to the operator. Only an out-of-band operator writes it; the
    # hook additionally verifies uid/mode/expiresAt before honoring it.
    ".uap/operator-overrides.json",
    # F1: the liveness cache the gate's degrade consult trusts. A forged entry
    # ({healthy:false, degradable:true}) would downgrade a BLOCKING policy to
    # advisory — exactly the sabotage the degrade guard exists to refuse — so
    # the cache must be as unwritable as the verdicts it carries. Legitimate
    # writes go through `uap policy liveness`/`status`, whose command text
    # never names the file (same shape as the policies.db guard).
    ".uap/policy-liveness.json",
)

_SEGMENT_SPLIT = re.compile(r"(?:\|\||&&|[;\n|&])")
_ENV_ASSIGN = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=\S*$")
_QUOTES = str.maketrans("", "", "\"'")


def _mentions_protected(text: str) -> bool:
    """True when any UNIT of `text` names a protected path.

    Judged unit by unit, not over the whole blob. The exemption used to be
    evaluated across the entire text, so one `policies/waivers` anywhere made
    everything else invisible — appending a single innocuous line to a deletion
    list defeated the check completely (found by the review, reproduced).
    """
    for raw_unit in text.translate(_QUOTES).lower().split():
        # Normalise BEFORE matching. `policies/waivers/../../.policy-tools` was
        # exempt by substring while resolving to a protected path, and the old
        # "./" -> "/" rewrite ran first and mangled the `..` segments so a later
        # normpath could not undo it. normpath subsumes that rewrite: it maps
        # "./.uap" -> ".uap", which is what the rewrite existed to do.
        unit = posixpath.normpath(raw_unit) if "/" in raw_unit else raw_unit
        if any(ex in unit for ex in PROTECTED_EXEMPT):
            continue
        # The .uap DIRECTORY ITSELF: `rm -rf .uap` destroys the manifest, while
        # `echo 0 > .uap/verify-cadence` names a deeper path and is ordinary
        # tooling. Bare directory protected; a file under it is not.
        for m in re.finditer(re.escape(".uap"), unit):
            rest = unit[m.end():]
            if rest[:1] in ("", " ", '"', "'", "*"):
                return True
            # `rm -rf .uap/` and `rm -rf .uap/*` name the DIRECTORY, and take
            # evidence, reviews and interaction with it. A deeper path
            # (`.uap/verify-cadence`) is ordinary tooling and stays writable.
            if rest.strip("/") in ("", "*"):
                return True
        for target in PROTECTED_TARGETS:
            t = target.lower()
            for m in re.finditer(re.escape(t), unit):
                if unit[m.end():m.end() + 1] in ("", "/", ".", " ", '"', "'", "*"):
                    return True
    return False


# An argument list is a list of paths; it is never a megabyte. The old 1 MiB cap
# also SKIPPED anything larger, so padding a list file past the cap was a
# one-line bypass. Read a bounded prefix instead of skipping.
_MAX_SRC_BYTES = 1 << 16
_MAX_SOURCES = 32
# Commands whose arguments are literal paths we can read now.
_FILE_READERS = ("cat", "head", "tail", "sort", "uniq", "cut", "tr", "nl", "rev")
_LITERAL_EMITTERS = ("echo", "printf")
# Wrappers that hand their remaining words back to a shell as a command.
_WRAPPERS = ("eval", "env", "exec", "source", ".")
_SHELL_C = re.compile(
    r"(?:^|[\s;|&(])(?:ba|z|k|da|a)?sh\s+(?:-\w+\s+)*-\w*c\s+(['\"])(.*?)\1", re.S)
_REDIRECT = re.compile(r">>?")
_SUBST_FILE = re.compile(r"\$\(\s*(?:cat\s+)?<?\s*([^\s)]+)[^)]*\)|`\s*cat\s+([^`]+)`")
_ARGFILE = re.compile(r"--arg-file=([^\s;|&]+)|(?:^|\s)-a\s+([^\s;|&]+)")
_STDIN_REDIR = re.compile(r"<\s*([^\s;|&<>]+)")



_LAUNCHERS = ("nohup", "timeout", "command", "builtin", "setsid", "sudo", "doas",
              "nice", "ionice", "stdbuf", "time", "unbuffer")
# Producers whose output genuinely cannot be known from the command text.
_SEARCH_PRODUCERS = ("grep", "egrep", "fgrep", "rg", "ag", "ack", "find", "fd",
                     "ls", "comm", "diff", "git", "locate", "which")


def _verb_of(token: str) -> str:
    """The command a token invokes, with quoting and \\-escaping removed."""
    return token.strip("\"'").lstrip("\\").rsplit("/", 1)[-1].lower()


def _has_unknown_producer(command: str) -> bool:
    """True when a pipeline stage feeding a consumer is not a search tool."""
    stages = [s.strip() for s in command.split("|") if s.strip()]
    if len(stages) < 2:
        return False
    for stage in stages[:-1]:
        toks = [t for t in stage.split() if not _ENV_ASSIGN.match(t)]
        if toks and _verb_of(toks[0]) not in _SEARCH_PRODUCERS:
            return True
    return False

def _read_source(tok: str) -> str:
    """A bounded prefix of `tok` if it is a readable regular file, else ""."""
    tok = (tok or "").strip("\"'`$()").rstrip(";|&")
    if not tok or tok.startswith("-"):
        return ""
    try:
        p = Path(tok)
        if not p.is_file():          # excludes FIFOs and devices: no blocking read
            return ""
        with p.open(errors="replace") as fh:
            return fh.read(_MAX_SRC_BYTES)
    except (OSError, ValueError):
        return ""


def _resolved_arguments(command: str) -> list[str]:
    """Text that will actually REACH a command as arguments.

    Only sources knowable right now: a `< file` redirect, xargs --arg-file/-a,
    $(cat f)/`cat f`, and an upstream pipe stage that is a literal emitter
    (echo/printf) or a file reader (cat/head/tail/...).

    Deliberately NOT resolved: `grep … | xargs sed`. grep's output is unknown
    here, and inferring it from the pattern text is exactly what made ordinary
    refactors unrunnable. Unknowable means allow — the same call made for a path
    held in a shell variable.
    """
    out: list[str] = []

    def add(text: str) -> None:
        if text and len(out) < _MAX_SOURCES:
            out.append(text)

    for m in _STDIN_REDIR.finditer(command):
        add(_read_source(m.group(1)))
    for m in _ARGFILE.finditer(command):
        add(_read_source(m.group(1) or m.group(2)))
    for m in _SUBST_FILE.finditer(command):
        add(_read_source(m.group(1) or m.group(2)))

    stages = [s.strip() for s in command.split("|") if s.strip()]
    for stage in stages[:-1]:                       # producers only
        toks = [t for t in stage.split() if not _ENV_ASSIGN.match(t)]
        if not toks:
            continue
        verb = toks[0].rsplit("/", 1)[-1].lower()
        if verb in _LITERAL_EMITTERS:
            add(" ".join(toks[1:]))
        elif verb in _FILE_READERS:
            for t in toks[1:]:
                if not t.startswith("-"):
                    add(_read_source(t))
    return out


def _inner_commands(command: str) -> list[str]:
    """Command strings this command hands back to a shell to execute."""
    out = [m.group(2) for m in _SHELL_C.finditer(command or "")]
    for segment in _SEGMENT_SPLIT.split(command or ""):
        toks = [t for t in segment.split() if not _ENV_ASSIGN.match(t)]
        if toks and toks[0].rsplit("/", 1)[-1].lower() in _WRAPPERS:
            rest = " ".join(toks[1:]).strip().strip("\"'")
            if rest:
                out.append(rest)
    return out


def _destructive_intent(command: str) -> bool:
    """A destructive verb or a redirect appears somewhere in `command`."""
    toks = {t.rsplit("/", 1)[-1].lower().strip("\"'") for t in command.split()}
    return bool(toks & set(DESTRUCTIVE_VERBS)) or bool(_REDIRECT.search(command))


_DELIVER_COORD = (
    ".uap/deliver.lock",
    ".uap/deliver-runs",
    ".uap/deliver.heartbeat",
)


def _mentions_deliver_coord(command: str) -> bool:
    """True when the command names the delivery coordination surface.

    Only chooses the WORDING of a refusal that has already been decided by
    `_bash_destructive`; it never widens or narrows what is refused.
    """
    text = command.translate(_QUOTES).lower()
    return any(t in text for t in _DELIVER_COORD)


# --- Signalling a LIVE deliver run -------------------------------------------
#
# The lock, the run checkpoints and the heartbeat are protected above, but the
# RUN ITSELF was not: `kill <pid>` ended a mission mid-turn and no rule saw it.
#
# Measured 2026-08-11: three consecutive runs reached turn 3, turn 8 and turn 10
# and every one was terminated from outside. The journal caught the exact shape,
# a kill of that run's own pid followed by a cooperative stop request, five
# minutes after launch. Both halves are the caller trying to stop a run; only
# the second keeps the work. The first drops the turn on the floor with the lock
# still held, and it is why "deliver never gets past planning" was believed
# while the runs were in fact working.
#
# Deliberately NARROW. Killing anything else stays allowed - a blanket refusal
# on `kill` would block ordinary process cleanup for no gain. The rule fires
# only when the target is verified to be a live deliver run.

# `kill -0` is a liveness PROBE and must stay allowed: refusing it would break
# the very check that tells a caller whether a run is still alive.
_KILL_RE = re.compile(r"\bkill\s+(?P<flag>-[\w]+\s+)?(?P<pids>[\d\s]+)")
_PKILL_RE = re.compile(r"\b(?:pkill|killall)\b(?P<rest>[^;&|]*)")
_PROBE_SIGNALS = {"-0"}


def _signalled_pids(command: str) -> set:
    """PIDs a command would send a TERMINATING signal to."""
    out = set()
    for m in _KILL_RE.finditer(command or ""):
        if (m.group("flag") or "").strip() in _PROBE_SIGNALS:
            continue
        for tok in (m.group("pids") or "").split():
            if tok.isdigit():
                out.add(int(tok))
    return out


def _cmdline_of(pid: int) -> str:
    try:
        with open("/proc/%d/cmdline" % pid, "rb") as fh:
            return fh.read().replace(b"\x00", b" ").decode("utf-8", "replace")
    except OSError:
        return ""


def _live_deliver_runs(root) -> dict:
    """{pid: runId} for deliver runs that are RUNNING and still alive.

    Verifies the pid against /proc rather than trusting state.json. Pids are
    recycled, and a stale record pointing at a reused pid would otherwise refuse
    an unrelated kill - the same PID-reuse trap that once deadlocked the deliver
    lock. If the process is not a deliver, the record is stale and the kill is
    none of this rule's business.
    """
    runs = {}
    base = Path(root) / ".uap" / "deliver-runs"
    try:
        entries = list(base.iterdir())
    except OSError:
        return runs
    for entry in entries:
        try:
            data = json.loads((entry / "state.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        pid = data.get("pid")
        if not isinstance(pid, int) or data.get("status") != "running":
            continue
        if data.get("exit"):
            continue
        if "deliver" not in _cmdline_of(pid):
            continue
        runs[pid] = str(data.get("runId") or entry.name)
    return runs


def _kills_live_deliver_run(command: str, root) -> str:
    """The runId this command would terminate, or "" when it terminates none."""
    if not command or not re.search(r"\b(?:kill|pkill|killall)\b", command):
        return ""
    live = _live_deliver_runs(root)
    if not live:
        return ""
    for pid in _signalled_pids(command):
        if pid in live:
            return live[pid]
    # Pattern kills name no pid: test the pattern against what the run IS.
    for m in _PKILL_RE.finditer(command):
        for raw in re.findall(r"""["\']([^"\']+)["\']|(\S+)""", m.group("rest") or ""):
            token = (raw[0] or raw[1]).strip()
            if not token or token.startswith("-"):
                continue
            try:
                pat = re.compile(token)
            except re.error:
                continue
            for pid, run_id in live.items():
                if pat.search(_cmdline_of(pid)):
                    return run_id
    return ""


# The two files the gate's TRUST decisions rest on: the signed operator
# override and the liveness cache the degrade consult reads. They get a rule
# the rest of the protected surface does not (deliver-hardening security
# review, 2026-07-13): an INTERPRETER-MEDIATED write —
#   python3 -c 'import json; json.dump({...}, open(".uap/operator-overrides.json","w"))'
# carries no destructive verb, no shell redirect and no UAP_* bypass text, so
# every other scan here walks straight past it — yet a successful write used
# to mint a full bypass. The hook now also requires these files ROOT-owned
# before trusting them, which is the load-bearing fix; this rule is the
# defense-in-depth that stops the write from landing at all. Root ownership
# is what makes this narrow list sufficient — anything else the agent writes
# is distrusted on READ, so it need not be write-blocked here.
_TRUST_ANCHORS = (".uap/operator-overrides.json", ".uap/policy-liveness.json")
_INTERPRETER_RE = re.compile(r"(?:^|[\s;|&('\"`])(?:python\d*(?:\.\d+)?|perl|ruby|node)(?:\s|$)")
# A write primitive in interpreter code: open(…, "w"/"a"/"x"/"+"), or a
# mutating method call. Reads (open without a mode, json.load, print) match
# neither and stay allowed.
_INTERPRETER_WRITE_RE = re.compile(
    r"open\s*\([^)]*[\"'][wax+]|"
    r"\.\s*(?:write\w*|writelines|dump|rename|replace|unlink|remove|removedirs|"
    r"chmod|chown|rmtree|move|copy\w*)\s*\(")


def _interpreter_write_to_anchor(command: str) -> bool:
    """True when an interpreter command names a trust anchor with write intent."""
    lowered = command.lower()
    if not any(anchor in lowered for anchor in _TRUST_ANCHORS):
        return False
    return bool(_INTERPRETER_RE.search(command) and _INTERPRETER_WRITE_RE.search(command))


def _direct_destructive(command: str) -> bool:
    """Destructive op naming a protected path, judged per command segment."""
    cd_into_protected = False
    for segment in _SEGMENT_SPLIT.split(command or ""):
        seg = segment.strip()
        if not seg:
            continue
        # A redirect writes just as destructively as `rm`; the target may be
        # quoted, ./-prefixed, or fd-numbered (`1> .uap/x`).
        for m in _REDIRECT.finditer(seg):
            if _mentions_protected(seg[m.end():]):
                return True
        tokens = [t for t in seg.split() if not _ENV_ASSIGN.match(t)]
        # Step over launchers: `nohup rm -rf x`, `timeout 5 rm -rf x`,
        # `command rm …`, `sudo rm …` all run rm, but the verb read as the
        # launcher and the removal was invisible. Flags and their values are
        # skipped with them.
        while len(tokens) > 1 and _verb_of(tokens[0]) in _LAUNCHERS:
            tokens = tokens[1:]
            while tokens and (tokens[0].startswith("-") or tokens[0].isdigit()):
                tokens = tokens[1:]
        if not tokens:
            continue
        verb = _verb_of(tokens[0])
        # `cd .policy-tools && rm -f _common.py` put the protected path in one
        # segment and the verb in another, so neither segment looked dangerous.
        if verb == "cd":
            cd_into_protected = _mentions_protected(" ".join(tokens[1:]))
            continue
        if verb == "git" and len(tokens) > 1:
            verb = f"git {tokens[1].lower()}"
            if verb not in ("git clean", "git checkout"):
                continue
        elif verb not in DESTRUCTIVE_VERBS:
            continue
        # A conditionally-destructive verb without its write flag is a READ.
        elif verb in CONDITIONAL_VERBS and not CONDITIONAL_VERBS[verb](tokens[1:]):
            continue
        if cd_into_protected or _mentions_protected(" ".join(tokens[1:])):
            return True
    return False


def _bash_destructive(command: str, _depth: int = 0) -> bool:
    """Destructive op against the protected surface, however the target arrives.

    Three ways a target reaches a verb, all of them observed:
      1. on the command line              -> _direct_destructive
      2. through a shell wrapper          -> _inner_commands (bash -c, eval, env)
      3. as resolved arguments            -> _resolved_arguments (xargs, $(cat))

    HONEST LIMIT: shell state this process cannot see still wins. `P=.policy-
    tools; rm $P/x` expands inside the shell, and no scan of command TEXT can
    resolve a VALUE. Refusing every destructive command containing a variable
    would block ordinary work for no real gain, so the residual is accepted and
    covered by the gate's fail-closed and the _common.py self-heal.
    """
    if not command:
        return False
    if _direct_destructive(command):
        return True
    # Checked at EVERY depth (an interpreter write inside `bash -c "..."` is
    # still one) and BEFORE the intent gate below — that gate reads shell
    # verbs, and an interpreter-mediated write to a trust anchor carries none.
    if _interpreter_write_to_anchor(command):
        return True
    if _depth < 2:                       # bounded: `bash -c "bash -c ..."`
        for inner in _inner_commands(command):
            if _bash_destructive(inner, _depth + 1):
                return True
    if not (hands_text_to_shell(command) or "$(" in command or "`" in command):
        return False
    sources = _resolved_arguments(command)
    # Intent can live in the SOURCE rather than the outer text: for
    # `bash -c "$(cat f)"` the outer words are just bash, so judging intent on
    # them alone found nothing while f held both the verb and the target.
    for src in sources:
        if _mentions_protected(src) and (
                _destructive_intent(command) or _destructive_intent(src)):
            return True
    if not _destructive_intent(command):
        return False
    # Nothing resolvable. A SEARCH producer really is unknowable here, and
    # guessing from its pattern text is what blocked ordinary refactors
    # (`grep -rl policies/ docs/ | xargs sed -i …`). An arbitrary producer the
    # agent chose is a different matter: `python3 -c 'print(".policy-tools/x")'
    # | xargs rm` carries the path in plain sight. Fall back to the text only
    # when no producer is a search tool.
    if not sources and _has_unknown_producer(command):
        return _mentions_protected(scannable_command(command))
    return False

OVERRIDE = os.environ.get("UAP_SELF_PROTECT_OFF") == "1"


def _is_protected_path(rel_posix: str) -> bool:
    # Ensure a leading separator so slash-anchored markers ("/policies/",
    # "/src/policies/", …) match only a genuine path SEGMENT. Filename markers
    # ("uap-policy-gate.sh", "anthropic-proxy.env") still match as substrings.
    low = "/" + rel_posix.lower().lstrip("/")
    # Designed-writable escape hatches that live UNDER a protected marker but are
    # NOT part of the delivery-enforcement control surface: expert-review
    # artifacts (.uap/reviews/) and the committable review waiver
    # (policies/waivers/). Writing these satisfies the SEPARATE
    # expert-review-required gate and cannot weaken delivery enforcement — the
    # markers above still guard .uap.json, proxy env, enforcer code and hooks.
    # Without this carve-out the two gates deadlock: expert-review demands an
    # artifact that self-protect forbids writing.
    allow = ("/" + REVIEW_ARTIFACT_DIR + "/", "/" + REVIEW_WAIVER_DIR + "/")
    if any(a in low for a in allow):
        return False
    return any(m in low for m in PROTECTED_MARKERS)


def main() -> None:
    if OVERRIDE:
        emit(True, "self-protect disabled by trusted operator override")

    op, args = parse_cli()

    if op in EDIT_OPS:
        target = args.get("file_path") or args.get("path") or args.get("target") or ""
        if not target:
            emit(True, "no file path in args")
        rp = Path(target).resolve()
        try:
            rel = str(rp.relative_to(repo_root()))
        except ValueError:
            # Out-of-repo writes (e.g. the proxy env in ~/.config) — match by name
            # against the RESOLVED path, never the raw arg: a raw
            # ".uap/reviews/../../anthropic-proxy.env" would otherwise smuggle the
            # allow-list carve-out to reach an out-of-repo control file.
            rel = str(rp)
        rel_posix = rel.replace(os.sep, "/")
        if _is_protected_path(rel_posix):
            emit(
                False,
                "BLOCKED: this file controls delivery enforcement and cannot be "
                f"edited by the agent ('{rel_posix}'). Do not try to disable or "
                "relax the gate — route your change through the `deliver` tool "
                "instead. (Operator-only override: UAP_SELF_PROTECT_OFF=1.)",
            )
        emit(True, "not an enforcement-control file")

    if op in {"Bash", "bash"}:
        cmd = args.get("command") or ""
        # The flag form is checked against the SCANNABLE command, not the raw
        # one: `scannable_command` blanks multi-word quoted blobs, so a commit
        # message or a `uap memory store "..."` that merely NAMES the switch is
        # not refused, while text handed to a shell is left intact and still
        # caught. It must ALSO look like a deliver invocation — the flag does
        # nothing anywhere else, so refusing `rg -- <flag> src/` bought no
        # security and blocked someone auditing the switch.
        _scannable = scannable_command(cmd)
        if GATELESS_FLAG_RE.search(_scannable) and DELIVER_INVOCATION_RE.search(_scannable):
            emit(
                False,
                "BLOCKED: setting a delivery-enforcement bypass/advisory flag is "
                "not allowed for the agent. Route your change through the "
                "`deliver` tool instead of disabling the gate. "
                "(Operator-only override: UAP_SELF_PROTECT_OFF=1.)",
            )
        for pat in BYPASS_PATTERNS:
            if pat.search(cmd):
                emit(
                    False,
                    "BLOCKED: setting a delivery-enforcement bypass/advisory flag is "
                    "not allowed for the agent. Route your change through the "
                    "`deliver` tool instead of disabling the gate. "
                    "(Operator-only override: UAP_SELF_PROTECT_OFF=1.)",
                )
        live_run = _kills_live_deliver_run(cmd, repo_root())
        if live_run:
            emit(
                False,
                "BLOCKED: that signal would kill deliver run %s, which is RUNNING "
                "right now. Killing it drops the turn in flight - its work is lost "
                "and the lock stays held until the next launch reclaims it. "
                "Measured 2026-08-11: three runs were killed this way at turns 3, 8 "
                "and 10 while they were working, and the runs were then reported as "
                "'stuck in planning'. "
                "To STOP it and KEEP the work, request the cooperative stop - "
                "`touch .uap/deliver-runs/STOP` - which ends the run at the next "
                "turn boundary with its checkpoint written and the lock released. "
                "To watch it instead, `uap deliver --await-run` reports live "
                "progress. (Operator-only override: UAP_SELF_PROTECT_OFF=1.)"
                % live_run,
            )
        if _bash_destructive(cmd):
            # Name the SURFACE that was touched. "policy enforcers or proxy env"
            # is simply untrue of a lock file, and a refusal that describes the
            # wrong thing and offers no alternative is how a loop survives a
            # guard: the agent that hit this had been clearing the lock to force
            # a relaunch, seven times, and nothing told it what to do instead.
            if _mentions_deliver_coord(cmd):
                emit(
                    False,
                    "BLOCKED: this removes delivery COORDINATION state. "
                    "`.uap/deliver.lock` is the single-flight guard - deleting it "
                    "does not free anything, it puts a SECOND mission on the same "
                    "tree, and two of them overwrite each other's edits. "
                    "`.uap/deliver-runs/` holds every run's checkpoint, which is "
                    "the work itself. `.uap/deliver.heartbeat` is how a live run is "
                    "told apart from an abandoned one - remove it and the next launch "
                    "reclaims a RUNNING mission's lock. "
                    "You never need to remove either: a lock whose holder is dead "
                    "or wedged is reclaimed automatically by the next launch. "
                    "To STOP a run instead of forcing past it, request the "
                    "cooperative stop - `touch .uap/deliver-runs/STOP` - which "
                    "ends it at the next turn boundary with its work checkpointed "
                    "and the lock released. "
                    "(Operator-only override: UAP_SELF_PROTECT_OFF=1.)",
                )
            emit(
                False,
                "BLOCKED: modifying/removing the policy enforcers or proxy env is "
                "not allowed for the agent.",
            )
        emit(True, "no enforcement-tampering in command")

    emit(True, "not a protected operation")


if __name__ == "__main__":
    main()
