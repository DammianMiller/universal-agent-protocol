import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { CoordinationService } from '../../src/coordination/service.js';
import { CoordinationDatabase } from '../../src/coordination/database.js';
import { coordDbPath } from '../../src/coordination/board-inject.js';

describe('challenge mode', () => {
  let dir: string;
  let service: CoordinationService;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'uap-challenge-'));
    mkdirSync(join(dir, 'agents', 'data', 'coordination'), { recursive: true });
    CoordinationDatabase.resetInstance();
    service = new CoordinationService({ dbPath: coordDbPath(dir) });
  });
  afterEach(() => {
    CoordinationDatabase.resetInstance();
    rmSync(dir, { recursive: true, force: true });
  });

  it('opens a challenge and seeds the board with goal + norms', () => {
    const id = service.createChallenge('Speed up inference', { metric: 'tps', ropeMargin: 4 });
    expect(service.getChallenge(id)?.status).toBe('open');
    const board = service.readBoard();
    expect(board.some((p) => p.text.includes('OPEN') && p.text.includes('Speed up inference'))).toBe(true);
    expect(board.some((p) => p.kind === 'norm' && p.text.includes('TIES'))).toBe(true);
  });

  it('only ranks VERIFIED submissions on the leaderboard', () => {
    const id = service.createChallenge('goal', { ropeMargin: 0 });
    service.submitToChallenge(id, 'a', 100, { verified: true });
    service.submitToChallenge(id, 'cheater', 999); // unverified
    const lb = service.leaderboard(id);
    expect(lb).toHaveLength(1);
    expect(lb[0].submission.agentId).toBe('a');
  });

  it('applies the significance norm: scores within the ROPE margin tie for the lead', () => {
    const id = service.createChallenge('speed', { metric: 'tps', ropeMargin: 4, higherIsBetter: true });
    service.submitToChallenge(id, 'a', 247, { verified: true });
    service.submitToChallenge(id, 'b', 245, { verified: true });
    service.submitToChallenge(id, 'c', 118, { verified: true });
    const lb = service.leaderboard(id);
    expect(lb[0].tiedForLead).toBe(true);
    expect(lb[1].tiedForLead).toBe(true); // 245 within ±4 of 247 → tie
    expect(lb[2].tiedForLead).toBe(false); // 118 is a real loss
    expect(lb[2].rank).toBe(3);
  });

  it('respects lower-is-better metrics', () => {
    const id = service.createChallenge('latency', { higherIsBetter: false, ropeMargin: 0 });
    service.submitToChallenge(id, 'fast', 10, { verified: true });
    service.submitToChallenge(id, 'slow', 50, { verified: true });
    const lb = service.leaderboard(id);
    expect(lb[0].submission.agentId).toBe('fast'); // lower wins
  });

  it('verify promotes a submission into the ranking', () => {
    const id = service.createChallenge('goal');
    const sid = service.submitToChallenge(id, 'a', 5);
    expect(service.leaderboard(id)).toHaveLength(0);
    expect(service.verifySubmission(sid)).toBe(true);
    expect(service.leaderboard(id)).toHaveLength(1);
  });

  it('closes a challenge (idempotent)', () => {
    const id = service.createChallenge('goal');
    expect(service.closeChallenge(id)).toBe(true);
    expect(service.getChallenge(id)?.status).toBe('closed');
    expect(service.closeChallenge(id)).toBe(false);
  });
});
