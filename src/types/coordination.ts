import { z } from 'zod';

// Agent status enum
export type AgentStatus = 'active' | 'idle' | 'completed' | 'failed';

// Message types for inter-agent communication
export type MessageType = 'request' | 'response' | 'notification' | 'claim' | 'release';

// Communication channels
export type MessageChannel = 'broadcast' | 'deploy' | 'review' | 'direct' | 'coordination' | 'board';

// Collaboration board: a public, re-readable feed all agents post to and read.
// Modeled on the open multi-agent challenge boards where the *communication
// substrate* (public posts, shared negative knowledge, peer flags) drives
// collective performance. Private side-channels are discouraged by norm.
export type BoardKind =
  | 'note' // general update / status
  | 'finding' // a confirmed result or insight worth sharing
  | 'dead-end' // a tried-and-failed approach so peers don't repeat it
  | 'flag' // an integrity/verification concern raised for peer/human ruling
  | 'handoff' // an artifact staged for any capable agent to pick up
  | 'norm'; // an agreed working convention

export interface BoardPost {
  id: number;
  fromAgent?: string;
  kind: BoardKind;
  text: string;
  createdAt: string;
}

// Challenge: an open shared goal with verified, significance-gated submissions.
export interface Challenge {
  id: number;
  goal: string;
  metric?: string;
  higherIsBetter: boolean;
  ropeMargin: number;
  status: 'open' | 'closed';
  createdAt: string;
  updatedAt: string;
}

export interface Submission {
  id: number;
  challengeId: number;
  agentId?: string;
  score: number;
  artifact?: string;
  note?: string;
  verified: boolean;
  createdAt: string;
}

export interface LeaderboardEntry {
  rank: number;
  submission: Submission;
  /** Within the ROPE margin of the leader — a statistical tie for #1, not a win. */
  tiedForLead: boolean;
}

// Staged work: an artifact + acceptance spec offered for any capable agent.
export type StagedStatus = 'staged' | 'claimed' | 'completed' | 'abandoned';

export interface StagedWork {
  id: number;
  originator: string;
  title: string;
  artifact?: string;
  /** How a picker verifies the work is done (the acceptance spec). */
  acceptance?: string;
  /** Capability/resource the picker needs, e.g. "gpu", "quota", "deploy". */
  needs?: string;
  status: StagedStatus;
  claimant?: string;
  result?: string;
  createdAt: string;
  updatedAt: string;
}

// Findings ledger: a tracked claim with mutable status + lineage.
export type FindingStatus = 'proposed' | 'confirmed' | 'reversed' | 'disputed';

export interface Finding {
  id: number;
  agentId?: string;
  claim: string;
  status: FindingStatus;
  evidence?: string;
  /** id of an earlier finding this one supersedes/reverses (lineage). */
  supersedes?: number;
  /** ruling text when confirmed/reversed/resolved. */
  resolution?: string;
  createdAt: string;
  updatedAt: string;
}

// Work intent types (informational, not locking)
export type WorkIntentType = 'editing' | 'reviewing' | 'refactoring' | 'testing' | 'documenting';

// Merge conflict risk levels
export type ConflictRisk = 'none' | 'low' | 'medium' | 'high' | 'critical';

// Deploy action types
export type DeployActionType = 'commit' | 'push' | 'merge' | 'deploy' | 'workflow';

// Deploy status
export type DeployStatus = 'pending' | 'batched' | 'executing' | 'completed' | 'failed';

// Agent registry entry
export interface AgentRegistryEntry {
  id: string;
  name: string;
  sessionId: string;
  status: AgentStatus;
  currentTask?: string;
  worktreeBranch?: string;
  startedAt: string;
  lastHeartbeat: string;
  capabilities?: string[];
}

// Message payload
export interface MessagePayload {
  action: string;
  resource?: string;
  data?: unknown;
}

// Agent message
export interface AgentMessage {
  id: number;
  channel: MessageChannel;
  fromAgent?: string;
  toAgent?: string;
  type: MessageType;
  payload: MessagePayload;
  priority: number;
  createdAt: string;
  readAt?: string;
  expiresAt?: string;
}

// Work announcement (replaces claim - informational only)
export interface WorkAnnouncement {
  id: number;
  agentId: string;
  agentName?: string;
  worktreeBranch?: string;
  intentType: WorkIntentType;
  resource: string;
  description?: string;
  filesAffected?: string[];
  estimatedCompletion?: string;
  announcedAt: string;
  completedAt?: string;
}

// Overlap detection result
export interface WorkOverlap {
  resource: string;
  agents: Array<{
    id: string;
    name: string;
    intentType: WorkIntentType;
    worktreeBranch?: string;
    description?: string;
  }>;
  conflictRisk: ConflictRisk;
  suggestion: string;
}

// Collaboration suggestion
export interface CollaborationSuggestion {
  type: 'sequence' | 'parallel' | 'handoff' | 'merge_order';
  agents: string[];
  reason: string;
  suggestedOrder?: string[];
  estimatedMergeComplexity?: ConflictRisk;
}

// Legacy alias for backward compatibility
export type ClaimType = 'exclusive' | 'shared';
export interface WorkClaim extends WorkAnnouncement {
  claimType?: ClaimType;
  claimedAt: string;
  expiresAt?: string;
}

// Deploy action
export interface DeployAction {
  id: number;
  agentId: string;
  actionType: DeployActionType;
  target: string;
  payload?: Record<string, unknown>;
  status: DeployStatus;
  batchId?: string;
  queuedAt: string;
  executeAfter?: string;
  priority: number;
  dependencies?: string[];
}

// Batch of deploy actions
export interface DeployBatch {
  id: string;
  actions: DeployAction[];
  createdAt: string;
  status: DeployStatus;
}

// Batch execution result
export interface BatchResult {
  batchId: string;
  success: boolean;
  executedActions: number;
  failedActions: number;
  errors?: string[];
  duration: number;
}

// Coordination status
export interface CoordinationStatus {
  activeAgents: AgentRegistryEntry[];
  activeClaims: WorkClaim[];
  pendingDeploys: DeployAction[];
  pendingMessages: number;
}

// Zod schemas for validation
export const AgentRegistryEntrySchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  sessionId: z.string(),
  status: z.enum(['active', 'idle', 'completed', 'failed']),
  currentTask: z.string().optional(),
  startedAt: z.string(),
  lastHeartbeat: z.string(),
  capabilities: z.array(z.string()).optional(),
});

export const MessagePayloadSchema = z.object({
  action: z.string(),
  resource: z.string().optional(),
  data: z.unknown().optional(),
});

export const AgentMessageSchema = z.object({
  id: z.number(),
  channel: z.enum(['broadcast', 'deploy', 'review', 'direct', 'coordination']),
  fromAgent: z.string().optional(),
  toAgent: z.string().optional(),
  type: z.enum(['request', 'response', 'notification', 'claim', 'release']),
  payload: MessagePayloadSchema,
  priority: z.number().default(5),
  createdAt: z.string(),
  readAt: z.string().optional(),
  expiresAt: z.string().optional(),
});

export const DeployActionSchema = z.object({
  id: z.number(),
  agentId: z.string(),
  actionType: z.enum(['commit', 'push', 'merge', 'deploy', 'workflow']),
  target: z.string(),
  payload: z.record(z.any(), z.any()).optional(),
  status: z.enum(['pending', 'batched', 'executing', 'completed', 'failed']),
  batchId: z.string().optional(),
  queuedAt: z.string(),
  executeAfter: z.string().optional(),
  priority: z.number().default(5),
  dependencies: z.array(z.string()).optional(),
});
