import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CoordinationService } from '../src/coordination/service.js';
import { CoordinationDatabase } from '../src/coordination/database.js';
import { existsSync, unlinkSync, mkdirSync } from 'fs';
import { join } from 'path';

const TEST_DB_DIR = '.uap-test-coord';
const TEST_DB_PATH = join(TEST_DB_DIR, 'coordination.db');

describe('CoordinationService', () => {
  let service: CoordinationService;

  beforeEach(() => {
    // Clean up any previous test DB
    CoordinationDatabase.resetInstance();
    if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);
    if (existsSync(TEST_DB_PATH + '-wal')) unlinkSync(TEST_DB_PATH + '-wal');
    if (existsSync(TEST_DB_PATH + '-shm')) unlinkSync(TEST_DB_PATH + '-shm');
    if (!existsSync(TEST_DB_DIR)) mkdirSync(TEST_DB_DIR, { recursive: true });

    service = new CoordinationService({
      dbPath: TEST_DB_PATH,
      heartbeatIntervalMs: 1000,
      claimExpiryMs: 60000,
    });
  });

  afterEach(() => {
    CoordinationDatabase.resetInstance();
    if (existsSync(TEST_DB_PATH)) unlinkSync(TEST_DB_PATH);
    if (existsSync(TEST_DB_PATH + '-wal')) unlinkSync(TEST_DB_PATH + '-wal');
    if (existsSync(TEST_DB_PATH + '-shm')) unlinkSync(TEST_DB_PATH + '-shm');
  });

  describe('Agent Lifecycle', () => {
    it('should register an agent and return an ID', () => {
      const id = service.register('test-agent', ['coding', 'review']);
      expect(id).toBeTruthy();
      expect(typeof id).toBe('string');
    });

    it('should retrieve a registered agent', () => {
      const id = service.register('test-agent', ['coding']);
      const agent = service.getAgent(id);
      expect(agent).not.toBeNull();
      expect(agent!.name).toBe('test-agent');
      expect(agent!.status).toBe('active');
      expect(agent!.capabilities).toEqual(['coding']);
    });

    it('should list active agents', () => {
      service.register('agent-1');
      service.register('agent-2');
      const agents = service.getActiveAgents();
      expect(agents.length).toBe(2);
    });

    it('should update agent status', () => {
      const id = service.register('test-agent');
      service.updateStatus(id, 'idle', 'waiting for work');
      const agent = service.getAgent(id);
      expect(agent!.status).toBe('idle');
      expect(agent!.currentTask).toBe('waiting for work');
    });

    it('should deregister an agent', () => {
      const id = service.register('test-agent');
      service.deregister(id);
      const agent = service.getAgent(id);
      expect(agent!.status).toBe('completed');
    });

    it('should update heartbeat', () => {
      const id = service.register('test-agent');
      const before = service.getAgent(id)!.lastHeartbeat;
      // Small delay to ensure timestamp changes
      service.heartbeat(id);
      const after = service.getAgent(id)!.lastHeartbeat;
      expect(after).toBeTruthy();
      // Heartbeat should be >= before
      expect(new Date(after).getTime()).toBeGreaterThanOrEqual(new Date(before).getTime());
    });
  });

  describe('Work Claims', () => {
    it('should claim a resource exclusively', () => {
      const agentId = service.register('agent-1');
      const claimed = service.claimResource(agentId, 'src/main.ts', 'exclusive');
      expect(claimed).toBe(true);
    });

    it('should prevent double exclusive claims', () => {
      const agent1 = service.register('agent-1');
      const agent2 = service.register('agent-2');
      service.claimResource(agent1, 'src/main.ts', 'exclusive');
      const claimed = service.claimResource(agent2, 'src/main.ts', 'exclusive');
      expect(claimed).toBe(false);
    });

    it('should allow shared claims from multiple agents', () => {
      const agent1 = service.register('agent-1');
      const agent2 = service.register('agent-2');
      expect(service.claimResource(agent1, 'src/main.ts', 'shared')).toBe(true);
      expect(service.claimResource(agent2, 'src/main.ts', 'shared')).toBe(true);
    });

    it('should prevent exclusive claim when shared claims exist', () => {
      const agent1 = service.register('agent-1');
      const agent2 = service.register('agent-2');
      service.claimResource(agent1, 'src/main.ts', 'shared');
      const claimed = service.claimResource(agent2, 'src/main.ts', 'exclusive');
      expect(claimed).toBe(false);
    });

    it('should release a resource', () => {
      const agentId = service.register('agent-1');
      service.claimResource(agentId, 'src/main.ts', 'exclusive');
      service.releaseResource(agentId, 'src/main.ts');
      const claimedBy = service.isResourceClaimed('src/main.ts');
      expect(claimedBy).toBeNull();
    });

    it('should release all claims on deregister', () => {
      const agentId = service.register('agent-1');
      service.claimResource(agentId, 'src/a.ts', 'exclusive');
      service.claimResource(agentId, 'src/b.ts', 'exclusive');
      service.deregister(agentId);
      expect(service.isResourceClaimed('src/a.ts')).toBeNull();
      expect(service.isResourceClaimed('src/b.ts')).toBeNull();
    });

    it('should check if resource is claimed', () => {
      const agentId = service.register('agent-1');
      service.claimResource(agentId, 'src/main.ts', 'exclusive');
      expect(service.isResourceClaimed('src/main.ts')).toBe(agentId);
      expect(service.isResourceClaimed('src/other.ts')).toBeNull();
    });

    it('should get claims for a resource', () => {
      const agent1 = service.register('agent-1');
      const agent2 = service.register('agent-2');
      service.claimResource(agent1, 'src/main.ts', 'shared');
      service.claimResource(agent2, 'src/main.ts', 'shared');
      const claims = service.getResourceClaims('src/main.ts');
      expect(claims.length).toBe(2);
    });

    it('should get claims for an agent', () => {
      const agentId = service.register('agent-1');
      service.claimResource(agentId, 'src/a.ts', 'exclusive');
      service.claimResource(agentId, 'src/b.ts', 'shared');
      const claims = service.getAgentClaims(agentId);
      expect(claims.length).toBe(2);
    });
  });

  describe('Work Announcements', () => {
    it('should announce work and return announcement', () => {
      const agentId = service.register('agent-1', [], 'feature/test');
      const result = service.announceWork(agentId, 'src/main.ts', 'editing', {
        description: 'Refactoring main module',
        filesAffected: ['src/main.ts', 'src/utils.ts'],
        estimatedMinutes: 30,
      });
      expect(result.announcement).toBeTruthy();
      expect(result.announcement.resource).toBe('src/main.ts');
      expect(result.announcement.intentType).toBe('editing');
    });

    it('should detect overlaps between agents', () => {
      const agent1 = service.register('agent-1', [], 'feature/a');
      const agent2 = service.register('agent-2', [], 'feature/b');

      service.announceWork(agent1, 'src/main.ts', 'editing', {
        filesAffected: ['src/main.ts'],
      });

      const result = service.announceWork(agent2, 'src/main.ts', 'refactoring', {
        filesAffected: ['src/main.ts'],
      });

      expect(result.overlaps.length).toBeGreaterThan(0);
    });

    it('should auto-register unknown agent IDs when announcing work', () => {
      const unknownAgentId = 'claude-1f37071d1559';

      const result = service.announceWork(unknownAgentId, 'src/cli/agent.ts', 'editing', {
        description: 'Fix announcement flow',
      });

      const agent = service.getAgent(unknownAgentId);
      expect(agent).not.toBeNull();
      expect(agent!.name).toBe(unknownAgentId);
      expect(agent!.status).toBe('active');
      expect(result.announcement.agentName).toBe(unknownAgentId);
    });

    it('should reactivate completed agents when they announce work again', () => {
      const agentId = service.register('agent-1');
      service.deregister(agentId);
      expect(service.getAgent(agentId)?.status).toBe('completed');

      service.announceWork(agentId, 'src/main.ts', 'testing');

      const reactivated = service.getAgent(agentId);
      expect(reactivated).not.toBeNull();
      expect(reactivated!.status).toBe('active');
      const activeWork = service.getActiveWork().filter((work) => work.agentId === agentId);
      expect(activeWork.length).toBe(1);
    });
  });

  describe('Messaging', () => {
    it('should send and receive direct messages', () => {
      const agent1 = service.register('agent-1');
      const agent2 = service.register('agent-2');

      service.send(agent1, agent2, { action: 'notify', data: 'Hello from agent-1' });

      const messages = service.receive(agent2);
      expect(messages.length).toBe(1);
    });

    it('should broadcast messages to a channel', () => {
      const agent1 = service.register('agent-1');
      const agent2 = service.register('agent-2');

      service.broadcast(agent1, 'broadcast', { action: 'announce', data: 'Broadcast message' });

      const messages = service.receive(agent2, 'broadcast');
      expect(messages.length).toBe(1);
    });
  });

  describe('Status', () => {
    it('should return coordination status', () => {
      service.register('agent-1');
      service.register('agent-2');
      const status = service.getStatus();
      expect(status.activeAgents.length).toBe(2);
      expect(status.activeClaims).toBeDefined();
      expect(status.pendingMessages).toBeDefined();
    });
  });
});
