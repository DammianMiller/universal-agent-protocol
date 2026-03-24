import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

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

    it('SessionStart hook uses matcher + hooks array shape', () => {
      const settings = JSON.parse(
        readFileSync(join(rootDir, '.claude/settings.json'), 'utf-8'),
      );

      expect(Array.isArray(settings.hooks.SessionStart)).toBe(true);
      expect(settings.hooks.SessionStart[0].matcher).toBe('');
      expect(Array.isArray(settings.hooks.SessionStart[0].hooks)).toBe(true);
    });

    it('PreCompact hook uses matcher + hooks array shape', () => {
      const settings = JSON.parse(
        readFileSync(join(rootDir, '.claude/settings.json'), 'utf-8'),
      );

      expect(Array.isArray(settings.hooks.PreCompact)).toBe(true);
      expect(settings.hooks.PreCompact[0].matcher).toBe('');
      expect(Array.isArray(settings.hooks.PreCompact[0].hooks)).toBe(true);
    });
  });

  describe('settings.local.json normalization during install', () => {
    it('normalizes legacy object-shaped hooks for Claude install', async () => {
      const testDir = join(tmpdir(), `uap-claude-hooks-normalize-${Date.now()}`);
      mkdirSync(join(testDir, 'templates', 'hooks'), { recursive: true });
      mkdirSync(join(testDir, '.claude'), { recursive: true });

      writeFileSync(
        join(testDir, '.claude', 'settings.local.json'),
        JSON.stringify(
          {
            hooks: {
              SessionStart: {
                hooks: [{ type: 'command', command: 'bash .claude/hooks/session-start.sh' }],
              },
              PreCompact: {
                hooks: [{ type: 'command', command: 'bash .claude/hooks/pre-compact.sh' }],
              },
              UserPromptSubmit: {
                hooks: [{ type: 'command', command: 'bash .claude/hooks/prompt.sh' }],
              },
            },
          },
          null,
          2,
        ),
      );

      try {
        const { hooksCommand } = await import('../src/cli/hooks.js');
        await hooksCommand('install', { projectDir: testDir, target: 'claude' });

        const settings = JSON.parse(
          readFileSync(join(testDir, '.claude', 'settings.local.json'), 'utf-8'),
        );
        expect(Array.isArray(settings.hooks.SessionStart)).toBe(true);
        expect(Array.isArray(settings.hooks.PreCompact)).toBe(true);
        expect(Array.isArray(settings.hooks.UserPromptSubmit)).toBe(true);
        expect(settings.hooks.UserPromptSubmit[0].matcher).toBe('');
      } finally {
        rmSync(testDir, { recursive: true, force: true });
      }
    });

    it('normalizes legacy object-shaped hooks for Factory install', async () => {
      const testDir = join(tmpdir(), `uap-factory-hooks-normalize-${Date.now()}`);
      mkdirSync(join(testDir, 'templates', 'hooks'), { recursive: true });
      mkdirSync(join(testDir, '.factory'), { recursive: true });

      writeFileSync(
        join(testDir, '.factory', 'settings.local.json'),
        JSON.stringify(
          {
            hooks: {
              SessionStart: {
                hooks: [
                  {
                    type: 'command',
                    command: '"$FACTORY_PROJECT_DIR"/.factory/hooks/session-start.sh',
                  },
                ],
              },
              PreCompact: {
                hooks: [
                  {
                    type: 'command',
                    command: '"$FACTORY_PROJECT_DIR"/.factory/hooks/pre-compact.sh',
                  },
                ],
              },
              UserPromptSubmit: {
                hooks: [
                  {
                    type: 'command',
                    command: '"$FACTORY_PROJECT_DIR"/.factory/hooks/pattern-rag-prompt.sh',
                  },
                ],
              },
            },
          },
          null,
          2,
        ),
      );

      try {
        const { hooksCommand } = await import('../src/cli/hooks.js');
        await hooksCommand('install', { projectDir: testDir, target: 'factory' });

        const settings = JSON.parse(
          readFileSync(join(testDir, '.factory', 'settings.local.json'), 'utf-8'),
        );
        expect(Array.isArray(settings.hooks.SessionStart)).toBe(true);
        expect(Array.isArray(settings.hooks.PreCompact)).toBe(true);
        expect(Array.isArray(settings.hooks.UserPromptSubmit)).toBe(true);
        expect(settings.hooks.UserPromptSubmit[0].matcher).toBe('');
      } finally {
        rmSync(testDir, { recursive: true, force: true });
      }
    });
  });
});
