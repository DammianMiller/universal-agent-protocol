/**
 * Tests for CoordinationDatabase
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CoordinationDatabase } from '../src/coordination/database.js';

describe('CoordinationDatabase', () => {
  let db: CoordinationDatabase;
  const testDbPath = ':memory:';

  beforeEach(() => {
    CoordinationDatabase.resetInstance();
    db = CoordinationDatabase.getInstance(testDbPath);
  });

  afterEach(() => {
    db.close();
    CoordinationDatabase.resetInstance();
  });

  describe('Singleton Pattern', () => {
    it('should return same instance on multiple calls', () => {
      const instance1 = CoordinationDatabase.getInstance(testDbPath);
      const instance2 = CoordinationDatabase.getInstance(testDbPath);

      expect(instance1).toBe(instance2);
    });

    it('should allow resetting singleton instance', () => {
      const instance1 = CoordinationDatabase.getInstance(testDbPath);
      CoordinationDatabase.resetInstance();

      const instance2 = CoordinationDatabase.getInstance(testDbPath);
      expect(instance1).not.toBe(instance2);
    });
  });

  describe('Database Schema', () => {
    it('should create agent_registry table', () => {
      const database = db.getDatabase();
      const tables = database
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_registry'")
        .all();

      expect(tables.length).toBe(1);
    });

    it('should create agent_messages table', () => {
      const database = db.getDatabase();
      const tables = database
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_messages'")
        .all();

      expect(tables.length).toBe(1);
    });

    it('should create work_announcements table', () => {
      const database = db.getDatabase();
      const tables = database
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='work_announcements'")
        .all();

      expect(tables.length).toBe(1);
    });
  });

  describe('Agent Registry', () => {
    it('should register an agent', () => {
      const database = db.getDatabase();
      const stmt = database.prepare(
        'INSERT INTO agent_registry (id, name, session_id, status, current_task, worktree_branch, started_at, last_heartbeat, capabilities) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      );

      const now = Date.now().toString();
      stmt.run(
        'agent-1',
        'Test Agent',
        'session-1',
        'active',
        null,
        null,
        now,
        now,
        JSON.stringify(['code-generation'])
      );

      const agent = database.prepare('SELECT * FROM agent_registry WHERE id = ?').get('agent-1');
      expect(agent).toBeDefined();
      expect((agent as any).name).toBe('Test Agent');
    });

    it('should update agent status', () => {
      const database = db.getDatabase();
      const now = Date.now().toString();

      // Insert initial agent
      database
        .prepare(
          'INSERT INTO agent_registry (id, name, session_id, status, current_task, worktree_branch, started_at, last_heartbeat) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        )
        .run('agent-1', 'Test Agent', 'session-1', 'active', null, null, now, now);

      // Update status
      database
        .prepare('UPDATE agent_registry SET status = ?, last_heartbeat = ? WHERE id = ?')
        .run('completed', Date.now().toString(), 'agent-1');

      const agent = database.prepare('SELECT * FROM agent_registry WHERE id = ?').get('agent-1');
      expect((agent as any).status).toBe('completed');
    });

    it('should list agents by status', () => {
      const database = db.getDatabase();
      const now = Date.now().toString();

      database
        .prepare(
          'INSERT INTO agent_registry (id, name, session_id, status, started_at, last_heartbeat) VALUES (?, ?, ?, ?, ?, ?)'
        )
        .run('agent-1', 'Active Agent', 'session-1', 'active', now, now);

      database
        .prepare(
          'INSERT INTO agent_registry (id, name, session_id, status, started_at, last_heartbeat) VALUES (?, ?, ?, ?, ?, ?)'
        )
        .run('agent-2', 'Completed Agent', 'session-2', 'completed', now, now);

      const activeAgents = database
        .prepare('SELECT * FROM agent_registry WHERE status = ?')
        .all('active');
      expect(activeAgents.length).toBe(1);
      expect((activeAgents[0] as any).name).toBe('Active Agent');
    });
  });

  describe('Agent Messages', () => {
    it('should post a message', () => {
      const database = db.getDatabase();
      const stmt = database.prepare(
        'INSERT INTO agent_messages (channel, from_agent, to_agent, type, payload, priority, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      );

      const now = Date.now().toString();
      stmt.run(
        'general',
        'agent-1',
        'agent-2',
        'request',
        JSON.stringify({ action: 'test' }),
        5,
        now
      );

      const messages = database
        .prepare('SELECT * FROM agent_messages WHERE channel = ?')
        .all('general');
      expect(messages.length).toBe(1);
    });

    it('should mark messages as read', () => {
      const database = db.getDatabase();
      const now = Date.now().toString();

      // Insert unread message
      database
        .prepare(
          'INSERT INTO agent_messages (channel, to_agent, type, payload, created_at) VALUES (?, ?, ?, ?, ?)'
        )
        .run('general', 'agent-1', 'notification', '{}', now);

      // Mark as read
      database
        .prepare(
          'UPDATE agent_messages SET read_at = ? WHERE channel = ? AND to_agent = ? AND read_at IS NULL'
        )
        .run(Date.now().toString(), 'general', 'agent-1');

      const messages = database
        .prepare('SELECT * FROM agent_messages WHERE channel = ? AND to_agent = ?')
        .all('general', 'agent-1');
      expect(messages.length).toBe(1);
      expect((messages[0] as any).read_at).toBeDefined();
    });
  });

  describe('Work Announcements', () => {
    beforeEach(() => {
      const database = db.getDatabase();
      const now = Date.now().toString();

      // Register test agents to satisfy foreign key constraints
      database
        .prepare(
          'INSERT INTO agent_registry (id, name, session_id, status, started_at, last_heartbeat) VALUES (?, ?, ?, ?, ?, ?)'
        )
        .run('agent-1', 'Test Agent 1', 'session-1', 'active', now, now);

      database
        .prepare(
          'INSERT INTO agent_registry (id, name, session_id, status, started_at, last_heartbeat) VALUES (?, ?, ?, ?, ?, ?)'
        )
        .run('agent-2', 'Test Agent 2', 'session-2', 'active', now, now);
    });

    it('should create a work announcement', () => {
      const database = db.getDatabase();
      const stmt = database.prepare(
        'INSERT INTO work_announcements (agent_id, agent_name, worktree_branch, intent_type, resource, description, files_affected, announced_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      );

      const now = Date.now().toString();
      stmt.run(
        'agent-1',
        'Test Agent',
        'main',
        'editing',
        'src/main.ts',
        'Updating main file',
        JSON.stringify(['src/main.ts']),
        now
      );

      const announcements = database
        .prepare('SELECT * FROM work_announcements WHERE resource = ?')
        .all('src/main.ts');
      expect(announcements.length).toBe(1);
    });

    it('should mark announcement as completed', () => {
      const database = db.getDatabase();
      const now = Date.now().toString();

      // Create announcement
      database
        .prepare(
          'INSERT INTO work_announcements (agent_id, agent_name, intent_type, resource, announced_at) VALUES (?, ?, ?, ?, ?)'
        )
        .run('agent-1', 'Test Agent', 'editing', 'src/main.ts', now);

      // Mark as completed
      database
        .prepare(
          'UPDATE work_announcements SET completed_at = ? WHERE resource = ? AND agent_id = ?'
        )
        .run(Date.now().toString(), 'src/main.ts', 'agent-1');

      const announcement = database
        .prepare('SELECT * FROM work_announcements WHERE resource = ?')
        .get('src/main.ts');
      expect((announcement as any).completed_at).toBeDefined();
    });

    it('should find active announcements', () => {
      const database = db.getDatabase();
      const now = Date.now().toString();

      // Create completed announcement
      database
        .prepare(
          'INSERT INTO work_announcements (agent_id, intent_type, resource, announced_at, completed_at) VALUES (?, ?, ?, ?, ?)'
        )
        .run('agent-1', 'editing', 'completed-file.ts', now, now);

      // Create active announcement
      database
        .prepare(
          'INSERT INTO work_announcements (agent_id, intent_type, resource, announced_at) VALUES (?, ?, ?, ?)'
        )
        .run('agent-2', 'reviewing', 'active-file.ts', now);

      const active = database
        .prepare('SELECT * FROM work_announcements WHERE completed_at IS NULL')
        .all();
      expect(active.length).toBe(1);
    });
  });
});
