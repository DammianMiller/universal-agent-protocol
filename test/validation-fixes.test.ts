import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'fs';
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

      // Check 2: SESSION START with uap task ready
      expect(content).toContain('## SESSION START');
      expect(content).toContain('uap task ready');

      // Check 3: DECISION LOOP with @Skill:name.md
      expect(content).toContain('@Skill:name.md');

      // Check 4: MANDATORY worktree enforcement
      expect(content).toMatch(/WORKTREE WORKFLOW.*MANDATORY/);

      // Check 5: PARALLEL REVIEW PROTOCOL
      expect(content).toContain('## PARALLEL REVIEW PROTOCOL');

      // Check 6: Schema Diff Gate in BLOCKING PREREQUISITES
      expect(content).toMatch(/Schema Diff Gate/);
      expect(content).toContain('BLOCKING PREREQUISITES');

      // Check 7: VERIFIER-FIRST
      expect(content).toContain('## VERIFIER-FIRST');

      // Check 8: COMPLETION GATES - MANDATORY
      expect(content).toMatch(/COMPLETION GATES.*-.*MANDATORY/);

      // Check 9: Pattern Router
      expect(content).toMatch(/Pattern.*Router/);

      // Check 10: RTK includes
      expect(content).toMatch(/@hooks-session-start\.md|@PreCompact\.md/);

      // Check 11: Verifier loop (min 3 times)
      expect(content).toMatch(/MANDATORY.*minimum 3 times|MANDATORY.*3 times/);
    });

    it('CLAUDE.md retains Pre-Edit Worktree Gate for defense-in-depth', () => {
      const content = readFileSync(join(rootDir, 'CLAUDE.md'), 'utf-8');

      expect(content).toContain('Pre-Edit Worktree Gate [REQUIRED]');
      expect(content).toContain('uap worktree ensure --strict');
      expect(content).toContain('No exceptions for "small changes"');

      // Worktree gate must appear BEFORE build gate
      const worktreePos = content.indexOf('Pre-Edit Worktree Gate');
      const buildPos = content.indexOf('Pre-Edit Build Gate');
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
    it('reinforcement.db exists with correct schema', () => {
      const dbPath = join(rootDir, 'agents/data/memory/reinforcement.db');
      expect(existsSync(dbPath)).toBe(true);

      const tables = execSync(
        `sqlite3 "${dbPath}" ".tables"`,
        { encoding: 'utf-8' }
      ).trim();
      expect(tables).toContain('reinforcement_log');
      expect(tables).toContain('pattern_weights');
      expect(tables).toContain('v_pattern_effectiveness');
    });

    it('reinforcement_log table has correct columns', () => {
      const dbPath = join(rootDir, 'agents/data/memory/reinforcement.db');
      const schema = execSync(
        `sqlite3 "${dbPath}" "PRAGMA table_info(reinforcement_log);"`,
        { encoding: 'utf-8' }
      );
      expect(schema).toContain('task_type');
      expect(schema).toContain('patterns_selected');
      expect(schema).toContain('success');
      expect(schema).toContain('reward_score');
    });
  });
});
