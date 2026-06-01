import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  EXECUTE_TOOL_DEFINITION,
  estimateExecuteToolTokens,
  handleExecuteTool,
} from '../../src/mcp-router/tools/execute.js';
import { ToolSearchIndex } from '../../src/mcp-router/search/fuzzy.js';
import type { McpClientPool } from '../../src/mcp-router/executor/client.js';
import { _resetHaloSession } from '../../src/observability/halo-exporter.js';

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

  describe('HALO spans on hallucination early-returns', () => {
    const stubPool = {} as McpClientPool;
    let dir: string;
    let trace: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'uap-exec-halo-'));
      trace = join(dir, 'traces.jsonl');
      process.env.UAP_HALO_TRACE = '1';
      process.env.UAP_HALO_TRACE_PATH = trace;
      _resetHaloSession();
    });
    afterEach(() => {
      delete process.env.UAP_HALO_TRACE;
      delete process.env.UAP_HALO_TRACE_PATH;
      rmSync(dir, { recursive: true, force: true });
    });

    it('records an invalid_path span for a dot-less tool path', async () => {
      const res = await handleExecuteTool(
        { path: 'github_create_issue', args: {} },
        new ToolSearchIndex({ threshold: 0.2 }),
        stubPool
      );
      expect(res.success).toBe(false);
      const span = JSON.parse(readFileSync(trace, 'utf-8').trim());
      expect(span.attributes['error.kind']).toBe('invalid_path');
      expect(span.attributes['inference.observation_kind']).toBe('TOOL');
      expect(span.status.code).toBe('STATUS_CODE_ERROR');
    });

    it('records a not_found span for an unknown tool name', async () => {
      const res = await handleExecuteTool(
        { path: 'gh.craete_issue', args: {} },
        new ToolSearchIndex({ threshold: 0.2 }),
        stubPool
      );
      expect(res.success).toBe(false);
      const lines = readFileSync(trace, 'utf-8').trim().split('\n');
      const span = JSON.parse(lines[lines.length - 1]);
      expect(span.attributes['error.kind']).toBe('not_found');
    });
  });
});
