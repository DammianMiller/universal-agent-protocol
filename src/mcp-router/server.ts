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
    try {
      await this.clientPool.disconnectAll();
    } catch (err) {
      console.error(`[router] Shutdown error: ${(err as Error).message}`);
    }
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

/** Safely serialize a value to JSON without throwing on BigInt/circular refs */
function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    if (value === null || value === undefined) return '';
    if (typeof value === 'object') {
      try {
        return JSON.stringify(value, (_key, val) =>
          typeof val === 'bigint' ? val.toString() : val
        );
      } catch {
        return '[complex value]';
      }
    }
    return String(value);
  }
}

// Safety limits
const MAX_BATCH_SIZE = 100; // Reject batches larger than this
const MAX_BUFFER_BYTES = 10 * 1024 * 1024; // 10MB max stdin buffer

// ESM-compatible version reader for TypeScript modules
const PKG_VERSION = (() => {
  try {
    const { readFileSync } = require('fs');
    const { join, dirname } = require('path');
    const pkg = JSON.parse(
      readFileSync(
        join(dirname(new URL(import.meta.url).pathname), '..', '..', 'package.json'),
        'utf-8'
      )
    );
    return pkg.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
})();

/**
 * Run as stdio MCP server.
 * Fully JSON-RPC 2.0 compliant: parse errors (-32700), invalid request (-32600),
 * batch request support, jsonrpc field validation, protocol version negotiation,
 * initialize state gate, isError signaling, and proper batch response aggregation.
 */
export async function runStdioServer(options: RouterOptions = {}): Promise<void> {
  const router = new McpRouter({ ...options, verbose: true });

  let buffer = '';
  let initialized = false;
  let notifiedInitialized = false; // Track notifications/initialized receipt

  /** Safe write to stdout — silently ignores EPIPE (broken pipe) */
  function safeSend(data: string): void {
    try {
      process.stdout.write(data);
    } catch (err) {
      // EPIPE = client disconnected. Log and continue; don't crash.
      if ((err as NodeJS.ErrnoException).code !== 'EPIPE') {
        console.error(`[router] stdout write error: ${(err as Error).message}`);
      }
    }
  }

  function send(message: object): void {
    safeSend(JSON.stringify(message) + '\n');
  }

  /**
   * Handle a single JSON-RPC message. Returns a response object for batch
   * aggregation, or null for notifications (which produce no response).
   */
  function handleMessage(message: unknown): Promise<object | null> {
    // Validate it's an object
    if (!message || typeof message !== 'object') {
      return Promise.resolve({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32600, message: 'Invalid Request: expected a JSON object' },
      });
    }

    const msg = message as Record<string, unknown>;

    // JSON-RPC 2.0 compliance: validate jsonrpc field
    if (msg.jsonrpc !== '2.0') {
      return Promise.resolve({
        jsonrpc: '2.0',
        id: msg.id ?? null,
        error: {
          code: -32600,
          message: 'Invalid Request: missing or invalid "jsonrpc" field (must be "2.0")',
        },
      });
    }

    // JSON-RPC 2.0: id can be string, number, or null
    const id = msg.id as string | number | null | undefined;
    const method = msg.method as string;
    const params = msg.params as unknown;

    // Validate method field exists
    if (typeof method !== 'string') {
      if (id !== undefined) {
        return Promise.resolve({
          jsonrpc: '2.0',
          id,
          error: { code: -32600, message: 'Invalid Request: missing or invalid "method" field' },
        });
      }
      return Promise.resolve(null); // Notification with no method — ignore
    }

    switch (method) {
      case 'initialize': {
        // Reject re-initialization after notifications/initialized per MCP spec
        if (notifiedInitialized) {
          return Promise.resolve({
            jsonrpc: '2.0',
            id,
            error: {
              code: -32600,
              message: 'Already initialized. Re-initialization is not allowed.',
            },
          });
        }
        // Protocol version negotiation
        const initParams = params as { protocolVersion?: string } | undefined;
        const clientVersion = initParams?.protocolVersion;
        if (clientVersion && clientVersion !== SUPPORTED_PROTOCOL_VERSION) {
          console.error(
            `[router] Client requested protocol version ${clientVersion}, ` +
              `server supports ${SUPPORTED_PROTOCOL_VERSION}. Proceeding with server version.`
          );
        }
        initialized = true;
        return Promise.resolve({
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: SUPPORTED_PROTOCOL_VERSION,
            capabilities: {
              tools: { listChanged: false },
            },
            serverInfo: {
              name: 'uap-mcp-router',
              version: PKG_VERSION,
            },
          },
        });
      }

      case 'notifications/initialized':
        // Mark initialization complete — reject future re-initialization
        notifiedInitialized = true;
        return Promise.resolve(null);

      case 'ping':
        return Promise.resolve({ jsonrpc: '2.0', id, result: {} });

      case 'tools/list':
        // Gate: require initialization before accepting requests
        if (!initialized) {
          return Promise.resolve({
            jsonrpc: '2.0',
            id,
            error: {
              code: -32600,
              message: 'Server not initialized. Send "initialize" first.',
            },
          });
        }
        return Promise.resolve({
          jsonrpc: '2.0',
          id,
          result: {
            tools: router.getToolDefinitions(),
          },
        });

      case 'tools/call': {
        // Gate: require initialization
        if (!initialized) {
          return Promise.resolve({
            jsonrpc: '2.0',
            id,
            error: {
              code: -32600,
              message: 'Server not initialized. Send "initialize" first.',
            },
          });
        }
        if (!params || typeof params !== 'object') {
          return Promise.resolve({
            jsonrpc: '2.0',
            id,
            error: { code: -32602, message: 'Invalid params: expected { name, arguments }' },
          });
        }
        const { name, arguments: args } = params as { name: string; arguments: unknown };
        if (typeof name !== 'string') {
          return Promise.resolve({
            jsonrpc: '2.0',
            id,
            error: { code: -32602, message: 'Invalid params: "name" must be a string' },
          });
        }
        return router
          .handleToolCall(name, args)
          .then((result) => {
            // execute.ts no longer includes compressionStats in the return value,
            // so no stripping is needed. Serialize without pretty-printing.
            const safeResult = result ?? '';
            const serialized = safeJsonStringify(safeResult);

            // Check if the tool call itself reported failure (success: false)
            const isError =
              safeResult &&
              typeof safeResult === 'object' &&
              'success' in (safeResult as Record<string, unknown>) &&
              (safeResult as Record<string, unknown>).success === false;

            return {
              jsonrpc: '2.0',
              id,
              result: {
                content: [{ type: 'text', text: serialized }],
                ...(isError ? { isError: true } : {}),
              },
            };
          })
          .catch((error) => ({
            // Protocol-level errors (unknown tool, handleToolCall rejection) use
            // JSON-RPC error responses. Tool-level failures (success: false) are
            // handled in the .then() path with isError content instead.
            jsonrpc: '2.0',
            id,
            error: {
              code: -32603,
              message: error instanceof Error ? error.message : String(error),
            },
          }));
      }

      default:
        // Only send error for requests (with id), not notifications
        if (id !== undefined) {
          return Promise.resolve({
            jsonrpc: '2.0',
            id,
            error: {
              code: -32601,
              message: `Method not found: ${method}`,
            },
          });
        }
        return Promise.resolve(null);
    }
  }

  process.stdin.on('data', (data: Buffer) => {
    buffer += data.toString();

    // Guard against unbounded buffer growth from a client that never sends newlines
    if (Buffer.byteLength(buffer, 'utf-8') > MAX_BUFFER_BYTES) {
      console.error(`[router] stdin buffer exceeded ${MAX_BUFFER_BYTES} bytes, dropping`);
      buffer = '';
      send({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32600, message: 'Request too large' },
      });
      return;
    }

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
          } else if (parsed.length > MAX_BATCH_SIZE) {
            send({
              jsonrpc: '2.0',
              id: null,
              error: {
                code: -32600,
                message: `Batch too large: ${parsed.length} requests (max ${MAX_BATCH_SIZE})`,
              },
            });
          } else {
            // Process all messages in the batch and aggregate responses
            // into a single JSON array per JSON-RPC 2.0 spec section 6.
            // Use allSettled to prevent one rejection from breaking the batch.
            Promise.allSettled(parsed.map((msg: unknown) => handleMessage(msg)))
              .then((results) => {
                const responses: object[] = [];
                for (const r of results) {
                  if (r.status === 'fulfilled' && r.value !== null) {
                    responses.push(r.value);
                  } else if (r.status === 'rejected') {
                    responses.push({
                      jsonrpc: '2.0',
                      id: null,
                      error: { code: -32603, message: 'Internal error' },
                    });
                  }
                }
                if (responses.length > 0) {
                  safeSend(JSON.stringify(responses) + '\n');
                }
              })
              .catch((err) => {
                console.error(`[router] batch processing error: ${(err as Error).message}`);
              });
          }
        } else {
          // Single request — send response directly
          handleMessage(parsed)
            .then((response) => {
              if (response) send(response);
            })
            .catch((err) => {
              console.error(`[router] message handling error: ${(err as Error).message}`);
            });
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

  process.stdin.on('error', (err) => {
    console.error(`[router] stdin error: ${err.message}`);
  });

  process.stdout.on('error', (err) => {
    if ((err as NodeJS.ErrnoException).code === 'EPIPE') {
      // Client disconnected — shut down gracefully
      router.shutdown().then(() => process.exit(0));
    } else {
      console.error(`[router] stdout error: ${err.message}`);
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
