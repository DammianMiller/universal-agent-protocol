/**
 * Config Parser
 * Loads MCP configurations from Cursor, Claude, VS Code, and local mcp.json
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { McpConfig, McpServerConfig } from '../types.js';

const CONFIG_PATHS = {
  // Claude Desktop
  claudeDesktop: {
    darwin: '~/Library/Application Support/Claude/claude_desktop_config.json',
    win32: '%APPDATA%/Claude/claude_desktop_config.json',
    linux: '~/.config/Claude/claude_desktop_config.json',
  },
  // Cursor
  cursor: {
    darwin: '~/Library/Application Support/Cursor/User/globalStorage/cursor.mcp/config.json',
    win32: '%APPDATA%/Cursor/User/globalStorage/cursor.mcp/config.json',
    linux: '~/.config/Cursor/User/globalStorage/cursor.mcp/config.json',
  },
  // VS Code
  vscode: {
    darwin: '~/Library/Application Support/Code/User/globalStorage/anthropic.claude-code/settings.json',
    win32: '%APPDATA%/Code/User/globalStorage/anthropic.claude-code/settings.json',
    linux: '~/.config/Code/User/globalStorage/anthropic.claude-code/settings.json',
  },
  // Claude Code CLI
  claudeCode: {
    darwin: '~/.claude/settings.json',
    win32: '%USERPROFILE%/.claude/settings.json',
    linux: '~/.claude/settings.json',
  },
  // Factory.AI Droid
  factoryAI: {
    darwin: '~/.factory/mcp.json',
    win32: '%USERPROFILE%/.factory/mcp.json',
    linux: '~/.factory/mcp.json',
  },
};

function expandPath(p: string): string {
  if (p.startsWith('~')) {
    return path.join(os.homedir(), p.slice(1));
  }
  if (p.includes('%APPDATA%')) {
    return p.replace('%APPDATA%', process.env.APPDATA || '');
  }
  if (p.includes('%USERPROFILE%')) {
    return p.replace('%USERPROFILE%', process.env.USERPROFILE || os.homedir());
  }
  return p;
}

function expandEnvVars(value: string): string {
  // Support ${VAR}, ${VAR:-default}, and $env:VAR patterns
  return value
    .replace(/\$\{([^}:-]+)(?::-([^}]*))?\}/g, (_, name, fallback) => {
      return process.env[name] || fallback || '';
    })
    .replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/g, (_, name) => {
      return process.env[name] || '';
    });
}

function expandConfigEnvVars(config: McpServerConfig): McpServerConfig {
  const expanded = { ...config };
  
  if (expanded.env) {
    expanded.env = Object.fromEntries(
      Object.entries(expanded.env).map(([k, v]) => [k, expandEnvVars(v)])
    );
  }
  
  if (expanded.url) {
    expanded.url = expandEnvVars(expanded.url);
  }
  
  if (expanded.args) {
    expanded.args = expanded.args.map(expandEnvVars);
  }
  
  return expanded;
}

function readJsonFile(filePath: string): unknown | null {
  try {
    const expanded = expandPath(filePath);
    if (!fs.existsSync(expanded)) return null;
    const content = fs.readFileSync(expanded, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function extractMcpServers(config: unknown): Record<string, McpServerConfig> {
  if (!config || typeof config !== 'object') return {};
  
  const obj = config as Record<string, unknown>;
  
  // Direct mcpServers key
  if (obj.mcpServers && typeof obj.mcpServers === 'object') {
    return obj.mcpServers as Record<string, McpServerConfig>;
  }
  
  // Claude Desktop format
  if (obj.mcp_servers && typeof obj.mcp_servers === 'object') {
    return obj.mcp_servers as Record<string, McpServerConfig>;
  }
  
  return {};
}

function isRouterSelf(name: string, serverConfig: McpServerConfig): boolean {
  // Check if this is the router itself to prevent circular reference
  if (name === 'router') return true;
  
  // Check if args contain mcp-router start
  if (serverConfig.args) {
    const argsStr = serverConfig.args.join(' ');
    if (argsStr.includes('mcp-router') && argsStr.includes('start')) {
      return true;
    }
  }
  
  return false;
}

export function loadConfigFromPaths(): McpConfig {
  const platform = process.platform as 'darwin' | 'win32' | 'linux';
  const servers: Record<string, McpServerConfig> = {};
  
  // Load from all known config locations
  for (const [_source, paths] of Object.entries(CONFIG_PATHS)) {
    const configPath = paths[platform];
    if (!configPath) continue;
    
    const config = readJsonFile(configPath);
    const sourceServers = extractMcpServers(config);
    
    for (const [name, serverConfig] of Object.entries(sourceServers)) {
      // Skip disabled servers
      if (serverConfig.disabled) continue;
      
      // Skip router itself to prevent circular reference
      if (isRouterSelf(name, serverConfig)) continue;
      
      if (!servers[name]) {
        servers[name] = expandConfigEnvVars(serverConfig);
      }
    }
  }
  
  // Load local mcp.json (highest priority)
  const localConfig = readJsonFile('./mcp.json') || readJsonFile('./.mcp.json');
  const localServers = extractMcpServers(localConfig);
  
  for (const [name, serverConfig] of Object.entries(localServers)) {
    // Skip disabled servers
    if (serverConfig.disabled) continue;
    
    // Skip router itself to prevent circular reference
    if (isRouterSelf(name, serverConfig)) continue;
    
    servers[name] = expandConfigEnvVars(serverConfig);
  }
  
  return { mcpServers: servers };
}

export function loadConfigFromFile(filePath: string): McpConfig {
  const config = readJsonFile(filePath);
  const servers = extractMcpServers(config);
  
  const expanded: Record<string, McpServerConfig> = {};
  for (const [name, serverConfig] of Object.entries(servers)) {
    // Skip disabled servers
    if (serverConfig.disabled) continue;
    
    // Skip router itself to prevent circular reference
    if (isRouterSelf(name, serverConfig)) continue;
    
    expanded[name] = expandConfigEnvVars(serverConfig);
  }
  
  return { mcpServers: expanded };
}

export function mergeConfigs(...configs: McpConfig[]): McpConfig {
  const merged: Record<string, McpServerConfig> = {};
  
  for (const config of configs) {
    for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
      merged[name] = serverConfig;
    }
  }
  
  return { mcpServers: merged };
}
