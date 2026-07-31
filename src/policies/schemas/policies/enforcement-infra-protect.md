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

- A broad `-f`/`--full` kill whose pattern is a substring of the stack's own
  argv (`uap`, `llama`, `qwen`, `mmproj`, `nomic`, `anthropic`), or a glob over
  the python interpreter that runs the proxy (`pkill -f "python.*"`).
- A kill held **apart** from its target, however the two are separated: by a
  pipe (`ps aux | grep llama-server | xargs kill -9`), by an infra-port lookup
  feeding it (`lsof -t -i:4000 | xargs kill -9`), by a variable
  (`P=$(pgrep -f llama-server); kill -9 $P`), by a loop
  (`for p in $(pgrep -f llama-server); do kill -9 $p; done`), or by a `-f`
  pattern that is itself an infra port (`pkill -f 8080`).
- A kill whose **bare PID** resolves to a deliver run or the inference stack
  (`kill -9 3936358`, and `kill -9 -3936358`, which kills the whole group).
  This is resolved from `.uap/deliver.lock` and `/proc` rather than from the
  command text, so it cannot be spelled around; a dead or recycled PID is never
  protected.
- The same rules applied to the body of a shell script the command would run —
  moving a stack-restart one level down into a file once slipped past every
  text rule.

**Allowed**: killing a SPECIFIC process by pattern
(`pkill -f "python3 -m http.server 8765"`) and serving your app on any non-infra
port (e.g. `8765`) — **unless the pattern itself carries a stack token**, so
`pkill -f "uap deliver"` is refused. If a deliver run is in flight, wait for it
(deliver tool with `follow:true`, or `uap deliver --await-run`) instead of
killing it: a run that is still working is not stuck, and killing it discards
the work it has already done.

**Known limits.** This is a text gate over a language with unbounded ways to say
the same thing. Obfuscated patterns (`grep '[l]lama-server'`) match the real
process but not these rules; anything routed through `eval` or base64 defeats
every text rule by construction; the script-body scan is depth-1 and shell-only.
The bare-PID rule is the part that resolves rather than reads. Treat the rest as
raising the cost, not as a boundary.

## Why

Observed live (qwen on opencode, 2026-07-12, octopus_invaders_v3): during
playtest loops the model ran `pkill -9 -f python3` (killed the UAP anthropic
proxy), `kill $(lsof -t -i:8080)` (killed `llama-server`), then
`python3 -m http.server 8080` (stole the inference port), driving `llama-server`
into a systemd bind-failure crash loop and `529`-ing its own session. The model
cannot serve requests once it has killed the stack that answers them.

Observed again (2026-07-31, octopus_invaders_v3): the model spent ~50 minutes in
a `ps`/`sleep`/`kill` loop, destroying six of its own in-flight `uap deliver`
runs and restarting them — each kill discarding work the run had already
completed. When its `pkill -f "uap deliver"` was refused at 11:13:46Z it ran the
`xargs kill -9` form **eight seconds later** and reported "cleaned". That is why
the rules above cover the whole family rather than the observed spelling: the
evasion gets found without being sought, and `SIGKILL` runs no exit handler, so
none of it appears in `.uap/deliver-exits.log`.

## Enforcement

Python enforcer `enforcement_infra_protect.py` (Bash/run_bash ops only). Emits a
specific remediation: kill your own processes by exact pattern and serve on a
port other than `8080`/`4000`/`8081`, or — for a live deliver run — wait for it
rather than killing it.

Active by default in every project; this protects the runtime, not a per-project
opt-in. The only override is `UAP_INFRA_PROTECT_OFF=1` set in the launch
**environment** by the operator. An inline `UAP_INFRA_PROTECT_OFF=1 <cmd>` is
deliberately NOT honoured and is separately refused by `enforcement-self-protect`
— an agent that can grant itself the exemption has no control at all.
