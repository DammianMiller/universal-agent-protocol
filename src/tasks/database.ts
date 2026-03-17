import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';

export class TaskDatabase {
  private db: Database.Database;
  private static instance: TaskDatabase | null = null;

  private constructor(dbPath: string) {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath);
    // Enable WAL mode for concurrent multi-agent read/write performance
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('busy_timeout = 10000');
    this.initSchema();
    this.migrate();
  }

  static getInstance(dbPath: string): TaskDatabase {
    if (!TaskDatabase.instance) {
      TaskDatabase.instance = new TaskDatabase(dbPath);
    }
    return TaskDatabase.instance;
  }

  static resetInstance(): void {
    if (TaskDatabase.instance) {
      TaskDatabase.instance.close();
      TaskDatabase.instance = null;
    }
  }

  getDatabase(): Database.Database {
    return this.db;
  }

  private initSchema(): void {
    this.db.exec(`
      -- Tasks (core)
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT,
        type TEXT NOT NULL CHECK(type IN ('task', 'bug', 'feature', 'epic', 'chore', 'story')) DEFAULT 'task',
        status TEXT NOT NULL CHECK(status IN ('open', 'in_progress', 'blocked', 'done', 'wont_do')) DEFAULT 'open',
        priority INTEGER NOT NULL CHECK(priority BETWEEN 0 AND 4) DEFAULT 2,
        assignee TEXT,
        worktree_branch TEXT,
        labels TEXT,
        notes TEXT,
        parent_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        due_date TEXT,
        closed_at TEXT,
        closed_reason TEXT,
        FOREIGN KEY (parent_id) REFERENCES tasks(id)
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_type ON tasks(type);
      CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority);
      CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee);
      CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_due_date ON tasks(due_date);

      -- Dependencies (DAG edges)
      CREATE TABLE IF NOT EXISTS task_dependencies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_task TEXT NOT NULL,
        to_task TEXT NOT NULL,
        dep_type TEXT NOT NULL CHECK(dep_type IN ('blocks', 'related', 'discovered_from')),
        created_at TEXT NOT NULL,
        FOREIGN KEY (from_task) REFERENCES tasks(id),
        FOREIGN KEY (to_task) REFERENCES tasks(id),
        UNIQUE(from_task, to_task)
      );
      CREATE INDEX IF NOT EXISTS idx_deps_from ON task_dependencies(from_task);
      CREATE INDEX IF NOT EXISTS idx_deps_to ON task_dependencies(to_task);
      CREATE INDEX IF NOT EXISTS idx_deps_type ON task_dependencies(dep_type);

      -- Task history (audit trail)
      CREATE TABLE IF NOT EXISTS task_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        field TEXT NOT NULL,
        old_value TEXT,
        new_value TEXT,
        changed_by TEXT,
        changed_at TEXT NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks(id)
      );
      CREATE INDEX IF NOT EXISTS idx_history_task ON task_history(task_id);
      CREATE INDEX IF NOT EXISTS idx_history_time ON task_history(changed_at);

      -- Task activity (for coordination integration)
      CREATE TABLE IF NOT EXISTS task_activity (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        activity TEXT NOT NULL CHECK(activity IN ('claimed', 'released', 'commented', 'updated', 'created', 'closed')),
        details TEXT,
        timestamp TEXT NOT NULL,
        FOREIGN KEY (task_id) REFERENCES tasks(id)
      );
      CREATE INDEX IF NOT EXISTS idx_activity_task ON task_activity(task_id);
      CREATE INDEX IF NOT EXISTS idx_activity_agent ON task_activity(agent_id);

      -- Compacted summaries (memory decay)
      CREATE TABLE IF NOT EXISTS task_summaries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        original_ids TEXT NOT NULL,
        summary TEXT NOT NULL,
        labels TEXT,
        closed_period TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_summaries_period ON task_summaries(closed_period);

    `);
  }

  /**
   * Run schema migrations for existing databases.
   * Each migration is idempotent (checks before altering).
   */
  private migrate(): void {
    const columns = this.db.pragma('table_info(tasks)') as Array<{ name: string }>;
    const columnNames = new Set(columns.map((c) => c.name));

    // v4.9.0: Add due_date column to tasks
    if (!columnNames.has('due_date')) {
      this.db.exec('ALTER TABLE tasks ADD COLUMN due_date TEXT');
      this.db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_due_date ON tasks(due_date)');
    }

    // v9.4.0: Add closed_at and closed_reason if missing (older DBs)
    if (!columnNames.has('closed_at')) {
      this.db.exec('ALTER TABLE tasks ADD COLUMN closed_at TEXT');
    }
    if (!columnNames.has('closed_reason')) {
      this.db.exec('ALTER TABLE tasks ADD COLUMN closed_reason TEXT');
    }
  }

  close(): void {
    this.db.close();
  }
}

export function getDefaultTaskDbPath(): string {
  return './.uap/tasks/tasks.db';
}

export function getDefaultTaskJSONLPath(): string {
  return './.uap/tasks/tasks.jsonl';
}
