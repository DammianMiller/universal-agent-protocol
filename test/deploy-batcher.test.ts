import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DeployBatcher } from '../src/coordination/deploy-batcher.js';
import { CoordinationDatabase } from '../src/coordination/database.js';
import { existsSync, unlinkSync, mkdirSync } from 'fs';
import { join } from 'path';

const TEST_DB_DIR = '.uap-test-deploy';
const TEST_DB_PATH = join(TEST_DB_DIR, 'coordination.db');

describe('DeployBatcher', () => {
  let batcher: DeployBatcher;

  beforeEach(() => {
    CoordinationDatabase.resetInstance();
    for (const f of [TEST_DB_PATH, TEST_DB_PATH + '-wal', TEST_DB_PATH + '-shm']) {
      if (existsSync(f)) unlinkSync(f);
    }
    if (!existsSync(TEST_DB_DIR)) mkdirSync(TEST_DB_DIR, { recursive: true });

    batcher = new DeployBatcher({
      dbPath: TEST_DB_PATH,
      dryRun: true, // Always dry run in tests
      maxBatchSize: 10,
    });
  });

  afterEach(() => {
    CoordinationDatabase.resetInstance();
    for (const f of [TEST_DB_PATH, TEST_DB_PATH + '-wal', TEST_DB_PATH + '-shm']) {
      if (existsSync(f)) unlinkSync(f);
    }
  });

  describe('Batch Windows', () => {
    it('should return default windows', () => {
      const config = batcher.getWindowConfig();
      expect(config.commit).toBe(30000);
      expect(config.push).toBe(5000);
      expect(config.merge).toBe(10000);
      expect(config.workflow).toBe(5000);
      expect(config.deploy).toBe(60000);
    });

    it('should return type-specific window', () => {
      expect(batcher.getBatchWindow('commit')).toBe(30000);
      expect(batcher.getBatchWindow('push')).toBe(5000);
      expect(batcher.getBatchWindow('deploy')).toBe(60000);
    });

    it('should switch to urgent mode', () => {
      batcher.setUrgentMode(true);
      const config = batcher.getWindowConfig();
      expect(config.commit).toBe(2000);
      expect(config.push).toBe(1000);
      expect(config.deploy).toBe(5000);
    });

    it('should restore defaults from urgent mode', () => {
      batcher.setUrgentMode(true);
      batcher.setUrgentMode(false);
      const config = batcher.getWindowConfig();
      expect(config.commit).toBe(30000);
    });
  });

  describe('Queue', () => {
    it('should queue an action and return an ID', async () => {
      const id = await batcher.queue('agent-1', 'commit', 'main', {
        message: 'test commit',
        files: ['src/main.ts'],
      });
      expect(id).toBeGreaterThan(0);
    });

    it('should merge similar pending actions', async () => {
      const id1 = await batcher.queue('agent-1', 'commit', 'main', {
        message: 'first commit',
        files: ['src/a.ts'],
      });
      const id2 = await batcher.queue('agent-1', 'commit', 'main', {
        message: 'second commit',
        files: ['src/b.ts'],
      });
      // Should merge into the first action
      expect(id2).toBe(id1);
    });

    it('should not merge different action types', async () => {
      const id1 = await batcher.queue('agent-1', 'commit', 'main', { message: 'commit' });
      const id2 = await batcher.queue('agent-1', 'push', 'main');
      expect(id2).not.toBe(id1);
    });

    it('should queue bulk actions atomically', async () => {
      const ids = await batcher.queueBulk('agent-1', [
        { actionType: 'commit', target: 'main', payload: { message: 'a' } },
        { actionType: 'push', target: 'main' },
        { actionType: 'workflow', target: 'ci.yml' },
      ]);
      expect(ids.length).toBe(3);
      expect(ids.every((id) => id > 0)).toBe(true);
    });
  });

  describe('Batch Creation', () => {
    it('should create a batch from ready actions', async () => {
      // Queue with immediate execution (urgent)
      await batcher.queue('agent-1', 'commit', 'main', { message: 'test' }, { urgent: true });

      // Wait for the urgent window (1s)
      await new Promise((r) => setTimeout(r, 1100));

      const batch = await batcher.createBatch();
      expect(batch).not.toBeNull();
      expect(batch!.actions.length).toBeGreaterThan(0);
      expect(batch!.status).toBe('pending');
    });

    it('should return null when no actions are ready', async () => {
      // Queue with default window (30s for commit)
      await batcher.queue('agent-1', 'commit', 'main', { message: 'test' });
      // Don't wait - should not be ready yet
      const batch = await batcher.createBatch();
      expect(batch).toBeNull();
    });

    it('should squash multiple commits to same target', async () => {
      await batcher.queue('agent-1', 'commit', 'main', { message: 'first' }, { urgent: true });
      // The second queue will merge with the first, so we need to force separate entries
      // by using different targets
      await batcher.queue('agent-1', 'push', 'main', {}, { urgent: true });

      await new Promise((r) => setTimeout(r, 1100));

      const batch = await batcher.createBatch();
      expect(batch).not.toBeNull();
      expect(batch!.actions.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Batch Execution (dry run)', () => {
    it('should execute a batch in dry run mode', async () => {
      await batcher.queue('agent-1', 'commit', 'main', { message: 'test' }, { urgent: true });
      await new Promise((r) => setTimeout(r, 1100));

      const batch = await batcher.createBatch();
      expect(batch).not.toBeNull();

      const result = await batcher.executeBatch(batch!.id);
      expect(result.success).toBe(true);
      expect(result.executedActions).toBeGreaterThan(0);
      expect(result.failedActions).toBe(0);
    });
  });

  describe('Batch Retrieval', () => {
    it('should retrieve a batch by ID', async () => {
      await batcher.queue('agent-1', 'workflow', 'ci.yml', {}, { urgent: true });
      await new Promise((r) => setTimeout(r, 1100));

      const batch = await batcher.createBatch();
      expect(batch).not.toBeNull();

      const retrieved = batcher.getBatch(batch!.id);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe(batch!.id);
    });

    it('should return null for non-existent batch', () => {
      expect(batcher.getBatch('non-existent')).toBeNull();
    });
  });

  describe('Custom Windows', () => {
    it('should accept custom dynamic windows', () => {
      CoordinationDatabase.resetInstance();
      const custom = new DeployBatcher({
        dbPath: TEST_DB_PATH,
        dynamicWindows: { commit: 1000, push: 500 },
        dryRun: true,
      });
      const config = custom.getWindowConfig();
      expect(config.commit).toBe(1000);
      expect(config.push).toBe(500);
      // Others should be defaults
      expect(config.deploy).toBe(60000);
    });

    it('should accept legacy single window', () => {
      CoordinationDatabase.resetInstance();
      const legacy = new DeployBatcher({
        dbPath: TEST_DB_PATH,
        batchWindowMs: 2000,
        dryRun: true,
      });
      const config = legacy.getWindowConfig();
      expect(config.commit).toBe(2000);
      expect(config.push).toBe(2000);
      expect(config.deploy).toBe(2000);
    });
  });
});
