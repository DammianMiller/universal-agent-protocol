import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { dashboardBundle } from './helpers/dashboard-bundle.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..');

describe('Kanban Board Feature', () => {
  // PR #410 (dashboard-uplift): dashboard.html is now a thin shell; the kanban
  // feature lives in the web/dash/ modules (tabs.js renders the board, DOM is
  // built with the el() hyperscript helper so ids appear as `id: '...'`, and
  // styles.css carries the animations). Assertions target the whole bundle.
  describe('Web Dashboard Kanban', () => {
    it('dashboard bundle contains kanban board markup', () => {
      const bundle = dashboardBundle();
      expect(bundle).toContain('kanban-board');
      expect(bundle).toContain('kanban-col');
      expect(bundle).toContain('kanban-card');
      // The old id="kanban-panel" wrapper became the shared panel() helper
      // rendering the "Task Board" panel around the board.
      expect(bundle).toContain("panel('Task Board'");
    });

    it('dashboard bundle has all 5 kanban columns', () => {
      // Columns are no longer static markup with id="kb-*"; they are built
      // from the COLS status/label definition in web/dash/tabs.js.
      const bundle = dashboardBundle();
      expect(bundle).toContain("['open', 'Open']");
      expect(bundle).toContain("['in_progress', 'In Progress']");
      expect(bundle).toContain("['blocked', 'Blocked']");
      expect(bundle).toContain("['done', 'Done']");
      expect(bundle).toContain(`['wont_do', "Won't Do"]`);
    });

    it('dashboard bundle has card animation CSS keyframes', () => {
      const bundle = dashboardBundle();
      expect(bundle).toContain('@keyframes card-enter');
      expect(bundle).toContain('@keyframes card-exit');
      expect(bundle).toMatch(/animation:\s*card-enter/);
    });

    it('dashboard bundle has a kanban render function', () => {
      // renderKanban was ported as renderBoard in web/dash/tabs.js.
      expect(dashboardBundle()).toContain('function renderBoard');
      // TODO(dashboard-uplift): the prevCardMap card-level enter/exit diffing
      // state was not ported (tabs.js re-renders the board on a JSON signature
      // change instead); restore a prevCardMap-style assertion when per-card
      // diff animation returns.
    });

    it('dashboard bundle renders card with id, title, and priority', () => {
      const bundle = dashboardBundle();
      expect(bundle).toContain('card-id');
      expect(bundle).toContain('card-title');
      expect(bundle).toContain('card-priority');
      expect(bundle).toContain('card-meta');
    });

    it('kanban board container exists', () => {
      // el() hyperscript form of the old id="kanban-board" container.
      expect(dashboardBundle()).toContain("id: 'kanban-board'");
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
