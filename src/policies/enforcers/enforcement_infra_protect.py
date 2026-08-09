"""enforcement-infra-protect enforcer: the model must not kill or displace the
inference stack it runs on.

Observed live (qwen on opencode, 2026-07-12, octopus_invaders_v3): during game
playtest loops the model ran `pkill -9 -f python3` (killed the UAP anthropic
proxy), `kill $(lsof -t -i:8080)` (killed llama-server), and then
`python3 -m http.server 8080` (stole the inference port, putting llama-server
into a systemd bind-failure crash loop and 529-ing its own session).

Observed again (2026-07-16, octopus_invaders_v3): a deliver cleanup loop ran
`pkill -9 -f "uap"` — a BROAD -f pattern that never names llama-server, yet
matched it anyway because the server's own argv carries the token via
`--slot-save-path ~/.cache/uap/llama-slots`. That killed llama-server 5x in
4 minutes (systemd restart counter 3->6) until the model narrowed the pattern.
Rule 6 closes that gap: any -f/--full kill whose pattern is a substring of the
inference stack's argv (uap/llama/qwen/mmproj/nomic/anthropic) is refused.
Note the stack that a bare interpreter can hit is the PROXY only (python3);
llama-server and embeddings are native binaries, so `node.*` globs are inert
against infra and are left to loop-protection, not this enforcer.

Scope (Bash/bash/run_bash commands only):
  - pkill/killall with a bare-interpreter pattern (matches EVERY python/node).
  - kill/pkill/killall aimed at llama-server / anthropic_proxy / nomic by name.
  - kill-by-port or fuser -k on the infra ports (8080 llama, 4000 proxy,
    8081 embeddings).
  - broad `-f`/`--full` kill whose pattern is a substring of the stack's argv
    (uap/llama/qwen/mmproj/nomic/anthropic) or a glob over the python
    interpreter that runs the proxy.
  - a kill held APART from its target — by a pipe (`ps aux | grep llama-server
    | xargs kill -9`), by an infra-port lookup feeding it (`lsof -t -i:4000 |
    xargs kill -9`), by a variable (`X=$(pgrep -f llama-server); kill -9 $X`),
    or by a `-f` pattern that is an infra port (`pkill -f 8080`) — rule 8.
    Matching is on TEXT, so a token counts wherever it appears; quoted data and
    heredoc bodies are stripped first so prose about a kill is not a kill.
  - a kill whose bare PID resolves to a deliver run or the inference stack
    (`kill -9 3936358`, `kill -9 -3936358`) — rule 9. Resolved from
    .uap/deliver.lock and /proc argv, not from the command text, and only for
    the numbers the command actually names.
  - systemctl stop/restart/kill/disable of the inference services.
  - Starting a server that BINDS an infra port (http.server 8080 etc.) —
    this is how the port got stolen even with kills blocked (the model
    bound the port inside llama-server's crash/restart window).

Killing a SPECIFIC process pattern (e.g. `pkill -f "python3 -m http.server
8765"`) and serving on non-infra ports stay allowed — unless the pattern itself
carries a stack token, so `pkill -f 'uap deliver'` is refused; wait for the run
instead.

KNOWN LIMITS, so nobody reads this as airtight. It is a TEXT gate on a language
with unbounded ways to say the same thing:
  - obfuscated patterns (`grep '[l]lama-server'`, `pkill -f 'llam[a]-server'`)
    match the real process but not these rules;
  - anything routed through `eval`/base64 defeats every text rule by design;
  - the script-body scan is depth-1 and shell-only (`.sh/.bash/.zsh`).
Rule 9 is the part that cannot be spelled around, because it resolves PIDs
rather than reading them. Treat 1-8 as raising the cost, not as a boundary.
"""
import os
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _common import emit, parse_cli, repo_root, scannable_command  # noqa: E402

BASH_OPS = {"Bash", "bash", "run_bash", "shell", "execute_command"}

INFRA_PORTS = r"(8080|4000|8081)"

RULES = (
    # 1) Bare-interpreter pkill/killall (pattern matches EVERY python/node proc)
    re.compile(
        r"\b(pkill|killall)\b(\s+-[A-Za-z0-9-]+)*\s+"
        r"([\"'](python[0-9.]*|node|bun|deno)[\"']"
        r"|(python[0-9.]*|node|bun|deno)(\s|;|\||&|$))"
    ),
    # 2) Kill aimed at the inference services by name
    re.compile(r"\b(pkill|kill|killall)\b[^|;&\n]*(llama-server|anthropic_proxy|nomic)"),
    # 3) Kill by critical port (kill $(lsof -t -i:8080) / fuser -k 8080/tcp)
    re.compile(r"\bkill\b[^|;&\n]*lsof[^|;&\n]*-i[: ]*" + INFRA_PORTS + r"\b"),
    re.compile(r"\bfuser\b[^|;&\n]*-\w*k\w*[^|;&\n]*" + INFRA_PORTS + r"/tcp"),
    # 4) Stopping/restarting the inference services via systemctl
    re.compile(
        r"systemctl\s+(--user\s+)?(stop|restart|kill|disable)\s+\S*"
        r"(uap-llama-server|uap-anthropic-proxy|nomic-embeddings)"
    ),
    # 5) Binding an infra port with a dev/file server
    re.compile(r"http\.server\s+(-[^\s]+\s+)*" + INFRA_PORTS + r"\b"),
    re.compile(
        r"\b(serve|live-server|http-server|vite|webpack-dev-server|next\s+dev|python3?\s+-m\s+flask\s+run)"
        r"\b[^|;&\n]*(--port[= ]|-p[= ]?|:)" + INFRA_PORTS + r"\b"
    ),
    # 6) Broad kill by FULL-cmdline match (-f/--full/-e) whose pattern is a
    #    substring of the inference stack's own argv. The stack carries these
    #    tokens (e.g. --slot-save-path ~/.cache/uap/llama-slots, model 'qwen',
    #    'mmproj', anthropic_proxy). `pkill -9 -f uap` killed llama-server 5x on
    #    2026-07-16 via the 'uap' in its slot path — this is NOT a specific
    #    pattern even though it never names the server.
    re.compile(
        r"\b(pkill|kill|killall)\b[^|;&\n]*"
        r"(\s-(?:-full|[A-Za-z0-9]*f)\b|\s-e\b)"
        r"[^|;&\n]*\b(uap|llama|anthropic|nomic|mmproj|qwen[0-9.]*|llama-slots|slots?[_-]?save)\b"
    ),
    # 7) Same, but a GLOB/regex over the python interpreter that runs the proxy
    #    (`python3 .../anthropic_proxy.py`): `pkill -f "python.*"` sweeps it even
    #    without an explicit infra token. Bare `pkill -f python3` -> rule 1.
    re.compile(
        r"\b(pkill|kill|killall)\b[^|;&\n]*"
        r"(\s-(?:-full|[A-Za-z0-9]*f)\b)"
        r"[^|;&\n]*[\"']?python[0-9.]*[.*\[\]\\]"
    ),
)

# --------------------------------------------------------------------------
# 8) LAUNDERED kills — the verb and its target pulled apart.
#
# Rules 1-7 each scan a single shell SEGMENT (`[^|;&\n]*`), so moving the PID
# list one hop away splits the kill verb from the thing being killed and the
# whole rule set goes blind. Every one of these reached the stack:
#     ps aux | grep llama-server | awk '{print $2}' | xargs kill -9   (pipe)
#     lsof -t -i:4000 | xargs kill -9                                 (pipe)
#     PIDS=$(pgrep -f llama-server); kill -9 $PIDS                    (variable)
#     for p in $(pgrep -f llama-server); do kill -9 $p; done          (loop)
#
# Observed live (2026-07-31, octopus_invaders_v3, qwen on opencode): the model's
# `pkill -f "uap deliver"` was refused at 11:13:46Z and EIGHT SECONDS LATER it
# ran the xargs form and reported "cleaned"; it repeated that at 11:41:53Z. The
# evasion is found without being sought, so closing only the observed spelling
# is not closing anything — the `;` twin is the same thought one keystroke away.
#
# Three passes, all on ONE logical command:
#   a) statement-local: a kill verb plus a stack token / infra-port lookup.
#   b) cross-statement taint: a LOOKUP that names the stack (pgrep/ps/lsof/...)
#      anywhere, plus a kill verb anywhere. This is what catches the `;` and
#      loop forms, where neither half is damning alone.
#   c) a `-f` kill whose pattern IS an infra port (`pkill -f 8080`), which names
#      no token yet matches llama-server's argv.
# Statements split on `;`, `&&`, `||`, newline — never on `|`, since a pipeline
# is one command.
#
# Quoted DATA is stripped first via scannable_command(), which removes heredoc
# bodies and multi-word quoted blobs but keeps single-word quoted arguments, and
# strips nothing when the command hands text to a shell (`bash <<EOF`, `sh -c`,
# `eval`, `xargs`). That kills the false-positive class — a commit message or an
# `echo` describing a kill — WITHOUT opening a heredoc as an evasion. Rules 1-7
# still read the raw text, so `pkill -f "uap deliver"` stays caught by rule 6.
_STATEMENT_SPLIT_RE = re.compile(r";|&&|\|\||\n")
# A kill in COMMAND POSITION, not the word "kill" inside prose or a grep pattern.
# The `xargs` branch is what keeps the pipe form matching.
_KILL_VERB_RE = re.compile(
    r"(?:^|[|;&(`]|\|\||&&|\bxargs\b[^|;&\n]*|\bsudo\b\s+|\bexec\b\s+"
    r"|\bthen\b\s+|\bdo\b\s+|\$\()"
    r"\s*(?:\w+=\S*\s+)*(?:[\w./~-]*/)?(?:p?kill(?:all)?[0-9]*|skill)\b"
)
_LOOKUP_VERB_RE = re.compile(r"\b(?:pgrep|pidof|ps|lsof|fuser|ss|netstat)\b")
_INFRA_TOKEN_RE = re.compile(
    r"\b(uap|llama|llama-server|anthropic|anthropic_proxy|nomic|mmproj"
    r"|qwen[0-9.]*|llama-slots|slots?[_-]?save|deliver)\b",
    re.IGNORECASE,
)
_PORT_LOOKUP_RE = re.compile(
    r"\b(lsof|fuser|ss|netstat)\b[^\n]*?[:\s=]" + INFRA_PORTS + r"\b"
)
# `pkill -f 8080` — the pattern is the port itself; no token, still fatal.
_KILL_PATTERN_PORT_RE = re.compile(
    r"\b(?:p?kill(?:all)?|skill)\b[^|;&\n]*"
    r"(?:\s-(?:-full|[A-Za-z0-9]*f)\b)[^|;&\n]*\b" + INFRA_PORTS + r"\b"
)
# Simple `VAR=value` / `VAR="value"` bindings, substituted before splitting so
# `X=llama-server; pkill -f "$X"` collapses to the form rule 6 already refuses.
# Heuristic by design: no scoping, no command-substitution values. It can only
# ADD matches, never remove one, so it cannot introduce a miss.
_ASSIGN_RE = re.compile(
    r"\b([A-Za-z_]\w*)=(?:\"([^\"]*)\"|'([^']*)'|([^\s;&|]+))"
)


def _expand_assignments(cmd: str) -> str:
    bindings = {
        m.group(1): (m.group(2) or m.group(3) or m.group(4) or "")
        for m in _ASSIGN_RE.finditer(cmd)
    }
    for name, value in bindings.items():
        if value:
            cmd = re.sub(r"\$\{?" + re.escape(name) + r"\}?", value, cmd)
    return cmd


def _laundered_infra_kill(cmd: str) -> bool:
    """True when a command kills the stack with the verb held apart from it.

    The two halves are read from DIFFERENT views of the same command, because
    they fail in opposite directions:

      * the kill VERB is read from scannable_command() — quoted data removed —
        so `-m "…laundered kill of llama-server"` is not mistaken for a kill;
      * the stack TOKEN is read from the RAW text, because the token routinely
        lives inside the quotes that identify the victim
        (`pgrep -f "uap deliver" | while read p; do kill -9 $p; done`). Reading
        tokens from the blanked view lost exactly that form.

    Statement counts are compared before pairing the two views; if blanking
    changed the shape (a heredoc removed lines), fall back to the raw text for
    both, which is the conservative direction.
    """
    raw = _expand_assignments(cmd)
    scannable = _expand_assignments(scannable_command(cmd))
    raw_stmts = _STATEMENT_SPLIT_RE.split(raw)
    kill_stmts = _STATEMENT_SPLIT_RE.split(scannable)
    if len(kill_stmts) != len(raw_stmts):
        kill_stmts = raw_stmts

    kills = [bool(_KILL_VERB_RE.search(s)) for s in kill_stmts]
    for is_kill, stmt in zip(kills, raw_stmts):
        if is_kill and (_INFRA_TOKEN_RE.search(stmt) or _PORT_LOOKUP_RE.search(stmt)):
            return True
    if _KILL_PATTERN_PORT_RE.search(raw):
        return True
    # Cross-statement: a lookup that NAMES the stack, and a kill anywhere.
    if any(kills) and any(
        _LOOKUP_VERB_RE.search(s)
        and (_INFRA_TOKEN_RE.search(s) or _PORT_LOOKUP_RE.search(s))
        for s in raw_stmts
    ):
        return True
    return False


# --------------------------------------------------------------------------
# 9) Kill by BARE PID.
#
# `kill -9 3936358` names nothing, so no text rule can see what it hits. The
# model killed its own in-flight deliver this way six times in one hour on
# 2026-07-31, discarding each run's completed work — the direct cause of ~50
# minutes spent in a ps/sleep/kill loop making no progress.
#
# Resolution is SEMANTIC, not textual, so it cannot be spelled around: the
# numbers the command names are looked up in /proc and compared against the
# deliver lock and the stack's argv. Only the PIDs the command actually names
# are resolved (never a full /proc walk), which is both cheaper and narrower.
#
# A dead PID is never protected, and a lock PID must ALSO still look like a
# deliver run: a crashed run leaves a stale lock, and without the identity check
# whatever process later recycles that number becomes unkillable while the
# refusal says "wait for the deliver run" — recreating the exact stall this rule
# exists to prevent. delivery_enforcement._deliver_lock_holder() has taken the
# same precaution since the PID-reuse incident; this must not diverge from it.
_PID_TOKEN_RE = re.compile(r"(?<![\w.])(-?\d{1,10})(?![\w.-])")
# The label both deliver paths agree on, so the caller has one thing to compare.
DELIVER_LABEL = "the deliver run in progress"

# A deliver PROCESS, by argv. Deliberately separate from _STACK_ARGV_RE: a
# deliver run is protected for a different reason than llama-server, and gets a
# different remedy, so the two must not be told apart by string-matching the
# combined pattern's output.
_DELIVER_ARGV_RE = re.compile(
    r"(\buap\s+deliver\b|(?:cli\.js|uap)\s+(?:\S+\s+)*deliver\b)",
    re.IGNORECASE,
)

_STACK_ARGV_RE = re.compile(
    r"(llama-server|anthropic_proxy|nomic-embed"
    r"|\buap\s+deliver\b|(?:cli\.js|uap)\s+(?:\S+\s+)*deliver\b)",
    re.IGNORECASE,
)
# A pathological command full of integers must not become a syscall storm.
_MAX_PID_CANDIDATES = 32


def _lock_holder_pids() -> dict[str, str]:
    """PIDs claimed by a deliver lock, from the main root AND any worktree.

    deliver writes its lock under the root it was LAUNCHED from, which under
    this repo's mandated worktree workflow is often `.worktrees/NNN-*/`, while
    the gate resolves repo_root() to the main checkout. Reading only the main
    root would leave rule 9's headline case unprotected in the normal workflow.
    """
    holders: dict[str, str] = {}
    roots = [repo_root()]
    try:
        roots.extend(sorted((repo_root() / ".worktrees").glob("*")))
    except Exception:  # noqa: BLE001 - no worktrees dir: main root only
        pass
    for root in roots:
        try:
            text = (root / ".uap" / "deliver.lock").read_text(errors="replace")
        except OSError:
            continue
        m = re.match(r"\s*(\d+)", text)
        if m:
            holders[str(int(m.group(1)))] = DELIVER_LABEL
    return holders


def _identify_pid(pid: str, holders: dict[str, str]) -> str | None:
    """What `pid` actually IS right now, or None if it is nothing to protect."""
    try:
        argv = (
            Path(f"/proc/{pid}/cmdline")
            .read_bytes()
            .replace(b"\0", b" ")
            .decode(errors="replace")
        )
    except OSError:
        return None  # dead: a stale lock protects nothing
    m = _STACK_ARGV_RE.search(argv)
    if pid in holders:
        # Confirm identity too — a recycled PID must not inherit the claim. The
        # claim is "this is the deliver run", so confirm it with the DELIVER
        # pattern: checking the combined stack pattern let a stale lock whose
        # PID had been recycled by llama-server inherit the deliver label, and
        # with it a remedy that does not apply to the stack.
        if _DELIVER_ARGV_RE.search(argv):
            return holders[pid]
        return m.group(1).lower() if m else None
    if not m:
        return None
    # Canonicalise a deliver match to the SAME label the lock-holder path uses.
    # Without this the caller fell through to the inference-stack message, which
    # told the operator that killing their own mission "ends your own session"
    # and pointed at llama-server / the proxy — none of which is true. The
    # lock-holder path only fires when the lock is under THIS repo, so any
    # deliver launched against another project (the usual case) got the wrong
    # message and the wrong remedy.
    if _DELIVER_ARGV_RE.search(argv):
        return DELIVER_LABEL
    return m.group(1).lower()


_PROBE_RE = re.compile(r"\bkill\b\s+(?:-0\b|-s\s+0\b|-s\s+SIGNULL\b)", re.IGNORECASE)


def _only_liveness_probes(text: str) -> bool:
    """True when EVERY kill in `text` is `kill -0` / `kill -s 0` — a probe.

    Signal 0 performs error checking only: it tests whether the PID exists and
    is signalable, and delivers nothing. Refusing it protects nothing and denies
    the cheapest way to ask "is that run still alive?".

    Scoped per STATEMENT, and deliberately so. Testing the whole command instead
    let one probe anywhere switch rule 9 off for every PID in the text, so
    `kill -0 $P && kill -9 $P` — the canonical "kill it if it is alive" idiom,
    and the `if kill -0 …; then kill -9 …; fi` form — reached the stack. Rule 9
    is the ONLY guard on a bare-PID kill (rules 1-8 all need pkill/killall, a
    service name, a -f pattern or a lookup verb), so a whole-text exemption
    turned this module's one un-spell-around-able rule into a text rule whose
    password was two characters. Measured before the fix: all four laundering
    spellings were allowed.
    """
    kills = [
        seg for seg in _STATEMENT_SPLIT_RE.split(text) if _KILL_VERB_RE.search(seg)
    ]
    if not kills:
        return False
    return all(_PROBE_RE.search(seg) for seg in kills)


def _protected_pid_hit(text: str) -> tuple[str, str] | None:
    if not (_KILL_VERB_RE.search(text) and _PID_TOKEN_RE.search(text)):
        return None
    if _only_liveness_probes(text):
        return None
    holders = _lock_holder_pids()
    seen: set[str] = set()
    for m in _PID_TOKEN_RE.finditer(text):
        # `kill -9 -3936358` kills the process GROUP — strictly more
        # destructive, and invisible if the sign is treated as part of the token.
        pid = str(abs(int(m.group(1))))
        if pid in seen:
            continue
        seen.add(pid)
        if len(seen) > _MAX_PID_CANDIDATES:
            break
        what = _identify_pid(pid, holders)
        if what:
            return pid, what
    return None


DELIVER_PID_REASON = (
    "infra-protect: this command kills the deliver run in progress (pid {pid}). "
    "A deliver run that is still working is NOT stuck — killing it discards the "
    "work it has already done and starts the cycle over. Wait for it instead: "
    "call the deliver tool with follow:true, which answers within about a "
    "minute; a 'STILL RUNNING' answer is normal and means keep polling, not "
    "fail. From a shell, `uap deliver --await-run` blocks until the run ends. "
    "If it genuinely must stop, do NOT kill it: request the COOPERATIVE stop "
    "(the dashboard's Cancel, or `touch <projectRoot>/.uap/deliver-runs/<runId>/STOP`) — "
    "the loop observes it at the next turn boundary and exits with its work "
    "checkpointed and the lock released, which a signal does not. "
    "Operator override: set UAP_INFRA_PROTECT_OFF=1 in the launch environment "
    "(not inline on the command)."
)

STACK_PID_REASON = (
    "infra-protect: this command kills {what} (pid {pid}) — the inference stack "
    "answering this session's own requests (llama-server :8080 / UAP proxy "
    ":4000 / embeddings :8081). Killing it ends your own session; it is not a "
    "way to fix a slow response. If the stack genuinely needs restarting, ask "
    "the operator. Operator override: set UAP_INFRA_PROTECT_OFF=1 in the launch "
    "environment (not inline on the command)."
)

REASON = (
    "infra-protect: this command would kill or displace the inference stack this "
    "session runs on (llama-server :8080 / UAP proxy :4000 / embeddings :8081). "
    "Kill only your own processes by SPECIFIC pattern (e.g. pkill -f 'python3 -m "
    "http.server 8765') and serve your app on a port other than 8080/4000/8081 "
    "(e.g. 8765). Operator override: set UAP_INFRA_PROTECT_OFF=1 in the launch "
    "environment (not inline on the command)."
)


# Scripts invoked by the command, e.g. `bash deploy.sh`, `sh ./x.sh`, `./x.sh`,
# `source x.sh`. Every rule above reads the command TEXT, so moving a
# service-restart of the inference stack one level down -- into a file -- slipped
# past all of them. Not theoretical: it was used during this project's own
# sessions to cycle the stack while the gate reported nothing to block.
_SCRIPT_INVOCATION_RE = re.compile(
    r"(?:^|[|;&]|\bsudo\b|\benv\b\s)\s*"
    r"(?:(?:ba|z|k|da)?sh\s+|source\s+|\.\s+)?"
    r"((?:\./|/|~/|\.\./)[^\s;|&<>()'\"]+|[\w./-]+\.(?:sh|bash|zsh))"
)
# Only small local files are worth reading; the cap keeps this off the hot path.
_MAX_SCRIPT_BYTES = 256 * 1024


def _referenced_script_bodies(cmd: str, limit: int = 4) -> list[tuple[str, str]]:
    """(path, contents) for scripts this command would execute.

    Best-effort and deliberately shallow: one level, at most `limit` files, and
    any read error is skipped. A miss must degrade to today's behaviour
    (text-only scanning), never to an exception that takes the whole gate down.
    """
    found: list[tuple[str, str]] = []
    seen: set[str] = set()
    for m in _SCRIPT_INVOCATION_RE.finditer(cmd):
        raw = m.group(1)
        if raw in seen:
            continue
        seen.add(raw)
        try:
            p = Path(raw).expanduser()
            if not p.is_absolute():
                p = Path.cwd() / p
            if not p.is_file() or p.stat().st_size > _MAX_SCRIPT_BYTES:
                continue
            found.append((str(p), p.read_text(errors="replace")))
        except Exception:  # noqa: BLE001 - unreadable/oddly-named file: skip it
            continue
        if len(found) >= limit:
            break
    return found


# Operator escape hatch — ENVIRONMENT ONLY, deliberately.
#
# This is the only enforcer that had no override, which is why every restart of
# the inference stack required the operator to run the command by hand. That is
# defensible for a control whose purpose is to stop the agent cycling the stack
# it runs on, but it also meant an operator who WANTED the agent to restart a
# service had no way to say so.
#
# It reads os.environ and nothing else. It does NOT honour an inline
# `UAP_INFRA_PROTECT_OFF=1 systemctl ...` assignment, unlike expert-review's
# override, because the agent composes its own command strings: an inline form is
# self-grantable and would delete the control rather than delegate it. An
# environment variable is set by whoever launched the session, so honouring only
# that keeps the decision with the operator.
#
# enforcement-self-protect additionally lists this flag among the bypasses the
# agent may not set, so an inline attempt is refused with an explicit message
# instead of silently doing nothing.
OVERRIDE = os.environ.get("UAP_INFRA_PROTECT_OFF") == "1"


def main() -> None:
    operation, args = parse_cli()
    if OVERRIDE:
        emit(True, "UAP_INFRA_PROTECT_OFF=1 set in the launch environment (operator)")
    if operation not in BASH_OPS:
        emit(True, "not a shell operation")
    cmd = str(args.get("command") or "")
    if not cmd:
        emit(True, "no command payload")
    for rule in RULES:
        if rule.search(cmd):
            emit(False, REASON)
    # Rules 8 and 9 apply to the command AND to any script it would run — the
    # script-body pass exists because moving a stack-restart one level down into
    # a file slipped past every text rule once already, and a rule that skips
    # that pass reopens exactly that hole.
    for label, text in [("", cmd), *((f" (matched inside the invoked script {p})", b)
                                     for p, b in _referenced_script_bodies(cmd))]:
        if text is not cmd:
            for rule in RULES:
                if rule.search(text):
                    emit(False, f"{REASON}{label}")
        if _laundered_infra_kill(text):
            emit(False, f"{REASON}{label}")
        hit = _protected_pid_hit(text)
        if hit:
            pid, what = hit
            if what == DELIVER_LABEL:
                emit(False, DELIVER_PID_REASON.format(pid=pid) + label)
            emit(False, STACK_PID_REASON.format(what=what, pid=pid) + label)
    emit(True, "no infra-destructive pattern")


if __name__ == "__main__":
    main()
