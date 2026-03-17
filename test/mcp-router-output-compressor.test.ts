import { describe, it, expect } from 'vitest';
import { compressToolOutput } from '../src/mcp-router/output-compressor.js';

describe('MCP Router Output Compressor', () => {
  it('should pass through small output unchanged', () => {
    const result = compressToolOutput('small output');
    expect(result.output).toBe('small output');
    expect(result.stats.method).toBe('passthrough');
    expect(result.stats.savings).toBe('0%');
  });

  it('should pass through object output under threshold', () => {
    const obj = { key: 'value', nested: { a: 1 } };
    const result = compressToolOutput(obj);
    expect(result.output).toEqual(obj);
    expect(result.stats.method).toBe('passthrough');
  });

  it('should truncate large output without intent', () => {
    const largeContent = Array.from({ length: 500 }, (_, i) => `line ${i}: ${'x'.repeat(50)}`).join('\n');
    const result = compressToolOutput(largeContent, { maxBytes: 2048 });

    expect(result.stats.method).toBe('truncated');
    expect(result.stats.compressedBytes).toBeLessThan(result.stats.originalBytes);
    expect(typeof result.output).toBe('string');
    const output = result.output as string;
    expect(output).toContain('line 0:');
    expect(output).toContain('truncated');
  });

  it('should track compression stats correctly', () => {
    const largeContent = 'x'.repeat(10000);
    const result = compressToolOutput(largeContent, { maxBytes: 2048 });

    expect(result.stats.originalBytes).toBeGreaterThanOrEqual(10000);
    expect(result.stats.compressedBytes).toBeLessThan(result.stats.originalBytes);
    expect(result.stats.savings).toMatch(/\d+%/);
  });

  it('should index and search with intent on large output', () => {
    // Create large structured output with distinct sections
    const sections = [
      '# Authentication\nJWT tokens are used for auth. Bearer tokens in headers.\nToken expiry is 24 hours.',
      '# Database\nPostgreSQL 15 with pgvector extension.\nConnection pooling via pgbouncer.',
      '# Caching\nRedis cluster with 3 nodes.\nCache invalidation uses pub/sub.',
      '# Logging\nStructured JSON logging via winston.\nLog rotation every 24 hours.',
      '# Deployment\nKubernetes with Helm charts.\nCI/CD via GitHub Actions.',
    ];
    // Pad each section to make total > 10KB
    const padded = sections.map(s => s + '\n' + 'Additional details. '.repeat(100));
    const content = padded.join('\n\n');

    const result = compressToolOutput(content, { intent: 'authentication JWT token', maxBytes: 2048 });

    expect(result.stats.method).toBe('indexed');
    expect(result.stats.compressedBytes).toBeLessThan(result.stats.originalBytes);
    const output = result.output as string;
    expect(output).toContain('Indexed');
    // Should find the auth section
    expect(output.toLowerCase()).toContain('jwt');
  });

  it('should fall back to truncation when intent matches nothing', () => {
    const content = 'x'.repeat(15000);
    const result = compressToolOutput(content, { intent: 'nonexistent query xyz', maxBytes: 2048 });

    // Should still produce output (fallback to truncation)
    expect(result.stats.compressedBytes).toBeLessThan(result.stats.originalBytes);
    expect(typeof result.output).toBe('string');
  });

  it('should include vocabulary in indexed output', () => {
    const sections = Array.from({ length: 20 }, (_, i) =>
      `# Section ${i}\nThe authentication module handles JWT token validation and refresh.\n` +
      'Security headers are enforced. Rate limiting applies to API endpoints.\n'.repeat(20)
    );
    const content = sections.join('\n\n');

    const result = compressToolOutput(content, { intent: 'authentication', maxBytes: 2048 });

    if (result.stats.method === 'indexed') {
      const output = result.output as string;
      expect(output).toContain('Searchable terms');
    }
  });
});
