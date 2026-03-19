/**
 * MCP Router Types
 * Lightweight hierarchical router for 98%+ token reduction
 */

export interface McpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  transport?: 'stdio' | 'http' | 'sse';
  disabled?: boolean;
}

export interface McpConfig {
  mcpServers: Record<string, McpServerConfig>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
  serverName: string;
  serverConfig: McpServerConfig;
}

export interface ToolSearchResult {
  path: string;
  name: string;
  description: string;
  server: string;
  score: number;
}

export interface DiscoverToolsArgs {
  query: string;
  limit?: number;
  server?: string;
}

export interface ExecuteToolArgs {
  path: string;
  args?: Record<string, unknown>;
  intent?: string;
}

export interface OutputCompressionStats {
  originalBytes: number;
  compressedBytes: number;
  savings: string;
  method: 'passthrough' | 'truncated' | 'indexed';
}

// ToolRegistry interface removed — was never implemented or used

export interface RouterStats {
  totalServers: number;
  totalTools: number;
  traditionalTokens: number;
  routerTokens: number;
  savings: string;
}
