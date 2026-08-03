# Platform & Harness Reference

> Universal Agent Protocol (UAP) v1.93.1

> **🏭 Where this fits:** Cross-cutting — the same line, whichever floor you work
> on. **What it delivers:** every station of your [delivery pipeline](../guides/DELIVERY_PIPELINE.md)
> — the guards, the policy gate, the lean-context router — shows up in whichever
> agent harness you already use, so your rules travel with you instead of living
> in one tool.

You shouldn't have to rebuild the factory just because you switched agents. UAP
integrates with 9 agent harnesses so the same enforcement layer follows you
across all of them. The canonical list is `ALL_TARGETS` in `src/cli/hooks.ts`.
Every platform receives the UAP enforcement layer: lifecycle hooks, the
DB-driven policy gate, and (where supported) the hierarchical MCP router.

## Supported platforms

| Target flag | Platform | Config location | Integration style |
|-------------|----------|-----------------|-------------------|
| `claude` | Claude Code | `.claude/settings.local.json` + `.claude/hooks/` | Native hook events |
| `factory` | Factory.AI Droid | `.factory/settings.local.json` + `.factory/hooks/` | Native hook events (`$FACTORY_PROJECT_DIR`) |
| `cursor` | Cursor | `.cursor/hooks.json` + `.cursor/hooks/` | Native hook events |
| `vscode` | VSCode | `.claude/settings.local.json` + `.claude/hooks/` | Claude Code hook format (via third-party skills) |
| `opencode` | OpenCode | `.opencode/plugin/uap-session-hooks.ts` + `.opencode/hooks/` | TypeScript plugin |
| `codex` | Codex CLI | `AGENTS.md`, `.codex/config.toml`, `.codex/hooks/`, `.agents/skills/` | AGENTS.md + skills + MCP server |
| `forgecode` | ForgeCode | `.forge/forgecode.plugin.sh` + `.forge/hooks/` | ZSH plugin |
| `omp` | Oh-My-Pi | `.uap/omp/settings.json` + `.uap/omp/hooks/{pre,post}/` | omp pre/post hook dirs |
| `hermes` | Hermes Agent (NousResearch) | `~/.hermes/config.yaml` + `~/.hermes/agent-hooks/` | **Global** YAML config + MCP |

> **Hermes is global.** Its config lives under `~/.hermes` (or `$HERMES_HOME`),
> so it is excluded from the default project install loop (`PROJECT_TARGETS`).
> Installing it requires an explicit `-t hermes`. `status`/`doctor` still report it.

## Support matrix

| Platform | Lifecycle hooks | Worktree/Bash guards | Policy gate | MCP router |
|----------|-----------------|----------------------|-------------|------------|
| Claude Code | Native | Yes | Hard (PreToolUse) | Yes |
| Factory.AI | Native | Yes | Hard (PreToolUse) | Yes |
| Cursor | Native | Yes | Hard (preToolUse) | Yes |
| VSCode | Native (Claude format) | Yes | Hard (PreToolUse) | Yes |
| OpenCode | Plugin events | Yes | Hard (`tool.execute.before` → exit 2 blocks) | Yes |
| Codex CLI | Advisory (no native pre-tool event) | Advisory | Hard for MCP-routed tools; advisory for native edit/bash | Yes (`[mcp_servers.uap]`) |
| ForgeCode | ZSH plugin | Yes (scripts) | Via gate script | — |
| Oh-My-Pi | pre/post dirs | Yes | Yes (`uap-policy-gate.sh`) | — |
| Hermes | `pre_tool_call` / `on_session_start` | `pre_tool_call` matcher | Hard via `uap-policy-gate-hermes.sh` (emits block JSON) | Yes (`mcp_servers.uap`) |

> **Gating notes.** Codex CLI has no native pre-tool-use hook event, so policy
> gating is **hard** only for tools routed through the UAP MCP server
> (`execute_tool` runs the PolicyGate) and **advisory** for Codex-native
> edit/bash. `uap hooks doctor` reports Codex as MCP-gated. Hermes hooks are
> fail-open by design, but the UAP gate always emits a decision JSON so real
> blocks are enforced; Hermes prompts once to approve each hook command
> (`~/.hermes/shell-hooks-allowlist.json`) unless `hooks_auto_accept: true`.

## Lifecycle hooks installed

The shared hook scripts (copied from `templates/hooks/`) are wired into each
platform's lifecycle events:

| Script | Event | Purpose |
|--------|-------|---------|
| `session-start.sh` | SessionStart | Injects recent memory context. |
| `pre-tool-use-edit-write.sh` | PreToolUse (Edit/Write/MultiEdit) | Worktree file guard — **blocks** edits outside worktree dirs. |
| `pre-tool-use-bash.sh` | PreToolUse (Bash) | Dangerous-command guard — **blocks** force push, `terraform apply`, etc. |
| `uap-policy-gate.sh` | PreToolUse | DB-driven policy gate (`policies.db` + `.policy-tools/*.py`). |
| `post-tool-use-edit-write.sh` | PostToolUse (Edit/Write) | Build gate + backup reminder after edits. |
| `post-tool-use-read.sh` | PostToolUse (Read/Grep/Glob) | Writes `.uap/read_log.state` — the evidence `codebase-read-before-plan` gates on. |
| `pre-compact.sh` | PreCompact | Flushes a compaction marker to memory. |
| `post-compact.sh` | PostCompact | Re-injects policy awareness after compaction. |
| `stop.sh` | Stop | Completion-gate checklist + session cleanup. |
| `session-end.sh` | SessionEnd | Agent deregistration + backup retention. |
| `loop-protection.sh` | — | Loop/spawn protection. |

## Install & verify

```bash
uap hooks install              # install for all PROJECT_TARGETS (excludes hermes)
uap hooks install -t claude    # install for a single platform
uap hooks install -t hermes    # required to install the global Hermes config
uap hooks status               # per-platform script + settings status (all targets)
uap hooks doctor               # health check across all targets
```

The MCP router is configured separately and across all harnesses with:

```bash
uap mcp-setup                  # configure the hierarchical MCP router everywhere
uap mcp-router start           # run the stdio MCP router server
```
