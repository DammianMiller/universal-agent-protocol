import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { CoordinationService } from '../../src/coordination/service.js';
import { CoordinationDatabase } from '../../src/coordination/database.js';
import { coordDbPath } from '../../src/coordination/board-inject.js';
import { runChallengeAgents } from '../../src/coordination/challenge-runner.js';

describe('challenge run orchestrator', () => {
  let dir: string;
  let service: CoordinationService;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uap-chrun-'));
    mkdirSync(join(dir, 'agents', 'data', 'coordination'), { recursive: true });
    CoordinationDatabase.resetInstance();
    service = new CoordinationService({ dbPath: coordDbPath(dir) });
  });
  afterEach(() => {
    CoordinationDatabase.resetInstance();
    rmSync(dir, { recursive: true, force: true });
  });

  it('launches N participants, each submitting, and returns the leaderboard', async () => {
    const id = service.createChallenge('speed', { metric: 'tps', ropeMargin: 4 });
    const report = await runChallengeAgents(service, {
      challengeId: id,
      agents: 5,
      concurrency: 2,
      participant: async (ctx) => {
        // score 240..244 (all within ±4 of the leader → ties)
        ctx.service.submitToChallenge(ctx.challengeId, ctx.agentId, 240 + ctx.index, { verified: true });
      },
    });
    expect(report.agents).toBe(5);
    expect(report.results).toHaveLength(5);
    expect(report.results.every((r) => r.ok && r.submitted === 1)).toBe(true);
    expect(report.leaderboard).toHaveLength(5);
    expect(report.leaderboard.every((e) => e.tiedForLead)).toBe(true); // all within ±4
  });

  it('registers each participant agent in the registry', async () => {
    const id = service.createChallenge('goal');
    await runChallengeAgents(service, {
      challengeId: id,
      agents: 3,
      participant: async () => {},
      agentPrefix: 'racer',
    });
    // Registered durably (status is 'completed' after the run, so getAgent, not
    // getActiveAgents).
    expect(service.getAgent('racer-1')).not.toBeNull();
    expect(service.getAgent('racer-3')).not.toBeNull();
    expect(service.getAgent('racer-2')?.status).toBe('completed');
  });

  it('respects the concurrency cap (never exceeds it)', async () => {
    const id = service.createChallenge('goal');
    let active = 0;
    let maxActive = 0;
    await runChallengeAgents(service, {
      challengeId: id,
      agents: 8,
      concurrency: 3,
      participant: async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 10));
        active--;
      },
    });
    expect(maxActive).toBeLessThanOrEqual(3);
  });

  it('records a failed participant without aborting the run', async () => {
    const id = service.createChallenge('goal');
    const report = await runChallengeAgents(service, {
      challengeId: id,
      agents: 3,
      participant: async (ctx) => {
        if (ctx.index === 1) throw new Error('boom');
        ctx.service.submitToChallenge(ctx.challengeId, ctx.agentId, 10, { verified: true });
      },
    });
    expect(report.results.filter((r) => !r.ok)).toHaveLength(1);
    expect(report.results.filter((r) => r.submitted > 0)).toHaveLength(2);
  });

  it('errors on a missing/closed challenge or no participant', async () => {
    await expect(runChallengeAgents(service, { challengeId: 999, agents: 1, participant: async () => {} }))
      .rejects.toThrow(/not found/);
    const id = service.createChallenge('g');
    service.closeChallenge(id);
    await expect(runChallengeAgents(service, { challengeId: id, agents: 1, participant: async () => {} }))
      .rejects.toThrow(/closed/);
    const id2 = service.createChallenge('g2');
    await expect(runChallengeAgents(service, { challengeId: id2, agents: 1 }))
      .rejects.toThrow(/participant function or a --cmd/);
  });
});
