import { describe, it, expect } from 'vitest';
import { EXECUTE_TOOL_DEFINITION, estimateExecuteToolTokens } from '../../src/mcp-router/tools/execute.js';

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
});
