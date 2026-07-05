/**
 * Orchestration hierarchy — the mission -> epic -> task tree with the agents
 * working each node. Built from real persisted state (fail-soft):
 *  - .uap/tasks/tasks.db: parent_id linkage (the durable task DAG)
 *  - .uap/completion-ledger.json: the in-flight build's definition-of-done tree
 *  - agents/data/coordination/coordination.db: agent_registry (who is on what)
 */

import { existsSync } from 'fs';
import { join } from 'path';
import Database from 'better-sqlite3';
import { loadLedger, progress, type LedgerItem } from '../delivery/completion-ledger.js';

export interface OrchestrationNode {
  id: string;
  title: string;
  type: string; // epic | task | phase | ...
  status: string;
  assignee?: string;
  agents: string[];
  children: OrchestrationNode[];
}

export interface LedgerTreeNode {
  id: string;
  title: string;
  kind: string;
  status: string;
  deps: string[];
}

export interface OrchestrationTree {
  /** Task-DB missions (roots) with their descendant tasks. */
  missions: OrchestrationNode[];
  /** The active build ledger, if any (epic/task DoD tree). */
  ledger: {
    mission: string;
    pct: number;
    done: number;
    total: number;
    items: LedgerTreeNode[];
  } | null;
  /** Agents currently registered, keyed to the task they claim. */
  agents: Array<{ id: string; name: string; status: string; task: string }>;
  hasHierarchy: boolean;
}

interface TaskRow {
  id: string;
  title: string;
  type: string;
  status: string;
  assignee: string | null;
  parent_id: string | null;
}

export function getOrchestrationTree(cwd: string = process.cwd()): OrchestrationTree {
  const agents = readAgents(cwd);
  const agentsByTask = new Map<string, string[]>();
  for (const a of agents) {
    if (a.task) {
      const list = agentsByTask.get(a.task) ?? [];
      list.push(a.name || a.id);
      agentsByTask.set(a.task, list);
    }
  }

  const missions = buildTaskTree(cwd, agentsByTask);
  const ledger = readLedgerTree(cwd);
  const hasHierarchy = missions.some((m) => m.children.length > 0) || (ledger?.items.length ?? 0) > 0;

  return { missions, ledger, agents, hasHierarchy };
}

function buildTaskTree(cwd: string, agentsByTask: Map<string, string[]>): OrchestrationNode[] {
  const dbPath = join(cwd, '.uap', 'tasks', 'tasks.db');
  if (!existsSync(dbPath)) return [];
  try {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const rows = db
      .prepare(
        "SELECT id, title, type, status, assignee, parent_id FROM tasks WHERE status != 'wont_do' ORDER BY created_at DESC LIMIT 500"
      )
      .all() as TaskRow[];
    db.close();

    const byId = new Map<string, OrchestrationNode>();
    for (const r of rows) {
      byId.set(r.id, {
        id: r.id,
        title: r.title,
        type: r.type,
        status: r.status,
        ...(r.assignee ? { assignee: r.assignee } : {}),
        agents: agentsByTask.get(r.id) ?? [],
        children: [],
      });
    }
    const roots: OrchestrationNode[] = [];
    for (const r of rows) {
      const node = byId.get(r.id)!;
      const parent = r.parent_id ? byId.get(r.parent_id) : undefined;
      if (parent) parent.children.push(node);
      else roots.push(node);
    }
    // Surface roots that actually have children first (real orchestrations),
    // then epics, then the rest — capped so the panel stays readable.
    roots.sort((a, b) => {
      const score = (n: OrchestrationNode) => (n.children.length > 0 ? 2 : 0) + (n.type === 'epic' ? 1 : 0);
      return score(b) - score(a);
    });
    return roots.slice(0, 50);
  } catch {
    return [];
  }
}

function readLedgerTree(cwd: string): OrchestrationTree['ledger'] {
  try {
    const ledger = loadLedger(cwd);
    if (!ledger) return null;
    const p = progress(ledger);
    return {
      mission: ledger.mission,
      pct: p.pct,
      done: p.done,
      total: p.total,
      items: ledger.items.map((i: LedgerItem) => ({
        id: i.id,
        title: i.title,
        kind: i.kind,
        status: i.status,
        deps: i.deps ?? [],
      })),
    };
  } catch {
    return null;
  }
}

function readAgents(cwd: string): OrchestrationTree['agents'] {
  const dbPath = join(cwd, 'agents', 'data', 'coordination', 'coordination.db');
  if (!existsSync(dbPath)) return [];
  try {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const rows = db
      .prepare(
        "SELECT id, name, status, current_task FROM agent_registry WHERE last_heartbeat >= datetime('now','-1 day') ORDER BY last_heartbeat DESC LIMIT 100"
      )
      .all() as Array<{ id: string; name: string | null; status: string; current_task: string | null }>;
    db.close();
    return rows.map((r) => ({ id: r.id, name: r.name || r.id, status: r.status, task: r.current_task || '' }));
  } catch {
    return [];
  }
}
