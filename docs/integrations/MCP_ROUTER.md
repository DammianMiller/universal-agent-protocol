# MCP Router

`v1.91.0` · `src/mcp-router/`

> **🏭 Where this fits:** Cross-cutting (keeps the belt from jamming) — every
> station downstream stalls when your agent's context window is choked with
> hundreds of tool schemas and raw tool dumps, so it loses the thread and burns
> budget before doing any work. **What it delivers:** up to 98% fewer
> tool-definition tokens and relevance-ranked tool output, so context stays lean
> and work keeps moving down the [delivery pipeline](../guides/DELIVERY_PIPELINE.md).

The MCP Router is a hierarchical Model Context Protocol server that sits in
front of all of your downstream MCP servers and dramatically reduces the tokens
the model spends on tool definitions and tool output. It is the mechanism behind
UAP's "up to 98% savings on large tool calls."

For where it fits in the wider system, see
[../architecture/OVERVIEW.md](../architecture/OVERVIEW.md#mcp-router-srcmcp-router).

---

## Why it exists

A normal MCP setup exposes every tool from every server directly to the model.
With a dozen servers that is easily 150+ tool schemas at roughly ~500 tokens
each — tens of thousands of tokens of context burned before the agent does any
work. On top of that, tools like file readers and shell wrappers return large
outputs that flood the context window. Either way, the belt jams: your agent is
reasoning around clutter instead of the task.

The router fixes both:

1. **Tool hiding.** It exposes just three meta-tools instead of every
   downstream tool. The documented design target is ~75,000 tokens of tool
   definitions collapsed to ~700 (`src/mcp-router/index.ts`,
   `src/mcp-router/server.ts`).
2. **Output compression.** Large tool results are indexed into an in-memory
   SQLite **FTS5** table and only the most relevant snippets are returned
   (`src/mcp-router/output-compressor.ts`).

---

## How it works

### The three meta-tools

Instead of N downstream tools, the model sees:

| Meta-tool | What it does |
|-----------|--------------|
| `discover_tools` | Natural-language query → matching downstream tool paths |
| `execute_tool`   | Run a tool by `path` with `args` (+ optional `intent`) |
| `deliver`        | Run the `uap deliver` convergence loop |

Downstream tools are loaded into an in-memory fuzzy search index at startup and
are never surfaced as definitions. The agent's flow is:

```
discover_tools("read the auth config")
        │  → [ "filesystem.read_file", ... ]
        ▼
execute_tool({ path: "filesystem.read_file",
               args: { path: "src/auth.ts" },
               intent: "csrf token validation" })
        │
        ▼
  ┌──────────── output compressor ────────────┐
  │ small result → passthrough                 │
  │ large result → FTS5 index + BM25(intent)   │
  │   → top snippets + searchable-vocab footer │
  │ huge / no intent → head+tail truncation    │
  └────────────────────────────────────────────┘
```

The `intent` string on `execute_tool` is what drives the BM25 query — provide a
focused intent to get focused snippets. The model can then issue a follow-up
`execute_tool` with a refined intent using the vocabulary footer.

---

## Setup

### One command, all harnesses

```bash
uap mcp-setup
```

`uap mcp-setup` (`src/cli/setup-mcp-router.ts`) configures the MCP Router as the
single MCP server across your AI harnesses. It writes a `mcpServers.router`
entry pointing at the router and migrates/backs up any existing servers
(prompts unless `--force`), then validates the result with `uap mcp-router list`.

Harnesses configured (global `~/` config paths):

| Harness | Config file |
|---------|-------------|
| Claude Code | `~/.claude/settings.json` |
| Factory.AI | `~/.factory/mcp.json` |
| VSCode | `~/.vscode/mcp.json` (skipped if absent) |
| Cursor | `~/.cursor/settings.json` |

The router entry it writes looks like:

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

### Running and inspecting the router

`uap mcp-router <action>` (`src/cli/mcp-router.ts`) drives the router directly:

```bash
uap mcp-router start      # run the stdio MCP server (what harnesses launch)
uap mcp-router list       # list discovered downstream tools
uap mcp-router discover   # try a natural-language tool discovery query
uap mcp-router stats      # token-savings stats
```

`uap mcp-router start` is the command harnesses invoke via the generated config;
you normally don't run it by hand.

---

## Verifying it works

```bash
uap mcp-router list       # should enumerate tools from your downstream servers
uap mcp-router stats      # shows tool-hiding savings + per-output compression
uap hooks doctor          # confirms gate/router wiring across harnesses
```

If `list` is empty, the router found no downstream MCP configs — confirm your
harness still has its original MCP servers defined (they are migrated into the
router's view, not deleted) and re-run `uap mcp-setup`.

---

## Notes

- The router reads downstream MCP configs from Claude Desktop, Cursor, VSCode,
  Claude Code CLI, Factory.AI, and a local `mcp.json`, expands `~`/env vars,
  skips disabled servers, and refuses to reference itself.
- The 98% / 75k→700 figures are the documented design target for tool hiding;
  per-output FTS5 savings are computed live for each call and reported by
  `uap mcp-router stats`.
- Pair the router with **RTK** for CLI-output savings — see
  [RTK.md](RTK.md). The two are complementary (tool definitions + CLI output),
  and together they keep the whole belt clear of context clutter.
