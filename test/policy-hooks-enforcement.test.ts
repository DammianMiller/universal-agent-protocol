import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');

describe('Policy Enforcement Hooks', () => {
  // ─── Hook Existence & Structure ─────────────────────────────────
  describe('all enforcement hooks exist in templates', () => {
    const requiredHooks = [
      'pre-tool-use-edit-write.sh',
      'pre-tool-use-bash.sh',
      'post-tool-use-edit-write.sh',
      'post-compact.sh',
      'stop.sh',
      'session-end.sh',
    ];

    for (const hook of requiredHooks) {
      it(`${hook} template exists`, () => {
        const hookPath = join(rootDir, 'templates/hooks', hook);
        expect(existsSync(hookPath)).toBe(true);
      });

      it(`${hook} has correct shebang and strict mode`, () => {
        const content = readFileSync(join(rootDir, 'templates/hooks', hook), 'utf-8');
        expect(content).toContain('#!/usr/bin/env bash');
        expect(content).toContain('set -euo pipefail');
      });
    }
  });

  describe('all enforcement hooks exist in .claude/hooks', () => {
    const requiredHooks = [
      'pre-tool-use-edit-write.sh',
      'pre-tool-use-bash.sh',
      'post-tool-use-edit-write.sh',
      'post-compact.sh',
      'stop.sh',
      'session-end.sh',
    ];

    for (const hook of requiredHooks) {
      it(`${hook} exists in .claude/hooks`, () => {
        const hookPath = join(rootDir, '.claude/hooks', hook);
        expect(existsSync(hookPath)).toBe(true);
      });
    }
  });

  // ─── Worktree File Guard (pre-tool-use-edit-write.sh) ──────────
  describe('worktree file guard hook', () => {
    const content = readFileSync(
      join(rootDir, 'templates/hooks/pre-tool-use-edit-write.sh'),
      'utf-8',
    );

    it('checks for .worktrees/ in file path', () => {
      expect(content).toContain('.worktrees/');
    });

    it('allows exempt paths (agents/data, node_modules, .uap-backups, etc)', () => {
      const exemptPaths = [
        'agents/data/',
        'node_modules/',
        '.uap-backups/',
        '.uap/',
        '.git/',
        'dist/',
      ];
      for (const path of exemptPaths) {
        expect(content).toContain(path);
      }
    });

    it('exits 2 to block non-worktree edits', () => {
      expect(content).toContain('exit 2');
    });

    it('references worktree-file-guard policy', () => {
      expect(content).toContain('worktree-file-guard');
    });

    it('extracts file_path from JSON input via jq', () => {
      expect(content).toContain('jq');
      expect(content).toContain('file_path');
    });

    it('blocks edit targeting project root', () => {
      // Simulate the hook with a project-root file path
      const hookPath = join(rootDir, '.claude/hooks/pre-tool-use-edit-write.sh');
      const input = JSON.stringify({
        tool_name: 'Edit',
        tool_input: { file_path: '/home/user/project/src/index.ts' },
      });

      try {
        execSync(`echo '${input}' | bash "${hookPath}"`, {
          encoding: 'utf-8',
          env: { ...process.env, CLAUDE_PROJECT_DIR: rootDir },
        });
        // Should not reach here — hook should exit 2
        expect.unreachable('Hook should have blocked this edit');
      } catch (err: unknown) {
        const error = err as { status: number; stderr: string };
        expect(error.status).toBe(2);
        expect(error.stderr).toContain('WORKTREE POLICY VIOLATION');
      }
    });

    it('allows edit inside a worktree path', () => {
      const hookPath = join(rootDir, '.claude/hooks/pre-tool-use-edit-write.sh');
      const input = JSON.stringify({
        tool_name: 'Write',
        tool_input: {
          file_path: '/home/user/project/.worktrees/001-fix/src/index.ts',
        },
      });

      const result = execSync(`echo '${input}' | bash "${hookPath}"`, {
        encoding: 'utf-8',
        env: { ...process.env, CLAUDE_PROJECT_DIR: rootDir },
      });
      // Exit 0 = allowed (no error thrown)
      expect(result).toBeDefined();
    });

    it('allows edit to exempt path (agents/data)', () => {
      const hookPath = join(rootDir, '.claude/hooks/pre-tool-use-edit-write.sh');
      const input = JSON.stringify({
        tool_name: 'Write',
        tool_input: {
          file_path: '/home/user/project/agents/data/memory/short_term.db',
        },
      });

      const result = execSync(`echo '${input}' | bash "${hookPath}"`, {
        encoding: 'utf-8',
        env: { ...process.env, CLAUDE_PROJECT_DIR: rootDir },
      });
      expect(result).toBeDefined();
    });
  });

  // ─── Dangerous Command Guard (pre-tool-use-bash.sh) ────────────
  describe('dangerous command guard hook', () => {
    const content = readFileSync(
      join(rootDir, 'templates/hooks/pre-tool-use-bash.sh'),
      'utf-8',
    );

    it('blocks terraform apply', () => {
      expect(content).toContain('terraform');
      expect(content).toMatch(/apply|destroy/);

      const hookPath = join(rootDir, '.claude/hooks/pre-tool-use-bash.sh');
      const input = JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'terraform apply -auto-approve' },
      });

      try {
        execSync(`echo '${input}' | bash "${hookPath}"`, {
          encoding: 'utf-8',
          env: { ...process.env, CLAUDE_PROJECT_DIR: rootDir },
        });
        expect.unreachable('Hook should have blocked terraform apply');
      } catch (err: unknown) {
        const error = err as { status: number; stderr: string };
        expect(error.status).toBe(2);
        expect(error.stderr).toContain('iac-pipeline-enforcement');
      }
    });

    it('allows terraform plan', () => {
      const hookPath = join(rootDir, '.claude/hooks/pre-tool-use-bash.sh');
      const input = JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'terraform plan -out=plan.tfplan' },
      });

      const result = execSync(`echo '${input}' | bash "${hookPath}"`, {
        encoding: 'utf-8',
        env: { ...process.env, CLAUDE_PROJECT_DIR: rootDir },
      });
      expect(result).toBeDefined();
    });

    it('blocks git push --force', () => {
      expect(content).toContain('force');

      const hookPath = join(rootDir, '.claude/hooks/pre-tool-use-bash.sh');
      const input = JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'git push --force origin main' },
      });

      try {
        execSync(`echo '${input}' | bash "${hookPath}"`, {
          encoding: 'utf-8',
          env: { ...process.env, CLAUDE_PROJECT_DIR: rootDir },
        });
        expect.unreachable('Hook should have blocked force push');
      } catch (err: unknown) {
        const error = err as { status: number; stderr: string };
        expect(error.status).toBe(2);
        expect(error.stderr).toContain('git-safety');
      }
    });

    it('blocks direct push to master', () => {
      const hookPath = join(rootDir, '.claude/hooks/pre-tool-use-bash.sh');
      const input = JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'git push origin master' },
      });

      try {
        execSync(`echo '${input}' | bash "${hookPath}"`, {
          encoding: 'utf-8',
          env: { ...process.env, CLAUDE_PROJECT_DIR: rootDir },
        });
        expect.unreachable('Hook should have blocked push to master');
      } catch (err: unknown) {
        const error = err as { status: number; stderr: string };
        expect(error.status).toBe(2);
        expect(error.stderr).toContain('worktree-enforcement');
      }
    });

    it('blocks manual package.json version edits via sed', () => {
      expect(content).toContain('semver-versioning');

      const hookPath = join(rootDir, '.claude/hooks/pre-tool-use-bash.sh');
      const input = {
        tool_name: 'Bash',
        tool_input: {
          command: 'sed -i s/version/version/ package.json',
        },
      };
      // Write input to temp file to avoid shell quoting issues
      const tmpFile = join(rootDir, '.uap-backups', 'test-input.json');
      const { writeFileSync, unlinkSync, mkdirSync } = require('fs');
      mkdirSync(join(rootDir, '.uap-backups'), { recursive: true });
      writeFileSync(tmpFile, JSON.stringify(input));

      try {
        execSync(`cat "${tmpFile}" | bash "${hookPath}"`, {
          encoding: 'utf-8',
          env: { ...process.env, CLAUDE_PROJECT_DIR: rootDir },
        });
        expect.unreachable('Hook should have blocked manual version edit');
      } catch (err: unknown) {
        const error = err as { status: number; stderr: string };
        expect(error.status).toBe(2);
        expect(error.stderr).toContain('semver-versioning');
      } finally {
        try { unlinkSync(tmpFile); } catch { /* ignore */ }
      }
    });

    it('allows normal git operations', () => {
      const hookPath = join(rootDir, '.claude/hooks/pre-tool-use-bash.sh');
      const input = JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'git status' },
      });

      const result = execSync(`echo '${input}' | bash "${hookPath}"`, {
        encoding: 'utf-8',
        env: { ...process.env, CLAUDE_PROJECT_DIR: rootDir },
      });
      expect(result).toBeDefined();
    });

    it('references all enforced policies', () => {
      expect(content).toContain('iac-pipeline-enforcement');
      expect(content).toContain('worktree-enforcement');
      expect(content).toContain('semver-versioning');
    });
  });

  // ─── Build Gate Reminder (post-tool-use-edit-write.sh) ─────────
  describe('build gate reminder hook', () => {
    const content = readFileSync(
      join(rootDir, 'templates/hooks/post-tool-use-edit-write.sh'),
      'utf-8',
    );

    it('detects TypeScript file edits', () => {
      expect(content).toContain('.ts');
    });

    it('references pre-edit-build-gate policy', () => {
      expect(content).toContain('pre-edit-build-gate');
    });

    it('includes backup reminder', () => {
      expect(content).toContain('.uap-backups');
      expect(content).toContain('BACKUP');
    });

    it('always exits 0 (never blocks)', () => {
      // Should not contain exit 2
      const lines = content.split('\n');
      const exitLines = lines.filter(
        (l) => l.trim().startsWith('exit') && !l.trim().startsWith('#'),
      );
      for (const line of exitLines) {
        expect(line).not.toContain('exit 2');
      }
    });
  });

  // ─── Post-Compact Compliance Re-injection ──────────────────────
  describe('post-compact hook', () => {
    const content = readFileSync(
      join(rootDir, 'templates/hooks/post-compact.sh'),
      'utf-8',
    );

    it('injects system-reminder block', () => {
      expect(content).toContain('<system-reminder>');
      expect(content).toContain('</system-reminder>');
    });

    it('lists all active policies', () => {
      expect(content).toContain('worktree-enforcement');
      expect(content).toContain('worktree-file-guard');
      expect(content).toContain('pre-edit-build-gate');
      expect(content).toContain('completion-gate');
      expect(content).toContain('semver-versioning');
      expect(content).toContain('mandatory-file-backup');
      expect(content).toContain('iac-state-parity');
      expect(content).toContain('iac-pipeline-enforcement');
      expect(content).toContain('kubectl-verify-backport');
    });

    it('queries recent memory from DB', () => {
      expect(content).toContain('sqlite3');
      expect(content).toContain('memories');
    });

    it('checks multi-agent coordination state', () => {
      expect(content).toContain('work_announcements');
      expect(content).toContain('COORD_DB');
    });

    it('detects worktree violations', () => {
      expect(content).toContain('WORKTREE VIOLATION');
    });
  });

  // ─── Stop Hook (Completion Gate) ──────────────────────────────
  describe('stop hook (completion gate)', () => {
    const content = readFileSync(join(rootDir, 'templates/hooks/stop.sh'), 'utf-8');

    it('checks for code changes via git diff', () => {
      expect(content).toContain('git');
      expect(content).toContain('diff');
    });

    it('checks for test file changes', () => {
      expect(content).toContain('TEST_FILES_CHANGED');
      expect(content).toContain('test/');
    });

    it('checks for version bump', () => {
      expect(content).toContain('VERSION_BUMPED');
      expect(content).toContain('package.json');
    });

    it('reports completion gate checklist', () => {
      expect(content).toContain('COMPLETION GATE CHECKLIST');
      expect(content).toContain('[PASS]');
      expect(content).toContain('[WARN]');
    });

    it('cleans up agent registration on stop', () => {
      expect(content).toContain('agent_registry');
      expect(content).toContain('completed');
    });

    it('stores session end marker in memory', () => {
      expect(content).toContain('session-end');
      expect(content).toContain('memories');
    });

    it('references completion-gate policy', () => {
      expect(content).toContain('completion-gate');
    });
  });

  // ─── Session End Hook ─────────────────────────────────────────
  describe('session-end hook', () => {
    const content = readFileSync(
      join(rootDir, 'templates/hooks/session-end.sh'),
      'utf-8',
    );

    it('stores session end marker', () => {
      expect(content).toContain('session-end');
      expect(content).toContain('memories');
    });

    it('cleans up coordination DB', () => {
      expect(content).toContain('agent_registry');
      expect(content).toContain('work_announcements');
      expect(content).toContain('work_claims');
    });

    it('cleans up old backups (7-day retention)', () => {
      expect(content).toContain('.uap-backups');
      expect(content).toContain('-mtime +7');
    });

    it('always exits 0 (never blocks)', () => {
      expect(content.trim()).toMatch(/exit 0$/);
    });
  });

  // ─── Settings.json Wiring ─────────────────────────────────────
  describe('settings.json hook registration', () => {
    const settingsPath = join(rootDir, '.claude/settings.json');
    const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));

    it('has PreToolUse hooks registered', () => {
      expect(settings.hooks.PreToolUse).toBeDefined();
      expect(settings.hooks.PreToolUse).toHaveLength(2);
    });

    it('PreToolUse Edit|Write matcher is registered', () => {
      const editWriteHook = settings.hooks.PreToolUse.find(
        (h: { matcher: string }) => h.matcher === 'Edit|Write',
      );
      expect(editWriteHook).toBeDefined();
      expect(editWriteHook.hooks[0].command).toContain('pre-tool-use-edit-write.sh');
    });

    it('PreToolUse Bash matcher is registered', () => {
      const bashHook = settings.hooks.PreToolUse.find(
        (h: { matcher: string }) => h.matcher === 'Bash',
      );
      expect(bashHook).toBeDefined();
      expect(bashHook.hooks[0].command).toContain('pre-tool-use-bash.sh');
    });

    it('has PostToolUse hook registered', () => {
      expect(settings.hooks.PostToolUse).toBeDefined();
      const editWriteHook = settings.hooks.PostToolUse.find(
        (h: { matcher: string }) => h.matcher === 'Edit|Write',
      );
      expect(editWriteHook).toBeDefined();
    });

    it('has PostCompact hook registered', () => {
      expect(settings.hooks.PostCompact).toBeDefined();
    });

    it('has Stop hook registered', () => {
      expect(settings.hooks.Stop).toBeDefined();
    });

    it('has SessionEnd hook registered', () => {
      expect(settings.hooks.SessionEnd).toBeDefined();
    });

    it('retains existing SessionStart and PreCompact hooks', () => {
      expect(settings.hooks.SessionStart).toBeDefined();
      expect(settings.hooks.PreCompact).toBeDefined();
    });
  });
});
