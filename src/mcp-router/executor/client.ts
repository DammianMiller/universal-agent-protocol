/**
 * MCP Client Executor
 * Spawns and communicates with MCP servers
 */

import { spawn, type ChildProcess } from 'child_process';
import type { McpServerConfig, ToolDefinition } from '../types.js';

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

  constructor(serverName: string, config: McpServerConfig) {
    this.serverName = serverName;
    this.config = config;
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
      this.pendingRequests.set(id, { resolve, reject });

      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request timeout for ${method}`));
      }, 30000);

      const originalResolve = this.pendingRequests.get(id)!.resolve;
      this.pendingRequests.get(id)!.resolve = (value) => {
        clearTimeout(timeout);
        originalResolve(value);
      };

      this.process!.stdin!.write(JSON.stringify(request) + '\n');
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

  async callTool(toolName: string, args: Record<string, unknown> = {}): Promise<unknown> {
    if (!this.initialized) {
      await this.connect();
    }

    const result = await this.sendRequest('tools/call', {
      name: toolName,
      arguments: args,
    });

    // Return the raw MCP result as-is. The MCP tools/call response format
    // { content: [{ type, text }] } is the standard envelope and must be
    // preserved for downstream consumers (execute.ts, output-compressor).
    // Do NOT unwrap content blocks here - that would double-process when
    // the router itself wraps results in the same format for upstream clients.
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
      this.process.stdin?.end();
      this.process.kill();
      this.cleanup();
    }
  }

  get isConnected(): boolean {
    return this.process !== null && this.initialized;
  }
}

// Connection pool for reusing MCP clients
export class McpClientPool {
  private clients = new Map<string, McpClient>();

  getClient(serverName: string, config: McpServerConfig): McpClient {
    let client = this.clients.get(serverName);

    if (!client) {
      client = new McpClient(serverName, config);
      this.clients.set(serverName, client);
    }

    return client;
  }

  async disconnectAll(): Promise<void> {
    for (const client of this.clients.values()) {
      client.disconnect();
    }
    this.clients.clear();
  }

  getConnectedServers(): string[] {
    return Array.from(this.clients.entries())
      .filter(([_, client]) => client.isConnected)
      .map(([name]) => name);
  }
}
