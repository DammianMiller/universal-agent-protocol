/**
 * Tests for CLI tools - basic smoke tests
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

describe('CLI Source Files', () => {
  const cliDir = join(process.cwd(), 'src/bin');

  it('should have policy.ts file', async () => {
    const content = readFileSync(join(cliDir, 'policy.ts'), 'utf-8');
    expect(content).toContain('Command');
  });

  it('should have tool-calls.ts file', async () => {
    const content = readFileSync(join(cliDir, 'tool-calls.ts'), 'utf-8');
    expect(content).toContain('Command');
  });

  it('should have llama-server-optimize.ts file', async () => {
    const content = readFileSync(join(cliDir, 'llama-server-optimize.ts'), 'utf-8');
    expect(content).toContain('Command');
  });
});

describe('CLI Module Exports', () => {
  it('should export policy module functions', async () => {
    const module = await import('../src/policies/policy-memory.js');
    expect(module.getPolicyMemoryManager).toBeDefined();
  });

  it('should export policy tools module functions', async () => {
    const module = await import('../src/policies/policy-tools.js');
    expect(module.getPolicyToolRegistry).toBeDefined();
  });

  it('should export policy gate module functions', async () => {
    const module = await import('../src/policies/policy-gate.js');
    expect(module.getPolicyGate).toBeDefined();
  });
});
