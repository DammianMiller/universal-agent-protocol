/**
 * Tests for CLI modules
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('CLI Init Module', () => {
  it('should export initCommand function', async () => {
    const module = await import('../src/cli/init.js');
    expect(module.initCommand).toBeDefined();
    expect(typeof module.initCommand).toBe('function');
  });
});

describe('CLI Memory Module', () => {
  it('should export memoryCommand function', async () => {
    const module = await import('../src/cli/memory.js');
    expect(module.memoryCommand).toBeDefined();
    expect(typeof module.memoryCommand).toBe('function');
  });
});

describe('CLI Model Module', () => {
  it('should export registerModelCommands function', async () => {
    const module = await import('../src/cli/model.js');
    expect(module.registerModelCommands).toBeDefined();
    expect(typeof module.registerModelCommands).toBe('function');
  });
});

describe('CLI Setup Module', () => {
  it('should export setupCommand function', async () => {
    const module = await import('../src/cli/setup.js');
    expect(module.setupCommand).toBeDefined();
    expect(typeof module.setupCommand).toBe('function');
  });
});

describe('CLI Sync Module', () => {
  it('should export syncCommand function', async () => {
    const module = await import('../src/cli/sync.js');
    expect(module.syncCommand).toBeDefined();
    expect(typeof module.syncCommand).toBe('function');
  });
});

describe('CLI Worktree Module', () => {
  it('should export worktreeCommand function', async () => {
    const module = await import('../src/cli/worktree.js');
    expect(module.worktreeCommand).toBeDefined();
    expect(typeof module.worktreeCommand).toBe('function');
  });
});

describe('CLI Droids Module', () => {
  it('should export droidsCommand function', async () => {
    const module = await import('../src/cli/droids.js');
    expect(module.droidsCommand).toBeDefined();
    expect(typeof module.droidsCommand).toBe('function');
  });
});

describe('CLI Coord Module', () => {
  it('should export coordCommand function', async () => {
    const module = await import('../src/cli/coord.js');
    expect(module.coordCommand).toBeDefined();
    expect(typeof module.coordCommand).toBe('function');
  });
});

describe('CLI Agent Module', () => {
  it('should export agentCommand function', async () => {
    const module = await import('../src/cli/agent.js');
    expect(module.agentCommand).toBeDefined();
    expect(typeof module.agentCommand).toBe('function');
  });
});

describe('CLI Deploy Module', () => {
  it('should export deployCommand function', async () => {
    const module = await import('../src/cli/deploy.js');
    expect(module.deployCommand).toBeDefined();
    expect(typeof module.deployCommand).toBe('function');
  });
});

describe('CLI Task Module', () => {
  it('should export taskCommand function', async () => {
    const module = await import('../src/cli/task.js');
    expect(module.taskCommand).toBeDefined();
    expect(typeof module.taskCommand).toBe('function');
  });
});

describe('CLI Dashboard Module', () => {
  it('should export dashboardCommand function', async () => {
    const module = await import('../src/cli/dashboard.js');
    expect(module.dashboardCommand).toBeDefined();
    expect(typeof module.dashboardCommand).toBe('function');
  });
});

describe('CLI Hooks Module', () => {
  it('should export hooks module', async () => {
    const module = await import('../src/cli/hooks.js');
    expect(module).toBeDefined();
  });
});

describe('CLI Patterns Module', () => {
  it('should export patternsCommand function', async () => {
    const module = await import('../src/cli/patterns.js');
    expect(module.patternsCommand).toBeDefined();
    expect(typeof module.patternsCommand).toBe('function');
  });
});

describe('CLI Compliance Module', () => {
  it('should export complianceCommand function', async () => {
    const module = await import('../src/cli/compliance.js');
    expect(module.complianceCommand).toBeDefined();
    expect(typeof module.complianceCommand).toBe('function');
  });
});

describe('CLI MCP Router Module', () => {
  it('should export mcpRouterCommand function', async () => {
    const module = await import('../src/cli/mcp-router.js');
    expect(module.mcpRouterCommand).toBeDefined();
    expect(typeof module.mcpRouterCommand).toBe('function');
  });
});

describe('CLI RTK Module', () => {
  it('should export rtk module', async () => {
    const module = await import('../src/cli/rtk.js');
    expect(module).toBeDefined();
  });
});
