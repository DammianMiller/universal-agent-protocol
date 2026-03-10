/**
 * MCP Router Config Filtering Tests
 * 
 * Verifies that:
 * - Disabled servers are excluded
 * - Router itself is excluded (prevents circular reference)
 * - Valid servers are loaded
 */

import { describe, it, expect } from 'vitest';
import { loadConfigFromFile } from '../src/mcp-router/config/parser.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('MCP Router Config Filtering', () => {
  it('should exclude servers marked as disabled', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-test-'));
    const configPath = path.join(tmpDir, 'mcp.json');
    
    const config = {
      mcpServers: {
        'enabled-server': {
          command: 'npx',
          args: ['some-server'],
          disabled: false,
        },
        'disabled-server': {
          command: 'npx',
          args: ['disabled-server'],
          disabled: true,
        },
        'implicitly-enabled': {
          command: 'npx',
          args: ['another-server'],
        },
      },
    };
    
    fs.writeFileSync(configPath, JSON.stringify(config));
    
    const loaded = loadConfigFromFile(configPath);
    const serverNames = Object.keys(loaded.mcpServers);
    
    expect(serverNames).toContain('enabled-server');
    expect(serverNames).toContain('implicitly-enabled');
    expect(serverNames).not.toContain('disabled-server');
    
    fs.rmSync(tmpDir, { recursive: true });
  });
  
  it('should exclude router named "router"', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-test-'));
    const configPath = path.join(tmpDir, 'mcp.json');
    
    const config = {
      mcpServers: {
        'router': {
          command: 'npx',
          args: ['uap', 'mcp-router', 'start'],
        },
        'other-server': {
          command: 'npx',
          args: ['some-server'],
        },
      },
    };
    
    fs.writeFileSync(configPath, JSON.stringify(config));
    
    const loaded = loadConfigFromFile(configPath);
    const serverNames = Object.keys(loaded.mcpServers);
    
    expect(serverNames).not.toContain('router');
    expect(serverNames).toContain('other-server');
    
    fs.rmSync(tmpDir, { recursive: true });
  });
  
  it('should exclude servers with "mcp-router start" in args', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-test-'));
    const configPath = path.join(tmpDir, 'mcp.json');
    
    const config = {
      mcpServers: {
        'self-reference': {
          command: 'uap',
          args: ['mcp-router', 'start', '--config', 'foo.json'],
        },
        'another-self-reference': {
          command: 'npx',
          args: ['uap', 'mcp-router', 'start'],
        },
        'valid-server': {
          command: 'npx',
          args: ['some-other-tool'],
        },
      },
    };
    
    fs.writeFileSync(configPath, JSON.stringify(config));
    
    const loaded = loadConfigFromFile(configPath);
    const serverNames = Object.keys(loaded.mcpServers);
    
    expect(serverNames).not.toContain('self-reference');
    expect(serverNames).not.toContain('another-self-reference');
    expect(serverNames).toContain('valid-server');
    
    fs.rmSync(tmpDir, { recursive: true });
  });
  
  it('should handle combined disabled + self-reference', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-test-'));
    const configPath = path.join(tmpDir, 'mcp.json');
    
    const config = {
      mcpServers: {
        'router': {
          command: 'npx',
          args: ['uap', 'mcp-router', 'start'],
          disabled: true, // Both conditions to filter
        },
        'playwright': {
          command: 'npx',
          args: ['-y', '@playwright/mcp@latest'],
          disabled: true,
        },
        'chrome-devtools': {
          command: 'npx',
          args: ['-y', 'chrome-devtools-mcp@latest'],
          disabled: false,
        },
        'dev-browser': {
          command: 'npx',
          args: ['-y', '@anthropic-claude/dev-browser-mcp'],
        },
      },
    };
    
    fs.writeFileSync(configPath, JSON.stringify(config));
    
    const loaded = loadConfigFromFile(configPath);
    const serverNames = Object.keys(loaded.mcpServers);
    
    expect(serverNames).toEqual(['chrome-devtools', 'dev-browser']);
    
    fs.rmSync(tmpDir, { recursive: true });
  });
  
  it('should not filter servers with "router" in description but different command', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-test-'));
    const configPath = path.join(tmpDir, 'mcp.json');
    
    const config = {
      mcpServers: {
        'request-router': {
          command: 'node',
          args: ['request-router.js'], // Different tool, not mcp-router
        },
      },
    };
    
    fs.writeFileSync(configPath, JSON.stringify(config));
    
    const loaded = loadConfigFromFile(configPath);
    const serverNames = Object.keys(loaded.mcpServers);
    
    expect(serverNames).toContain('request-router');
    
    fs.rmSync(tmpDir, { recursive: true });
  });
});
