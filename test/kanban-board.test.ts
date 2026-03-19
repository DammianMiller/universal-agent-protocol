import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');

describe('Kanban Board Feature', () => {
  describe('Web Dashboard Kanban', () => {
    it('dashboard.html contains kanban board markup', () => {
      const html = readFileSync(join(rootDir, 'web/dashboard.html'), 'utf-8');
      expect(html).toContain('id="kanban-board"');
      expect(html).toContain('id="kanban-panel"');
      expect(html).toContain('kanban-col');
      expect(html).toContain('kanban-card');
    });

    it('dashboard.html has all 5 kanban columns', () => {
      const html = readFileSync(join(rootDir, 'web/dashboard.html'), 'utf-8');
      expect(html).toContain('id="kb-open"');
      expect(html).toContain('id="kb-progress"');
      expect(html).toContain('id="kb-blocked"');
      expect(html).toContain('id="kb-done"');
      expect(html).toContain('id="kb-wontdo"');
    });

    it('dashboard.html has card animation CSS keyframes', () => {
      const html = readFileSync(join(rootDir, 'web/dashboard.html'), 'utf-8');
      expect(html).toContain('@keyframes card-enter');
      expect(html).toContain('@keyframes card-exit');
      expect(html).toMatch(/animation:\s*card-enter/);
    });

    it('dashboard.html has renderKanban function', () => {
      const html = readFileSync(join(rootDir, 'web/dashboard.html'), 'utf-8');
      expect(html).toContain('function renderKanban');
      expect(html).toContain('function renderColumn');
      expect(html).toContain('prevCardMap');
    });

    it('dashboard.html renders card with id, title, priority, and type', () => {
      const html = readFileSync(join(rootDir, 'web/dashboard.html'), 'utf-8');
      expect(html).toContain('card-id');
      expect(html).toContain('card-title');
      expect(html).toContain('card-priority');
      expect(html).toContain('card-type');
      expect(html).toContain('card-meta');
    });

    it('kanban board panel has full-width class', () => {
      const html = readFileSync(join(rootDir, 'web/dashboard.html'), 'utf-8');
      // The kanban panel should span the full grid width
      expect(html).toMatch(/class="[^"]*full-width[^"]*"[^>]*id="kanban-panel"/);
    });
  });

  describe('Data Service TaskData', () => {
    it('TaskData interface includes items array', () => {
      const source = readFileSync(join(rootDir, 'src/dashboard/data-service.ts'), 'utf-8');
      expect(source).toContain('items: TaskItem[]');
    });

    it('TaskItem interface has required fields', () => {
      const source = readFileSync(join(rootDir, 'src/dashboard/data-service.ts'), 'utf-8');
      expect(source).toContain('export interface TaskItem');
      expect(source).toContain('id: string');
      expect(source).toContain('title: string');
      expect(source).toContain('type: string');
      expect(source).toContain('status: string');
      expect(source).toContain('priority: number');
    });

    it('getTaskData fetches individual task items from DB', () => {
      const source = readFileSync(join(rootDir, 'src/dashboard/data-service.ts'), 'utf-8');
      // Should query individual tasks, not just counts
      expect(source).toContain('SELECT id, title, type, status, priority, assignee, updated_at');
      expect(source).toContain('result.items');
    });
  });

  describe('CLI Board Command', () => {
    it('task.ts exports board action type', () => {
      const source = readFileSync(join(rootDir, 'src/cli/task.ts'), 'utf-8');
      expect(source).toContain("| 'board'");
    });

    it('task.ts has showBoard function', () => {
      const source = readFileSync(join(rootDir, 'src/cli/task.ts'), 'utf-8');
      expect(source).toContain('async function showBoard');
      expect(source).toContain('Task Board');
    });

    it('cli.ts registers board subcommand', () => {
      const source = readFileSync(join(rootDir, 'src/bin/cli.ts'), 'utf-8');
      expect(source).toContain("'board'");
      expect(source).toContain('Show tasks as a kanban board');
    });

    it('showBoard groups tasks by status into columns', () => {
      const source = readFileSync(join(rootDir, 'src/cli/task.ts'), 'utf-8');
      // Should group by all 5 statuses
      expect(source).toMatch(/open:.*filter.*status.*===.*'open'/s);
      expect(source).toMatch(/in_progress:.*filter.*status.*===.*'in_progress'/s);
      expect(source).toMatch(/blocked:.*filter.*status.*===.*'blocked'/s);
      expect(source).toMatch(/done:.*filter.*status.*===.*'done'/s);
    });
  });
});
