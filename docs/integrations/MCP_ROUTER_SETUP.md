# MCP Router Setup Guide

The MCP Router provides **98%+ token reduction** by exposing only 2 meta-tools (\`discover_tools\`, \`execute_tool\`) instead of loading 150+ individual tool definitions.

## Quick Start

\`\`\`bash
# Check configured servers
uap mcp-router list

# Show token savings
uap mcp-router stats

# Discover tools
uap mcp-router discover --query "github issues"

# Start as MCP server (for use with Claude/Cursor)
uap mcp-router start
\`\`\`

---

## Configuration

### Adding Router to Claude/Cursor

Add this to your MCP client config (Claude Desktop, Cursor, etc.):

\`\`\`json
{
  "mcpServers": {
    "router": {
      "command": "npx",
      "args": ["uap", "mcp-router", "start"]
    }
  }
}
\`\`\`

**⚠️ Important**: Do NOT add the router to the config file it reads from!

### Backend Server Configuration

Create a **separate config file** for the backend MCP servers the router should load.

**Option 1: Use existing MCP configs**
The router auto-loads from these locations (in order):
1. \`~/.factory/mcp.json\`
2. \`~/.claude/settings.json\`
3. \`~/.config/Code/User/globalStorage/anthropic.claude-code/settings.json\`
4. \`~/.config/Cursor/User/globalStorage/cursor.mcp/config.json\`
5. \`~/.config/Claude/claude_desktop_config.json\`
6. \`./mcp.json\` or \`./.mcp.json\` (local project)

**Option 2: Use a dedicated config file**
\`\`\`bash
uap mcp-router start --config ~/.uap/mcp-backend.json
\`\`\`

---

## Token Optimization Architecture

### The Token Problem
Traditional MCP clients load every tool schema into the system prompt. With 100+ tools, this consumes 20k+ tokens per request, leading to high costs and reduced context window.

### The Router Solution
The MCP Router replaces the full list of tools with two meta-tools:
1. \`discover_tools\`: Returns a list of tool paths and descriptions using fuzzy search.
2. \`execute_tool\`: Routes the request to the backend server.

### Output Compression
To further optimize, the \`OutputCompressor\` in \`src/mcp-router/output-compressor.ts\` strips redundant metadata, large repetitive blocks, and unnecessary whitespace from tool responses before they reach the LLM. This ensures that the "savings" are not lost during the response phase.

---

## Usage

### As an MCP Server

When run with \`uap mcp-router start\`, the router exposes 2 tools:

#### 1. \`discover_tools\`
Find MCP tools matching a query.
\`\`\`typescript
{
  query: string;      // "github issues", "read files", etc.
  limit?: number;    // Max results (default: 10)
  server?: string;    // Filter to specific server
}
\`\`\`

#### 2. \`execute_tool\`
Execute a tool by its path.
\`\`\`typescript
{
  "path": string;              // "server.tool_name" from discover_tools
  "args": Record<string, any>; // Tool-specific arguments
}
\`\`\`

---

## Troubleshooting

### Router Tries to Load Itself
**Symptom**: Logs show \`[router] router: 2 tools\` or startup hangs.
**Cause**: The router is in its own config file.
**Fix**: Remove the router entry from the config it reads.

### No Tools Found
**Symptom**: \`uap mcp-router stats\` shows \`0 tools\`.
**Cause**: No valid backend MCP servers configured.
**Fix**: Add backend servers to config.

---

## Performance

| Metric                 | Value                                 |
| ------------------- | -------------------------------------------------------------------------------- |
| Startup time           | <1s                                   |
| First tool discovery   | ~2s (loads all backend servers)       |
| Subsequent discoveries | <50ms (cached)                        |
| Tool execution         | ~500ms (spawns backend server)       |
| Memory overhead       | ~50MB (Node.js + backend connections) |
