# MCP Router Setup Guide

The MCP Router provides **98%+ token reduction** by exposing only 2 meta-tools (`discover_tools`, `execute_tool`) instead of loading 150+ individual tool definitions.

## Quick Start

```bash
# Check configured servers
uap mcp-router list

# Show token savings
uap mcp-router stats

# Discover tools
uap mcp-router discover --query "github issues"

# Start as MCP server (for use with Claude/Cursor)
uap mcp-router start
```

---

## Configuration

### Adding Router to Claude/Cursor

Add this to your MCP client config (Claude Desktop, Cursor, etc.):

```json
{
  "mcpServers": {
    "router": {
      "command": "npx",
      "args": ["uap", "mcp-router", "start"]
    }
  }
}
```

**⚠️ Important**: Do NOT add the router to the config file it reads from!

### Backend Server Configuration

Create a **separate config file** for the backend MCP servers the router should load.

**Option 1: Use existing MCP configs**

The router auto-loads from these locations (in order):

1. `~/.factory/mcp.json` (Factory.AI)
2. `~/.claude/settings.json` (Claude CLI)
3. `~/.config/Code/User/globalStorage/anthropic.claude-code/settings.json` (VS Code)
4. `~/.config/Cursor/User/globalStorage/cursor.mcp/config.json` (Cursor)
5. `~/.config/Claude/claude_desktop_config.json` (Claude Desktop)
6. `./mcp.json` or `./.mcp.json` (local project)

**Option 2: Use a dedicated config file**

```bash
# Create ~/.uap/mcp-backend.json
mkdir -p ~/.uap
cat > ~/.uap/mcp-backend.json << 'EOF'
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["-y", "@playwright/mcp@latest"]
    },
    "chrome-devtools": {
      "command": "npx",
      "args": ["-y", "chrome-devtools-mcp@latest"]
    },
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/user/projects"]
    }
  }
}
EOF

# Then run with custom config
uap mcp-router start --config ~/.uap/mcp-backend.json
```

---

## Configuration Features

### Automatic Filtering

The router automatically excludes:

1. **Disabled servers**: Servers with `"disabled": true`
2. **Self-references**: The router itself (prevents circular reference)

#### Example Config with Filtering

```json
{
  "mcpServers": {
    "router": {
      "command": "npx",
      "args": ["uap", "mcp-router", "start"],
      "disabled": false
    },
    "playwright": {
      "command": "npx",
      "args": ["-y", "@playwright/mcp@latest"],
      "disabled": true
    },
    "chrome-devtools": {
      "command": "npx",
      "args": ["-y", "chrome-devtools-mcp@latest"]
    }
  }
}
```

**Result**: Only `chrome-devtools` is loaded

- `router` → Excluded (self-reference)
- `playwright` → Excluded (disabled)
- `chrome-devtools` → ✅ Loaded

### Environment Variable Expansion

The router supports environment variable expansion in configs:

```json
{
  "mcpServers": {
    "custom-server": {
      "command": "node",
      "args": ["${HOME}/servers/my-server.js"],
      "env": {
        "API_KEY": "${API_KEY:-default_key}",
        "PATH": "$env:PATH"
      }
    }
  }
}
```

Supported patterns:

- `${VAR}` - Simple substitution
- `${VAR:-default}` - With fallback
- `$env:VAR` - PowerShell-style (cross-platform)

---

## Usage

### As an MCP Server

When run with `uap mcp-router start`, the router exposes 2 tools:

#### 1. `discover_tools`

Find MCP tools matching a query.

```typescript
{
  query: string;      // "github issues", "read files", etc.
  limit?: number;     // Max results (default: 10)
  server?: string;    // Filter to specific server
}
```

**Example**:

```json
{
  "query": "github issues",
  "limit": 5
}
```

**Returns**:

```json
{
  "tools": [
    {
      "path": "github.create_issue",
      "name": "create_issue",
      "description": "Create a new GitHub issue",
      "server": "github",
      "score": 0.95
    }
  ],
  "hint": "Use execute_tool with path: github.create_issue"
}
```

#### 2. `execute_tool`

Execute a tool by its path.

```typescript
{
  path: string;              // "server.tool_name" from discover_tools
  args?: Record<string, any>; // Tool-specific arguments
}
```

**Example**:

```json
{
  "path": "github.create_issue",
  "args": {
    "title": "Bug: Router not starting",
    "body": "Router fails to start when..."
  }
}
```

**Returns**:

```json
{
  "success": true,
  "result": {
    /* tool response */
  },
  "toolPath": "github.create_issue",
  "executionTimeMs": 234
}
```

### CLI Commands

#### List Configured Servers

```bash
uap mcp-router list
```

Shows all servers in config (including disabled/filtered ones).

#### Show Token Savings

```bash
uap mcp-router stats
```

Example output:

```
MCP Router Statistics
──────────────────────────────────────────────────
Servers:        2
Tools:          48

Token Usage Comparison
──────────────────────────────────────────────────
Traditional:    24,000 tokens
With Router:    435 tokens
Savings:         98.2%
```

#### Discover Tools

```bash
# Search all servers
uap mcp-router discover --query "github"

# Filter to specific server
uap mcp-router discover --query "create" --server github

# Limit results
uap mcp-router discover --query "file" --limit 3

# JSON output
uap mcp-router discover --query "search" --json
```

---

## Troubleshooting

### Router Tries to Load Itself

**Symptom**: Logs show `[router] router: 2 tools` or startup hangs.

**Cause**: The router is in its own config file.

**Fix**: Remove the router entry from the config it's reading:

```bash
# Edit the config file
nano ~/.factory/mcp.json

# Remove this section:
{
  "mcpServers": {
    "router": { ... }  // ← DELETE THIS
  }
}
```

Or add `"disabled": true`:

```json
{
  "mcpServers": {
    "router": {
      "command": "npx",
      "args": ["uap", "mcp-router", "start"],
      "disabled": true
    }
  }
}
```

### No Tools Found

**Symptom**: `uap mcp-router stats` shows `0 tools`.

**Cause**: No valid backend MCP servers configured.

**Fix**: Add backend servers to config:

```bash
# Check what's configured
uap mcp-router list

# If empty, add servers
cat > ~/.uap/mcp-backend.json << 'EOF'
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["-y", "@playwright/mcp@latest"]
    }
  }
}
EOF

# Test with custom config
uap mcp-router stats --config ~/.uap/mcp-backend.json
```

### Server Fails to Load

**Symptom**: `[router] server-name: failed to load - Error: ...`

**Possible causes**:

1. Server not installed: `npx` will auto-install on first run
2. Invalid command/args: Check server documentation
3. Server requires environment variables: Add to `env` in config

**Debug with verbose output**:

```bash
uap mcp-router stats --verbose
```

---

## Architecture

### Token Reduction Example

**Without Router** (48 tools from 2 servers):

```
Tool definitions: 48 × ~500 tokens = 24,000 tokens
Every request includes all 48 tool schemas
```

**With Router**:

```
Tool definitions: 2 meta-tools = 435 tokens
discover_tools returns tool paths (not full schemas)
execute_tool routes to backend servers
```

**Savings**: 98.2% (23,565 tokens saved)

### How It Works

1. **Startup**: Router loads backend MCP server configs
2. **Discovery**: On first tool call, router connects to all backend servers and caches tool list
3. **Search**: `discover_tools` uses fuzzy search to find relevant tools
4. **Execution**: `execute_tool` spawns the appropriate backend server and forwards the request
5. **Caching**: Backend servers stay connected in pool for subsequent calls

---

## Best Practices

### ✅ DO

- Use separate config for router vs backend servers
- Enable `disabled: true` for servers you don't want loaded
- Use `--verbose` to debug startup issues
- Group related servers (e.g., all GitHub tools in one server)

### ❌ DON'T

- Add router to the config it reads from (circular reference)
- Load 150+ backend tools without testing first
- Forget to check token savings with `uap mcp-router stats`
- Use router for single-server setups (no benefit)

---

## Performance

Tested with 2 servers (48 tools):

| Metric                 | Value                                 |
| ---------------------- | ------------------------------------- |
| Startup time           | <1s                                   |
| First tool discovery   | ~2s (loads all backend servers)       |
| Subsequent discoveries | <50ms (cached)                        |
| Tool execution         | ~500ms (spawns backend server)        |
| Memory overhead        | ~50MB (Node.js + backend connections) |

---

## Related Commands

```bash
# Initialize UAP in a project
uap init

# Memory query with router context
uap memory query "mcp router setup"

# Agent coordination
uap agent status
```

---

## Support

- **Issues**: https://github.com/your-org/universal-agent-protocol/issues
- **Docs**: https://github.com/your-org/universal-agent-protocol/docs
- **Tests**: `npm test -- mcp-router-filter`
