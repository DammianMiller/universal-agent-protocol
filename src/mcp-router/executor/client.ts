/**
 * MCP Client Executor
 * Spawns and communicates with MCP servers
 */

import { spawn, type ChildProcess } from 'child_process';
import type { McpServerConfig, ToolDefinition } from '../types.js';
import { RateLimiter } from '../../utils/rate-limiter.js';
import { getEnforcedToolRouter } from '../../policies/enforced-tool-router.js';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export class McpClient {
  private process: ChildProcess | null = null;
  private requestId = 0;
  private pendingRequests = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
    }
  >();
  private buffer = '';
  private initialized = false;
  private serverName: string;
  private config: McpServerConfig;
  /** Serialized config for stale-detection by the pool */
  readonly configHash: string;

  constructor(serverName: string, config: McpServerConfig) {
    this.serverName = serverName;
    this.config = config;
    this.configHash = JSON.stringify(config);
  }

  async connect(): Promise<void> {
    if (this.process) return;

    if (this.config.url) {
      // HTTP/SSE transport requires a streaming HTTP client (planned for v0.9.0)
      throw new Error(
        `HTTP/SSE transport is not yet supported for server "${this.serverName}". ` +
          `Use stdio transport instead by specifying "command" in the server config. ` +
          `See: https://github.com/DammianMiller/universal-agent-protocol/issues`
      );
    }

    if (!this.config.command) {
      throw new Error(`No command specified for server ${this.serverName}`);
    }

    const env = { ...process.env, ...this.config.env };

    this.process = spawn(this.config.command, this.config.args || [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });

    this.process.stdout?.on('data', (data: Buffer) => {
      this.handleData(data.toString());
    });

    this.process.stderr?.on('data', (data: Buffer) => {
      // Log stderr but don't fail
      console.error(`[${this.serverName}] stderr:`, data.toString());
    });

    this.process.on('error', (err) => {
      console.error(`[${this.serverName}] process error:`, err);
      this.cleanup();
    });

    this.process.on('exit', (code) => {
      if (code !== 0) {
        console.error(`[${this.serverName}] exited with code ${code}`);
      }
      this.cleanup();
    });

    // Initialize MCP connection
    await this.initialize();
  }

  private handleData(data: string): void {
    this.buffer += data;

    // Process complete JSON-RPC messages (newline-delimited)
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const response = JSON.parse(line) as JsonRpcResponse;
        const pending = this.pendingRequests.get(response.id);

        if (pending) {
          this.pendingRequests.delete(response.id);
          if (response.error) {
            pending.reject(new Error(response.error.message));
          } else {
            // Guard against undefined response.result (JSON-RPC allows absent result)
            // Normalize to null so downstream code never receives undefined
            pending.resolve(response.result ?? null);
          }
        }
      } catch (e) {
        // Ignore non-JSON lines
      }
    }
  }

  private async sendRequest(method: string, params?: unknown): Promise<unknown> {
    if (!this.process?.stdin) {
      throw new Error(`Not connected to ${this.serverName}`);
    }

    const id = ++this.requestId;
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request timeout for ${method}`));
      }, 30000);

      this.pendingRequests.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });

      const requestStr = JSON.stringify(request) + '\n';
      this.process!.stdin!.write(requestStr, (writeErr) => {
        if (writeErr) {
          clearTimeout(timeout);
          this.pendingRequests.delete(id);
          reject(new Error(`Write failed: ${writeErr.message}`));
        }
      });
    });
  }

  private async initialize(): Promise<void> {
    await this.sendRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: {
        name: 'uap-mcp-router',
        version: '1.0.0',
      },
    });

    // Send initialized notification
    this.process?.stdin?.write(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      }) + '\n'
    );

    this.initialized = true;
  }

  async listTools(): Promise<ToolDefinition[]> {
    if (!this.initialized) {
      await this.connect();
    }

    const result = (await this.sendRequest('tools/list')) as {
      tools: Array<{
        name: string;
        description?: string;
        inputSchema: unknown;
      }>;
    };

    return (result.tools || []).map((tool) => ({
      name: tool.name,
      description: tool.description || '',
      inputSchema: tool.inputSchema as ToolDefinition['inputSchema'],
      serverName: this.serverName,
      serverConfig: this.config,
    }));
  }

  /**
   * Call a tool on the connected MCP server.
   *
   * !! REGRESSION GUARD — DO NOT MODIFY THE RETURN VALUE !!
   *
   * This method MUST return the raw JSON-RPC result exactly as received from
   * the downstream MCP server. The result is typically an MCP content envelope:
   *   { content: [{ type: "text", text: "..." }] }
   *
   * DO NOT:
   *  - Unwrap, flatten, or extract text from content blocks
   *  - Substitute placeholder strings like "(no output)" for null/undefined
   *  - Wrap the result in a new object or add metadata
   *
   * WHY: v1.4.0 added content unwrapping here and it was reverted in v1.4.1
   * because it broke Qwen3.5 (and similar small MoE models). The unwrapping
   * caused double-processing — the router's server.ts already wraps results
   * in MCP content blocks for upstream clients. When callTool() also unwrapped,
   * the model received flattened text instead of structured tool results,
   * causing it to misinterpret outputs and trigger infinite retries.
   *
   * The same regression was nearly re-introduced via unwrapMcpContent() in
   * execute.ts during the v1.4.2 compliance work and had to be reverted again.
   *
   * If you need to transform the result, do it in execute.ts (application
   * layer), NOT here (transport layer) — and read the v1.4.1 commit message
   * (5941768f) before changing anything.
   *
   * @see commit 5941768f "fix: v1.4.1 - revert callTool content unwrapping"
   */
  async callTool(toolName: string, args: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.initialized) {
      await this.connect();
    }

    const result = await this.sendRequest('tools/call', {
      name: toolName,
      arguments: args,
    });

    return result;
  }

  private cleanup(): void {
    this.process = null;
    this.initialized = false;
    this.buffer = '';

    // Reject all pending requests
    for (const [_id, { reject }] of this.pendingRequests) {
      reject(new Error('Connection closed'));
    }
    this.pendingRequests.clear();
  }

  disconnect(): void {
    if (this.process) {
      // Remove listeners before kill to prevent double-cleanup from the exit handler
      this.process.removeAllListeners();
      this.process.stdout?.removeAllListeners();
      this.process.stderr?.removeAllListeners();
      this.process.stdin?.end();
      this.process.kill();
      this.cleanup();
    }
  }

  get isConnected(): boolean {
    return this.process !== null && this.initialized;
  }
}

// Connection pool for reusing MCP clients with rate limiting
export class McpClientPool {
  private clients = new Map<string, McpClient>();
  /** Per-server rate limiter to prevent overloading downstream MCP servers */
  private rateLimiter: RateLimiter;

  constructor(options?: { maxRequestsPerWindow?: number; windowMs?: number }) {
    this.rateLimiter = new RateLimiter({
      maxRequests: options?.maxRequestsPerWindow ?? 60,
      windowMs: options?.windowMs ?? 10_000, // 60 requests per 10s per server
    });
  }

  getClient(serverName: string, config: McpServerConfig): McpClient {
    let client = this.clients.get(serverName);

    // Detect stale config — if the server config changed, disconnect the old
    // client and create a new one with the updated config.
    if (client && client.configHash !== JSON.stringify(config)) {
      client.disconnect();
      client = undefined;
    }

    if (!client) {
      client = new McpClient(serverName, config);
      this.clients.set(serverName, client);
    }

    return client;
  }

  /**
   * Check if a request to a server is allowed by the rate limiter.
   * Returns true if allowed, false if rate-limited.
   */
  isRequestAllowed(serverName: string): boolean {
    return this.rateLimiter.isAllowed(serverName);
  }

  /**
   * Get remaining requests for a server in the current window.
   */
  getRemainingRequests(serverName: string): number {
    return this.rateLimiter.getRemainingRequests(serverName);
  }

  async disconnectAll(): Promise<void> {
    for (const client of this.clients.values()) {
      client.disconnect();
    }
    this.clients.clear();
  }

  /**
   * Execute a tool call through the policy gate.
   * Checks REQUIRED policies before forwarding to the MCP server.
   * Falls back to direct execution if policy gate is not configured.
   */
  async executeToolWithPolicy(
    serverName: string,
    config: McpServerConfig,
    toolName: string,
    args: Record<string, unknown> = {}
  ): Promise<unknown> {
    // Rate limit check
    if (!this.isRequestAllowed(serverName)) {
      throw new Error(`Rate limited: ${serverName} (${this.getRemainingRequests(serverName)} remaining)`);
    }

    // Policy check (non-blocking if no policies configured)
    try {
      const router = getEnforcedToolRouter();
      const check = await router.wouldAllow(toolName, { ...args, _server: serverName });
      if (!check.allowed) {
        throw new Error(`Policy blocked tool "${toolName}": ${check.reasons.join('; ')}`);
      }
    } catch (err) {
      // If the error is a policy block, re-throw. Otherwise ignore (no policies configured).
      if (err instanceof Error && err.message.startsWith('Policy blocked')) throw err;
    }

    const client = this.getClient(serverName, config);
    return client.callTool(toolName, args);
  }

  getConnectedServers(): string[] {
    return Array.from(this.clients.entries())
      .filter(([_, client]) => client.isConnected)
      .map(([name]) => name);
  }
}
