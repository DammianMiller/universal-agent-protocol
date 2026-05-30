import { describe, it, expect } from 'vitest';
import {
  EXECUTE_TOOL_DEFINITION,
  estimateExecuteToolTokens,
  handleExecuteTool,
} from '../../src/mcp-router/tools/execute.js';
import { ToolSearchIndex } from '../../src/mcp-router/search/fuzzy.js';
import type { McpClientPool } from '../../src/mcp-router/executor/client.js';

describe('MCP Router Execute Tool', () => {
  describe('EXECUTE_TOOL_DEFINITION', () => {
    it('should have correct tool name', () => {
      expect(EXECUTE_TOOL_DEFINITION.name).toBe('execute_tool');
    });

    it('should have description', () => {
      expect(EXECUTE_TOOL_DEFINITION.description.length).toBeGreaterThan(0);
    });

    it('should have required path parameter', () => {
      expect(EXECUTE_TOOL_DEFINITION.inputSchema.required).toContain('path');
    });

    it('should have path, args, and intent properties', () => {
      const props = EXECUTE_TOOL_DEFINITION.inputSchema.properties;
      expect(props).toHaveProperty('path');
      expect(props).toHaveProperty('args');
      expect(props).toHaveProperty('intent');
    });

    it('should describe path format', () => {
      expect(EXECUTE_TOOL_DEFINITION.inputSchema.properties.path.description).toContain('server.tool_name');
    });
  });

  describe('estimateExecuteToolTokens', () => {
    it('should return a positive number', () => {
      const tokens = estimateExecuteToolTokens();
      expect(tokens).toBeGreaterThan(0);
    });

    it('should be consistent across calls', () => {
      const t1 = estimateExecuteToolTokens();
      const t2 = estimateExecuteToolTokens();
      expect(t1).toBe(t2);
    });
  });

  describe('expert consultation dispatch', () => {
    // The experts.<droid> branch runs before any search-index / client-pool
    // use, so a fresh index and a stub pool are sufficient. consultExpert reads
    // the real .factory/droids/ in the worktree cwd.
    const emptyIndex = () => new ToolSearchIndex({ threshold: 0.2 });
    const stubPool = {} as McpClientPool;

    it('dispatches experts.<droid> to an in-process consultation', async () => {
      const res = await handleExecuteTool(
        { path: 'experts.security-auditor', args: { context: 'review my auth diff' } },
        emptyIndex(),
        stubPool
      );
      expect(res.success).toBe(true);
      expect(res.toolPath).toBe('experts.security-auditor');
      expect(String(res.result)).toContain('security-auditor');
      expect(String(res.result)).toContain('review my auth diff');
    });

    it('returns a not-found error for an unknown expert', async () => {
      const res = await handleExecuteTool(
        { path: 'experts.no-such-droid', args: { context: 'x' } },
        emptyIndex(),
        stubPool
      );
      expect(res.success).toBe(false);
      expect(res.error).toContain('not found');
    });
  });
});
