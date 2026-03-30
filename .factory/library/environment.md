# Environment

Environment variables, external dependencies, and setup notes for the Qwen3.5 optimization mission.

**What belongs here:** paths, models, binaries, endpoints, config files, and runtime assumptions.
**What does NOT belong here:** service start/stop commands (use `.factory/services.yaml`).

---

## Key Paths
- Root repo: `/home/cogtek/dev/miller-tech/universal-agent-protocol`
- Mission worktree: `/home/cogtek/dev/miller-tech/universal-agent-protocol/.worktrees/033-proxy-endturn-retry`
- Mission directory: `/home/cogtek/.factory/missions/4c6b8f21-367f-41b5-9c20-e288ab9e735d`
- llama.cpp worktree/binary: `/home/cogtek/llama.cpp/.worktrees/turboquant-cuda-v2/build/bin/llama-server`
- Model: `/home/cogtek/Downloads/Qwen3.5-35B-A3B-UD-IQ4_XS.gguf`

## Runtime Endpoints
- Proxy (preferred end-to-end path): `http://127.0.0.1:4000`
- llama.cpp direct runtime: `http://127.0.0.1:8080`

## Logs
- Proxy log: `/home/cogtek/anthropic-proxy-relaxed.log`
- llama runtime stdout log: `/home/cogtek/llama-server-stable.out`
- llama structured/server log: `/tmp/turboquant-v2-best.log`

## Client / Config Surfaces To Tune
- `opencode.json`
- `.opencode/config.json`
- `~/.opencode/plugin/*.ts` when real-client bootstrap failures are part of the assigned mission feature
- `tools/agents/scripts/anthropic_proxy.py`
- local llama.cpp launch flags and continuity scripts

## Setup Notes
- No external credentials are needed beyond local placeholder API keys already used for the local stack.
- The worktree does not contain its own `node_modules`; init creates a symlink to the root repo dependencies when needed.
- Prefer `127.0.0.1` over `192.168.1.165` for this mission unless a feature proves a different route is required.

## Current Client Config Facts
- The committed `.opencode/config.json` on this branch is normalized to `http://127.0.0.1:4000/v1` for the local proxy-backed path.
- The same config no longer includes the old `prompt_settings.settings_file` field that earlier mission notes referenced.

## Known Config Caveat
- `.opencode/config.json` declares `"$schema": "./config.schema.json"`, but no local `.opencode/config.schema.json` file exists in this worktree. Workers validating config changes should rely on runtime/tests rather than assuming a local schema file is present.
- The real client path may also load user-level plugins from `~/.opencode/plugin/*.ts`; recent benchmark evidence showed repeated bootstrap failures there (`fn3 is not a function`), so workers must treat that directory as a live runtime input when the assigned feature scopes it in.

## Remaining Validation Caveat
- Even with the client path normalized to `127.0.0.1`, workers must still prove the exact benchmark workflow from real transcripts; config text alone is not evidence that the session-stability contract is satisfied.
