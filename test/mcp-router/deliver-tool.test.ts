import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  DELIVER_TOOL_DEFINITION,
  handleDeliver,
  estimateDeliverToolTokens,
  extractLastJson,
} from '../../src/mcp-router/tools/deliver.js';
import { McpRouter } from '../../src/mcp-router/server.js';

describe('DELIVER_TOOL_DEFINITION', () => {
  it('is a well-formed MCP tool definition requiring instruction', () => {
    expect(DELIVER_TOOL_DEFINITION.name).toBe('deliver');
    expect(DELIVER_TOOL_DEFINITION.inputSchema.required).toContain('instruction');
    expect(DELIVER_TOOL_DEFINITION.inputSchema.properties).toHaveProperty('dryRun');
    expect(DELIVER_TOOL_DEFINITION.description).toMatch(/convergence loop|uap deliver/i);
    expect(estimateDeliverToolTokens()).toBeGreaterThan(0);
  });
});

describe('handleDeliver validation', () => {
  it('rejects an empty instruction', async () => {
    const r = await handleDeliver({ instruction: '   ' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/instruction is required/);
  });

  it('rejects an out-of-range maxTurns', async () => {
    const r = await handleDeliver({ instruction: 'do it', maxTurns: 99 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/maxTurns/);
  });

  it('rejects a non-finite timeoutSec and a non-preset model id', async () => {
    expect((await handleDeliver({ instruction: 'x', timeoutSec: Number.NaN })).error).toMatch(/timeoutSec/);
    expect((await handleDeliver({ instruction: 'x', timeoutSec: -5 })).error).toMatch(/timeoutSec/);
    expect((await handleDeliver({ instruction: 'x', model: '--endpoint http://evil/v1' })).error).toMatch(/model/);
  });

  it('rejects a projectRoot outside the sandbox (RCE containment)', async () => {
    const saved = process.env.UAP_DELIVER_SANDBOX;
    const base = mkdtempSync(join(tmpdir(), 'mcp-sandbox-'));
    const outside = mkdtempSync(join(tmpdir(), 'mcp-outside-'));
    process.env.UAP_DELIVER_SANDBOX = base;
    try {
      const r = await handleDeliver({ instruction: 'do it', projectRoot: outside, dryRun: true });
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/outside the allowed sandbox/);
    } finally {
      if (saved === undefined) delete process.env.UAP_DELIVER_SANDBOX;
      else process.env.UAP_DELIVER_SANDBOX = saved;
      rmSync(base, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('extractLastJson (robust parse of decorated CLI stdout)', () => {
  it('returns the trailing pretty-printed JSON even when progress contains a brace', () => {
    const stdout = [
      '⚙ auto-optimize: complex task → exploration ×4',
      'Delivering via Qwen (profile: Small MoE)',
      '  Turn 1: code had a { brace in feedback',
      '{',
      '  "success": true,',
      '  "turns": 2',
      '}',
    ].join('\n');
    expect(extractLastJson(stdout)).toEqual({ success: true, turns: 2 });
  });

  it('returns undefined when there is no JSON object', () => {
    expect(extractLastJson('just progress, no json here')).toBeUndefined();
  });
});

describe('handleDeliver dry-run (real CLI subprocess)', () => {
  it('classifies complexity and returns the plan without calling a model', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-deliver-'));
    const savedSandbox = process.env.UAP_DELIVER_SANDBOX;
    process.env.UAP_DELIVER_SANDBOX = dir; // allow this temp project as the sandbox root
    try {
      // a project with a detectable gate so deliver does not error on "no gates"
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(
        join(dir, 'package.json'),
        JSON.stringify({ name: 't', version: '1.0.0', scripts: { test: 'node -e ""' } })
      );

      const r = await handleDeliver({
        instruction: 'implement a token-bucket rate limiter, refactor the auth middleware, add tests and edge cases',
        projectRoot: dir,
        dryRun: true,
        timeoutSec: 60,
      });
      expect(r.ok).toBe(true);
      expect(r.dryRun).toBe(true);
      const plan = r.result as { auto?: string; gates?: unknown[] };
      // the complexity classification is surfaced in the dry-run plan
      expect(typeof plan.auto).toBe('string');
      expect(plan.auto).toMatch(/task →/);
      expect(Array.isArray(plan.gates)).toBe(true);
    } finally {
      if (savedSandbox === undefined) delete process.env.UAP_DELIVER_SANDBOX;
      else process.env.UAP_DELIVER_SANDBOX = savedSandbox;
      rmSync(dir, { recursive: true, force: true });
    }
  }, 90_000);
});

describe('router exposes deliver', () => {
  it('lists deliver among the meta-tools and dispatches to it', async () => {
    const router = new McpRouter({ autoDiscover: false });
    const names = router.getToolDefinitions().map((t) => t.name);
    expect(names).toContain('discover_tools');
    expect(names).toContain('execute_tool');
    expect(names).toContain('deliver');

    // dispatch path: an empty instruction returns the validation error object
    const out = (await router.handleToolCall('deliver', { instruction: '' })) as {
      ok: boolean;
      error?: string;
    };
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/instruction is required/);
  });
});
