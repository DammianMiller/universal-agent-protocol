import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createRunCoordinator, collectAppliedFiles } from '../../src/delivery/run-coordinator.js';
import { CoordinationService } from '../../src/coordination/service.js';
import type { DeliveryResult } from '../../src/delivery/convergence-loop.js';

function makeResult(overrides: Partial<DeliveryResult> = {}): DeliveryResult {
  return {
    success: true,
    alreadyDelivered: false,
    turns: 1,
    bestScore: 1,
    bestTurn: 1,
    history: [
      {
        turn: 1,
        passed: true,
        score: 1,
        gateResults: [],
        filesApplied: ['src/a.ts', 'src/b.ts'],
        durationMs: 10,
      },
      {
        turn: 2,
        passed: true,
        score: 1,
        gateResults: [],
        filesApplied: ['src/b.ts', 'src/c.ts'],
        durationMs: 10,
      },
    ],
    finalFeedback: '',
    finalOutput: '',
    totalDurationMs: 20,
    ...overrides,
  };
}

describe('collectAppliedFiles', () => {
  it('deduplicates files across the iteration history', () => {
    expect(collectAppliedFiles(makeResult())).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
  });

  it('returns [] for an empty history', () => {
    expect(collectAppliedFiles(makeResult({ history: [] }))).toEqual([]);
  });
});

describe('createRunCoordinator', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'run-coord-'));
    dbPath = join(dir, 'coordination.db');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('registers an agent, heartbeats on iteration, and deregisters on finish', async () => {
    const coordinator = await createRunCoordinator({
      instruction: 'implement the feature',
      projectRoot: '/tmp/project',
      modelId: 'test-model',
      dbPath,
    });
    expect(coordinator.agentId).toBeTruthy();

    const service = new CoordinationService({ dbPath });
    const before = service.getAgent(coordinator.agentId!);
    expect(before?.status).toBe('active');
    expect(before?.name).toBe('uap-deliver-test-model');

    coordinator.onIteration(makeResult().history[0]);

    await coordinator.finish(makeResult());
    const after = service.getAgent(coordinator.agentId!);
    expect(after?.status).toBe('completed');
  });

  it('queues a commit of applied files into the deploy batcher on success', async () => {
    const coordinator = await createRunCoordinator({
      instruction: 'implement the feature',
      projectRoot: '/tmp/project',
      modelId: 'test-model',
      dbPath,
    });

    const actionId = await coordinator.queueDeploy(makeResult(), 'feat(delivery): test');
    expect(actionId).not.toBeNull();
    expect(typeof actionId).toBe('number');

    // The queued action must carry everything executeCommit needs to run
    // from any cwd: the deduped file list, the message, and the project cwd.
    const { CoordinationDatabase } = await import('../../src/coordination/database.js');
    const db = CoordinationDatabase.getInstance(dbPath).getDatabase();
    const row = db
      .prepare('SELECT agent_id, action_type, target, payload FROM deploy_queue WHERE id = ?')
      .get(actionId) as { agent_id: string; action_type: string; target: string; payload: string };
    expect(row.agent_id).toBe(coordinator.agentId);
    expect(row.action_type).toBe('commit');
    expect(row.target).toBe('/tmp/project');
    const payload = JSON.parse(row.payload);
    expect(payload.message).toBe('feat(delivery): test');
    expect(payload.files).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
    expect(payload.cwd).toBe('/tmp/project');
  });

  it('does not queue a deploy for a failed delivery', async () => {
    const coordinator = await createRunCoordinator({
      instruction: 'x',
      projectRoot: '/tmp/project',
      modelId: 'test-model',
      dbPath,
    });
    const actionId = await coordinator.queueDeploy(makeResult({ success: false }), 'msg');
    expect(actionId).toBeNull();
  });

  it('does not queue a deploy when no files were applied', async () => {
    const coordinator = await createRunCoordinator({
      instruction: 'x',
      projectRoot: '/tmp/project',
      modelId: 'test-model',
      dbPath,
    });
    const actionId = await coordinator.queueDeploy(makeResult({ history: [] }), 'msg');
    expect(actionId).toBeNull();
  });
});
