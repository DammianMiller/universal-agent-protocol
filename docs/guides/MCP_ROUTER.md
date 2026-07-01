# MCP Router

> UAP v1.91.0

> **🏭 Where this fits:** CROSS-CUTTING — keeping the context window lean at every station of the [delivery pipeline](./DELIVERY_PIPELINE.md). In a normal agentic workflow every tool call dumps its full result into context, so mostly-irrelevant output crowds out the details your agent actually needs. **What it delivers:** a proxy that compresses tool output before it reaches the model — up to 98% fewer tokens on large results — so the agent keeps room for real work and you spend less per session.

The MCP Router is a token-optimizing proxy that sits between an AI harness and
its MCP tool servers. It is implemented as 11 modules under
[`src/mcp-router/`](../../src/mcp-router/) and exposed through the
`uap mcp-router` CLI.

## The problem: tool-output token bloat

When an agent calls an MCP tool, the *entire* tool result is injected into the
model's context window. A single `read_file`, search, or API call can return tens
of kilobytes of mostly-irrelevant text. Across a session this dominates token
spend and crowds out useful context.

The router solves this by **compressing tool output before it reaches the model**,
returning only the parts the agent actually needs. In practice this yields **up
to 98% token reduction** on large outputs.

## Compression strategy

Every tool result passes through the output compressor
([`output-compressor.ts`](../../src/mcp-router/output-compressor.ts)), which picks
a strategy based on output size and whether the call supplied an *intent*:

| Output size | Strategy | Method |
|-------------|----------|--------|
| ≤ 5 KB | **Pass through** unchanged | `passthrough` |
| 5–10 KB | **Head + tail** smart truncation | `truncated` |
| ≥ 10 KB **with intent** | **FTS5 index-then-search** — return only matching snippets | `indexed` |
| ≥ 10 KB without intent | Head + tail smart truncation | `truncated` |

The exact thresholds are `5120` bytes (truncation) and `10240` bytes
(auto-indexing).

### Intent-driven FTS5 search

When an output is large and the agent describes what it is looking for (an
`intent`), the compressor:

1. **Chunks** the content by structure — markdown headings first, then
   blank-line paragraphs, then fixed-size line blocks as a fallback.
2. Builds an **in-memory SQLite FTS5** virtual table (`porter` tokenizer) over
   the chunks.
3. Runs the intent as a **BM25-ranked** full-text query and returns up to
   **3 matching snippets** (`MAX_SNIPPETS`).
4. Appends a short list of searchable vocabulary terms so the agent can refine a
   follow-up query.

If FTS5 returns nothing, it falls back to a keyword scan of the chunks, and
finally to plain truncation.

### Safety guards

Native tokenizers can choke on pathological input, so the compressor defends
against it:

- **Null-byte sanitization** — embedded `\0` bytes are stripped before insertion
  to avoid tokenizer crashes.
- **Per-chunk cap** — chunks are limited to **8 KB** (`MAX_CHUNK_BYTES`) to avoid
  stressing the porter tokenizer on inputs with no word boundaries (base64 blobs,
  minified JS, double-serialized JSON).
- **Index ceiling** — outputs above **2 MB** (`MAX_INDEX_BYTES`) skip FTS5
  entirely and fall back to truncation, since the native tokenizer can segfault on
  very large unbroken inputs.
- **Null/exotic results** — `null`/`undefined` results collapse to an empty
  string; BigInt and circular values are coerced safely rather than producing
  `"[object Object]"`.

### Supplying intent

The `execute_tool` proxy accepts an optional `intent` argument. From its schema
([`tools/execute.ts`](../../src/mcp-router/tools/execute.ts)):

> *Optional: describe what you are looking for in the output. For large results
> (>10KB), only matching sections are returned instead of the full output.*

So an agent calling a tool through the router can pass, e.g.,
`intent: "the failing test name and stack frame"` and receive only the matching
sections of an otherwise huge log.

## Modules

| Concern | Module |
|---------|--------|
| Stdio MCP server entrypoint | [`server.ts`](../../src/mcp-router/server.ts) |
| Tool discovery (search across servers) | [`tools/discover.ts`](../../src/mcp-router/tools/discover.ts) |
| Tool execution + output compression | [`tools/execute.ts`](../../src/mcp-router/tools/execute.ts) |
| Output compression engine | [`output-compressor.ts`](../../src/mcp-router/output-compressor.ts) |
| Per-session token-savings accounting | [`session-stats.ts`](../../src/mcp-router/session-stats.ts) |
| Config parsing (`mcp.json`) | [`config/parser.ts`](../../src/mcp-router/config/parser.ts) |
| Fuzzy tool search | [`search/fuzzy.ts`](../../src/mcp-router/search/fuzzy.ts) |

## The `uap mcp-router` CLI

Commands are defined in [`src/bin/cli.ts`](../../src/bin/cli.ts) and implemented
in [`src/cli/mcp-router.ts`](../../src/cli/mcp-router.ts).

### Start

Run the router as a stdio MCP server (this is what a harness launches).

```bash
uap mcp-router start [options]
```

| Option | Description |
|--------|-------------|
| `-c, --config <path>` | Path to an `mcp.json` config file |
| `-v, --verbose` | Enable verbose logging |

### Stats

Show servers, tools, and token savings for the session.

```bash
uap mcp-router stats [-c <path>] [-v] [--json]
```

### Discover

Find tools matching a query across all configured servers.

```bash
uap mcp-router discover -q "<query>" [options]
```

| Option | Default | Description |
|--------|---------|-------------|
| `-q, --query <query>` | — | Search query (required) |
| `-s, --server <server>` | — | Filter to a specific server |
| `-l, --limit <limit>` | `10` | Max results |
| `-c, --config <path>` | — | Path to `mcp.json` config file |
| `-v, --verbose` | — | Enable verbose logging |
| `--json` | — | Output as JSON |

### List

List the configured MCP servers.

```bash
uap mcp-router list [-c <path>] [--json]
```

## Enabling the router per harness

The router replaces a harness's individual MCP servers with a single `router`
entry that runs `uap mcp-router start`. The bundled installer wires this up for
all supported harnesses:

```bash
uap mcp-setup [--force] [--verbose]
```

This command ([`src/cli/setup-mcp-router.ts`](../../src/cli/setup-mcp-router.ts))
configures **Claude Code**, **Factory.AI**, **VSCode**, and **Cursor**. It writes
a `router` server into each harness's MCP config:

- **Claude Code** — `~/.claude/settings.json`
- **Factory.AI** — `~/.factory/mcp.json`
- **VSCode** — `~/.vscode/mcp.json`
- **Cursor** — `~/.cursor/settings.json`

The entry it installs looks like:

```json
{
  "mcpServers": {
    "router": {
      "command": "npx",
      "args": ["uap", "mcp-router", "start"],
      "description": "Unified MCP Router - routes all tool calls"
    }
  }
}
```

When a harness already has MCP servers configured, `mcp-setup` migrates them
behind the router (preserving the originals in a backup field) — pass `--force` to
skip the confirmation prompt. After setup it validates the install by running
`uap mcp-router list`.

## The savings

For the common case where a tool returns a large, mostly-irrelevant payload and
the agent supplies an intent, the router returns only the 3 best-matching
snippets — **up to 98% fewer tokens** than the raw output. Small outputs (≤5 KB)
pass through untouched, so there is no penalty for the common small-result case.
Per-session savings are tracked in
[`session-stats.ts`](../../src/mcp-router/session-stats.ts) and surfaced via
`uap mcp-router stats`.

See also the [Memory guide](./MEMORY.md) for reducing token spend on persistent
context rather than tool output.
