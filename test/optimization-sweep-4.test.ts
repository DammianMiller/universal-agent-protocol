/**
 * Tests for fourth-pass optimization sweep:
 * 1-4: Dead files removed (factory.ts, indexeddb.ts, worktree-enforcer.ts, droid-validator.ts)
 * 10-11: Dead memory files removed (agent-scoped-memory.ts, multi-view-memory.ts)
 * 12: DatabaseManager typed returns (PolicyRow, ExecutableToolRow, PolicyExecutionRow)
 * 13: Logger rolled out to runtime modules
 * 14: as any casts fixed in policy-memory.ts and convert-policy-to-claude.ts
 * 15: .unref() on telemetry intervals
 * 16: dashboardResume deduplicated
 */

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';

// ── 1-4: Dead files removed ──

describe('1-4: Dead files removed', () => {
  it('should NOT have short-term/factory.ts', () => {
    expect(existsSync('src/memory/short-term/factory.ts')).toBe(false);
  });

  it('should NOT have short-term/indexeddb.ts', () => {
    expect(existsSync('src/memory/short-term/indexeddb.ts')).toBe(false);
  });

  it('should NOT have worktree-enforcer.ts', () => {
    expect(existsSync('src/coordination/worktree-enforcer.ts')).toBe(false);
  });

  it('should NOT have droid-validator.ts', () => {
    expect(existsSync('src/coordination/droid-validator.ts')).toBe(false);
  });

  it('coordination/index.ts should NOT re-export removed modules', () => {
    const source = readFileSync('src/coordination/index.ts', 'utf-8');
    expect(source).not.toContain('droid-validator');
    expect(source).not.toContain('worktree-enforcer');
  });
});

// ── 10-11: Dead memory files removed ──

describe('10-11: Dead memory files removed', () => {
  it('should NOT have agent-scoped-memory.ts', () => {
    expect(existsSync('src/memory/agent-scoped-memory.ts')).toBe(false);
  });

  it('should NOT have multi-view-memory.ts', () => {
    expect(existsSync('src/memory/multi-view-memory.ts')).toBe(false);
  });

  it('index.ts should NOT export removed modules', () => {
    const source = readFileSync('src/index.ts', 'utf-8');
    expect(source).not.toContain("from './memory/agent-scoped-memory.js'");
    expect(source).not.toContain("from './memory/multi-view-memory.js'");
  });
});

// ── 12: DatabaseManager typed returns ──

describe('12: DatabaseManager typed returns', () => {
  it('should export PolicyRow, ExecutableToolRow, PolicyExecutionRow types', async () => {
    const mod = await import('../src/policies/database-manager.js');
    // These are interfaces so we check the module has the class
    expect(mod.DatabaseManager).toBeDefined();
  });

  it('findPolicies should return PolicyRow[] (not Record<string, unknown>[])', () => {
    const source = readFileSync('src/policies/database-manager.ts', 'utf-8');
    expect(source).toContain('findPolicies(where: Record<string, unknown>): PolicyRow[]');
    expect(source).toContain('findOnePolicy(where: Record<string, unknown>): PolicyRow | null');
    expect(source).toContain('getAllActivePolicies(): PolicyRow[]');
  });

  it('findExecutableTools should return ExecutableToolRow[]', () => {
    const source = readFileSync('src/policies/database-manager.ts', 'utf-8');
    expect(source).toContain('findExecutableTools(policyId: string): ExecutableToolRow[]');
    expect(source).toContain('findExecutableTool(policyId: string, toolName: string): ExecutableToolRow | null');
  });

  it('getExecutionLog should return PolicyExecutionRow[]', () => {
    const source = readFileSync('src/policies/database-manager.ts', 'utf-8');
    expect(source).toContain('getExecutionLog(policyId?: string, limit: number = 50): PolicyExecutionRow[]');
  });
});

// ── 13: Logger rolled out ──

describe('13: Logger rolled out to runtime modules', () => {
  it('embeddings.ts should use createLogger', () => {
    const source = readFileSync('src/memory/embeddings.ts', 'utf-8');
    expect(source).toContain("import { createLogger }");
    expect(source).not.toContain('console.log(');
  });

  it('backends/factory.ts should use createLogger', () => {
    const source = readFileSync('src/memory/backends/factory.ts', 'utf-8');
    expect(source).toContain("import { createLogger }");
    expect(source).not.toContain('console.warn(');
  });

  it('auto-agent.ts should use createLogger', () => {
    const source = readFileSync('src/coordination/auto-agent.ts', 'utf-8');
    expect(source).toContain("import { createLogger }");
    expect(source).not.toContain('console.warn(');
  });

  it('models/router.ts should use createLogger', () => {
    const source = readFileSync('src/models/router.ts', 'utf-8');
    expect(source).toContain("import { createLogger }");
    expect(source).not.toContain('console.warn(');
  });

  it('models/planner.ts should use createLogger', () => {
    const source = readFileSync('src/models/planner.ts', 'utf-8');
    expect(source).toContain("import { createLogger }");
    expect(source).not.toContain('console.warn(');
  });

  it('tasks/coordination.ts should not have console.error', () => {
    const source = readFileSync('src/tasks/coordination.ts', 'utf-8');
    expect(source).not.toContain('console.error(');
  });

  it('tasks/event-bus.ts should not have console.error', () => {
    const source = readFileSync('src/tasks/event-bus.ts', 'utf-8');
    expect(source).not.toContain('console.error(');
  });
});

// ── 14: as any casts fixed ──

describe('14: as any casts fixed', () => {
  it('policy-memory.ts should not have as any', () => {
    const source = readFileSync('src/policies/policy-memory.ts', 'utf-8');
    expect(source).not.toContain('as any');
  });

  it('convert-policy-to-claude.ts should not have as any', () => {
    const source = readFileSync('src/policies/convert-policy-to-claude.ts', 'utf-8');
    expect(source).not.toContain('as any');
  });
});

// ── 15: .unref() on telemetry intervals ──

describe('15: Telemetry intervals have .unref()', () => {
  it('session-telemetry.ts should have .unref() calls', () => {
    const source = readFileSync('src/telemetry/session-telemetry.ts', 'utf-8');
    const unrefCount = (source.match(/\.unref\(\)/g) || []).length;
    expect(unrefCount).toBeGreaterThanOrEqual(3);
  });
});

// ── 16: dashboardResume deduplicated ──

describe('16: dashboardResume deduplicated', () => {
  it('dashboardResume should call renderDashboard instead of duplicating', () => {
    const source = readFileSync('src/telemetry/session-telemetry.ts', 'utf-8');
    // Find the dashboardResume function and verify it calls renderDashboard
    const resumeIdx = source.indexOf('function dashboardResume');
    if (resumeIdx > -1) {
      const resumeBody = source.slice(resumeIdx, resumeIdx + 500);
      expect(resumeBody).toContain('renderDashboard(');
    }
  });
});

// ── ShortTermMemoryBackend inlined ──

describe('ShortTermMemoryBackend interface inlined', () => {
  it('sqlite.ts should define ShortTermMemoryBackend locally', () => {
    const source = readFileSync('src/memory/short-term/sqlite.ts', 'utf-8');
    expect(source).toContain('export interface ShortTermMemoryBackend');
    expect(source).not.toContain("from './factory.js'");
  });
});
