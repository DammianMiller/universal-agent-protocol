/**
 * execute_tool - Meta-tool for executing MCP tools
 * 
 * This is one of the 2 tools exposed by the router (the other being discover_tools).
 * Routes tool calls to the appropriate MCP server.
 */

import type { ExecuteToolArgs, OutputCompressionStats } from '../types.js';
import type { ToolSearchIndex } from '../search/fuzzy.js';
import type { McpClientPool } from '../executor/client.js';
import { compressToolOutput } from '../output-compressor.js';
import { globalSessionStats } from '../session-stats.js';

export const EXECUTE_TOOL_DEFINITION = {
  name: 'execute_tool',
  description: `Execute an MCP tool by its path. Use discover_tools first to find the correct path.

Path format: "server.tool_name" (e.g., "github.create_issue", "filesystem.read_file")

Example:
1. First: discover_tools({ query: "github issues" })
   → Returns: [{ path: "github.create_issue", ... }]
2. Then: execute_tool({ path: "github.create_issue", args: { title: "Bug", body: "..." } })

The args object should match the tool's expected input schema.`,
  inputSchema: {
    type: 'object' as const,
    properties: {
      path: {
        type: 'string',
        description: 'Tool path in format "server.tool_name" (from discover_tools results)',
      },
      args: {
        type: 'object',
        description: 'Arguments to pass to the tool (schema depends on the specific tool)',
        additionalProperties: true,
      },
      intent: {
        type: 'string',
        description: 'Optional: describe what you are looking for in the output. For large results (>10KB), only matching sections are returned instead of the full output.',
      },
    },
    required: ['path'],
  },
};

export interface ExecuteResult {
  success: boolean;
  result?: unknown;
  error?: string;
  toolPath: string;
  executionTimeMs: number;
  compressionStats?: OutputCompressionStats;
}

export async function handleExecuteTool(
  args: ExecuteToolArgs,
  searchIndex: ToolSearchIndex,
  clientPool: McpClientPool
): Promise<ExecuteResult> {
  const startTime = Date.now();
  const { path, args: toolArgs = {}, intent } = args;
  
  // Parse path
  const dotIndex = path.indexOf('.');
  if (dotIndex === -1) {
    return {
      success: false,
      error: `Invalid tool path "${path}". Expected format: "server.tool_name"`,
      toolPath: path,
      executionTimeMs: Date.now() - startTime,
    };
  }
  
  const serverName = path.slice(0, dotIndex);
  const toolName = path.slice(dotIndex + 1);
  
  // Find tool definition
  const tool = searchIndex.getToolByPath(path);
  if (!tool) {
    // Try fuzzy match suggestion
    const suggestions = searchIndex.search(toolName, 3);
    const suggestionText = suggestions.length > 0
      ? ` Did you mean: ${suggestions.map(s => s.path).join(', ')}?`
      : '';
    
    return {
      success: false,
      error: `Tool "${path}" not found.${suggestionText}`,
      toolPath: path,
      executionTimeMs: Date.now() - startTime,
    };
  }
  
  // Get or create client for this server
  const client = clientPool.getClient(serverName, tool.serverConfig);
  
  try {
    await client.connect();
    const rawResult = await client.callTool(toolName, toolArgs as Record<string, unknown>);
    
    // Compress output to save context window
    const compressed = compressToolOutput(rawResult, { intent });
    
    // Record stats
    globalSessionStats.record(
      path,
      compressed.stats.originalBytes,
      compressed.stats.compressedBytes
    );
    
    return {
      success: true,
      result: compressed.output,
      toolPath: path,
      executionTimeMs: Date.now() - startTime,
      compressionStats: compressed.stats,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
      toolPath: path,
      executionTimeMs: Date.now() - startTime,
    };
  }
}

// Token estimation for the execute_tool definition
export function estimateExecuteToolTokens(): number {
  const json = JSON.stringify(EXECUTE_TOOL_DEFINITION);
  // Rough estimate: ~4 chars per token
  return Math.ceil(json.length / 4);
}
