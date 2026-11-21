import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import {
  planRecall,
  formatRecallBanner,
  tokenizeForRecall,
  keywordOverlapScore,
  keywordRecallLongTerm,
  recordRecallHealthEvent,
  recallHealthTelemetryPath,
  type RecallHealth,
  type RecallDegradation,
} from '../../src/memory/recall-health.js';
import {
  EmbeddingService,
  FALLBACK_EMBEDDING_PROVIDERS,
  isFallbackEmbeddingProvider,
} from '../../src/memory/embeddings.js';
import { ensureDailyLogSchema } from '../../src/memory/daily-log.js';

function health(overrides: Partial<RecallHealth> = {}): RecallHealth {
  return {
    shortTermDb: 'ok',
    shortTermDbPath: '/tmp/short_term.db',
    qdrant: 'ok',
    qdrantEndpoint: 'http://localhost:6333',
    embeddings: 'ok',
    activeEmbeddingProvider: 'llama-cpp',
    degraded: [],
    ...overrides,
  };
}

function degradation(component: RecallDegradation['component'], state: string): RecallDegradation {
  return { component, state, detail: `${component} ${state} (fixture)` };
}

describe('recall health — planRecall (the single source of truth)', () => {
  it('keeps the semantic path when every substrate is healthy', () => {
    expect(planRecall(health())).toEqual({
      useVectorSearch: true,
      useKeywordFallback: false,
      suppressEmptyLongTerm: false,
    });
  });

  it('degrades to keyword recall when Qdrant is unreachable', () => {
    const h = health({
      qdrant: 'unreachable',
      degraded: [degradation('qdrant', 'unreachable')],
    });
    const plan = planRecall(h);
    expect(plan.useVectorSearch).toBe(false);
    expect(plan.useKeywordFallback).toBe(true);
    expect(plan.suppressEmptyLongTerm).toBe(true);
  });

  it('degrades to keyword recall when the embedding chain is on its fallback tier', () => {
    // A TF-IDF vector (384-dim) searched against a nomic-built collection
    // (768-dim) returns "no results" while the store holds the answer —
    // the degradation this plan must refuse to present as healthy recall.
    const h = health({
      embeddings: 'fallback',
      activeEmbeddingProvider: 'tfidf-enhanced',
      degraded: [degradation('embeddings', 'fallback')],
    });
    const plan = planRecall(h);
    expect(plan.useVectorSearch).toBe(false);
    expect(plan.useKeywordFallback).toBe(true);
    expect(plan.suppressEmptyLongTerm).toBe(true);
  });

  it('stays degraded with both backends down (no partial revival)', () => {
    const h = health({
      qdrant: 'unreachable',
      embeddings: 'error',
      activeEmbeddingProvider: null,
      degraded: [degradation('qdrant', 'unreachable'), degradation('embeddings', 'error')],
    });
    expect(planRecall(h).useVectorSearch).toBe(false);
  });
});

describe('recall health — the visible banner', () => {
  it('names every degraded component and labels the fallback non-semantic', () => {
    const h = health({
      qdrant: 'unreachable',
      embeddings: 'fallback',
      activeEmbeddingProvider: 'tfidf-enhanced',
      shortTermDb: 'missing',
      degraded: [
        degradation('qdrant', 'unreachable'),
        degradation('embeddings', 'fallback'),
        degradation('short-term-db', 'missing'),
      ],
    });
    const lines = formatRecallBanner(h).join('\n');
    expect(lines).toContain('Memory recall is degraded');
    expect(lines).toContain('qdrant:');
    expect(lines).toContain('embeddings:');
    expect(lines).toContain('short-term-db:');
    expect(lines).toContain('NOT semantic');
  });
});

describe('recall health — keyword fallback scoring', () => {
  it('tokenizes deterministically and drops single-character noise', () => {
    expect(tokenizeForRecall('The THE the a-b 1')).toEqual(['the', 'the', 'the']);
  });

  it('scores overlap as the share of query tokens present in the entry', () => {
    expect(keywordOverlapScore('alpha beta', 'alpha beta gamma')).toBe(1);
    expect(keywordOverlapScore('alpha beta', 'beta delta')).toBe(0.5);
    expect(keywordOverlapScore('alpha beta', 'unrelated words')).toBe(0);
    expect(keywordOverlapScore('', 'anything')).toBe(0);
  });
});

describe('recall health — keyword recall over the daily-log store', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'uap-recall-health-'));
    mkdirSync(join(cwd, 'agents', 'data', 'memory'), { recursive: true });
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  function seedDailyLog(rows: Array<[string, string, string]>): void {
    const db = new Database(join(cwd, 'agents', 'data', 'memory', 'short_term.db'));
    ensureDailyLogSchema(db);
    const stmt = db.prepare(
      'INSERT INTO daily_log (date, timestamp, content, type, gate_score) VALUES (?, ?, ?, ?, 0)'
    );
    for (const [timestamp, content, type] of rows) {
      stmt.run(timestamp.slice(0, 10), timestamp, content, type);
    }
    db.close();
  }

  it('ranks by overlap, excludes non-matches, and respects the limit', () => {
    seedDailyLog([
      ['2026-11-01T10:00:00Z', 'alpha beta gamma deployment', 'goal'],
      ['2026-11-02T10:00:00Z', 'beta delta rollout', 'observation'],
      ['2026-11-03T10:00:00Z', 'completely unrelated gardening notes', 'thought'],
    ]);

    const hits = keywordRecallLongTerm(cwd, undefined, 'alpha beta', 2);
    expect(hits.length).toBe(2);
    expect(hits[0].content).toBe('alpha beta gamma deployment');
    expect(hits[0].score).toBe(1);
    expect(hits[1].content).toBe('beta delta rollout');
    expect(hits[1].score).toBe(0.5);
    expect(hits.some((h) => h.content.includes('gardening'))).toBe(false);
  });

  it('breaks score ties by recency, then content — deterministic order', () => {
    seedDailyLog([
      ['2026-11-01T10:00:00Z', 'same score early', 'goal'],
      ['2026-11-05T10:00:00Z', 'same score late', 'goal'],
    ]);

    const hits = keywordRecallLongTerm(cwd, undefined, 'same score', 2);
    expect(hits[0].content).toBe('same score late');
    expect(hits[1].content).toBe('same score early');
  });

  it('returns an empty list (never an error) when the store is missing', () => {
    expect(keywordRecallLongTerm(cwd, undefined, 'anything', 5)).toEqual([]);
  });

  it('returns an empty list when the store exists but has no daily-log table', () => {
    new Database(join(cwd, 'agents', 'data', 'memory', 'short_term.db')).close();
    expect(keywordRecallLongTerm(cwd, undefined, 'anything', 5)).toEqual([]);
  });
});

describe('recall health — transition telemetry', () => {
  let telemetryDir: string;

  beforeEach(() => {
    telemetryDir = mkdtempSync(join(tmpdir(), 'uap-recall-telemetry-'));
    process.env.UAP_MEMORY_TELEMETRY_DIR = telemetryDir;
  });
  afterEach(() => {
    delete process.env.UAP_MEMORY_TELEMETRY_DIR;
    rmSync(telemetryDir, { recursive: true, force: true });
  });

  it('honors the telemetry-dir override and records one line per state change', () => {
    expect(recallHealthTelemetryPath()).toBe(join(telemetryDir, 'memory-health.jsonl'));

    const bothDown = health({
      qdrant: 'unreachable',
      embeddings: 'fallback',
      activeEmbeddingProvider: 'tfidf-enhanced',
      degraded: [degradation('qdrant', 'unreachable'), degradation('embeddings', 'fallback')],
    });

    recordRecallHealthEvent(bothDown);
    recordRecallHealthEvent(bothDown); // same signature — throttled
    const path = join(telemetryDir, 'memory-health.jsonl');
    const afterFirst = readFileSync(path, 'utf-8').trim().split('\n');
    expect(afterFirst.length).toBe(1);
    const first = JSON.parse(afterFirst[0]) as { signature: string; qdrant: string };
    expect(first.signature).toBe('embeddings,qdrant');
    expect(first.qdrant).toBe('unreachable');

    // A different degraded set is a NEW transition — recorded.
    recordRecallHealthEvent(
      health({ qdrant: 'unreachable', degraded: [degradation('qdrant', 'unreachable')] })
    );
    const afterSecond = readFileSync(path, 'utf-8').trim().split('\n');
    expect(afterSecond.length).toBe(2);
  });

  it('never writes for a healthy probe', () => {
    recordRecallHealthEvent(health());
    expect(existsSync(join(telemetryDir, 'memory-health.jsonl'))).toBe(false);
  });
});

describe('recall health — embedding provider transparency', () => {
  it('flags the always-available tier as semantically incompatible', () => {
    expect(FALLBACK_EMBEDDING_PROVIDERS.has('tfidf-enhanced')).toBe(true);
    expect(isFallbackEmbeddingProvider('tfidf-enhanced')).toBe(true);
    expect(isFallbackEmbeddingProvider('llama-cpp')).toBe(false);
    expect(isFallbackEmbeddingProvider('ollama')).toBe(false);
    expect(isFallbackEmbeddingProvider(null)).toBe(false);
    expect(isFallbackEmbeddingProvider(undefined)).toBe(false);
  });

  it('reports no active provider before initialization', () => {
    expect(new EmbeddingService().getActiveProviderName()).toBeNull();
  });
});
