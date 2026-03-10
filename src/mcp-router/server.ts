/**
 * MCP Router Server
 * Exposes 2 meta-tools: discover_tools and execute_tool
 * Achieves 98%+ token reduction by hiding individual tool definitions
 */

import { loadConfigFromPaths, loadConfigFromFile } from './config/parser.js';
import { ToolSearchIndex } from './search/fuzzy.js';
import { McpClient, McpClientPool } from './executor/client.js';
import { 
  DISCOVER_TOOLS_DEFINITION, 
  handleDiscoverTools,
  estimateDiscoverToolsTokens,
} from './tools/discover.js';
import { 
  EXECUTE_TOOL_DEFINITION, 
  handleExecuteTool,
  estimateExecuteToolTokens,
} from './tools/execute.js';
import type { McpConfig, ToolDefinition, RouterStats } from './types.js';

export interface RouterOptions {
  configPath?: string;
  autoDiscover?: boolean;
  verbose?: boolean;
}

export class McpRouter {
  private config: McpConfig;
  private searchIndex: ToolSearchIndex;
  private clientPool: McpClientPool;
  private options: RouterOptions;
  private toolsLoaded = false;
  
  constructor(options: RouterOptions = {}) {
    this.options = {
      autoDiscover: true,
      verbose: false,
      ...options,
    };
    
    // Load config
    if (options.configPath) {
      this.config = loadConfigFromFile(options.configPath);
    } else {
      this.config = loadConfigFromPaths();
    }
    
    this.searchIndex = new ToolSearchIndex({ threshold: 0.2 });
    this.clientPool = new McpClientPool();
  }
  
  /**
   * Load tools from all configured MCP servers
   */
  async loadTools(): Promise<void> {
    if (this.toolsLoaded) return;
    
    const servers = Object.entries(this.config.mcpServers);
    
    if (this.options.verbose) {
      console.error(`[router] Loading tools from ${servers.length} servers...`);
    }
    
    const allTools: ToolDefinition[] = [];
    
    for (const [serverName, serverConfig] of servers) {
      try {
        const client = new McpClient(serverName, serverConfig);
        await client.connect();
        const tools = await client.listTools();
        allTools.push(...tools);
        client.disconnect();
        
        if (this.options.verbose) {
          console.error(`[router] ${serverName}: ${tools.length} tools`);
        }
      } catch (error) {
        if (this.options.verbose) {
          console.error(`[router] ${serverName}: failed to load - ${error}`);
        }
      }
    }
    
    this.searchIndex.clear();
    this.searchIndex.addTools(allTools);
    this.toolsLoaded = true;
    
    if (this.options.verbose) {
      const stats = this.searchIndex.getStats();
      console.error(`[router] Loaded ${stats.tools} tools from ${stats.servers} servers`);
    }
  }
  
  /**
   * Get the 2 meta-tool definitions (for MCP tools/list)
   */
  getToolDefinitions(): Array<typeof DISCOVER_TOOLS_DEFINITION | typeof EXECUTE_TOOL_DEFINITION> {
    return [DISCOVER_TOOLS_DEFINITION, EXECUTE_TOOL_DEFINITION];
  }
  
  /**
   * Handle tool call
   */
  async handleToolCall(name: string, args: unknown): Promise<unknown> {
    // Ensure tools are loaded
    if (!this.toolsLoaded && this.options.autoDiscover) {
      await this.loadTools();
    }
    
    switch (name) {
      case 'discover_tools':
        return handleDiscoverTools(args as Parameters<typeof handleDiscoverTools>[0], this.searchIndex);
      
      case 'execute_tool':
        return handleExecuteTool(
          args as Parameters<typeof handleExecuteTool>[0],
          this.searchIndex,
          this.clientPool
        );
      
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }
  
  /**
   * Get router statistics
   */
  getStats(): RouterStats {
    const { servers, tools } = this.searchIndex.getStats();
    
    // Estimate traditional token usage: ~500 tokens per tool
    const traditionalTokens = tools * 500;
    
    // Router uses only 2 tools
    const routerTokens = estimateDiscoverToolsTokens() + estimateExecuteToolTokens();
    
    const savings = traditionalTokens > 0
      ? ((traditionalTokens - routerTokens) / traditionalTokens * 100).toFixed(1) + '%'
      : '0%';
    
    return {
      totalServers: servers,
      totalTools: tools,
      traditionalTokens,
      routerTokens,
      savings,
    };
  }
  
  /**
   * Shutdown - cleanup all connections
   */
  async shutdown(): Promise<void> {
    await this.clientPool.disconnectAll();
  }
  
  /**
   * Get loaded config
   */
  getConfig(): McpConfig {
    return this.config;
  }
}

/**
 * Run as stdio MCP server
 */
export async function runStdioServer(options: RouterOptions = {}): Promise<void> {
  const router = new McpRouter({ ...options, verbose: true });
  
  let buffer = '';
  
  function send(message: object): void {
    process.stdout.write(JSON.stringify(message) + '\n');
  }
  
  function handleMessage(message: { 
    jsonrpc: string; 
    id?: number; 
    method: string; 
    params?: unknown;
  }): void {
    const { id, method, params } = message;
    
    switch (method) {
      case 'initialize':
        send({
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: {
              tools: {},
            },
            serverInfo: {
              name: 'uap-mcp-router',
              version: '1.0.0',
            },
          },
        });
        break;
      
      case 'notifications/initialized':
        // No response needed
        break;
      
      case 'tools/list':
        send({
          jsonrpc: '2.0',
          id,
          result: {
            tools: router.getToolDefinitions(),
          },
        });
        break;
      
      case 'tools/call': {
        const { name, arguments: args } = params as { name: string; arguments: unknown };
        router.handleToolCall(name, args)
          .then(result => {
            send({
              jsonrpc: '2.0',
              id,
              result: {
                content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
              },
            });
          })
          .catch(error => {
            send({
              jsonrpc: '2.0',
              id,
              error: {
                code: -32000,
                message: error instanceof Error ? error.message : String(error),
              },
            });
          });
        break;
      }
      
      default:
        if (id !== undefined) {
          send({
            jsonrpc: '2.0',
            id,
            error: {
              code: -32601,
              message: `Method not found: ${method}`,
            },
          });
        }
    }
  }
  
  process.stdin.on('data', (data: Buffer) => {
    buffer += data.toString();
    
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    
    for (const line of lines) {
      if (!line.trim()) continue;
      
      try {
        const message = JSON.parse(line);
        handleMessage(message);
      } catch (e) {
        console.error('[router] Invalid JSON:', e);
      }
    }
  });
  
  process.stdin.on('end', async () => {
    await router.shutdown();
    process.exit(0);
  });
  
  process.on('SIGINT', async () => {
    await router.shutdown();
    process.exit(0);
  });
  
  console.error('[router] MCP Router server started (stdio)');
  console.error('[router] Exposing 2 tools: discover_tools, execute_tool');
}
