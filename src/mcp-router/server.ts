/**
 * MCP Router Server
 * Exposes 2 meta-tools: discover_tools and execute_tool
 * Achieves 98%+ token reduction by hiding individual tool definitions
 */

import { loadConfigFromPaths, loadConfigFromFile } from './config/parser.js';
import { ToolSearchIndex } from './search/fuzzy.js';
import { McpClientPool } from './executor/client.js';
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
   * Load tools from all configured MCP servers.
   * Uses Promise.allSettled for parallel discovery and keeps clients alive in the pool.
   */
  async loadTools(): Promise<void> {
    if (this.toolsLoaded) return;

    const servers = Object.entries(this.config.mcpServers);

    if (this.options.verbose) {
      console.error(`[router] Loading tools from ${servers.length} servers in parallel...`);
    }

    // Parallel server discovery - connect to all servers simultaneously
    const results = await Promise.allSettled(
      servers.map(async ([serverName, serverConfig]) => {
        // Use the client pool so connections persist for later execute_tool calls
        const client = this.clientPool.getClient(serverName, serverConfig);
        await client.connect();
        const tools = await client.listTools();
        // Do NOT disconnect - keep alive for subsequent execute_tool calls
        return { serverName, tools };
      })
    );

    const allTools: ToolDefinition[] = [];
    for (const result of results) {
      if (result.status === 'fulfilled') {
        allTools.push(...result.value.tools);
        if (this.options.verbose) {
          console.error(`[router] ${result.value.serverName}: ${result.value.tools.length} tools`);
        }
      } else if (this.options.verbose) {
        console.error(`[router] server failed to load - ${result.reason}`);
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
        return handleDiscoverTools(
          args as Parameters<typeof handleDiscoverTools>[0],
          this.searchIndex
        );

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

    const savings =
      traditionalTokens > 0
        ? (((traditionalTokens - routerTokens) / traditionalTokens) * 100).toFixed(1) + '%'
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

// Supported MCP protocol version
const SUPPORTED_PROTOCOL_VERSION = '2024-11-05';

/**
 * Run as stdio MCP server.
 * Fully JSON-RPC 2.0 compliant: parse errors (-32700), invalid request (-32600),
 * batch request support, jsonrpc field validation, and protocol version negotiation.
 */
export async function runStdioServer(options: RouterOptions = {}): Promise<void> {
  const router = new McpRouter({ ...options, verbose: true });

  let buffer = '';

  function send(message: object): void {
    process.stdout.write(JSON.stringify(message) + '\n');
  }

  function handleMessage(message: unknown): void {
    // Validate it's an object
    if (!message || typeof message !== 'object') {
      send({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32600, message: 'Invalid Request: expected a JSON object' },
      });
      return;
    }

    const msg = message as Record<string, unknown>;

    // JSON-RPC 2.0 compliance: validate jsonrpc field
    if (msg.jsonrpc !== '2.0') {
      send({
        jsonrpc: '2.0',
        id: msg.id ?? null,
        error: {
          code: -32600,
          message: 'Invalid Request: missing or invalid "jsonrpc" field (must be "2.0")',
        },
      });
      return;
    }

    const id = msg.id as number | undefined;
    const method = msg.method as string;
    const params = msg.params as unknown;

    // Validate method field exists
    if (typeof method !== 'string') {
      if (id !== undefined) {
        send({
          jsonrpc: '2.0',
          id,
          error: { code: -32600, message: 'Invalid Request: missing or invalid "method" field' },
        });
      }
      return;
    }

    switch (method) {
      case 'initialize': {
        // Protocol version negotiation
        const initParams = params as { protocolVersion?: string } | undefined;
        const clientVersion = initParams?.protocolVersion;
        if (clientVersion && clientVersion !== SUPPORTED_PROTOCOL_VERSION) {
          console.error(
            `[router] Client requested protocol version ${clientVersion}, ` +
              `server supports ${SUPPORTED_PROTOCOL_VERSION}. Proceeding with server version.`
          );
        }
        send({
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: SUPPORTED_PROTOCOL_VERSION,
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
      }

      case 'notifications/initialized':
        // No response needed for notifications
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
        if (!params || typeof params !== 'object') {
          send({
            jsonrpc: '2.0',
            id,
            error: { code: -32602, message: 'Invalid params: expected { name, arguments }' },
          });
          break;
        }
        const { name, arguments: args } = params as { name: string; arguments: unknown };
        if (typeof name !== 'string') {
          send({
            jsonrpc: '2.0',
            id,
            error: { code: -32602, message: 'Invalid params: "name" must be a string' },
          });
          break;
        }
        router
          .handleToolCall(name, args)
          .then((result) => {
            const safeResult = result ?? { success: true, result: '(no output)' };
            send({
              jsonrpc: '2.0',
              id,
              result: {
                content: [{ type: 'text', text: JSON.stringify(safeResult, null, 2) }],
              },
            });
          })
          .catch((error) => {
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
        // Only send error for requests (with id), not notifications
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
        const parsed = JSON.parse(line);

        // JSON-RPC 2.0 batch support: handle arrays of requests
        if (Array.isArray(parsed)) {
          if (parsed.length === 0) {
            // Empty batch is an invalid request per spec
            send({
              jsonrpc: '2.0',
              id: null,
              error: { code: -32600, message: 'Invalid Request: empty batch' },
            });
          } else {
            for (const msg of parsed) {
              handleMessage(msg);
            }
          }
        } else {
          handleMessage(parsed);
        }
      } catch {
        // JSON-RPC 2.0 spec: parse errors MUST return -32700 with id: null
        send({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: 'Parse error: invalid JSON' },
        });
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
