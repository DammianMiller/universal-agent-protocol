import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  validateDecoderFirst,
  type DroidMeta,
  type TaskContext,
} from '../../src/tasks/decoder-gate.js';

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn((path: string) => {
      if (path.includes('.factory/droids/test-droid.md')) return true;
      if (path.includes('.factory/droids/no-desc.md')) return true;
      if (path.includes('coordination.db')) return false;
      return actual.existsSync(path);
    }),
    readFileSync: vi.fn((path: string, encoding?: string) => {
      if (path.includes('test-droid.md')) {
        return `---
name: test-droid
description: A test droid for unit tests
model: gpt-4
---
# Test Droid
`;
      }
      if (path.includes('no-desc.md')) {
        return `---
name: no-desc
description:
---
# No Desc
`;
      }
      return actual.readFileSync(path, encoding as any);
    }),
    readdirSync: vi.fn((dir: string) => {
      if (dir.includes('.factory/droids')) return ['test-droid.md', 'no-desc.md'];
      if (dir.includes('.claude/agents')) return [];
      return [];
    }),
  };
});

describe('Decoder Gate', () => {
  const baseContext: TaskContext = {
    agentId: 'test-agent',
    taskInstruction: 'Fix the authentication bug in src/auth/login.ts by adding input validation',
  };

  describe('validateDecoderFirst', () => {
    it('should validate a valid droid with clear instructions', async () => {
      const result = await validateDecoderFirst('test-droid', baseContext, {
        projectRoot: '/fake/root',
      });
      expect(result.valid).toBe(true);
      expect(result.errors.filter(e => e.severity === 'fatal')).toHaveLength(0);
    });

    it('should fail for non-existent droid', async () => {
      const result = await validateDecoderFirst('nonexistent-droid', baseContext, {
        projectRoot: '/fake/root',
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.gate === 'schema-validation')).toBe(true);
    });

    it('should error when worktree is required but not provided', async () => {
      const result = await validateDecoderFirst('test-droid', baseContext, {
        projectRoot: '/fake/root',
        requireWorktree: true,
      });
      expect(result.errors.some(e => e.gate === 'worktree-requirement')).toBe(true);
    });

    it('should pass when worktree is required and provided', async () => {
      const ctx: TaskContext = {
        ...baseContext,
        worktreePath: '/fake/.worktrees/001-fix',
      };
      const result = await validateDecoderFirst('test-droid', ctx, {
        projectRoot: '/fake/root',
        requireWorktree: true,
      });
      expect(result.errors.filter(e => e.gate === 'worktree-requirement')).toHaveLength(0);
    });

    it('should include ambiguity check in result', async () => {
      const result = await validateDecoderFirst('test-droid', baseContext, {
        projectRoot: '/fake/root',
      });
      expect(result.ambiguityCheck).toBeDefined();
      expect(typeof result.ambiguityCheck!.score).toBe('number');
      expect(result.ambiguityCheck!.score).toBeGreaterThanOrEqual(0);
    });

    it('should warn on ambiguous instructions', async () => {
      const ambiguousCtx: TaskContext = {
        agentId: 'test-agent',
        taskInstruction: 'fix it',
      };
      const result = await validateDecoderFirst('test-droid', ambiguousCtx, {
        projectRoot: '/fake/root',
        ambiguityThreshold: 0.1,
      });
      expect(result.ambiguityCheck!.score).toBeGreaterThan(0);
    });
  });
});
