/**
 * MCP Router - Lightweight Hierarchical Router for 98%+ Token Reduction
 * 
 * Instead of exposing 150+ tools to the LLM, exposes just 2:
 * - discover_tools: Find tools matching a query
 * - execute_tool: Execute a tool by path
 * 
 * This reduces context window consumption from ~75,000 tokens to ~700 tokens.
 */

export { McpRouter, runStdioServer } from './server.js';
export type { RouterOptions } from './server.js';
export { loadConfigFromPaths, loadConfigFromFile, mergeConfigs } from './config/parser.js';
export { ToolSearchIndex } from './search/fuzzy.js';
export { McpClient, McpClientPool } from './executor/client.js';
export { 
  DISCOVER_TOOLS_DEFINITION, 
  handleDiscoverTools,
  estimateDiscoverToolsTokens,
} from './tools/discover.js';
export { 
  EXECUTE_TOOL_DEFINITION, 
  handleExecuteTool,
  estimateExecuteToolTokens,
} from './tools/execute.js';
export type {
  McpConfig,
  McpServerConfig,
  ToolDefinition,
  ToolSearchResult,
  DiscoverToolsArgs,
  ExecuteToolArgs,
  ToolRegistry,
  RouterStats,
  OutputCompressionStats,
} from './types.js';
export { compressToolOutput } from './output-compressor.js';
export type { CompressedOutput, CompressionStats } from './output-compressor.js';
export { SessionStats, globalSessionStats } from './session-stats.js';
export type { StatsSummary, ToolBreakdown, ToolCallRecord } from './session-stats.js';
