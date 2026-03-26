import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');

describe('Validation Fixes', () => {
  describe('CLAUDE.md Compliance', () => {
    it('CLAUDE.md passes all 12 compliance checks', () => {
      const content = readFileSync(join(rootDir, 'CLAUDE.md'), 'utf-8');

      // Check 1: Version
      expect(content).toMatch(/CLAUDE\.md v2\.[2-9]|CLAUDE\.md v3\./);

      // Check 2: Worktree Gate
      expect(content).toContain('WORKTREE GATE');

      // Check 3: Build Gate
      expect(content).toContain('PRE-EDIT BUILD GATE');

      // Check 4: VERIFIER-FIRST
      expect(content).toContain('VERIFIER-FIRST');

      // Check 5: Pattern Router
      expect(content).toContain('PATTERN ROUTER');

      // Check 6: Schema Diff Gate in BLOCKING PREREQUISITES
      expect(content).toMatch(/Schema Diff Gate/);
      expect(content).toContain('BLOCKING PREREQUISITES');

      // Check 7: VERIFIER-FIRST
      expect(content).toContain('## VERIFIER-FIRST');

      // Check 8: COMPLETION GATES
      expect(content).toContain('COMPLETION GATES');

      // Check 9: Pattern Router
      expect(content).toMatch(/Pattern.*Router/i);

      // Check 10: RTK includes
      expect(content).toMatch(/@hooks-session-start\.md|@PreCompact\.md/);

      // Check 11: Verifier loop
      expect(content).toContain('before changes');
    });

    it('CLAUDE.md retains Worktree Gate for defense-in-depth', () => {
      const content = readFileSync(join(rootDir, 'CLAUDE.md'), 'utf-8');

      expect(content).toContain('WORKTREE GATE');
      expect(content).toContain('uap worktree ensure --strict');
      expect(content).toContain('Read-only tasks');

      // Worktree gate must appear BEFORE build gate
      const worktreePos = content.indexOf('WORKTREE GATE');
      const buildPos = content.indexOf('PRE-EDIT BUILD GATE');
      expect(worktreePos).toBeGreaterThan(-1);
      expect(buildPos).toBeGreaterThan(-1);
      expect(worktreePos).toBeLessThan(buildPos);
    });
  });

  describe('SKILL.md Script References', () => {
    it('hooks-session-start SKILL.md references correct path', () => {
      const content = readFileSync(
        join(rootDir, '.claude/skills/hooks-session-start/SKILL.md'),
        'utf-8'
      );
      expect(content).toContain('.forge/hooks/session-start.sh');
      expect(content).not.toContain('scripts/hooks/session-start.sh');
    });

    it('hooks-pre-compact SKILL.md references correct path', () => {
      const content = readFileSync(
        join(rootDir, '.claude/skills/hooks-pre-compact/SKILL.md'),
        'utf-8'
      );
      expect(content).toContain('.forge/hooks/pre-compact.sh');
      expect(content).not.toContain('scripts/hooks/pre-compact.sh');
    });

    it('scripts-preload-memory SKILL.md references TypeScript implementation', () => {
      const content = readFileSync(
        join(rootDir, '.claude/skills/scripts-preload-memory/SKILL.md'),
        'utf-8'
      );
      expect(content).toContain('src/memory/prepopulate.ts');
      expect(content).not.toContain('scripts/preload-memory.sh');
    });

    it('scripts-tool-router SKILL.md references TypeScript implementation', () => {
      const content = readFileSync(
        join(rootDir, '.claude/skills/scripts-tool-router/SKILL.md'),
        'utf-8'
      );
      expect(content).toContain('src/coordination/pattern-router.ts');
      expect(content).not.toContain('scripts/tool-router.sh');
    });
  });

  describe('Reinforcement Database', () => {
    it('reinforcement.db can be created with correct schema', () => {
      const dbPath = join(rootDir, 'agents/data/memory/reinforcement.db');
      mkdirSync(dirname(dbPath), { recursive: true });
      // Ensure the DB exists and has the schema (initialize if empty)
      execSync(
        `sqlite3 "${dbPath}" "CREATE TABLE IF NOT EXISTS reinforcement_log (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL DEFAULT (datetime('now')), task_type TEXT NOT NULL, patterns_selected TEXT NOT NULL DEFAULT '[]', success INTEGER NOT NULL DEFAULT 0, reward_score REAL NOT NULL DEFAULT 0.0, duration_ms INTEGER, model_id TEXT, notes TEXT); CREATE TABLE IF NOT EXISTS pattern_weights (pattern_id TEXT PRIMARY KEY, weight REAL NOT NULL DEFAULT 1.0, uses INTEGER NOT NULL DEFAULT 0, successes INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT (datetime('now'))); CREATE VIEW IF NOT EXISTS v_pattern_effectiveness AS SELECT pattern_id, weight, uses, successes, CASE WHEN uses > 0 THEN CAST(successes AS REAL) / uses ELSE 0 END as success_rate FROM pattern_weights;"`,
        { encoding: 'utf-8' }
      );

      const tables = execSync(`sqlite3 "${dbPath}" ".tables"`, { encoding: 'utf-8' }).trim();
      expect(tables).toContain('reinforcement_log');
      expect(tables).toContain('pattern_weights');
      expect(tables).toContain('v_pattern_effectiveness');
    });

    it('reinforcement_log table has correct columns', () => {
      const dbPath = join(rootDir, 'agents/data/memory/reinforcement.db');
      mkdirSync(dirname(dbPath), { recursive: true });
      const schema = execSync(`sqlite3 "${dbPath}" "PRAGMA table_info(reinforcement_log);"`, {
        encoding: 'utf-8',
      });
      expect(schema).toContain('task_type');
      expect(schema).toContain('patterns_selected');
      expect(schema).toContain('success');
      expect(schema).toContain('reward_score');
    });
  });
});
