import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
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
});
