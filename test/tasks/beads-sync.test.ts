/**
 * Beads → task import: legacy .beads issues fold into the task DB
 * idempotently, keyed by a beads:<id> label.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { TaskService } from '../../src/tasks/service.js';
import { syncBeadsToTasks, hasBeads, readBeadsIssues } from '../../src/tasks/beads-sync.js';

describe('beads → task sync', () => {
  let dir: string;
  let service: TaskService;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'uap-beads-'));
    mkdirSync(join(dir, '.beads'), { recursive: true });
    service = new TaskService({
      dbPath: join(dir, 'tasks.db'),
      jsonlPath: join(dir, 'tasks.jsonl'),
    });
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeIssues(issues: object[]): void {
    writeFileSync(
      join(dir, '.beads', 'issues.jsonl'),
      issues.map((i) => JSON.stringify(i)).join('\n') + '\nnot-json\n'
    );
  }

  it('imports issues with status/type/priority mapping', () => {
    writeIssues([
      { id: 'b-1', title: 'Open thing', status: 'open', priority: 1, issue_type: 'feature' },
      { id: 'b-2', title: 'Done thing', status: 'closed', priority: 2, issue_type: 'task' },
      { id: 'b-3', title: 'Busy thing', status: 'in_progress', priority: 9, issue_type: 'weird' },
    ]);
    expect(hasBeads(dir)).toBe(true);
    expect(readBeadsIssues(dir).length).toBe(3);

    const r = syncBeadsToTasks(dir, service);
    expect(r.imported).toBe(3);
    expect(r.skipped).toBe(0);

    const beadsTasks = service.list({ labels: ['beads'] });
    expect(beadsTasks.length).toBe(3);
    const byLabel = (id: string) => service.list({ labels: [`beads:${id}`] })[0];
    expect(byLabel('b-1').status).toBe('open');
    expect(byLabel('b-1').type).toBe('feature');
    expect(byLabel('b-2').status).toBe('done');
    expect(byLabel('b-3').status).toBe('in_progress');
    expect(byLabel('b-3').type).toBe('task'); // unknown type maps to task
    expect(byLabel('b-3').priority).toBe(4); // priority clamped to 0-4
  });

  it('is idempotent and applies beads-side status drift on re-sync', () => {
    const again = syncBeadsToTasks(dir, service);
    expect(again.imported).toBe(0);
    expect(again.unchanged).toBe(3);

    // Beads closes b-1 → the task follows.
    writeIssues([
      { id: 'b-1', title: 'Open thing', status: 'closed' },
      { id: 'b-2', title: 'Done thing', status: 'closed' },
      { id: 'b-3', title: 'Busy thing', status: 'in_progress' },
    ]);
    const drift = syncBeadsToTasks(dir, service);
    expect(drift.updated).toBe(1);
    expect(service.list({ labels: ['beads:b-1'] })[0].status).toBe('done');
  });
});
