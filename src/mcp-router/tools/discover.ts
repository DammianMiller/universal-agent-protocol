/**
 * discover_tools - Meta-tool for finding MCP tools
 * 
 * This is one of the 2 tools exposed by the router (the other being execute_tool).
 * Instead of loading 150+ tool definitions, the LLM uses this to find relevant tools.
 */

import type { DiscoverToolsArgs, ToolSearchResult } from '../types.js';
import type { ToolSearchIndex } from '../search/fuzzy.js';

export const DISCOVER_TOOLS_DEFINITION = {
  name: 'discover_tools',
  description: `Find MCP tools matching a natural language query. Returns tool paths that can be used with execute_tool.

Examples:
- "github issues" → finds github.create_issue, github.list_issues, etc.
- "file operations" → finds filesystem.read_file, filesystem.write_file, etc.
- "search" → finds tools across all servers with search capabilities

Use this FIRST to discover available tools, then use execute_tool with the returned path.`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      query: {
        type: 'string',
        description: 'Natural language search query (e.g., "create github issue", "read files", "search documentation")',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of results to return (default: 10)',
        default: 10,
      },
      server: {
        type: 'string',
        description: 'Optional: filter to specific server (e.g., "github", "filesystem")',
      },
    },
    required: ['query'],
  },
};

export function handleDiscoverTools(
  args: DiscoverToolsArgs,
  searchIndex: ToolSearchIndex
): { tools: ToolSearchResult[]; hint: string } {
  const { query, limit = 10, server } = args;
  
  let results: ToolSearchResult[];
  
  if (server) {
    // Filter to specific server
    results = searchIndex.searchByServer(server, limit);
    if (query) {
      // Further filter by query within server
      const queryLower = query.toLowerCase();
      results = results.filter(r => 
        r.name.toLowerCase().includes(queryLower) ||
        r.description.toLowerCase().includes(queryLower)
      );
    }
  } else {
    results = searchIndex.search(query, limit);
  }
  
  // Format hint for LLM
  const hint = results.length > 0
    ? `Found ${results.length} tools. Use execute_tool with the path (e.g., execute_tool({ path: "${results[0].path}", args: {...} }))`
    : 'No tools found. Try a different query or check available servers with discover_tools({ query: "*" })';
  
  return { tools: results, hint };
}

// Token estimation for the discover_tools definition
export function estimateDiscoverToolsTokens(): number {
  const json = JSON.stringify(DISCOVER_TOOLS_DEFINITION);
  // Rough estimate: ~4 chars per token
  return Math.ceil(json.length / 4);
}
