import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DailyLog, DailyLogEntry } from '../../src/memory/daily-log.js';
import { promoteFromDailyLog, semanticEntriesFor } from '../../src/cli/memory.js';
import { createLlamaCppEmbeddingResponse } from '../utils/mock-helpers.js';

let dir: string;
let logs: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'uap-promote-'));
  logs = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logs.push(args.join(' '));
  });
  // ora spinners print through process.stderr — capture that stream too, or
  // every spinner.succeed/fail line (the very lines under test) goes unseen.
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
    logs.push(String(chunk));
    return true;
  }) as typeof process.stderr.write);
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  rmSync(dir, { recursive: true, force: true });
});

const out = (): string => logs.join('\n');

const entry = (over: Partial<DailyLogEntry>): DailyLogEntry => ({
  id: 7,
  date: '2026-11-23',
  timestamp: '2026-11-23T01:02:03.000Z',
  content: 'Swift 1.5 IQ3 trial live since 2026-10-17',
  type: 'lesson',
  promoted: false,
  gateScore: 0.74,
  ...over,
});

describe('E.3 semanticEntriesFor — the daily-log → MemoryEntry mapping', () => {
  it('maps a valid entry with tags, rounded importance, and provenance metadata', () => {
    const [m] = semanticEntriesFor([entry({})]);
    expect(m.id).toBe('7');
    expect(m.timestamp).toBe('2026-11-23T01:02:03.000Z');
    expect(m.type).toBe('lesson');
    expect(m.content).toContain('Swift 1.5');
    expect(m.tags).toEqual(['daily-log', 'promoted']);
    expect(m.importance).toBe(7); // 0.74 -> 7
    expect(m.metadata).toEqual({ source: 'daily-log-promote', gateScore: 0.74 });
  });

  it('falls back to observation for non-memory types and to date when timestamp is empty', () => {
    const [m] = semanticEntriesFor([entry({ type: 'weather', timestamp: '' })]);
    expect(m.type).toBe('observation');
    expect(new Date(m.timestamp).toISOString()).toBe(new Date('2026-11-23').toISOString());
  });

  it('rounds importance toward the gate score (0.66 -> 7, 0.31 -> 3)', () => {
    const ms = semanticEntriesFor([entry({ gateScore: 0.66 }), entry({ id: 8, gateScore: 0.31 })]);
    expect(ms[0].importance).toBe(7);
    expect(ms[1].importance).toBe(3);
  });
});

/** The DB path promoteFromDailyLog resolves for a config-less cwd. */
function promoteDbPath(): string {
  return join(dir, 'agents', 'data', 'memory', 'short_term.db');
}

/** A daily-log DB holding one semantic-tier candidate (0.3 <= score < 0.6). */
function seededDb(): string {
  const dbPath = promoteDbPath();
  const log = new DailyLog(dbPath);
  log.write('Frontier-parity wave 2 shipped anchors plus approve', 'thought', 0.45);
  log.close();
  return dbPath;
}

describe('E.3 promoteFromDailyLog — the semantic tier actually embeds', () => {
  it('embeds semantic candidates and reports the backend (Qdrant + embedder mocked)', async () => {
    const dbPath = seededDb();
    // Route fetch: Qdrant REST at :6333 answers generically; the embedder at
    // :8081 answers the llama.cpp protocol. Everything else fails loudly.
    const fetchMock = vi.fn(async (input: unknown) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes(':6333')) {
        if (url.endsWith('/collections') || url.endsWith('/collections/')) {
          return new Response(JSON.stringify({ result: { collections: [] } }), { status: 200 });
        }
        // collection info + create + upsert all pass with a generic result.
        return new Response(JSON.stringify({ result: {} }), { status: 200 });
      }
      if (url.includes(':8081')) {
        return new Response(
          JSON.stringify(createLlamaCppEmbeddingResponse(['x'], 768)),
          { status: 200 }
        );
      }
      return new Response('unreachable', { status: 503 });
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    await promoteFromDailyLog(dir, {});

    expect(out()).toContain('Marked for semantic storage');
    expect(out()).toMatch(/Embedded 1 semantic entr/);
    // The upsert reached the collection API — the promise was actually kept.
    const upserts = fetchMock.mock.calls.filter(([u]) => String(u).includes(':6333'));
    expect(upserts.length).toBeGreaterThan(0);

    // The daily-log row is marked promoted-to-semantic.
    const check = new DailyLog(dbPath);
    const stats = check.getStats();
    check.close();
    expect(stats.promoted).toBe(1);
  });

  it('says so plainly when the semantic embedding fails — never reports a durable write that did not happen', async () => {
    const dbPath = seededDb();
    vi.stubGlobal('fetch', (async () => new Response('down', { status: 503 })) as unknown as typeof fetch);

    await promoteFromDailyLog(dir, {});

    expect(out()).toContain('Marked for semantic storage');
    expect(out()).toContain('Semantic embedding FAILED');
    expect(out()).toContain('marked promoted but remain unrecall-able');
    // Still marked — the operator can re-run promote after restoring Qdrant.
    const check = new DailyLog(dbPath);
    const stats = check.getStats();
    check.close();
    expect(stats.promoted).toBe(1);
  });

  it('reports no candidates when the log is empty', async () => {
    const log = new DailyLog(promoteDbPath());
    log.close();
    await promoteFromDailyLog(dir, {});
    expect(out()).toContain('No candidates for promotion');
  });
});
