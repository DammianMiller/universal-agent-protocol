/**
 * Tests for additional CLI modules
 */

import { describe, it, expect } from 'vitest';

describe('CLI Update Module', () => {
  it('should export updateCommand function', async () => {
    const module = await import('../src/cli/update.js');
    expect(module.updateCommand).toBeDefined();
    expect(typeof module.updateCommand).toBe('function');
  });
});

describe('CLI Generate Module', () => {
  it('should export generateCommand function', async () => {
    const module = await import('../src/cli/generate.js');
    expect(module.generateCommand).toBeDefined();
    expect(typeof module.generateCommand).toBe('function');
  });
});

describe('CLI Hooks Module', () => {
  it('should export hooks module', async () => {
    const module = await import('../src/cli/hooks.js');
    expect(module).toBeDefined();
  });
});

describe('CLI Setup Wizard Module', () => {
  it('should export runSetupWizard function', async () => {
    const module = await import('../src/cli/setup-wizard.js');
    expect(module.runSetupWizard).toBeDefined();
    expect(typeof module.runSetupWizard).toBe('function');
  });
});

describe('CLI Schema Diff Module', () => {
  it('should export registerSchemaDiffCommand function', async () => {
    const module = await import('../src/cli/schema-diff.js');
    expect(module.registerSchemaDiffCommand).toBeDefined();
    expect(typeof module.registerSchemaDiffCommand).toBe('function');
  });
});

describe('CLI Policy Module', () => {
  it('should export registerPolicyCommands function', async () => {
    const module = await import('../src/cli/policy.js');
    expect(module.registerPolicyCommands).toBeDefined();
    expect(typeof module.registerPolicyCommands).toBe('function');
  });
});

describe('CLI Analyze Module', () => {
  it('should export analyzeCommand function', async () => {
    const module = await import('../src/cli/analyze.js');
    expect(module.analyzeCommand).toBeDefined();
    expect(typeof module.analyzeCommand).toBe('function');
  });
});

describe('CLI Compliance Module', () => {
  it('should export complianceCommand function', async () => {
    const module = await import('../src/cli/compliance.js');
    expect(module.complianceCommand).toBeDefined();
    expect(typeof module.complianceCommand).toBe('function');
  });
});

describe('CLI RTK Module', () => {
  it('should export rtk module', async () => {
    const module = await import('../src/cli/rtk.js');
    expect(module).toBeDefined();
  });
});

describe('CLI MCP Router Setup Module', () => {
  it('should export setupMcpRouter function', async () => {
    const module = await import('../src/cli/setup-mcp-router.js');
    expect(module.setupMcpRouter).toBeDefined();
    expect(typeof module.setupMcpRouter).toBe('function');
  });
});
