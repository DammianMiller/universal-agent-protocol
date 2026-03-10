import { z } from 'zod';

// Agent status enum
export type AgentStatus = 'active' | 'idle' | 'completed' | 'failed';

// Message types for inter-agent communication
export type MessageType = 'request' | 'response' | 'notification' | 'claim' | 'release';

// Communication channels
export type MessageChannel = 'broadcast' | 'deploy' | 'review' | 'direct' | 'coordination';

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
  payload: z.record(z.unknown()).optional(),
  status: z.enum(['pending', 'batched', 'executing', 'completed', 'failed']),
  batchId: z.string().optional(),
  queuedAt: z.string(),
  executeAfter: z.string().optional(),
  priority: z.number().default(5),
  dependencies: z.array(z.string()).optional(),
});
