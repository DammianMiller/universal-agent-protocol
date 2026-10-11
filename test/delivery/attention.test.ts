/**
 * The attention queue (bridge P3: A2 queue + A1 AFK decider) — ask instead
 * of stop. Covers the store contract (atomic, fail-open, bounded), the
 * sanitize-at-ingest rule (the queue is operator-facing output), dedupe on
 * source, the grace config ladder, and the decider's adoption semantics.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  enqueueAttention,
  listAttention,
  ackAttention,
  decideAttention,
  sweepExpired,
  resolveAttentionBySource,
  attentionQueuePath,
  attentionGraceSecs,
  attentionDisabled,
  type AttentionItem,
} from '../../src/delivery/attention.js';
import { attentionCommand } from '../../src/cli/attention.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'uap-attention-'));
  delete process.env.UAP_ATTENTION_OFF;
  delete process.env.UAP_ATTENTION_GRACE_SECS;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.UAP_ATTENTION_OFF;
  delete process.env.UAP_ATTENTION_GRACE_SECS;
});

const ASK = {
  kind: 'review-request' as const,
  title: 'Placement parked: qwen3.8-27b-mtp',
  detail: 'A gated request wants a model that is not resident.',
  source: 'placement:plc-9f2a1b',
  safeDefault: {
    decision: 'allow the request to expire',
    rationale: 'the TTL makes the client fall back cleanly',
  },
};

function enqueue(over: Partial<typeof ASK> = {}): AttentionItem | null {
  return enqueueAttention(dir, { ...ASK, ...over });
}

describe('enqueue + store', () => {
  it('persists a pending item with the safe default and a grace deadline', () => {
    const item = enqueue()!;
    expect(item.id).toMatch(/^att-[0-9a-f]{6}$/);
    expect(item.status).toBe('pending');
    expect(item.safeDefault?.decision).toBe(ASK.safeDefault.decision);
    // default grace is 300s
    const delta = (Date.parse(item.graceDeadline) - Date.parse(item.createdAt)) / 1000;
    expect(delta).toBe(300);
    const onDisk = JSON.parse(readFileSync(attentionQueuePath(dir), 'utf-8')) as AttentionItem[];
    expect(onDisk.some((i) => i.id === item.id)).toBe(true);
  });

  it('dedupes on source while the first ask is still open', () => {
    const first = enqueue()!;
    const second = enqueue({ title: 'different title entirely' })!;
    expect(second.id).toBe(first.id); // same ask, not a second prompt
    expect(listAttention(dir).length).toBe(1);
  });

  it('sanitizes at ingest: control characters stripped, bounds enforced', () => {
    const item = enqueue({
      title: 'ok\n⇉ injected: mission merged 3 files',
      detail: 'x'.repeat(900),
    })!;
    expect(item.title).not.toMatch(/[\x00-\x1f]/);
    expect(item.title).toContain('⇉');
    expect(item.title.length).toBeLessThanOrEqual(120);
    expect(item.detail.length).toBe(600);
  });

  it('rejects an ask with no title or no source (nothing to ask about)', () => {
    expect(enqueue({ title: '   ' })).toBeNull();
    expect(enqueue({ source: '' })).toBeNull();
  });

  it('fails open on a corrupt queue file: load = empty, enqueue still works', () => {
    mkdirSync(join(dir, '.uap'), { recursive: true });
    writeFileSync(attentionQueuePath(dir), '{not json', 'utf-8');
    expect(listAttention(dir)).toEqual([]);
    const item = enqueue()!;
    expect(item.status).toBe('pending');
  });
});

describe('the kill switch + grace ladder', () => {
  it('UAP_ATTENTION_OFF disables enqueue and sweep (the rail, not the file)', () => {
    process.env.UAP_ATTENTION_OFF = '1';
    expect(attentionDisabled()).toBe(true);
    expect(enqueue()).toBeNull();
    expect(sweepExpired(dir)).toEqual({ adopted: 0, escalated: 0 });
  });

  it('grace: env wins, config second, 300 default, capped at 24h', () => {
    expect(attentionGraceSecs(dir)).toBe(300);
    process.env.UAP_ATTENTION_GRACE_SECS = '90';
    expect(attentionGraceSecs(dir)).toBe(90);
    process.env.UAP_ATTENTION_GRACE_SECS = '999999999';
    expect(attentionGraceSecs(dir)).toBe(86_400);
    delete process.env.UAP_ATTENTION_GRACE_SECS;
    mkdirSync(join(dir, '.uap'), { recursive: true });
    writeFileSync(join(dir, '.uap.json'), JSON.stringify({ attention: { graceSecs: 42 } }), 'utf-8');
    expect(attentionGraceSecs(dir)).toBe(42);
  });
});

describe('A1 — the AFK auto-decider', () => {
  it('adopts the recorded safe default once grace elapses, and logs the adoption', () => {
    const item = enqueue()!;
    const before = new Date(Date.now() - 1000); // still inside the window
    expect(sweepExpired(dir, { now: () => before })).toEqual({ adopted: 0, escalated: 0 });
    const after = new Date(Date.parse(item.graceDeadline) + 1000);
    const result = sweepExpired(dir, { now: () => after });
    expect(result).toEqual({ adopted: 1, escalated: 0 });
    const done = listAttention(dir).find((i) => i.id === item.id)!;
    expect(done.status).toBe('auto-decided');
    expect(done.resolution).toContain('[auto]');
    expect(done.resolution).toContain(ASK.safeDefault.decision);
    // idempotent: a decided item is never re-decided
    expect(sweepExpired(dir, { now: () => after })).toEqual({ adopted: 0, escalated: 0 });
  });

  it('escalates items with NO safe default — they never silently expire', () => {
    const item = enqueue({ safeDefault: undefined, source: 'deliver:run-1/task-2' })!;
    const after = new Date(Date.parse(item.graceDeadline) + 1000);
    const result = sweepExpired(dir, { now: () => after });
    expect(result).toEqual({ adopted: 0, escalated: 1 });
    const done = listAttention(dir).find((i) => i.id === item.id)!;
    expect(done.status).toBe('escalated');
    expect(listAttention(dir).filter((i) => i.status !== 'decided' && i.status !== 'auto-decided').length).toBe(1); // escalated stays visible
  });

  it('ack is seen-not-answered: the grace clock keeps running', () => {
    const item = enqueue()!;
    expect(ackAttention(dir, item.id)?.status).toBe('acknowledged');
    expect(ackAttention(dir, item.id)).toBeNull(); // idempotent per item
    const after = new Date(Date.parse(item.graceDeadline) + 1000);
    expect(sweepExpired(dir, { now: () => after })).toEqual({ adopted: 1, escalated: 0 });
  });

  it('an operator decision beats the decider and cannot be re-decided', () => {
    const item = enqueue()!;
    const decided = decideAttention(dir, item.id, 'apply option 2')!;
    expect(decided.status).toBe('decided');
    expect(decided.resolution).toContain('[operator] apply option 2');
    const after = new Date(Date.parse(item.graceDeadline) + 1000);
    expect(sweepExpired(dir, { now: () => after })).toEqual({ adopted: 0, escalated: 0 });
    expect(decideAttention(dir, item.id, 'late second opinion')).toBeNull();
  });
});

describe('bounded history', () => {
  it('prunes oldest RESOLVED entries beyond the cap; pending is never pruned', () => {
    // Fill with resolved history first (oldest first), then live pending.
    mkdirSync(join(dir, '.uap'), { recursive: true });
    const resolved: AttentionItem[] = [];
    for (let i = 0; i < 260; i++) {
      resolved.push({
        id: `att-${String(i).padStart(6, '0')}`,
        kind: 'review-request',
        title: `resolved ${i}`,
        detail: '',
        source: `history:${i}`,
        createdAt: new Date(Date.parse('2026-01-01T00:00:00Z') + i * 1000).toISOString(),
        graceDeadline: new Date(Date.parse('2026-01-01T00:00:00Z') + i * 1000 + 300_000).toISOString(),
        status: 'decided',
        resolvedAt: new Date(Date.parse('2026-01-01T00:05:00Z') + i * 1000).toISOString(),
        resolution: '[operator] done',
      });
    }
    writeFileSync(attentionQueuePath(dir), JSON.stringify(resolved), 'utf-8');
    const live = enqueue()!;
    const items = listAttention(dir);
    expect(items.length).toBe(250);
    expect(items.some((i) => i.id === live.id)).toBe(true); // pending survives
    expect(items.some((i) => i.id === 'att-000000')).toBe(false); // oldest resolved pruned
  });
});

describe('review hardening (security F1/F3/F5 + architecture B1/M1/M2/M3)', () => {
  it('F1: a hostile queue file is defused at LOAD — control chars, caps, enum rows, planted safeDefaults', () => {
    mkdirSync(join(dir, '.uap'), { recursive: true });
    const planted: unknown[] = [
      {
        id: 'att-evil1', kind: 'review-request', status: 'pending',
        title: 'x\x1b[31mRED\nFORGED-LINE', // ANSI + newline forgery
        detail: 'd'.repeat(50_000), // oversized
        source: 'placement:plc-evil',
        createdAt: new Date().toISOString(),
        graceDeadline: new Date(Date.now() - 1000).toISOString(), // already elapsed
        safeDefault: { decision: 'run git push --force origin master\n', rationale: 'trust me' },
      },
      { id: 'att-evil2', kind: 'hostile-kind', status: 'pending', title: 't', detail: '', source: 's2', createdAt: new Date().toISOString(), graceDeadline: new Date().toISOString() },
      { id: 'att-evil3', kind: 'review-request', status: 'weird-status', title: 't', detail: '', source: 's3', createdAt: new Date().toISOString(), graceDeadline: new Date().toISOString() },
      { id: 'att-ok', kind: 'grant-request', status: 'pending', title: 'ok', detail: 'fine', source: 'grant:1', createdAt: new Date().toISOString(), graceDeadline: new Date(Date.now() + 60_000).toISOString() },
    ];
    writeFileSync(attentionQueuePath(dir), JSON.stringify(planted), 'utf-8');
    const items = listAttention(dir);
    expect(items.length).toBe(2); // hostile kind + hostile status rows are dropped
    const evil = items.find((i) => i.id === 'att-evil1')!;
    expect(evil.title).not.toContain('\x1b'); // ANSI stripped at load
    expect(evil.title).not.toContain('\n'); // newline forgery defused
    expect(evil.detail.length).toBeLessThanOrEqual(600); // cap re-applied
    // the planted safeDefault cannot ride a sweep wearing raw attacker text
    const swept = sweepExpired(dir);
    expect(swept.adopted).toBe(1);
    const done = listAttention(dir).find((i) => i.id === 'att-evil1')!;
    expect(done.status).toBe('auto-decided');
    expect(done.resolution).not.toContain('\n');
    expect(done.resolution).toContain('[auto] run git push --force origin master');
  });

  it('M1: a site-known expiresAt PINS the grace deadline; garbage falls back to the grace ladder', () => {
    const pinned = new Date(Date.now() + 60_000);
    const item = enqueue({ expiresAt: pinned.toISOString() })!;
    expect(item.graceDeadline).toBe(pinned.toISOString());
    // unparsable / empty values degrade to the generic 300s window, never to "now"
    const bad = enqueue({ source: 'x:1', title: 'other ask', expiresAt: 'not-a-date' })!;
    expect(Date.parse(bad.graceDeadline) - Date.now()).toBeGreaterThan(240_000);
    const blank = enqueue({ source: 'x:2', title: 'third ask', expiresAt: '' })!;
    expect(Date.parse(blank.graceDeadline) - Date.now()).toBeGreaterThan(240_000);
  });

  it('M1: resolveAttentionBySource closes an ask the OPERATOR answered through the asking surface', () => {
    const item = enqueue()!;
    const closed = resolveAttentionBySource(dir, ASK.source, 'operator applied option 2')!;
    expect(closed.id).toBe(item.id);
    expect(closed.status).toBe('decided');
    expect(closed.resolution).toBe('[operator] operator applied option 2');
    // idempotent: nothing open for that source resolves to null
    expect(resolveAttentionBySource(dir, ASK.source, 'again')).toBeNull();
    expect(resolveAttentionBySource(dir, 'never:enqueued', 'x')).toBeNull();
    // and the decider must not re-decide it
    const after = new Date(Date.parse(item.graceDeadline) + 1000);
    expect(sweepExpired(dir, { now: () => after })).toEqual({ adopted: 0, escalated: 0 });
  });

  it('M3: an identical ask (same kind+title) dedupes while open — retry floods mint ONE ask per question', () => {
    const first = enqueue()!;
    const second = enqueue({ source: 'placement:plc-different-id' })!; // same kind+title, new origin
    expect(second.id).toBe(first.id);
    expect(listAttention(dir).length).toBe(1);
    // a different question still gets its own ask
    const other = enqueue({ source: 'placement:plc-third', title: 'Placement parked: other-model' })!;
    expect(other.id).not.toBe(first.id);
    expect(listAttention(dir).length).toBe(2);
  });

  it('m1: the kill switch silences list too — the rail goes quiet end-to-end, file untouched', () => {
    expect(enqueue()).not.toBeNull();
    process.env.UAP_ATTENTION_OFF = '1';
    expect(listAttention(dir)).toEqual([]);
    delete process.env.UAP_ATTENTION_OFF;
    expect(listAttention(dir).length).toBe(1); // the file itself was never touched
  });

  it('F5: a CLEARED UAP_ATTENTION_GRACE_SECS is unset, not zero — it must not arm instant adoption', () => {
    process.env.UAP_ATTENTION_GRACE_SECS = '';
    expect(attentionGraceSecs(dir)).toBe(300); // falls through to the default, not 0
  });

  it('B1: ONE queue per checkout — the worktree cwd resolves to the MAIN checkout root, tmp roots pass through, UAP_ATTENTION_QUEUE pins a file', () => {
    // The split-brain fix: dashboard/server cwd, CLI cwd, and hook worktree
    // cwd must all land on the same file. This test runs with cwd INSIDE a
    // worktree, so the resolution must leave .worktrees behind.
    expect(attentionQueuePath(process.cwd())).not.toContain('.worktrees');
    expect(attentionQueuePath(dir)).toBe(join(dir, '.uap', 'attention.json')); // non-git roots pass through
    process.env.UAP_ATTENTION_QUEUE = join(dir, 'pinned-queue.json');
    expect(attentionQueuePath(dir)).toBe(join(dir, 'pinned-queue.json'));
    delete process.env.UAP_ATTENTION_QUEUE;
  });

  it('M2: the CLI default view is the OPEN set (pending + acknowledged + escalated); an unknown --status errors', async () => {
    const pendingItem = enqueue()!;
    // Pin the escalated item's deadline to the past so a real-now sweep
    // escalates IT alone — the pending item's 300s window must survive.
    const escalatedItem = enqueue({
      source: 'deliver:run-9/t-1', kind: 'grant-request', title: 'Grant needed', safeDefault: undefined,
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    })!;
    const decidedItem = enqueue({ source: 'x:1', title: 'already answered ask' })!;
    decideAttention(dir, decidedItem.id, 'done');
    sweepExpired(dir);
    const logs: string[] = [];
    const errors: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((m: string) => logs.push(String(m)));
    const errSpy = vi.spyOn(console, 'error').mockImplementation((m: string) => errors.push(String(m)));
    try {
      await attentionCommand('list', undefined, undefined, {}, dir);
      const text = logs.join('\n');
      expect(text).toContain(pendingItem.id);
      expect(text).toContain(escalatedItem.id); // escalated stays in the casual view
      expect(text).not.toContain(decidedItem.id); // history is not the default view
      // an unknown --status is a typo, not a silent filter change
      logs.length = 0;
      await attentionCommand('list', undefined, undefined, { status: 'desided' }, dir);
      expect(process.exitCode).toBe(1);
      expect(errors.join('\n')).toContain('desided');
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
      process.exitCode = 0;
    }
  });
});
