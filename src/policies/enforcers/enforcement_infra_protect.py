"""enforcement-infra-protect enforcer: the model must not kill or displace the
inference stack it runs on.

Observed live (qwen on opencode, 2026-07-12, octopus_invaders_v3): during game
playtest loops the model ran `pkill -9 -f python3` (killed the UAP anthropic
proxy), `kill $(lsof -t -i:8080)` (killed llama-server), and then
`python3 -m http.server 8080` (stole the inference port, putting llama-server
into a systemd bind-failure crash loop and 529-ing its own session).

Scope (Bash/bash/run_bash commands only):
  - pkill/killall with a bare-interpreter pattern (matches EVERY python/node).
  - kill/pkill/killall aimed at llama-server / anthropic_proxy / nomic by name.
  - kill-by-port or fuser -k on the infra ports (8080 llama, 4000 proxy,
    8081 embeddings).
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
)

REASON = (
    "infra-protect: this command would kill or displace the inference stack this "
    "session runs on (llama-server :8080 / UAP proxy :4000 / embeddings :8081). "
    "Kill only your own processes by SPECIFIC pattern (e.g. pkill -f 'python3 -m "
    "http.server 8765') and serve your app on a port other than 8080/4000/8081 "
    "(e.g. 8765)."
)


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
    emit(True, "no infra-destructive pattern")


if __name__ == "__main__":
    main()
