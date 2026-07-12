# enforcement-infra-protect

**Category**: safety
**Level**: REQUIRED
**Enforcement Stage**: pre-exec
**Tags**: infra, inference, safety, self-preservation, ports, processes

## Rule

A `Bash`/`run_bash` command that would **kill or displace the inference stack
the session runs on** is blocked:

- `pkill`/`killall` with a bare interpreter pattern (`python`, `python3`, `node`,
  `bun`, `deno`) — matches EVERY such process, including the UAP proxy and any
  agent tooling.
- `kill`/`pkill`/`killall` aimed at `llama-server`, `anthropic_proxy`, or `nomic`
  by name.
- Kill-by-port against the infra ports — `kill $(lsof -t -i:8080)`,
  `fuser -k 8080/tcp` — for `8080` (llama), `4000` (proxy), `8081` (embeddings).
- `systemctl stop|restart|kill|disable` of `uap-llama-server`,
  `uap-anthropic-proxy`, or `nomic-embeddings`.
- Starting a server that **binds** an infra port (`python3 -m http.server 8080`,
  `vite --port 4000`, …) — this is how the port gets stolen even when kills are
  blocked, during the service's crash/restart window.

**Allowed**: killing a SPECIFIC process by pattern
(`pkill -f "python3 -m http.server 8765"`) and serving your app on any non-infra
port (e.g. `8765`).

## Why

Observed live (qwen on opencode, 2026-07-12, octopus_invaders_v3): during
playtest loops the model ran `pkill -9 -f python3` (killed the UAP anthropic
proxy), `kill $(lsof -t -i:8080)` (killed `llama-server`), then
`python3 -m http.server 8080` (stole the inference port), driving `llama-server`
into a systemd bind-failure crash loop and `529`-ing its own session. The model
cannot serve requests once it has killed the stack that answers them.

## Enforcement

Python enforcer `enforcement_infra_protect.py` (Bash/run_bash ops only). Emits a
specific remediation: kill your own processes by exact pattern and serve on a
port other than `8080`/`4000`/`8081`. Always active — this protects the runtime,
not a per-project opt-in.
