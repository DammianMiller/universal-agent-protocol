import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  classifyHaloSpan,
  classifyProxyLogLine,
  mineFromHaloSpans,
  mineFromProxyLogLines,
} from '../src/self-harness/trace-mine.js';
import { PendingQueue, promotionGate } from '../src/self-harness/pending.js';
import { MemoryTransferStore, makeEntry } from '../src/self-harness/transfer.js';
import type { Mod } from '../src/self-harness/mods.js';

describe('trace-mine — HALO span classification', () => {
  it('classifies apply-error path failures as toolcall.path.garbled', () => {
    expect(classifyHaloSpan({ status: { code: 'STATUS_CODE_ERROR' }, attributes: { 'delivery.apply_error': 'no such file or directory: titleCase.js' } })).toBe('toolcall.path.garbled');
  });
  it('classifies timeouts and gate failures', () => {
    expect(classifyHaloSpan({ attributes: { 'delivery.executor_error': 'agent timed out' } })).toBe('agent.timeout');
    expect(classifyHaloSpan({ status: { code: 'STATUS_CODE_OK' }, attributes: { 'delivery.gates_failed': ['test'] } })).toBe('verify.fail');
    expect(classifyHaloSpan({ status: { code: 'STATUS_CODE_OK' }, attributes: { 'delivery.score': 1 } })).toBeNull();
  });
});

describe('trace-mine — proxy log signal classification (the prod path)', () => {
  it('maps the proxy log signals to failure kinds', () => {
    expect(classifyProxyLogLine("[INFO] TOOLCALL PATH NORMALIZER: t.file_path 'titleCase.js' -> 'titlecase.js'")).toBe('toolcall.path.garbled');
    expect(classifyProxyLogLine('[WARNING] TURN-COUNT FINALIZE BREAKER: 40 agent tool turns')).toBe('loop.nonterminate');
    expect(classifyProxyLogLine('RECON CONVERGENCE: injected hard-escalated directive')).toBe('guardrail.poison.recon');
    expect(classifyProxyLogLine('error: request exceeds the available context size')).toBe('gen.runaway.npredict');
    expect(classifyProxyLogLine('[INFO] some normal line')).toBeNull();
  });
  it('mines + ranks weaknesses from proxy log lines, keyed by stable signature', () => {
    const lines = [
      "TOOLCALL PATH NORMALIZER: a 'X.js' -> 'x.js' (fp:abc123)",
      "TOOLCALL PATH NORMALIZER: b 'Y.js' -> 'y.js' (fp:abc123)",
      'TURN-COUNT FINALIZE BREAKER: 40 turns (fp:def456)',
    ];
    const w = mineFromProxyLogLines(lines, { model: 'qwen36-35b-a3b' });
    expect(w[0].kind).toBe('toolcall.path.garbled'); // freq 2 outranks the loop's 1
    expect(w[0].signature).toHaveLength(16);
  });
});

describe('trace-mine — HALO end-to-end', () => {
  it('mines a verify.fail from a gates-failed span', () => {
    const spans = [
      { name: 'delivery.turn.1', status: { code: 'STATUS_CODE_OK' }, attributes: { 'delivery.gates_failed': ['lint'], 'inference.project_id': 'proj-1' } },
    ];
    const w = mineFromHaloSpans(spans, { model: 'm' });
    expect(w).toHaveLength(1);
    expect(w[0].kind).toBe('verify.fail');
    expect(w[0].affectedTasks).toEqual(['proj-1']);
  });
});

describe('pending — gated promotion queue', () => {
  it('env Mods auto-promote after validation; scaffold/middleware are human-gated', () => {
    const env: Mod = { kind: 'env', key: 'LLAMA_N_PREDICT', from: '8192', to: '4096' };
    const mw: Mod = { kind: 'middleware', id: 'toolcall-path-normalizer', params: {} };
    expect(promotionGate(env)).toBe('auto-after-validation');
    expect(promotionGate(mw)).toBe('human');
  });

  it('enqueues (de-duped), assigns the gate, and persists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sh-pq-'));
    const path = join(dir, 'pending.json');
    const q = new PendingQueue(path);
    const base = {
      id: 'p1', signature: 'sig', kind: 'toolcall.path.garbled' as const, model: 'm',
      mod: { kind: 'middleware', id: 'toolcall-path-normalizer', params: {} } as Mod,
      source: 'proxy-log', frequency: 5, createdAt: 't',
    };
    const p = q.enqueue(base);
    expect(p.gate).toBe('human');
    expect(p.status).toBe('pending');
    q.enqueue(base); // duplicate while pending → ignored
    expect(new PendingQueue(path).list()).toHaveLength(1); // persisted + deduped
    rmSync(dir, { recursive: true, force: true });
  });

  it('prunes stale pending entries but keeps fresh ones', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sh-pq2-'));
    const path = join(dir, 'pending.json');
    const q = new PendingQueue(path);
    const mod: Mod = { kind: 'env', key: 'LLAMA_N_PREDICT', from: '8192', to: '4096' };
    q.enqueue({ id: 'old', signature: 's1', kind: 'verify.fail', model: 'm', mod, source: 'halo', frequency: 1, createdAt: '2020-01-01T00:00:00Z' });
    q.enqueue({ id: 'new', signature: 's2', kind: 'verify.fail', model: 'm', mod, source: 'halo', frequency: 1, createdAt: new Date().toISOString() });
    const removed = q.prune({ maxPendingDays: 14 });
    expect(removed.map((r) => r.id)).toEqual(['old']);
    expect(q.list().map((x) => x.id)).toEqual(['new']);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('transfer — ablation prune', () => {
  it('drops no-longer-paying accepted entries and stale entries, keeps positive recent', () => {
    const s = new MemoryTransferStore();
    const mod: Mod = { kind: 'middleware', id: 'toolcall-path-normalizer', params: {} };
    const now = Date.parse('2026-06-23T00:00:00Z');
    s.record(makeEntry({ signature: 'a', kind: 'toolcall.path.garbled', model: 'm1', mod, delta: 0.05, accepted: true, validatedAt: '2026-06-22T00:00:00Z', provenance: 'recent positive' }));
    s.record(makeEntry({ signature: 'b', kind: 'verify.fail', model: 'm2', mod: { kind: 'env', key: 'LLAMA_N_PREDICT', from: '8192', to: '4096' }, delta: 0.0, accepted: true, validatedAt: '2026-06-22T00:00:00Z', provenance: 'no longer pays' }));
    s.record(makeEntry({ signature: 'c', kind: 'agent.timeout', model: 'm3', mod, delta: 0.3, accepted: true, validatedAt: '2020-01-01T00:00:00Z', provenance: 'stale' }));
    const r = s.prune({ minDelta: 0, maxAgeDays: 90, now });
    expect(r.removed.map((e) => e.provenance).sort()).toEqual(['no longer pays', 'stale']);
    expect(r.kept).toBe(1);
    expect(s.all()[0].provenance).toBe('recent positive');
  });
});
