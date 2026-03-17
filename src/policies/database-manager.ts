import Database from 'better-sqlite3';
import { mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

export class DatabaseManager {
  private db: InstanceType<typeof Database>;

  constructor(dbPath?: string) {
    const resolvedPath = dbPath || join(process.cwd(), 'agents', 'data', 'memory', 'policies.db');
    const dir = dirname(resolvedPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(resolvedPath);
    this.db.pragma('journal_mode = WAL');
    this.initialize();
  }

  private initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS policies (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        category TEXT NOT NULL,
        level TEXT NOT NULL,
        rawMarkdown TEXT,
        convertedFormat TEXT,
        executableTools TEXT DEFAULT '[]',
        tags TEXT DEFAULT '[]',
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        isActive INTEGER NOT NULL DEFAULT 1,
        priority INTEGER DEFAULT 50
      );

      CREATE TABLE IF NOT EXISTS executable_tools (
        id TEXT PRIMARY KEY,
        policyId TEXT NOT NULL,
        toolName TEXT NOT NULL,
        code TEXT NOT NULL,
        language TEXT NOT NULL DEFAULT 'python',
        createdAt TEXT NOT NULL,
        FOREIGN KEY (policyId) REFERENCES policies(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS policy_executions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        policyId TEXT NOT NULL,
        toolName TEXT NOT NULL,
        operation TEXT NOT NULL,
        args TEXT DEFAULT '{}',
        result TEXT,
        allowed INTEGER NOT NULL,
        reason TEXT,
        executedAt TEXT NOT NULL,
        FOREIGN KEY (policyId) REFERENCES policies(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_policies_category ON policies(category);
      CREATE INDEX IF NOT EXISTS idx_policies_level ON policies(level);
      CREATE INDEX IF NOT EXISTS idx_policies_active ON policies(isActive);
      CREATE INDEX IF NOT EXISTS idx_exec_tools_policy ON executable_tools(policyId);
      CREATE INDEX IF NOT EXISTS idx_policy_exec_policy ON policy_executions(policyId);
      CREATE INDEX IF NOT EXISTS idx_policy_exec_time ON policy_executions(executedAt);
    `);

    // Migration: add enforcementStage column if not present
    const columns = this.db.prepare('PRAGMA table_info(policies)').all() as Array<{ name: string }>;
    const hasEnforcementStage = columns.some((c) => c.name === 'enforcementStage');
    if (!hasEnforcementStage) {
      this.db.exec(
        "ALTER TABLE policies ADD COLUMN enforcementStage TEXT NOT NULL DEFAULT 'pre-exec'"
      );
    }

    // Migration: add taskId column to policy_executions if not present
    const execColumns = this.db.prepare('PRAGMA table_info(policy_executions)').all() as Array<{
      name: string;
    }>;
    const hasTaskId = execColumns.some((c) => c.name === 'taskId');
    if (!hasTaskId) {
      this.db.exec('ALTER TABLE policy_executions ADD COLUMN taskId TEXT');
    }
  }

  // --- Serialization helpers ---

  private serialize(value: unknown): unknown {
    if (Array.isArray(value)) return JSON.stringify(value);
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (typeof value === 'object' && value !== null) return JSON.stringify(value);
    return value;
  }

  private deserializeRow(row: Record<string, unknown>): Record<string, unknown> {
    if (!row) return row;
    const result = { ...row };

    // Boolean fields
    if ('isActive' in result) result.isActive = result.isActive === 1;
    if ('allowed' in result) result.allowed = result.allowed === 1;

    // JSON array fields
    for (const field of ['executableTools', 'tags']) {
      if (field in result && typeof result[field] === 'string') {
        try {
          result[field] = JSON.parse(result[field] as string);
        } catch {
          result[field] = [];
        }
      }
    }

    // JSON object fields
    for (const field of ['args', 'result']) {
      if (field in result && typeof result[field] === 'string') {
        try {
          result[field] = JSON.parse(result[field] as string);
        } catch {
          // leave as string
        }
      }
    }

    return result;
  }

  // --- CRUD for policies table ---

  upsertPolicy(data: Record<string, unknown>): void {
    const serialized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      serialized[key] = this.serialize(value);
    }

    const columns = Object.keys(serialized);
    const placeholders = columns.map(() => '?').join(', ');
    const sql = `INSERT OR REPLACE INTO policies (${columns.join(', ')}) VALUES (${placeholders})`;
    this.db.prepare(sql).run(...Object.values(serialized));
  }

  findPolicies(where: Record<string, unknown>): Record<string, unknown>[] {
    const keys = Object.keys(where);
    const serializedValues = keys.map((k) => this.serialize(where[k]));
    const conditions = keys.map((k) => `${k} = ?`).join(' AND ');
    const sql = `SELECT * FROM policies WHERE ${conditions}`;
    const rows = this.db.prepare(sql).all(...serializedValues) as Record<string, unknown>[];
    return rows.map((r) => this.deserializeRow(r));
  }

  findOnePolicy(where: Record<string, unknown>): Record<string, unknown> | null {
    const results = this.findPolicies(where);
    return results[0] || null;
  }

  updatePolicy(where: Record<string, unknown>, updates: Record<string, unknown>): void {
    const serializedUpdates: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(updates)) {
      serializedUpdates[key] = this.serialize(value);
    }
    const serializedWhere: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(where)) {
      serializedWhere[key] = this.serialize(value);
    }

    const setClauses = Object.keys(serializedUpdates)
      .map((k) => `${k} = ?`)
      .join(', ');
    const whereClauses = Object.keys(serializedWhere)
      .map((k) => `${k} = ?`)
      .join(' AND ');
    const sql = `UPDATE policies SET ${setClauses} WHERE ${whereClauses}`;
    this.db
      .prepare(sql)
      .run(...Object.values(serializedUpdates), ...Object.values(serializedWhere));
  }

  getAllActivePolicies(): Record<string, unknown>[] {
    const rows = this.db
      .prepare('SELECT * FROM policies WHERE isActive = 1 ORDER BY priority DESC')
      .all() as Record<string, unknown>[];
    return rows.map((r) => this.deserializeRow(r));
  }

  // --- CRUD for executable_tools table ---

  upsertExecutableTool(data: Record<string, unknown>): void {
    const columns = Object.keys(data);
    const placeholders = columns.map(() => '?').join(', ');
    const sql = `INSERT OR REPLACE INTO executable_tools (${columns.join(', ')}) VALUES (${placeholders})`;
    this.db.prepare(sql).run(...Object.values(data));
  }

  findExecutableTools(policyId: string): Record<string, unknown>[] {
    return this.db
      .prepare('SELECT * FROM executable_tools WHERE policyId = ?')
      .all(policyId) as Record<string, unknown>[];
  }

  findExecutableTool(policyId: string, toolName: string): Record<string, unknown> | null {
    const result = this.db
      .prepare('SELECT * FROM executable_tools WHERE policyId = ? AND toolName = ?')
      .get(policyId, toolName) as Record<string, unknown> | undefined;
    return result || null;
  }

  // --- CRUD for policy_executions table (audit trail) ---

  logExecution(data: {
    policyId: string;
    toolName: string;
    operation: string;
    args: Record<string, unknown>;
    result: unknown;
    allowed: boolean;
    reason: string;
    taskId?: string;
  }): void {
    const sql = `INSERT INTO policy_executions (policyId, toolName, operation, args, result, allowed, reason, executedAt, taskId) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    this.db
      .prepare(sql)
      .run(
        data.policyId,
        data.toolName,
        data.operation,
        JSON.stringify(data.args),
        JSON.stringify(data.result),
        data.allowed ? 1 : 0,
        data.reason,
        new Date().toISOString(),
        data.taskId || null
      );
  }

  getExecutionLog(policyId?: string, limit: number = 50): Record<string, unknown>[] {
    let sql = 'SELECT * FROM policy_executions';
    const params: unknown[] = [];
    if (policyId) {
      sql += ' WHERE policyId = ?';
      params.push(policyId);
    }
    sql += ' ORDER BY executedAt DESC LIMIT ?';
    params.push(limit);
    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map((r) => this.deserializeRow(r));
  }

  close(): void {
    this.db.close();
  }
}
