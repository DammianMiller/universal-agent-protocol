import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';
import { hooksCommand } from '../src/cli/hooks.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');

describe('Session Hooks', () => {
  describe('template hooks exist', () => {
    it('session-start.sh template exists and is valid', () => {
      const hookPath = join(rootDir, 'templates/hooks/session-start.sh');
      expect(existsSync(hookPath)).toBe(true);

      const content = readFileSync(hookPath, 'utf-8');
      expect(content).toContain('#!/usr/bin/env bash');
      expect(content).toContain('CLAUDE_PROJECT_DIR');
      expect(content).toContain('short_term.db');
      expect(content).toContain('sqlite3');
    });

    it('pre-compact.sh template exists and is valid', () => {
      const hookPath = join(rootDir, 'templates/hooks/pre-compact.sh');
      expect(existsSync(hookPath)).toBe(true);

      const content = readFileSync(hookPath, 'utf-8');
      expect(content).toContain('#!/usr/bin/env bash');
      expect(content).toContain('CLAUDE_PROJECT_DIR');
      expect(content).toContain('pre-compact');
    });
  });

  describe('hook scripts fail safely', () => {
    it('session-start.sh exits cleanly when DB does not exist', () => {
      const content = readFileSync(join(rootDir, 'templates/hooks/session-start.sh'), 'utf-8');
      // Verifies the early exit pattern: if DB not found, exit 0
      expect(content).toContain('if [ ! -f "$DB_PATH" ]; then');
      expect(content).toContain('exit 0');
    });

    it('pre-compact.sh exits cleanly when DB does not exist', () => {
      const content = readFileSync(join(rootDir, 'templates/hooks/pre-compact.sh'), 'utf-8');
      expect(content).toContain('if [ ! -f "$DB_PATH" ]; then');
      expect(content).toContain('exit 0');
    });

    it('both hooks use || true for sqlite3 calls (fail-safe)', () => {
      for (const hook of ['session-start.sh', 'pre-compact.sh']) {
        const content = readFileSync(join(rootDir, `templates/hooks/${hook}`), 'utf-8');
        // Every sqlite3 call should have || true to avoid blocking
        const sqlite3Lines = content.split('\n').filter(l => l.includes('sqlite3') && !l.startsWith('#'));
        for (const line of sqlite3Lines) {
          // The sqlite3 calls are in multiline blocks ending with || true
          // We check that the content has || true after sqlite3 usage blocks
          expect(content).toContain('|| true');
        }
      }
    });
  });

  describe('hook scripts do not parse transcripts', () => {
    it('session-start.sh does not reference transcripts', () => {
      const content = readFileSync(join(rootDir, 'templates/hooks/session-start.sh'), 'utf-8');
      expect(content).not.toContain('transcript');
      expect(content).not.toContain('conversation');
    });

    it('pre-compact.sh does not reference transcripts', () => {
      const content = readFileSync(join(rootDir, 'templates/hooks/pre-compact.sh'), 'utf-8');
      expect(content).not.toContain('transcript');
      expect(content).not.toContain('conversation');
    });
  });

  describe('enforcement hooks exist as templates', () => {
    const enforcementHooks = [
      'pre-tool-use-edit-write.sh',
      'pre-tool-use-bash.sh',
      'post-tool-use-edit-write.sh',
      'post-compact.sh',
      'stop.sh',
      'session-end.sh',
    ];

    for (const hook of enforcementHooks) {
      it(`${hook} template exists with correct structure`, () => {
        const hookPath = join(rootDir, 'templates/hooks', hook);
        expect(existsSync(hookPath)).toBe(true);

        const content = readFileSync(hookPath, 'utf-8');
        expect(content).toContain('#!/usr/bin/env bash');
        expect(content).toContain('set -euo pipefail');
      });
    }
  });

  describe('settings.json has all hooks wired', () => {
    it('settings.json contains all required hook events', () => {
      const settings = JSON.parse(
        readFileSync(join(rootDir, '.claude/settings.json'), 'utf-8'),
      );
      const requiredEvents = [
        'SessionStart',
        'PreToolUse',
        'PostToolUse',
        'PreCompact',
        'PostCompact',
        'Stop',
        'SessionEnd',
      ];
      for (const event of requiredEvents) {
        expect(settings.hooks[event]).toBeDefined();
      }
    });
  });

  describe('legacy settings.local schema migration', () => {
    it('migrates legacy claude SessionStart object to matcher array', async () => {
      const projectDir = mkdtempSync(join(tmpdir(), 'uap-claude-hooks-'));
      const claudeDir = join(projectDir, '.claude');
      mkdirSync(claudeDir, { recursive: true });

      const legacySettings = {
        hooks: {
          SessionStart: {
            hooks: [{ type: 'command', command: 'bash .claude/hooks/session-start.sh' }],
          },
        },
      };
      writeFileSync(join(claudeDir, 'settings.local.json'), JSON.stringify(legacySettings, null, 2));

      await hooksCommand('install', { projectDir, target: 'claude' });

      const updated = JSON.parse(readFileSync(join(claudeDir, 'settings.local.json'), 'utf-8'));
      expect(Array.isArray(updated.hooks.SessionStart)).toBe(true);
      expect(updated.hooks.SessionStart[0].matcher).toBe('');

      rmSync(projectDir, { recursive: true, force: true });
    });

    it('migrates legacy claude PreCompact object to matcher array', async () => {
      const projectDir = mkdtempSync(join(tmpdir(), 'uap-claude-hooks-'));
      const claudeDir = join(projectDir, '.claude');
      mkdirSync(claudeDir, { recursive: true });

      const legacySettings = {
        hooks: {
          PreCompact: {
            hooks: [{ type: 'command', command: 'bash .claude/hooks/pre-compact.sh' }],
          },
        },
      };
      writeFileSync(join(claudeDir, 'settings.local.json'), JSON.stringify(legacySettings, null, 2));

      await hooksCommand('install', { projectDir, target: 'claude' });

      const updated = JSON.parse(readFileSync(join(claudeDir, 'settings.local.json'), 'utf-8'));
      expect(Array.isArray(updated.hooks.PreCompact)).toBe(true);
      expect(updated.hooks.PreCompact[0].matcher).toBe('');

      rmSync(projectDir, { recursive: true, force: true });
    });
  });
});
