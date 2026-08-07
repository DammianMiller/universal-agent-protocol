/**
 * Memory was WRITE-ONLY for a day and nothing said so.
 *
 * `@qdrant/js-client-rest` removed `.search()` in 1.19, replacing it with
 * `.query()`. The repo's lockfile resolves 1.17, so tests and CI passed; a
 * global install resolved 1.19, where every `client.search(...)` threw
 * `TypeError: client.search is not a function`.
 *
 * What made it silent rather than loud: the caller wrapped each per-collection
 * search in a bare `catch {}` — there to tolerate a collection built at a
 * different vector width — so a missing METHOD was swallowed exactly like an
 * incompatible dimension. Stores use `upsert()`, which still exists, so writes
 * kept reporting success while every query returned "No results".
 *
 * These tests pin both halves: call whichever API exists, and never confuse a
 * broken client with an empty result set.
 */
import { describe, it, expect } from 'vitest';
import {
  searchByVector,
  isDimensionMismatch,
  QdrantSearchUnsupportedError,
} from '../src/memory/qdrant-search.js';

const VEC = [0.1, 0.2, 0.3];

/** Client as of 1.19+: only `query`, and it returns `{ points: [...] }`. */
function newClient(capture: Record<string, unknown> = {}) {
  return {
    query: async (collection: string, params: Record<string, unknown>) => {
      capture.collection = collection;
      capture.params = params;
      return { points: [{ score: 0.9, payload: { content: 'new-api' } }] };
    },
  };
}

/** Client up to 1.18: only `search`, and it returns a bare array. */
function oldClient(capture: Record<string, unknown> = {}) {
  return {
    search: async (collection: string, params: Record<string, unknown>) => {
      capture.collection = collection;
      capture.params = params;
      return [{ score: 0.8, payload: { content: 'old-api' } }];
    },
  };
}

describe('searchByVector across client versions', () => {
  it('uses query() and unwraps points on a 1.19 client', async () => {
    const cap: Record<string, unknown> = {};
    const hits = await searchByVector(newClient(cap), 'agent_memory_v768', VEC, 10);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ score: 0.9, payload: { content: 'new-api' } });
    // 1.19 takes the vector under `query`, not `vector` — getting this wrong
    // is a 400, not a TypeError, so it would fail differently and just as quietly.
    expect((cap.params as Record<string, unknown>).query).toBe(VEC);
    expect(cap.collection).toBe('agent_memory_v768');
  });

  it('uses search() on an older client and returns the same shape', async () => {
    const cap: Record<string, unknown> = {};
    const hits = await searchByVector(oldClient(cap), 'agent_memory', VEC, 10);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ score: 0.8, payload: { content: 'old-api' } });
    expect((cap.params as Record<string, unknown>).vector).toBe(VEC);
  });

  it('prefers query() when a client somehow exposes both', async () => {
    const client = { ...oldClient(), ...newClient() };
    const hits = await searchByVector(client, 'c', VEC, 5);
    expect(hits[0].payload).toEqual({ content: 'new-api' });
  });

  it('THROWS rather than returning [] when neither method exists', async () => {
    // The load-bearing assertion. Returning [] here is what let a broken client
    // masquerade as "no matches" for a day.
    await expect(searchByVector({}, 'c', VEC, 5)).rejects.toBeInstanceOf(
      QdrantSearchUnsupportedError
    );
  });

  it('passes the limit through', async () => {
    const cap: Record<string, unknown> = {};
    await searchByVector(newClient(cap), 'c', VEC, 7);
    expect((cap.params as Record<string, unknown>).limit).toBe(7);
  });

  it('tolerates a missing payload and a missing score', async () => {
    const client = { query: async () => ({ points: [{}] }) };
    expect(await searchByVector(client, 'c', VEC, 1)).toMatchObject([{ score: 0, payload: null }]);
  });

  it('treats an absent points key as no results, not a crash', async () => {
    const client = { query: async () => ({}) };
    expect(await searchByVector(client, 'c', VEC, 1)).toEqual([]);
  });
});

describe('isDimensionMismatch', () => {
  it('recognises the width error that is expected and must stay quiet', () => {
    // An older collection built by a different embedding model. The
    // width-pinned sibling in the candidate list is the one that answers.
    expect(
      isDimensionMismatch(new Error('Wrong input: Vector dimension error: expected dim: 384, got 768'))
    ).toBe(true);
    expect(isDimensionMismatch(new Error('Bad Request'))).toBe(true);
  });

  it('does NOT excuse a missing method', () => {
    // The whole bug: this must be reported, not swallowed as routine.
    expect(isDimensionMismatch(new TypeError('client.search is not a function'))).toBe(false);
    expect(isDimensionMismatch(new QdrantSearchUnsupportedError())).toBe(false);
  });
});
