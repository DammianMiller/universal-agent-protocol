import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';

/**
 * Singleton SQLite store for the mission ledger, mirroring the coordination
 * database's concurrency posture (WAL + busy timeout) since the orchestrator
 * daemon and CLI invocations read and write it concurrently.
 */
export class MissionDatabase {
  private db: Database.Database;
  private static instance: MissionDatabase | null = null;

  private constructor(dbPath: string) {
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('busy_timeout = 10000');
    // The REFERENCES clauses below are real: SQLite defaults foreign_keys OFF,
    // which would leave them decorative (code review P3).
    this.db.pragma('foreign_keys = ON');
    this.initSchema();
  }

  static getInstance(dbPath: string): MissionDatabase {
    if (!MissionDatabase.instance) {
      MissionDatabase.instance = new MissionDatabase(dbPath);
    }
    return MissionDatabase.instance;
  }

  static resetInstance(): void {
    if (MissionDatabase.instance) {
      MissionDatabase.instance.close();
      MissionDatabase.instance = null;
    }
  }

  getDatabase(): Database.Database {
    return this.db;
  }

  close(): void {
    this.db.close();
  }

  private initSchema(): void {
    this.db.exec(`
      -- Missions: durable goals above deliver runs.
      CREATE TABLE IF NOT EXISTS missions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        goal TEXT NOT NULL,
        acceptance TEXT NOT NULL,
        acceptance_hash TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('active', 'paused', 'delivered', 'failed')),
        preset_id TEXT,
        latest_run_id TEXT,
        launch_count INTEGER NOT NULL DEFAULT 0,
        relaunch_count INTEGER NOT NULL DEFAULT 0,
        last_launch_at TEXT,
        launch_pid INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_missions_status ON missions(status);

      -- Attempt history: one row per launch/outcome. The failed rows are the
      -- struggle metric — repeated failures per task ref trigger escalation.
      CREATE TABLE IF NOT EXISTS mission_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        mission_id INTEGER NOT NULL REFERENCES missions(id),
        run_id TEXT,
        task_ref TEXT,
        outcome TEXT NOT NULL CHECK(outcome IN ('launched', 'delivered', 'failed', 'interrupted')),
        summary TEXT,
        observed_at TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_attempts_mission ON mission_attempts(mission_id);
      CREATE INDEX IF NOT EXISTS idx_attempts_run ON mission_attempts(run_id);

      -- Approval-gated salvage proposals seeded from failed attempts.
      CREATE TABLE IF NOT EXISTS salvage_proposals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        mission_id INTEGER NOT NULL REFERENCES missions(id),
        from_attempt_id INTEGER,
        task_ref TEXT,
        proposal TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('proposed', 'approved', 'rejected')),
        created_at TEXT NOT NULL,
        decided_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_salvage_mission ON salvage_proposals(mission_id);
      CREATE INDEX IF NOT EXISTS idx_salvage_status ON salvage_proposals(status);

      -- Explicit supersede history for frozen acceptance criteria.
      CREATE TABLE IF NOT EXISTS acceptance_revisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        mission_id INTEGER NOT NULL REFERENCES missions(id),
        prior_acceptance TEXT NOT NULL,
        prior_hash TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_acceptance_revisions_mission ON acceptance_revisions(mission_id);
    `);
    this.stampSchemaVersion();
  }

  /** Ledger schema version. Bump + add a case in `migrate` when it changes. */
  private static readonly SCHEMA_VERSION = 1;

  /**
   * Stamp `PRAGMA user_version` and run any pending migrations. Without the
   * stamp, the first post-release schema change becomes a breaking migration
   * (architect review P2-3).
   */
  private stampSchemaVersion(): void {
    const current = this.db.pragma('user_version', { simple: true }) as number;
    if (current === MissionDatabase.SCHEMA_VERSION) return;
    if (current > 0 && current < MissionDatabase.SCHEMA_VERSION) {
      this.migrate(current);
    }
    this.db.pragma(`user_version = ${MissionDatabase.SCHEMA_VERSION}`);
  }

  /** Placeholder for future versioned migrations (v1 is the baseline). */
  private migrate(_fromVersion: number): void {
    /* no migrations yet — schema v1 is the first released shape */
  }
}

/** Default ledger location: `<projectRoot>/.uap/missions.db`. */
export function getMissionDbPath(projectRoot: string): string {
  return join(projectRoot, '.uap', 'missions.db');
}
