import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import { CoordinationDatabase, getDefaultCoordinationDbPath } from './database.js';
import type {
  AgentRegistryEntry,
  AgentMessage,
  WorkClaim,
  WorkAnnouncement,
  WorkOverlap,
  CollaborationSuggestion,
  DeployAction,
  CoordinationStatus,
  AgentStatus,
  MessageType,
  MessageChannel,
  ClaimType,
  WorkIntentType,
  ConflictRisk,
  DeployActionType,
  DeployStatus,
  MessagePayload,
} from '../types/coordination.js';

export interface CoordinationServiceConfig {
  dbPath?: string;
  sessionId?: string;
  heartbeatIntervalMs?: number;
  claimExpiryMs?: number;
}

export class CoordinationService {
  private db: Database.Database;
  private sessionId: string;
  private heartbeatIntervalMs: number;
  private claimExpiryMs: number;

  constructor(config: CoordinationServiceConfig = {}) {
    const dbPath = config.dbPath || getDefaultCoordinationDbPath();
    this.db = CoordinationDatabase.getInstance(dbPath).getDatabase();
    this.sessionId = config.sessionId || randomUUID();
    this.heartbeatIntervalMs = config.heartbeatIntervalMs || 30000;
    this.claimExpiryMs = config.claimExpiryMs || 300000; // 5 minutes
  }

  // ==================== Agent Lifecycle ====================

  register(name: string, capabilities?: string[], worktreeBranch?: string): string {
    const id = randomUUID();
    const now = new Date().toISOString();

    const stmt = this.db.prepare(`
      INSERT INTO agent_registry (id, name, session_id, status, worktree_branch, started_at, last_heartbeat, capabilities)
      VALUES (?, ?, ?, 'active', ?, ?, ?, ?)
    `);

    stmt.run(id, name, this.sessionId, worktreeBranch || null, now, now, capabilities ? JSON.stringify(capabilities) : null);
    return id;
  }

  heartbeat(agentId: string): void {
    const stmt = this.db.prepare(`
      UPDATE agent_registry
      SET last_heartbeat = ?
      WHERE id = ?
    `);
    stmt.run(new Date().toISOString(), agentId);
  }

  updateStatus(agentId: string, status: AgentStatus, currentTask?: string): void {
    const stmt = this.db.prepare(`
      UPDATE agent_registry
      SET status = ?, current_task = ?, last_heartbeat = ?
      WHERE id = ?
    `);
    stmt.run(status, currentTask || null, new Date().toISOString(), agentId);
  }

  deregister(agentId: string): void {
    // Release all claims
    this.releaseAllClaims(agentId);

    // Update status
    const stmt = this.db.prepare(`
      UPDATE agent_registry
      SET status = 'completed'
      WHERE id = ?
    `);
    stmt.run(agentId);
  }

  getAgent(agentId: string): AgentRegistryEntry | null {
    const stmt = this.db.prepare(`
      SELECT id, name, session_id as sessionId, status, current_task as currentTask,
             worktree_branch as worktreeBranch, started_at as startedAt, 
             last_heartbeat as lastHeartbeat, capabilities
      FROM agent_registry
      WHERE id = ?
    `);
    const row = stmt.get(agentId) as Record<string, unknown> | undefined;
    if (!row) return null;

    return {
      ...row,
      capabilities: row.capabilities ? JSON.parse(row.capabilities as string) : undefined,
    } as AgentRegistryEntry;
  }

  getActiveAgents(): AgentRegistryEntry[] {
    const stmt = this.db.prepare(`
      SELECT id, name, session_id as sessionId, status, current_task as currentTask,
             worktree_branch as worktreeBranch, started_at as startedAt, 
             last_heartbeat as lastHeartbeat, capabilities
      FROM agent_registry
      WHERE status IN ('active', 'idle')
      ORDER BY started_at DESC
    `);
    const rows = stmt.all() as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      ...row,
      capabilities: row.capabilities ? JSON.parse(row.capabilities as string) : undefined,
    })) as AgentRegistryEntry[];
  }

  // Cleanup stale agents (no heartbeat for too long)
  cleanupStaleAgents(): number {
    const cutoff = new Date(Date.now() - this.heartbeatIntervalMs * 3).toISOString();
    return this.cleanupAgentsOlderThan(cutoff);
  }

  // Cleanup agents with heartbeat older than a specific duration in hours
  cleanupStaleAgentsByTime(hours: number = 24): number {
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
    return this.cleanupAgentsOlderThan(cutoff);
  }

  private cleanupAgentsOlderThan(cutoff: string): number {
    // Get stale agents
    const staleStmt = this.db.prepare(`
      SELECT id FROM agent_registry
      WHERE status IN ('active', 'idle') AND last_heartbeat < ?
    `);
    const staleAgents = staleStmt.all(cutoff) as Array<{ id: string }>;

    // Release their claims and complete their announcements
    for (const agent of staleAgents) {
      this.releaseAllClaims(agent.id);
      this.db.prepare(`
        UPDATE work_announcements SET completed_at = ?
        WHERE agent_id = ? AND completed_at IS NULL
      `).run(new Date().toISOString(), agent.id);
    }

    // Mark as failed
    const updateStmt = this.db.prepare(`
      UPDATE agent_registry
      SET status = 'failed'
      WHERE status IN ('active', 'idle') AND last_heartbeat < ?
    `);
    const result = updateStmt.run(cutoff);
    return result.changes;
  }

  // ==================== Work Claims ====================

  claimResource(agentId: string, resource: string, claimType: ClaimType = 'exclusive'): boolean {
    const now = new Date().toISOString();
    const expiresAt = new Date(Date.now() + this.claimExpiryMs).toISOString();

    // Check for existing exclusive claim
    const checkStmt = this.db.prepare(`
      SELECT agent_id, claim_type FROM work_claims
      WHERE resource = ? AND (expires_at IS NULL OR expires_at > ?)
    `);
    const existing = checkStmt.get(resource, now) as { agent_id: string; claim_type: string } | undefined;

    if (existing) {
      if (existing.claim_type === 'exclusive') {
        return false; // Resource already exclusively claimed
      }
      if (claimType === 'exclusive') {
        return false; // Can't get exclusive claim when shared claims exist
      }
    }

    try {
      const stmt = this.db.prepare(`
        INSERT INTO work_claims (resource, agent_id, claim_type, claimed_at, expires_at)
        VALUES (?, ?, ?, ?, ?)
      `);
      stmt.run(resource, agentId, claimType, now, expiresAt);
      return true;
    } catch {
      return false; // Constraint violation (duplicate exclusive claim)
    }
  }

  releaseResource(agentId: string, resource: string): void {
    const stmt = this.db.prepare(`
      DELETE FROM work_claims
      WHERE agent_id = ? AND resource = ?
    `);
    stmt.run(agentId, resource);
  }

  releaseAllClaims(agentId: string): void {
    const stmt = this.db.prepare(`
      DELETE FROM work_claims
      WHERE agent_id = ?
    `);
    stmt.run(agentId);
  }

  isResourceClaimed(resource: string): string | null {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      SELECT agent_id FROM work_claims
      WHERE resource = ? AND claim_type = 'exclusive'
        AND (expires_at IS NULL OR expires_at > ?)
    `);
    const row = stmt.get(resource, now) as { agent_id: string } | undefined;
    return row?.agent_id || null;
  }

  getResourceClaims(resource: string): WorkClaim[] {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      SELECT id, resource, agent_id as agentId, claim_type as claimType,
             claimed_at as claimedAt, expires_at as expiresAt
      FROM work_claims
      WHERE resource = ? AND (expires_at IS NULL OR expires_at > ?)
    `);
    return stmt.all(resource, now) as WorkClaim[];
  }

  getAgentClaims(agentId: string): WorkClaim[] {
    const stmt = this.db.prepare(`
      SELECT id, resource, agent_id as agentId, claim_type as claimType,
             claimed_at as claimedAt, expires_at as expiresAt
      FROM work_claims
      WHERE agent_id = ?
    `);
    return stmt.all(agentId) as WorkClaim[];
  }

  // ==================== Work Announcements (Collaborative) ====================
  // NOTE: Agents work in isolated git worktrees, so they don't NEED to claim resources.
  // Announcements are informational - they help optimize velocity and minimize merge conflicts.

  /**
   * Announce intent to work on a resource. Does NOT lock - just informs other agents.
   * Returns overlap info if other agents are also working on related resources.
   */
  announceWork(
    agentId: string,
    resource: string,
    intentType: WorkIntentType,
    options: {
      description?: string;
      filesAffected?: string[];
      estimatedMinutes?: number;
    } = {}
  ): { announcement: WorkAnnouncement; overlaps: WorkOverlap[]; suggestions: CollaborationSuggestion[] } {
    const agent = this.getAgent(agentId);
    const now = new Date().toISOString();
    const estimatedCompletion = options.estimatedMinutes
      ? new Date(Date.now() + options.estimatedMinutes * 60000).toISOString()
      : null;

    const stmt = this.db.prepare(`
      INSERT INTO work_announcements 
        (agent_id, agent_name, worktree_branch, intent_type, resource, description, files_affected, estimated_completion, announced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      agentId,
      agent?.name || null,
      agent?.worktreeBranch || null,
      intentType,
      resource,
      options.description || null,
      options.filesAffected ? JSON.stringify(options.filesAffected) : null,
      estimatedCompletion,
      now
    );

    const announcement: WorkAnnouncement = {
      id: result.lastInsertRowid as number,
      agentId,
      agentName: agent?.name,
      worktreeBranch: agent?.worktreeBranch,
      intentType,
      resource,
      description: options.description,
      filesAffected: options.filesAffected,
      estimatedCompletion: estimatedCompletion || undefined,
      announcedAt: now,
    };

    // Detect overlaps and generate suggestions
    const overlaps = this.detectOverlaps(resource, agentId);
    const suggestions = this.generateCollaborationSuggestions(agentId, resource, overlaps);

    // Broadcast to other agents about potential overlap
    if (overlaps.length > 0) {
      this.broadcast(agentId, 'coordination', {
        action: 'work_overlap_detected',
        resource,
        data: { overlaps, suggestions },
      });
    }

    return { announcement, overlaps, suggestions };
  }

  /**
   * Mark work as complete on a resource.
   */
  completeWork(agentId: string, resource: string): void {
    const stmt = this.db.prepare(`
      UPDATE work_announcements
      SET completed_at = ?
      WHERE agent_id = ? AND resource = ? AND completed_at IS NULL
    `);
    stmt.run(new Date().toISOString(), agentId, resource);

    // Broadcast completion so others know merge order
    this.broadcast(agentId, 'coordination', {
      action: 'work_completed',
      resource,
    });
  }

  /**
   * Get all active work announcements (not completed).
   */
  getActiveWork(): WorkAnnouncement[] {
    const stmt = this.db.prepare(`
      SELECT 
        wa.id, wa.agent_id as agentId, wa.agent_name as agentName,
        wa.worktree_branch as worktreeBranch, wa.intent_type as intentType,
        wa.resource, wa.description, wa.files_affected as filesAffected,
        wa.estimated_completion as estimatedCompletion, wa.announced_at as announcedAt
      FROM work_announcements wa
      JOIN agent_registry ar ON wa.agent_id = ar.id
      WHERE wa.completed_at IS NULL AND ar.status IN ('active', 'idle')
      ORDER BY wa.announced_at DESC
    `);
    const rows = stmt.all() as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      ...row,
      filesAffected: row.filesAffected ? JSON.parse(row.filesAffected as string) : undefined,
    })) as WorkAnnouncement[];
  }

  /**
   * Get work announcements for a specific resource.
   */
  getWorkOnResource(resource: string): WorkAnnouncement[] {
    const stmt = this.db.prepare(`
      SELECT 
        wa.id, wa.agent_id as agentId, wa.agent_name as agentName,
        wa.worktree_branch as worktreeBranch, wa.intent_type as intentType,
        wa.resource, wa.description, wa.files_affected as filesAffected,
        wa.estimated_completion as estimatedCompletion, wa.announced_at as announcedAt
      FROM work_announcements wa
      JOIN agent_registry ar ON wa.agent_id = ar.id
      WHERE wa.resource LIKE ? AND wa.completed_at IS NULL AND ar.status IN ('active', 'idle')
      ORDER BY wa.announced_at DESC
    `);
    const rows = stmt.all(`%${resource}%`) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      ...row,
      filesAffected: row.filesAffected ? JSON.parse(row.filesAffected as string) : undefined,
    })) as WorkAnnouncement[];
  }

  /**
   * Detect overlapping work that might cause merge conflicts.
   */
  detectOverlaps(resource: string, excludeAgentId?: string): WorkOverlap[] {
    const activeWork = this.getActiveWork();
    const overlaps: WorkOverlap[] = [];

    // Group by resource pattern (file, directory, or module)
    const resourceParts = resource.split('/');
    const directory = resourceParts.slice(0, -1).join('/');

    // Find work on same file
    const sameFile = activeWork.filter(
      (w) => w.agentId !== excludeAgentId && w.resource === resource
    );

    // Find work on same directory
    const sameDirectory = activeWork.filter(
      (w) =>
        w.agentId !== excludeAgentId &&
        w.resource !== resource &&
        w.resource.startsWith(directory + '/')
    );

    // Find work with overlapping files
    const overlappingFiles = activeWork.filter((w) => {
      if (w.agentId === excludeAgentId) return false;
      if (!w.filesAffected) return false;
      return w.filesAffected.some((f) => f === resource || resource.includes(f) || f.includes(resource));
    });

    if (sameFile.length > 0) {
      overlaps.push({
        resource,
        agents: sameFile.map((w) => ({
          id: w.agentId,
          name: w.agentName || 'unknown',
          intentType: w.intentType,
          worktreeBranch: w.worktreeBranch,
          description: w.description,
        })),
        conflictRisk: this.assessConflictRisk(sameFile),
        suggestion: this.generateOverlapSuggestion(sameFile, 'same_file'),
      });
    }

    if (sameDirectory.length > 0) {
      overlaps.push({
        resource: directory,
        agents: sameDirectory.map((w) => ({
          id: w.agentId,
          name: w.agentName || 'unknown',
          intentType: w.intentType,
          worktreeBranch: w.worktreeBranch,
          description: w.description,
        })),
        conflictRisk: this.assessConflictRisk(sameDirectory, 'directory'),
        suggestion: this.generateOverlapSuggestion(sameDirectory, 'same_directory'),
      });
    }

    if (overlappingFiles.length > 0) {
      overlaps.push({
        resource: 'files_overlap',
        agents: overlappingFiles.map((w) => ({
          id: w.agentId,
          name: w.agentName || 'unknown',
          intentType: w.intentType,
          worktreeBranch: w.worktreeBranch,
          description: w.description,
        })),
        conflictRisk: 'medium',
        suggestion: this.generateOverlapSuggestion(overlappingFiles, 'files_overlap'),
      });
    }

    return overlaps;
  }

  private assessConflictRisk(work: WorkAnnouncement[], type: string = 'file'): ConflictRisk {
    if (work.length === 0) return 'none';

    // Multiple agents editing same file = high risk
    const editors = work.filter((w) => w.intentType === 'editing' || w.intentType === 'refactoring');
    if (editors.length >= 2) return 'critical';
    if (editors.length === 1 && work.length > 1) return 'high';

    // Refactoring has higher conflict potential
    if (work.some((w) => w.intentType === 'refactoring')) return 'high';

    // Directory-level work is lower risk
    if (type === 'directory') return 'medium';

    // Review/test/document are low risk
    const lowRiskTypes: WorkIntentType[] = ['reviewing', 'testing', 'documenting'];
    if (work.every((w) => lowRiskTypes.includes(w.intentType))) return 'low';

    return 'medium';
  }

  private generateOverlapSuggestion(work: WorkAnnouncement[], type: string): string {
    const agentNames = work.map((w) => w.agentName || w.agentId.slice(0, 8)).join(', ');

    switch (type) {
      case 'same_file':
        return `Multiple agents (${agentNames}) working on same file. Consider: ` +
          `1) Coordinate merge order - who finishes first should merge first, ` +
          `2) Split into non-overlapping sections, ` +
          `3) One agent waits for other to complete.`;

      case 'same_directory':
        return `Agents (${agentNames}) working in same directory. Usually safe with worktrees, ` +
          `but watch for: import changes, shared types/interfaces, barrel files (index.ts).`;

      case 'files_overlap':
        return `Agents (${agentNames}) have overlapping file changes. Review affected files ` +
          `and coordinate merge order to minimize conflicts.`;

      default:
        return `Overlap detected with ${agentNames}. Coordinate to optimize velocity.`;
    }
  }

  /**
   * Generate collaboration suggestions based on overlaps.
   */
  generateCollaborationSuggestions(
    agentId: string,
    _resource: string,
    overlaps: WorkOverlap[]
  ): CollaborationSuggestion[] {
    const suggestions: CollaborationSuggestion[] = [];

    for (const overlap of overlaps) {
      const allAgents = [agentId, ...overlap.agents.map((a) => a.id)];

      // Critical/High risk: suggest sequential work
      if (overlap.conflictRisk === 'critical' || overlap.conflictRisk === 'high') {
        suggestions.push({
          type: 'sequence',
          agents: allAgents,
          reason: `High merge conflict risk on ${overlap.resource}. Sequential work recommended.`,
          suggestedOrder: this.suggestMergeOrder(overlap),
          estimatedMergeComplexity: overlap.conflictRisk,
        });
      }

      // Medium risk: suggest merge order
      if (overlap.conflictRisk === 'medium') {
        suggestions.push({
          type: 'merge_order',
          agents: allAgents,
          reason: `Medium conflict risk. Agree on merge order to avoid rebase pain.`,
          suggestedOrder: this.suggestMergeOrder(overlap),
          estimatedMergeComplexity: 'medium',
        });
      }

      // Low risk: parallel is fine
      if (overlap.conflictRisk === 'low') {
        suggestions.push({
          type: 'parallel',
          agents: allAgents,
          reason: `Low conflict risk. Parallel work is safe. Watch for shared imports.`,
          estimatedMergeComplexity: 'low',
        });
      }
    }

    return suggestions;
  }

  private suggestMergeOrder(overlap: WorkOverlap): string[] {
    // Prefer: review/test first, then docs, then edits, then refactoring
    const priorityOrder: WorkIntentType[] = ['reviewing', 'testing', 'documenting', 'editing', 'refactoring'];

    return overlap.agents
      .sort((a, b) => {
        const aPriority = priorityOrder.indexOf(a.intentType);
        const bPriority = priorityOrder.indexOf(b.intentType);
        return aPriority - bPriority;
      })
      .map((a) => a.name || a.id);
  }

  // ==================== Messaging ====================

  broadcast(fromAgent: string, channel: MessageChannel, payload: MessagePayload, priority = 5): void {
    this.sendMessage(fromAgent, undefined, channel, 'notification', payload, priority);
  }

  send(fromAgent: string, toAgent: string, payload: MessagePayload, priority = 5): void {
    this.sendMessage(fromAgent, toAgent, 'direct', 'request', payload, priority);
  }

  private sendMessage(
    fromAgent: string | undefined,
    toAgent: string | undefined,
    channel: MessageChannel,
    type: MessageType,
    payload: MessagePayload,
    priority: number
  ): void {
    const stmt = this.db.prepare(`
      INSERT INTO agent_messages (channel, from_agent, to_agent, type, payload, priority, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(channel, fromAgent, toAgent, type, JSON.stringify(payload), priority, new Date().toISOString());
  }

  receive(agentId: string, channel?: MessageChannel, markAsRead = true): AgentMessage[] {
    let sql = `
      SELECT id, channel, from_agent as fromAgent, to_agent as toAgent, type,
             payload, priority, created_at as createdAt, read_at as readAt, expires_at as expiresAt
      FROM agent_messages
      WHERE (to_agent = ? OR (to_agent IS NULL AND channel != 'direct'))
        AND read_at IS NULL
        AND (expires_at IS NULL OR expires_at > ?)
    `;
    const params: unknown[] = [agentId, new Date().toISOString()];

    if (channel) {
      sql += ' AND channel = ?';
      params.push(channel);
    }

    sql += ' ORDER BY priority DESC, created_at ASC';

    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params) as Array<Record<string, unknown>>;

    const messages = rows.map((row) => ({
      ...row,
      payload: JSON.parse(row.payload as string),
    })) as AgentMessage[];

    if (markAsRead && messages.length > 0) {
      const ids = messages.map((m) => m.id);
      const updateStmt = this.db.prepare(`
        UPDATE agent_messages
        SET read_at = ?
        WHERE id IN (${ids.map(() => '?').join(',')})
      `);
      updateStmt.run(new Date().toISOString(), ...ids);
    }

    return messages;
  }

  getPendingMessages(agentId: string): number {
    const stmt = this.db.prepare(`
      SELECT COUNT(*) as count
      FROM agent_messages
      WHERE (to_agent = ? OR (to_agent IS NULL AND channel != 'direct'))
        AND read_at IS NULL
        AND (expires_at IS NULL OR expires_at > ?)
    `);
    const row = stmt.get(agentId, new Date().toISOString()) as { count: number };
    return row.count;
  }

  // ==================== Deploy Queue ====================

  queueDeploy(
    agentId: string,
    actionType: DeployActionType,
    target: string,
    payload?: Record<string, unknown>,
    options: { priority?: number; executeAfter?: Date; dependencies?: string[] } = {}
  ): number {
    const now = new Date().toISOString();
    const executeAfter = options.executeAfter?.toISOString() || 
      new Date(Date.now() + 30000).toISOString(); // Default 30s delay for batching

    const stmt = this.db.prepare(`
      INSERT INTO deploy_queue (agent_id, action_type, target, payload, status, queued_at, execute_after, priority, dependencies)
      VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)
    `);

    const result = stmt.run(
      agentId,
      actionType,
      target,
      payload ? JSON.stringify(payload) : null,
      now,
      executeAfter,
      options.priority || 5,
      options.dependencies ? JSON.stringify(options.dependencies) : null
    );

    return result.lastInsertRowid as number;
  }

  getPendingDeploys(): DeployAction[] {
    const stmt = this.db.prepare(`
      SELECT id, agent_id as agentId, action_type as actionType, target, payload,
             status, batch_id as batchId, queued_at as queuedAt, 
             execute_after as executeAfter, priority, dependencies
      FROM deploy_queue
      WHERE status = 'pending'
      ORDER BY priority DESC, queued_at ASC
    `);
    const rows = stmt.all() as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      ...row,
      payload: row.payload ? JSON.parse(row.payload as string) : undefined,
      dependencies: row.dependencies ? JSON.parse(row.dependencies as string) : undefined,
    })) as DeployAction[];
  }

  getReadyDeploys(): DeployAction[] {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      SELECT id, agent_id as agentId, action_type as actionType, target, payload,
             status, batch_id as batchId, queued_at as queuedAt, 
             execute_after as executeAfter, priority, dependencies
      FROM deploy_queue
      WHERE status = 'pending' AND execute_after <= ?
      ORDER BY priority DESC, queued_at ASC
    `);
    const rows = stmt.all(now) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      ...row,
      payload: row.payload ? JSON.parse(row.payload as string) : undefined,
      dependencies: row.dependencies ? JSON.parse(row.dependencies as string) : undefined,
    })) as DeployAction[];
  }

  updateDeployStatus(deployId: number, status: DeployStatus, batchId?: string): void {
    const stmt = this.db.prepare(`
      UPDATE deploy_queue
      SET status = ?, batch_id = ?
      WHERE id = ?
    `);
    stmt.run(status, batchId || null, deployId);
  }

  // ==================== Status ====================

  getStatus(): CoordinationStatus {
    const activeAgents = this.getActiveAgents();
    
    const claimsStmt = this.db.prepare(`
      SELECT id, resource, agent_id as agentId, claim_type as claimType,
             claimed_at as claimedAt, expires_at as expiresAt
      FROM work_claims
      WHERE expires_at IS NULL OR expires_at > ?
    `);
    const activeClaims = claimsStmt.all(new Date().toISOString()) as WorkClaim[];

    const pendingDeploys = this.getPendingDeploys();

    // Count pending messages (broadcast + unclaimed)
    const msgStmt = this.db.prepare(`
      SELECT COUNT(*) as count
      FROM agent_messages
      WHERE read_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
    `);
    const msgRow = msgStmt.get(new Date().toISOString()) as { count: number };

    return {
      activeAgents,
      activeClaims,
      pendingDeploys,
      pendingMessages: msgRow.count,
    };
  }

  // ==================== Cleanup ====================

  cleanup(): void {
    const cutoff = new Date(Date.now() - 86400000).toISOString(); // 24 hours ago

    // Clean old messages
    this.db.prepare(`DELETE FROM agent_messages WHERE created_at < ?`).run(cutoff);

    // Clean expired claims
    this.db.prepare(`DELETE FROM work_claims WHERE expires_at < ?`).run(new Date().toISOString());

    // Clean old completed agents
    this.db.prepare(`
      DELETE FROM agent_registry
      WHERE status IN ('completed', 'failed') AND started_at < ?
    `).run(cutoff);

    // Clean old completed deploys
    this.db.prepare(`
      DELETE FROM deploy_queue
      WHERE status IN ('completed', 'failed') AND queued_at < ?
    `).run(cutoff);
  }
}
