---
name: infra-worker
description: Infrastructure worker for systemd services, env files, and process management
---

# Infrastructure Worker

NOTE: Startup and cleanup are handled by `worker-base`. This skill defines the WORK PROCEDURE.

## When to Use This Skill

Features that involve:
- systemd user service configuration
- Environment file updates
- Process management (killing stale processes)
- Service continuity scripts
- Server startup configuration

## Required Skills

None.

## Work Procedure

### 1. Understand the Feature
- Read the feature description and AGENTS.md for key paths
- Read current state of files being modified

### 2. Read Current State
- Read systemd service files: `~/.config/systemd/user/uap-*.service`
- Read env files: `~/.config/uap/*.env`
- Read continuity scripts in the UAP repo
- Check running processes: `ps aux | grep -E '(llama|proxy)' | grep -v grep`

### 3. Make Changes
- Edit service files, env files, and scripts as needed
- Use stable repo-root paths, never worktree-dependent paths
- Ensure all paths referenced in ExecStart, WorkingDirectory, etc. actually exist

### 4. Reload and Test
```bash
# Reload systemd after unit changes
systemctl --user daemon-reload

# Test each service
systemctl --user restart uap-llama-server.service
sleep 45  # wait for model load
systemctl --user status uap-llama-server.service

systemctl --user restart uap-anthropic-proxy.service
sleep 3
systemctl --user status uap-anthropic-proxy.service
```

### 5. Verify End-to-End
- Check health endpoints
- Run a query through the proxy
- Verify no stale processes

### 6. Commit Changes
- Commit any modified scripts/configs in the UAP repo
- Note: systemd units and env files are outside the repo (user-level config)

## Example Handoff

```json
{
  "salientSummary": "Fixed systemd services: updated ExecStart and WorkingDirectory in both unit files from deleted worktree 057 to stable repo-root paths. Updated env files to remove worktree references. Killed stale proxy PID 3642337. Both services now start, run, and survive restart. End-to-end proxy query succeeds.",
  "whatWasImplemented": "Updated uap-llama-server.service ExecStart to use repo-root continuity script path. Updated uap-anthropic-proxy.service WorkingDirectory to /home/cogtek/dev/miller-tech/universal-agent-protocol. Updated llama-server.env LLAMA_CHAT_TEMPLATE_FILE to stable path. Killed stale proxy PID 3642337.",
  "whatWasLeftUndone": "",
  "verification": {
    "commandsRun": [
      {"command": "systemctl --user daemon-reload", "exitCode": 0, "observation": "Reloaded"},
      {"command": "systemctl --user restart uap-llama-server.service", "exitCode": 0, "observation": "Active (running)"},
      {"command": "systemctl --user restart uap-anthropic-proxy.service", "exitCode": 0, "observation": "Active (running)"},
      {"command": "curl http://localhost:4000/v1/messages (tool_use test)", "exitCode": 0, "observation": "Valid tool_use response"},
      {"command": "ps aux | grep anthropic_proxy | grep -v grep | wc -l", "exitCode": 0, "observation": "1 (single process)"}
    ],
    "interactiveChecks": []
  },
  "tests": {"added": []},
  "discoveredIssues": []
}
```

## When to Return to Orchestrator

- systemd service fails to start and root cause is unclear
- env file requires credentials or secrets not available
- Changes would affect other running services
