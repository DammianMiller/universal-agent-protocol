/**
 * Beads ↔ Task sync — one source of truth for "what needs doing".
 *
 * Some projects carry a legacy `beads` tracker (`.beads/issues.jsonl`)
 * alongside the UAP task DB, with no linkage — two half-true boards. This
 * module imports beads issues into the task DB idempotently: each issue maps
 * to one task carrying a `beads:<id>` label; re-running updates status drift
 * (beads is treated as the source for beads-labeled tasks).
 *
 * Import-only by design: UAP never writes back into `.beads/` (that file
 * belongs to the beads CLI). Fail-soft throughout.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { TaskService } from './service.js';
import type { TaskStatus, TaskType, TaskPriority } from './types.js';

export interface BeadsSyncResult {
  imported: number;
  updated: number;
  unchanged: number;
  skipped: number;
}

interface BeadsIssue {
  id: string;
  title: string;
  description?: string;
  status?: string;
  priority?: number;
  issue_type?: string;
}

const STATUS_MAP: Record<string, TaskStatus> = {
  open: 'open',
  in_progress: 'in_progress',
  blocked: 'blocked',
  closed: 'done',
  done: 'done',
  wont_do: 'wont_do',
};

const TYPE_SET = new Set<TaskType>(['task', 'bug', 'feature', 'epic', 'chore', 'story']);

export function beadsIssuesPath(projectRoot: string): string {
  return join(projectRoot, '.beads', 'issues.jsonl');
}

export function hasBeads(projectRoot: string): boolean {
  return existsSync(beadsIssuesPath(projectRoot));
}

/** Parse .beads/issues.jsonl, dropping malformed lines. */
/** Issue ids become task labels; refuse anything that is not a plain slug. */
const ISSUE_ID_RE = /^[A-Za-z0-9._:-]{1,64}$/;
/** Hard cap — the file is repo-controlled and sync auto-runs on `task ready`. */
const MAX_ISSUES = 2000;

export function readBeadsIssues(projectRoot: string): BeadsIssue[] {
  try {
    const lines = readFileSync(beadsIssuesPath(projectRoot), 'utf-8')
      .split('\n')
      .filter(Boolean)
      .slice(0, MAX_ISSUES);
    const issues: BeadsIssue[] = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as BeadsIssue;
        if (
          parsed &&
          typeof parsed.id === 'string' &&
          ISSUE_ID_RE.test(parsed.id) &&
          typeof parsed.title === 'string' &&
          parsed.title.trim()
        ) {
          issues.push(parsed);
        }
      } catch {
        // skip corrupt line
      }
    }
    return issues;
  } catch {
    return [];
  }
}

/**
 * Import/refresh beads issues into the task DB. Idempotent: matches on the
 * `beads:<id>` label; creates missing tasks, updates status drift, leaves
 * everything else alone.
 */
export function syncBeadsToTasks(projectRoot: string, service: TaskService): BeadsSyncResult {
  const result: BeadsSyncResult = { imported: 0, updated: 0, unchanged: 0, skipped: 0 };
  const issues = readBeadsIssues(projectRoot);
  if (issues.length === 0) return result;

  for (const issue of issues) {
    try {
      const label = `beads:${issue.id}`;
      const status = STATUS_MAP[issue.status ?? 'open'] ?? 'open';
      const existing = service.list({ labels: [label] });

      if (existing.length === 0) {
        const type = TYPE_SET.has(issue.issue_type as TaskType) ? (issue.issue_type as TaskType) : 'task';
        const rawPriority =
          typeof issue.priority === 'number' && Number.isFinite(issue.priority) ? issue.priority : 2;
        const priority = Math.min(4, Math.max(0, Math.round(rawPriority))) as TaskPriority;
        const task = service.create({
          title: issue.title.slice(0, 200),
          description: (issue.description ?? '').slice(0, 2000) || undefined,
          type,
          priority,
          labels: [label, 'beads'],
        });
        if (status !== 'open') {
          if (status === 'done') {
            service.close(task.id, `beads status: ${String(issue.status).slice(0, 40)}`);
          } else {
            // update() handles terminal wont_do correctly (sets closed_at);
            // close() would relabel it 'done' and churn forever on re-sync.
            service.update(task.id, { status });
          }
        }
        result.imported += 1;
        continue;
      }

      const task = existing[0];
      if (task.status === status) {
        result.unchanged += 1;
        continue;
      }
      // Beads is the source of truth for beads-labeled tasks.
      if (status === 'done') {
        service.close(task.id, `beads status: ${String(issue.status).slice(0, 40)}`);
      } else {
        service.update(task.id, { status });
      }
      result.updated += 1;
    } catch {
      result.skipped += 1;
    }
  }
  return result;
}
