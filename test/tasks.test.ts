import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TaskService } from '../src/tasks/service.js';
import { TaskDatabase } from '../src/tasks/database.js';
import { existsSync, unlinkSync, mkdirSync } from 'fs';
import { join } from 'path';

const TEST_DB_DIR = '.uap-test-tasks';
const TEST_DB_PATH = join(TEST_DB_DIR, 'tasks.db');
const TEST_JSONL_PATH = join(TEST_DB_DIR, 'tasks.jsonl');

describe('TaskService', () => {
  let service: TaskService;

  beforeEach(() => {
    TaskDatabase.resetInstance();
    for (const f of [TEST_DB_PATH, TEST_DB_PATH + '-wal', TEST_DB_PATH + '-shm', TEST_JSONL_PATH]) {
      if (existsSync(f)) unlinkSync(f);
    }
    if (!existsSync(TEST_DB_DIR)) mkdirSync(TEST_DB_DIR, { recursive: true });

    service = new TaskService({
      dbPath: TEST_DB_PATH,
      jsonlPath: TEST_JSONL_PATH,
      agentId: 'test-agent',
    });
  });

  afterEach(() => {
    TaskDatabase.resetInstance();
    for (const f of [TEST_DB_PATH, TEST_DB_PATH + '-wal', TEST_DB_PATH + '-shm', TEST_JSONL_PATH]) {
      if (existsSync(f)) unlinkSync(f);
    }
  });

  describe('CRUD', () => {
    it('should create a task with defaults', () => {
      const task = service.create({ title: 'Test task' });
      expect(task.id).toMatch(/^uap-/);
      expect(task.title).toBe('Test task');
      expect(task.status).toBe('open');
      expect(task.priority).toBe(2);
      expect(task.type).toBe('task');
    });

    it('should create a task with all fields', () => {
      const task = service.create({
        title: 'Full task',
        description: 'A detailed description',
        type: 'bug',
        priority: 0,
        labels: ['urgent', 'backend'],
        assignee: 'agent-1',
        notes: 'Some notes',
        dueDate: '2026-04-01',
      });
      expect(task.type).toBe('bug');
      expect(task.priority).toBe(0);
      expect(task.labels).toEqual(['urgent', 'backend']);
      expect(task.dueDate).toBe('2026-04-01');
    });

    it('should get a task by ID', () => {
      const created = service.create({ title: 'Get test' });
      const fetched = service.get(created.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.title).toBe('Get test');
    });

    it('should return null for non-existent task', () => {
      expect(service.get('uap-0000')).toBeNull();
    });

    it('should update a task', () => {
      const task = service.create({ title: 'Original' });
      const updated = service.update(task.id, {
        title: 'Updated',
        status: 'in_progress',
        priority: 1,
      });
      expect(updated!.title).toBe('Updated');
      expect(updated!.status).toBe('in_progress');
      expect(updated!.priority).toBe(1);
    });

    it('should update due date', () => {
      const task = service.create({ title: 'Due date test' });
      const updated = service.update(task.id, { dueDate: '2026-06-15' });
      expect(updated!.dueDate).toBe('2026-06-15');
    });

    it('should clear due date with null', () => {
      const task = service.create({ title: 'Clear due', dueDate: '2026-06-15' });
      const updated = service.update(task.id, { dueDate: null });
      expect(updated!.dueDate).toBeNull();
    });

    it('should close a task', () => {
      const task = service.create({ title: 'Close test' });
      const closed = service.close(task.id, 'Completed successfully');
      expect(closed!.status).toBe('done');
      expect(closed!.closedAt).toBeTruthy();
      expect(closed!.closedReason).toBe('Completed successfully');
    });

    it('should delete a task', () => {
      const task = service.create({ title: 'Delete test' });
      expect(service.delete(task.id)).toBe(true);
      expect(service.get(task.id)).toBeNull();
    });

    it('should return false when deleting non-existent task', () => {
      expect(service.delete('uap-0000')).toBe(false);
    });
  });

  describe('Queries', () => {
    beforeEach(() => {
      service.create({ title: 'Open bug', type: 'bug', priority: 0 });
      service.create({ title: 'Open feature', type: 'feature', priority: 2 });
      service.create({ title: 'Low chore', type: 'chore', priority: 4, labels: ['cleanup'] });
    });

    it('should list all tasks', () => {
      const tasks = service.list();
      expect(tasks.length).toBe(3);
    });

    it('should filter by type', () => {
      const bugs = service.list({ type: 'bug' });
      expect(bugs.length).toBe(1);
      expect(bugs[0].title).toBe('Open bug');
    });

    it('should filter by priority', () => {
      const critical = service.list({ priority: 0 });
      expect(critical.length).toBe(1);
    });

    it('should filter by labels', () => {
      const cleanup = service.list({ labels: ['cleanup'] });
      expect(cleanup.length).toBe(1);
      expect(cleanup[0].title).toBe('Low chore');
    });

    it('should search by title', () => {
      const results = service.list({ search: 'feature' });
      expect(results.length).toBe(1);
    });

    it('should get ready tasks', () => {
      const ready = service.ready();
      expect(ready.length).toBe(3);
      for (const t of ready) {
        expect(t.isReady).toBe(true);
      }
    });
  });

  describe('Dependencies', () => {
    it('should add a blocking dependency', () => {
      const task1 = service.create({ title: 'Blocker' });
      const task2 = service.create({ title: 'Blocked' });
      const dep = service.addDependency(task2.id, task1.id, 'blocks');
      expect(dep).not.toBeNull();
      expect(dep!.fromTask).toBe(task2.id);
      expect(dep!.toTask).toBe(task1.id);
    });

    it('should prevent self-dependency', () => {
      const task = service.create({ title: 'Self' });
      expect(service.addDependency(task.id, task.id)).toBeNull();
    });

    it('should detect blocked tasks', () => {
      const blocker = service.create({ title: 'Blocker' });
      const blocked = service.create({ title: 'Blocked' });
      service.addDependency(blocked.id, blocker.id, 'blocks');

      const withRelations = service.getWithRelations(blocked.id);
      expect(withRelations!.isBlocked).toBe(true);
      expect(withRelations!.isReady).toBe(false);
    });

    it('should unblock when blocker is closed', () => {
      const blocker = service.create({ title: 'Blocker' });
      const blocked = service.create({ title: 'Blocked' });
      service.addDependency(blocked.id, blocker.id, 'blocks');

      service.close(blocker.id);
      const withRelations = service.getWithRelations(blocked.id);
      expect(withRelations!.isBlocked).toBe(false);
      expect(withRelations!.isReady).toBe(true);
    });

    it('should remove a dependency', () => {
      const task1 = service.create({ title: 'Task 1' });
      const task2 = service.create({ title: 'Task 2' });
      service.addDependency(task1.id, task2.id);
      expect(service.removeDependency(task1.id, task2.id)).toBe(true);
    });
  });

  describe('Statistics', () => {
    it('should return correct stats', () => {
      service.create({ title: 'Open 1' });
      service.create({ title: 'Open 2', type: 'bug' });
      const t3 = service.create({ title: 'Done' });
      service.close(t3.id);

      const stats = service.getStats();
      expect(stats.total).toBe(3);
      expect(stats.byStatus.open).toBe(2);
      expect(stats.byStatus.done).toBe(1);
      expect(stats.byType.bug).toBe(1);
    });

    it('should count overdue tasks', () => {
      // Create a task with a past due date
      service.create({ title: 'Overdue task', dueDate: '2020-01-01' });
      // Create a task with a future due date
      service.create({ title: 'Future task', dueDate: '2099-12-31' });
      // Create a task with no due date
      service.create({ title: 'No due date' });

      const stats = service.getStats();
      expect(stats.overdue).toBe(1);
    });

    it('should not count closed tasks as overdue', () => {
      const task = service.create({ title: 'Closed overdue', dueDate: '2020-01-01' });
      service.close(task.id);

      const stats = service.getStats();
      expect(stats.overdue).toBe(0);
    });
  });

  describe('History & Activity', () => {
    it('should record creation history', () => {
      const task = service.create({ title: 'History test' });
      const history = service.getHistory(task.id);
      expect(history.length).toBeGreaterThan(0);
      expect(history.some((h) => h.field === 'created')).toBe(true);
    });

    it('should record update history', () => {
      const task = service.create({ title: 'Update history' });
      service.update(task.id, { title: 'New title' });
      const history = service.getHistory(task.id);
      expect(history.some((h) => h.field === 'title')).toBe(true);
    });

    it('should record activity', () => {
      const task = service.create({ title: 'Activity test' });
      const activity = service.getActivity(task.id);
      expect(activity.length).toBeGreaterThan(0);
      expect(activity.some((a) => a.activity === 'created')).toBe(true);
    });
  });

  describe('JSONL Export/Import', () => {
    it('should export and import tasks', () => {
      service.create({ title: 'Export 1', labels: ['test'] });
      service.create({ title: 'Export 2', type: 'bug' });

      service.saveToJSONL();

      // Create a new service pointing to same JSONL but fresh DB
      TaskDatabase.resetInstance();
      if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);
      if (existsSync(TEST_DB_PATH + '-wal')) unlinkSync(TEST_DB_PATH + '-wal');
      if (existsSync(TEST_DB_PATH + '-shm')) unlinkSync(TEST_DB_PATH + '-shm');

      const newService = new TaskService({
        dbPath: TEST_DB_PATH,
        jsonlPath: TEST_JSONL_PATH,
        agentId: 'test-agent',
      });

      const imported = newService.importFromJSONL();
      expect(imported).toBe(2);

      const tasks = newService.list();
      expect(tasks.length).toBe(2);
    });
  });

  describe('Hierarchy', () => {
    it('should support parent-child relationships', () => {
      const epic = service.create({ title: 'Epic', type: 'epic' });
      const child1 = service.create({ title: 'Child 1', parentId: epic.id });
      const child2 = service.create({ title: 'Child 2', parentId: epic.id });

      const children = service.getChildren(epic.id);
      expect(children.length).toBe(2);
      expect(children.map((c) => c.id).sort()).toEqual([child1.id, child2.id].sort());
    });

    it('should include parent in relations', () => {
      const parent = service.create({ title: 'Parent' });
      const child = service.create({ title: 'Child', parentId: parent.id });

      const withRelations = service.getWithRelations(child.id);
      expect(withRelations!.parent).toBeTruthy();
      expect(withRelations!.parent!.id).toBe(parent.id);
    });
  });
});
