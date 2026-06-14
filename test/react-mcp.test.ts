/**
 * Tests for the `react` MCP tool (Codex degraded mode — no hooks, MCP only).
 */
import { describe, it, expect } from 'vitest';
import { handleReact, REACT_TOOL_DEFINITION } from '../src/mcp-router/tools/react';
import type { ReactorResult } from '../src/coordination/reactor';

describe('react MCP tool', () => {
  it('exposes a valid tool definition requiring promptText', () => {
    expect(REACT_TOOL_DEFINITION.name).toBe('react');
    expect(REACT_TOOL_DEFINITION.inputSchema.required).toContain('promptText');
  });

  it('resolves capabilities for a substantive task', () => {
    const r = handleReact({
      promptText: 'add JWT auth and fix the security vulnerability in login',
      changedFiles: ['src/auth/login.ts'],
    });
    expect(r.ok).toBe(true);
    const result = r.result as ReactorResult;
    expect(result).toHaveProperty('inject');
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.inject).toContain('security-auditor');
  });

  it('errors on missing/empty promptText', () => {
    const r = handleReact({ promptText: '' });
    expect(r.ok).toBe(false);
    expect(r.error).toBeDefined();
  });

  it('honors surfaced-key dedup', () => {
    const r = handleReact({
      promptText: 'add JWT auth and fix the security vulnerability',
      changedFiles: ['src/auth/login.ts'],
      surfaced: ['droid:security-auditor'],
    });
    const result = r.result as ReactorResult;
    expect(result.inject).not.toContain('security-auditor');
  });
});
