# mcp-router-first

**Category**: custom
**Level**: RECOMMENDED
**Enforcement Stage**: pre-exec
**Tags**: mcp, router, tokens, context

## Rule

When the session lists MCP tools as deferred (loaded on demand), agents MUST use `ToolSearch` / `uap mcp-router` to pull individual tool schemas on need rather than eagerly loading full MCP tool catalogs.

## Why

The session has 150+ deferred MCP tools (Playwright, Pay2U API, Terraform, Drive, etc.). Loading the full schema set burns ~30k+ tokens. UAP's MCP Router provides 98% token reduction (per CLI docs).

## Enforcement

Python enforcer `mcp_router_first.py` blocks bulk-load patterns and requires the specific tool name in the ToolSearch query.

```rules
- title: "Load MCP tools on demand"
  keywords: [mcp, tool-schema, load-tools]
  antiPatterns: [load-all, bulk-load, eager-schema]
```
