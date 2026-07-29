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
  - systemctl stop/restart/kill/disable of the inference services.
  - Starting a server that BINDS an infra port (http.server 8080 etc.) —
    this is how the port got stolen even with kills blocked (the model
    bound the port inside llama-server's crash/restart window).

Killing a SPECIFIC process pattern (e.g. `pkill -f "python3 -m http.server
8765"`) and serving on non-infra ports stay allowed.
"""
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _common import emit, parse_cli  # noqa: E402

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

REASON = (
    "infra-protect: this command would kill or displace the inference stack this "
    "session runs on (llama-server :8080 / UAP proxy :4000 / embeddings :8081). "
    "Kill only your own processes by SPECIFIC pattern (e.g. pkill -f 'python3 -m "
    "http.server 8765') and serve your app on a port other than 8080/4000/8081 "
    "(e.g. 8765)."
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


def main() -> None:
    operation, args = parse_cli()
    if operation not in BASH_OPS:
        emit(True, "not a shell operation")
    cmd = str(args.get("command") or "")
    if not cmd:
        emit(True, "no command payload")
    for rule in RULES:
        if rule.search(cmd):
            emit(False, REASON)
    # Same rules, applied to the body of any script the command would run.
    for path, body in _referenced_script_bodies(cmd):
        for rule in RULES:
            if rule.search(body):
                emit(False, f"{REASON} (matched inside the invoked script {path})")
    emit(True, "no infra-destructive pattern")


if __name__ == "__main__":
    main()
