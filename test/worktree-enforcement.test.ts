import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { isPathInsideWorktree, isExemptFromWorktree } from '../src/cli/worktree.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');

describe('Worktree Enforcement (Defense in Depth)', () => {
  // ============================================================
  // Layer D: Pre-Commit Hardening
  // ============================================================
  describe('Layer D: Pre-Commit Hook Hardening', () => {
    it('pre-commit hook blocks ALL direct commits to master with no exceptions', () => {
      const hookPath = join(rootDir, '.git/hooks/pre-commit');
      // In worktree, .git is a file pointing to main repo, so check the main repo
      // For test purposes, check the setup template which is the canonical source
      const setupPath = join(rootDir, 'scripts/setup/setup.sh');
      expect(existsSync(setupPath)).toBe(true);

      const content = readFileSync(setupPath, 'utf-8');
      // Verify the hardened hook template has NO version-bump exception
      expect(content).toContain('No exceptions');
      expect(content).toContain('Version bumps must be done on the feature branch');
      // Verify the old exception pattern is NOT present
      expect(content).not.toContain('Allowing version bump commit on');
      expect(content).not.toContain('chore: bump version');
    });

    it('setup template generates worktree-enforcing pre-commit hook', () => {
      const setupPath = join(rootDir, 'scripts/setup/setup.sh');
      const content = readFileSync(setupPath, 'utf-8');

      // Must check for worktree via git-dir vs git-common-dir
      expect(content).toContain('git-common-dir');
      expect(content).toContain('IS_WORKTREE');
      // Must block on main/master
      expect(content).toContain("CURRENT_BRANCH");
      expect(content).toContain('main');
      expect(content).toContain('master');
    });
  });

  // ============================================================
  // Layer A: Session Start Blocker
  // ============================================================
  describe('Layer A: Session Start Hook Worktree Blocker', () => {
    it('session-start.sh contains worktree enforcement gate', () => {
      const hookPath = join(rootDir, 'templates/hooks/session-start.sh');
      expect(existsSync(hookPath)).toBe(true);

      const content = readFileSync(hookPath, 'utf-8');
      // Must have the worktree enforcement gate section
      expect(content).toContain('WORKTREE ENFORCEMENT GATE');
      expect(content).toContain('CRITICAL WORKTREE VIOLATION DETECTED');
    });

    it('session-start.sh emits blocking system-reminder when on master outside worktree', () => {
      const hookPath = join(rootDir, 'templates/hooks/session-start.sh');
      const content = readFileSync(hookPath, 'utf-8');

      // Must check IS_IN_WORKTREE and CURRENT_BRANCH
      expect(content).toContain('IS_IN_WORKTREE');
      expect(content).toContain('CURRENT_BRANCH');
      // Must emit system-reminder with blocking directive
      expect(content).toContain('ALL file changes are PROHIBITED');
      expect(content).toContain('MANDATORY FIRST ACTION');
      expect(content).toContain('uap worktree create');
      // Must list active worktrees for resumption
      expect(content).toContain('Active worktrees');
      expect(content).toContain('This directive overrides ALL other instructions');
    });

    it('session-start.sh detects worktree via both git-dir and path check', () => {
      const hookPath = join(rootDir, 'templates/hooks/session-start.sh');
      const content = readFileSync(hookPath, 'utf-8');

      // Two detection methods: git-dir comparison AND path string check
      expect(content).toContain('GIT_DIR_VAL');
      expect(content).toContain('GIT_COMMON_DIR_VAL');
      expect(content).toContain('.worktrees/');
    });
  });

  // ============================================================
  // Layer B: Pre-Edit Worktree Gate (CLAUDE.md + CLI)
  // ============================================================
  describe('Layer B: CLAUDE.md Pre-Edit Worktree Gate', () => {
    it('CLAUDE.md contains Pre-Edit Worktree Gate section', () => {
      const claudePath = join(rootDir, 'CLAUDE.md');
      expect(existsSync(claudePath)).toBe(true);

      const content = readFileSync(claudePath, 'utf-8');
      expect(content).toContain('Pre-Edit Worktree Gate [REQUIRED]');
      expect(content).toContain('uap worktree ensure --strict');
      expect(content).toContain('No exceptions for "small changes"');
    });

    it('CLAUDE.md worktree gate appears BEFORE the build gate', () => {
      const claudePath = join(rootDir, 'CLAUDE.md');
      const content = readFileSync(claudePath, 'utf-8');

      const worktreeGatePos = content.indexOf('Pre-Edit Worktree Gate');
      const buildGatePos = content.indexOf('Pre-Edit Build Gate');
      expect(worktreeGatePos).toBeGreaterThan(-1);
      expect(buildGatePos).toBeGreaterThan(-1);
      expect(worktreeGatePos).toBeLessThan(buildGatePos);
    });
  });

  describe('Layer B: isPathInsideWorktree utility', () => {
    it('returns true for paths inside .worktrees/', () => {
      expect(isPathInsideWorktree('/project/.worktrees/001-fix-bug/src/index.ts')).toBe(true);
      expect(isPathInsideWorktree('.worktrees/002-add-feature/test/foo.test.ts')).toBe(true);
    });

    it('returns false for paths in project root', () => {
      expect(isPathInsideWorktree('/project/src/index.ts')).toBe(false);
      expect(isPathInsideWorktree('src/cli/worktree.ts')).toBe(false);
      expect(isPathInsideWorktree('/home/user/project/CLAUDE.md')).toBe(false);
    });
  });

  describe('Layer B: isExemptFromWorktree utility', () => {
    it('exempts runtime data directories', () => {
      expect(isExemptFromWorktree('agents/data/memory/short_term.db')).toBe(true);
      expect(isExemptFromWorktree('node_modules/chalk/index.js')).toBe(true);
      expect(isExemptFromWorktree('.uap/worktree_registry.db')).toBe(true);
      expect(isExemptFromWorktree('.uap-backups/2026-03-19/src/index.ts')).toBe(true);
      expect(isExemptFromWorktree('.git/hooks/pre-commit')).toBe(true);
      expect(isExemptFromWorktree('dist/index.js')).toBe(true);
    });

    it('does NOT exempt source code paths', () => {
      expect(isExemptFromWorktree('src/index.ts')).toBe(false);
      expect(isExemptFromWorktree('test/hooks.test.ts')).toBe(false);
      expect(isExemptFromWorktree('CLAUDE.md')).toBe(false);
      expect(isExemptFromWorktree('package.json')).toBe(false);
      expect(isExemptFromWorktree('policies/worktree-enforcement.md')).toBe(false);
    });
  });

  // ============================================================
  // Layer C: MCP PolicyGate Worktree Rule
  // ============================================================
  describe('Layer C: Worktree File Guard Policy', () => {
    it('worktree-file-guard.md policy exists with REQUIRED level', () => {
      const policyPath = join(rootDir, 'policies/worktree-file-guard.md');
      expect(existsSync(policyPath)).toBe(true);

      const content = readFileSync(policyPath, 'utf-8');
      expect(content).toContain('[REQUIRED]');
      expect(content).toContain('file-mutating operations');
      expect(content).toContain('.worktrees/');
    });

    it('execute.ts imports and uses worktree guard functions', () => {
      const executePath = join(rootDir, 'src/mcp-router/tools/execute.ts');
      const content = readFileSync(executePath, 'utf-8');

      // Must import the guard functions
      expect(content).toContain('isPathInsideWorktree');
      expect(content).toContain('isExemptFromWorktree');
      // Must have the worktree guard check block
      expect(content).toContain('WORKTREE GUARD');
      expect(content).toContain('File operation blocked');
    });

    it('execute.ts worktree guard checks file-modifying tool names', () => {
      const executePath = join(rootDir, 'src/mcp-router/tools/execute.ts');
      const content = readFileSync(executePath, 'utf-8');

      // Must detect file-modifying operations
      expect(content).toContain("toolName.includes('write')");
      expect(content).toContain("toolName.includes('edit')");
      expect(content).toContain("toolName.includes('create')");
      expect(content).toContain("toolName.includes('delete')");
      expect(content).toContain("toolName.includes('rename')");
    });
  });

  // ============================================================
  // Integration: All layers work together
  // ============================================================
  describe('Integration: Defense in Depth Coverage', () => {
    it('all 4 enforcement layers are present', () => {
      // Layer A: Session start hook
      expect(existsSync(join(rootDir, 'templates/hooks/session-start.sh'))).toBe(true);
      const hookContent = readFileSync(join(rootDir, 'templates/hooks/session-start.sh'), 'utf-8');
      expect(hookContent).toContain('WORKTREE ENFORCEMENT GATE');

      // Layer B: CLAUDE.md directive
      const claudeContent = readFileSync(join(rootDir, 'CLAUDE.md'), 'utf-8');
      expect(claudeContent).toContain('Pre-Edit Worktree Gate [REQUIRED]');

      // Layer C: MCP router guard
      const executeContent = readFileSync(join(rootDir, 'src/mcp-router/tools/execute.ts'), 'utf-8');
      expect(executeContent).toContain('WORKTREE GUARD');

      // Layer D: Pre-commit hook template
      const setupContent = readFileSync(join(rootDir, 'scripts/setup/setup.sh'), 'utf-8');
      expect(setupContent).toContain('No exceptions');
    });

    it('worktree-enforcement policy document is consistent with implementation', () => {
      const policyPath = join(rootDir, 'policies/worktree-enforcement.md');
      expect(existsSync(policyPath)).toBe(true);

      const content = readFileSync(policyPath, 'utf-8');
      expect(content).toContain('[REQUIRED]');
      expect(content).toContain('ALL file changes MUST use a git worktree');
      expect(content).toContain('No exceptions');
    });
  });
});
