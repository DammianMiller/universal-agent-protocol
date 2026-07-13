# pay2u-enforcement-hooks

**Category**: workflow
**Level**: REQUIRED
**Enforcement Stage**: pre-exec
**Tags**: pay2u, hooks, enforcement, example-pack

## Rule

The following enforcement hooks are installed and run automatically:

- **uap-policy-gate.sh** - DB-driven policy gate (policies.db + .policy-tools/*.py)
- **pre-tool-use-edit-write.sh** - Blocks edits outside worktree directories
- **pre-tool-use-bash.sh** - Blocks dangerous commands (force push, terraform apply, etc)
- **post-tool-use-edit-write.sh** - Runs build gate + backup reminder after edits
- **post-compact.sh** - Re-injects policy awareness after context compaction
- **stop.sh** - Completion gate checklist + session cleanup
- **session-end.sh** - Agent deregistration + backup retention

> **Gating note (Codex):** Codex CLI has no native pre-tool-use *hook event*,
> so it cannot auto-run these scripts before every tool the way Claude Code does.
> Policy gating is enforced two ways: (1) **hard** for tools routed through the
> UAP MCP server (`[mcp_servers.uap]` below) — `execute_tool` runs the PolicyGate;
> (2) **advisory** for Codex-native edit/bash — run `bash .codex/hooks/uap-policy-gate.sh`
> per the lifecycle above. `uap hooks doctor` reports Codex as MCP-gated.

## Why

Extracted from AGENTS.md during `uap setup` — a project-specific rule promoted to a reviewable UAP policy.
