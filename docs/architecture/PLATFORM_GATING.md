# Platform Gating

How UAP's policy gate (the DB-driven enforcement that blocks tool calls via
`policies.db` + `.policy-tools/*.py`) is applied across each supported agent
harness, and where harness limits make it advisory.

## Install & validate

```bash
uap hooks install            # all project platforms (Hermes is global → opt-in)
uap hooks install -t hermes  # Hermes (writes global ~/.hermes/config.yaml)
uap hooks doctor             # audit coverage; exits non-zero on gaps
uap setup                    # now also installs hooks (Step 7)
```

The gate script `templates/hooks/uap-policy-gate.sh` is copied into each
platform's hooks dir and registered on that platform's pre-tool event. It reads
the tool payload on stdin, runs the active enforcers, and blocks with `exit 2`
(Claude convention). Hermes uses a wrapper (`uap-policy-gate-hermes.sh`) that
translates `exit 2` into a stdout `{"decision":"block"}` JSON.

## Coverage matrix

| Platform | Tier | Pre-tool mechanism | Config |
|---|---|---|---|
| claude | ✅ gated | `PreToolUse` hooks (Edit/Write/MultiEdit, Bash, Task/Agent/…) | `.claude/settings.local.json` |
| vscode | ✅ gated | same (Claude format) | `.claude/settings.local.json` |
| cursor | ✅ gated | `preToolUse` array | `.cursor/hooks.json` |
| factory | ✅ gated | `PreToolUse` hooks | `.factory/settings.local.json` |
| opencode | ✅ gated | `tool.execute.before` plugin hook (throws to abort) | `.opencode/plugin/uap-session-hooks.ts` |
| omp | ✅ gated | `preToolUsePolicyGate` hook | `.uap/omp/settings.json` |
| hermes | ✅ gated | `pre_tool_call` shell hook (stdout block JSON) | `~/.hermes/config.yaml` (global) |
| codex | ⚠️ MCP-gated | no native pre-tool hook event | `.codex/config.toml` `[mcp_servers.uap]` |
| forgecode | ⚠️ advisory | plugin injects policy context; no block path | `.forge/forgecode.plugin.sh` |

## Harness limits (why two platforms are not hard-gated)

- **Codex** has no pre-tool-use *hook event*, so it can't auto-run the gate
  before every tool. Gating is **hard** for tools routed through the UAP MCP
  server (`execute_tool` runs the PolicyGate) and **advisory** for codex-native
  edit/bash (run `bash .codex/hooks/uap-policy-gate.sh` per AGENTS.md). `hooks
  doctor` reports codex as MCP-gated.
- **ForgeCode**'s plugin surfaces session/compaction lifecycle and injects the
  active-policy list as context, but exposes no pre-tool interception point that
  can *block*. Reported as advisory.

## Hermes specifics

- Config is **global** (`$HERMES_HOME` or `~/.hermes/config.yaml`), so it is
  excluded from the default `uap hooks install` loop and installed explicitly
  with `-t hermes`. `hooks doctor` treats an absent `~/.hermes` as optional, and
  a present-but-unwired install as a real gap.
- Hermes hooks are **fail-open** (a crashing/exit-non-zero/bad-JSON hook lets the
  tool proceed). The UAP Hermes gate therefore always exits 0 and always emits a
  valid decision JSON, so genuine blocks are enforced.
- Hermes prompts once to approve each hook command (stored in
  `~/.hermes/shell-hooks-allowlist.json`); approve the UAP gate, or set
  `hooks_auto_accept: true`.
- Hermes has no per-file persona registry, so UAP droids are surfaced via a
  skills bridge (`~/.hermes/uap-skills/uap-experts/SKILL.md`) that routes to
  `uap expert-route` and the MCP `experts.<name>` tools.

## Key files

- Installer + doctor: `src/cli/hooks.ts` (`copyHookScripts`, `installHermesHooks`, `auditPlatform`, `hooksDoctor`, `ALL_TARGETS`).
- Gate scripts: `templates/hooks/uap-policy-gate.sh`, `templates/hooks/uap-policy-gate-hermes.sh`.
- MCP-router gate (codex path): `src/mcp-router/tools/execute.ts:handleExecuteTool`.
- Setup wiring: `src/cli/setup.ts`.
