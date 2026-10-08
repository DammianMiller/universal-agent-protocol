import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';

export class CoordinationDatabase {
  private db: Database.Database;
  private static instance: CoordinationDatabase | null = null;

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
  }

  static getInstance(dbPath: string): CoordinationDatabase {
    if (!CoordinationDatabase.instance) {
      CoordinationDatabase.instance = new CoordinationDatabase(dbPath);
    }
    return CoordinationDatabase.instance;
  }

  static resetInstance(): void {
    if (CoordinationDatabase.instance) {
      CoordinationDatabase.instance.close();
      CoordinationDatabase.instance = null;
    }
  }

  getDatabase(): Database.Database {
    return this.db;
  }

  private initSchema(): void {
    this.db.exec(`
      -- Agent registry for tracking active agents
      CREATE TABLE IF NOT EXISTS agent_registry (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        session_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('active', 'idle', 'completed', 'failed')),
        current_task TEXT,
        worktree_branch TEXT,
        started_at TEXT NOT NULL,
        last_heartbeat TEXT NOT NULL,
        capabilities TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_agent_registry_session ON agent_registry(session_id);
      CREATE INDEX IF NOT EXISTS idx_agent_registry_status ON agent_registry(status);

      -- Message bus for inter-agent communication
      CREATE TABLE IF NOT EXISTS agent_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel TEXT NOT NULL,
        from_agent TEXT,
        to_agent TEXT,
        type TEXT NOT NULL CHECK(type IN ('request', 'response', 'notification', 'claim', 'release')),
        payload TEXT NOT NULL,
        priority INTEGER DEFAULT 5,
        created_at TEXT NOT NULL,
        read_at TEXT,
        expires_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_messages_channel ON agent_messages(channel);
      CREATE INDEX IF NOT EXISTS idx_messages_to_agent ON agent_messages(to_agent);
      CREATE INDEX IF NOT EXISTS idx_messages_created ON agent_messages(created_at);

      -- Work announcements (informational - for coordination, NOT locking)
      -- Agents announce what they're working on so others can optimize velocity
      CREATE TABLE IF NOT EXISTS work_announcements (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL,
        agent_name TEXT,
        worktree_branch TEXT,
        intent_type TEXT NOT NULL CHECK(intent_type IN ('editing', 'reviewing', 'refactoring', 'testing', 'documenting')),
        resource TEXT NOT NULL,
        description TEXT,
        files_affected TEXT,
        estimated_completion TEXT,
        announced_at TEXT NOT NULL,
        completed_at TEXT,
        FOREIGN KEY (agent_id) REFERENCES agent_registry(id)
      );
      CREATE INDEX IF NOT EXISTS idx_announcements_agent ON work_announcements(agent_id);
      CREATE INDEX IF NOT EXISTS idx_announcements_resource ON work_announcements(resource);
      CREATE INDEX IF NOT EXISTS idx_announcements_active ON work_announcements(completed_at) WHERE completed_at IS NULL;

      -- Legacy work_claims table (for backward compatibility, maps to announcements)
      CREATE TABLE IF NOT EXISTS work_claims (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        resource TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        claim_type TEXT NOT NULL CHECK(claim_type IN ('exclusive', 'shared')),
        claimed_at TEXT NOT NULL,
        expires_at TEXT,
        FOREIGN KEY (agent_id) REFERENCES agent_registry(id)
      );
      CREATE INDEX IF NOT EXISTS idx_claims_agent ON work_claims(agent_id);
      CREATE INDEX IF NOT EXISTS idx_claims_resource ON work_claims(resource);

      -- Deployment batching queue
      CREATE TABLE IF NOT EXISTS deploy_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT NOT NULL,
        action_type TEXT NOT NULL CHECK(action_type IN ('commit', 'push', 'merge', 'deploy', 'workflow')),
        target TEXT NOT NULL,
        payload TEXT,
        status TEXT NOT NULL CHECK(status IN ('pending', 'batched', 'executing', 'completed', 'failed')),
        batch_id TEXT,
        queued_at TEXT NOT NULL,
        execute_after TEXT,
        priority INTEGER DEFAULT 5,
        dependencies TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_deploy_status ON deploy_queue(status);
      CREATE INDEX IF NOT EXISTS idx_deploy_batch ON deploy_queue(batch_id);
      CREATE INDEX IF NOT EXISTS idx_deploy_target ON deploy_queue(target);

      -- Batch tracking
      CREATE TABLE IF NOT EXISTS deploy_batches (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        executed_at TEXT,
        status TEXT NOT NULL CHECK(status IN ('pending', 'executing', 'completed', 'failed')),
        result TEXT
      );

      -- Findings ledger: tracked claims with mutable status + lineage, giving the
      -- append-only board a "what's actually true right now" layer. A claim is
      -- proposed, then confirmed/reversed/disputed by peers; a reversal can
      -- supersede an earlier finding (lineage), and a dispute is the integrity
      -- flag escalated for a peer/human ruling.
      CREATE TABLE IF NOT EXISTS findings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent_id TEXT,
        claim TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('proposed', 'confirmed', 'reversed', 'disputed')),
        evidence TEXT,
        supersedes INTEGER,
        resolution TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (supersedes) REFERENCES findings(id)
      );
      CREATE INDEX IF NOT EXISTS idx_findings_status ON findings(status);
      CREATE INDEX IF NOT EXISTS idx_findings_supersedes ON findings(supersedes);

      -- Staged work: relay/handoff + quota-pooling. An agent stages an artifact
      -- plus an acceptance spec for ANY capable agent to pick up (build/run/
      -- diagnose/ship split across agents), with capability/resource needs and
      -- credit to the originator. Driven by the open-challenge norm: "stage a
      -- candidate publicly for whoever has quota; credit the originator."
      CREATE TABLE IF NOT EXISTS staged_work (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        originator TEXT NOT NULL,
        title TEXT NOT NULL,
        artifact TEXT,
        acceptance TEXT,
        needs TEXT,
        status TEXT NOT NULL CHECK(status IN ('staged', 'claimed', 'completed', 'abandoned')),
        claimant TEXT,
        result TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_staged_status ON staged_work(status);
      CREATE INDEX IF NOT EXISTS idx_staged_needs ON staged_work(needs);

      -- Challenges: an open, shared goal that N agents work on a common board,
      -- with verified submissions and a significance-gated leaderboard (frontier
      -- deltas within the margin are ties, not wins). The capstone that composes
      -- the board, findings, staged-work, and the significance norm.
      CREATE TABLE IF NOT EXISTS challenges (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        goal TEXT NOT NULL,
        metric TEXT,
        higher_is_better INTEGER NOT NULL DEFAULT 1,
        rope_margin REAL NOT NULL DEFAULT 0,
        status TEXT NOT NULL CHECK(status IN ('open', 'closed')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS submissions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        challenge_id INTEGER NOT NULL,
        agent_id TEXT,
        score REAL NOT NULL,
        artifact TEXT,
        note TEXT,
        verified INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        FOREIGN KEY (challenge_id) REFERENCES challenges(id)
      );
      CREATE INDEX IF NOT EXISTS idx_submissions_challenge ON submissions(challenge_id);

      -- Model-slot leases: a cross-process semaphore over the inference backend's
      -- concurrent slots. Every model-calling path acquires a lease before a
      -- request and releases after; when active leases reach the budget, further
      -- acquirers wait. Leases carry a TTL so a crashed holder is auto-reaped.
      -- The "target" column keys a lease to a placement target (device+endpoint
      -- identity); callers that pass none land in the legacy 'default' bucket,
      -- so existing behaviour is unchanged until a caller opts in (spec §5.1).
      CREATE TABLE IF NOT EXISTS model_leases (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        holder TEXT,
        acquired_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        target TEXT NOT NULL DEFAULT 'default'
      );
      CREATE INDEX IF NOT EXISTS idx_model_leases_expires ON model_leases(expires_at);
      -- idx_model_leases_target is created in migrateSchema(), AFTER the
      -- target column exists on upgraded databases: on an old-shape DB this
      -- CREATE TABLE is a no-op, so an index on "target" here would throw
      -- "no such column" before the migration could add it.

      -- Adaptive backpressure (AIMD): one row PER TARGET tracking the current
      -- model concurrency limit. On an exhaustion signal (429 / timeout /
      -- slot-busy) the limit is multiplicatively decreased; on sustained
      -- success it additively recovers toward the ceiling (the static slot
      -- budget). Keyed by placement target so a struggling backend throttles
      -- itself without throttling a healthy one sharing the fleet.
      CREATE TABLE IF NOT EXISTS model_backpressure (
        target TEXT PRIMARY KEY,
        limit_val REAL NOT NULL,
        ceiling REAL NOT NULL,
        last_decrease_at TEXT,
        updated_at TEXT NOT NULL
      );
    `);
    this.migrateSchema();
  }

  /**
   * Idempotent schema evolution for pre-target databases. The coordination
   * DB has no version marker, so every step is guarded by a PRAGMA
   * table_info probe (the src/memory/short-term/schema.ts precedent) — an
   * unguarded ALTER next to CREATE TABLE IF NOT EXISTS would throw on the
   * second open.
   *
   * The model_backpressure rebuild maps the legacy `id = 1` row to
   * `target = 'default'`, so a revert of the code loses no operator-tuned
   * state: the migration stays reversible in code only (spec §5.1).
   */
  private migrateSchema(): void {
    const leaseCols = this.tableColumns('model_leases');
    if (leaseCols && !leaseCols.has('target')) {
      this.db.exec(`ALTER TABLE model_leases ADD COLUMN target TEXT NOT NULL DEFAULT 'default'`);
    }
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_model_leases_target ON model_leases(target, expires_at)`);

    const bpCols = this.tableColumns('model_backpressure');
    if (bpCols && bpCols.has('id') && !bpCols.has('target')) {
      // SQLite cannot drop the CHECK(id = 1) constraint in place — rebuild.
      this.db.transaction(() => {
        this.db.exec(`
          CREATE TABLE model_backpressure_new (
            target TEXT PRIMARY KEY,
            limit_val REAL NOT NULL,
            ceiling REAL NOT NULL,
            last_decrease_at TEXT,
            updated_at TEXT NOT NULL
          );
        `);
        this.db.prepare(
          `INSERT INTO model_backpressure_new (target, limit_val, ceiling, last_decrease_at, updated_at)
           SELECT 'default', limit_val, ceiling, last_decrease_at, updated_at FROM model_backpressure WHERE id = 1`,
        ).run();
        this.db.exec('DROP TABLE model_backpressure');
        this.db.exec('ALTER TABLE model_backpressure_new RENAME TO model_backpressure');
      })();
    }
  }

  private tableColumns(table: string): Set<string> | null {
    try {
      const rows = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      return new Set(rows.map((r) => r.name));
    } catch {
      return null;
    }
  }

  close(): void {
    this.db.close();
  }
}

export function getDefaultCoordinationDbPath(): string {
  // UAP_COORD_DB lets a caller (or test) point the shared coordination DB at a
  // specific path without changing cwd.
  return process.env.UAP_COORD_DB || './agents/data/coordination/coordination.db';
}
