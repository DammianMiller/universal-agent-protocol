import { describe, it, expect, vi } from 'vitest';
import {
  InMemoryPracticeStore,
  retrievePracticesSemantic,
  type PracticeCard,
  type SemanticRetriever,
} from '../../src/delivery/practice.js';

function card(id: string, keywords: string[], successCount = 1, bestTurns = 1): PracticeCard {
  return { id, strategy: 'direct', keywords, guidance: `guidance-${id}`, successCount, bestTurns };
}

/**
 * Deterministic fake embedder: maps each known token to a basis vector so
 * cosine similarity reflects shared-token overlap, independent of any real
 * embedding service.
 */
function fakeRetriever(vocab: string[]): SemanticRetriever {
  const index = new Map(vocab.map((t, i) => [t, i]));
  const embed = async (text: string): Promise<number[]> => {
    const v = new Array(vocab.length).fill(0);
    for (const tok of text.toLowerCase().split(/\s+/)) {
      const i = index.get(tok);
      if (i !== undefined) v[i] += 1;
    }
    return v;
  };
  const cosineSimilarity = (a: number[], b: number[]): number => {
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }
    if (na === 0 || nb === 0) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
  };
  return { embed, cosineSimilarity };
}

describe('retrievePracticesSemantic', () => {
  it('ranks by cosine similarity to the instruction', async () => {
    const store = new InMemoryPracticeStore([
      card('p1', ['duration', 'parse', 'seconds']),
      card('p2', ['fizzbuzz', 'modulo']),
    ]);
    const retriever = fakeRetriever(['duration', 'parse', 'seconds', 'fizzbuzz', 'modulo', 'into']);

    const hits = await retrievePracticesSemantic(store, 'parse duration into seconds', retriever, {
      minSimilarity: 0.3,
    });
    expect(hits.map((c) => c.id)).toEqual(['p1']);
  });

  it('breaks similarity ties by success count then fewest turns', async () => {
    const store = new InMemoryPracticeStore([
      card('weak', ['parse', 'json'], 1, 5),
      card('strong', ['parse', 'json'], 9, 2),
    ]);
    const retriever = fakeRetriever(['parse', 'json']);
    const hits = await retrievePracticesSemantic(store, 'parse json', retriever, { minSimilarity: 0.3 });
    expect(hits[0].id).toBe('strong');
  });

  it('falls back to keyword retrieval when the embedder throws', async () => {
    const store = new InMemoryPracticeStore([card('p1', ['parse', 'json'])]);
    const keywordSpy = vi.spyOn(store, 'retrieve');
    const throwing: SemanticRetriever = {
      embed: async () => {
        throw new Error('embedding service down');
      },
      cosineSimilarity: () => 0,
    };

    const hits = await retrievePracticesSemantic(store, 'parse json', throwing);
    expect(keywordSpy).toHaveBeenCalledWith('parse json', 3);
    expect(hits.map((c) => c.id)).toEqual(['p1']);
  });

  it('falls back to keyword retrieval when no card clears the similarity floor', async () => {
    const store = new InMemoryPracticeStore([card('p1', ['parse', 'json'])]);
    const keywordSpy = vi.spyOn(store, 'retrieve');
    // Embedder yields orthogonal vectors → similarity 0, below floor
    const retriever = fakeRetriever(['unrelated', 'tokens']);

    const hits = await retrievePracticesSemantic(store, 'parse json', retriever);
    expect(keywordSpy).toHaveBeenCalled();
    // keyword path also finds p1 because the query shares 'parse'/'json'
    expect(hits.map((c) => c.id)).toEqual(['p1']);
  });

  it('treats NaN similarity (degenerate vectors) as no-match, not a crash', async () => {
    const store = new InMemoryPracticeStore([card('p1', ['parse'])]);
    const nanRetriever: SemanticRetriever = {
      embed: async () => [0, 0, 0],
      cosineSimilarity: () => NaN,
    };
    // Falls back to keyword retrieval; query shares 'parse'
    const hits = await retrievePracticesSemantic(store, 'parse the input', nanRetriever);
    expect(hits.map((c) => c.id)).toEqual(['p1']);
  });

  it('isolates a single card whose cosineSimilarity throws (dimension mismatch)', async () => {
    const store = new InMemoryPracticeStore([
      card('good', ['parse', 'json']),
      card('bad', ['xml', 'config']),
    ]);
    const retriever: SemanticRetriever = {
      embed: async (text) => (text.includes('xml') ? [1, 2] : [1, 0, 0]), // 'bad' card is 2-dim
      cosineSimilarity: (a, b) => {
        if (a.length !== b.length) throw new Error('Vectors must have same dimensions');
        return a[0] === b[0] ? 1 : 0;
      },
    };
    // The 'bad' card throws; it must drop out, not collapse the batch to keyword
    const hits = await retrievePracticesSemantic(store, 'parse json', retriever, { minSimilarity: 0.3 });
    expect(hits.map((c) => c.id)).toEqual(['good']);
  });

  it('truncates to the limit and honors the default similarity floor', async () => {
    const store = new InMemoryPracticeStore([
      card('p1', ['parse']),
      card('p2', ['parse']),
      card('p3', ['parse']),
      card('p4', ['parse']),
    ]);
    const retriever = fakeRetriever(['parse']);
    // All four are identical → all clear the default 0.45 floor; limit caps at 2
    const hits = await retrievePracticesSemantic(store, 'parse', retriever, { limit: 2 });
    expect(hits).toHaveLength(2);
  });

  it('returns empty (no embedder call) for an empty store', async () => {
    const store = new InMemoryPracticeStore();
    const embed = vi.fn();
    const hits = await retrievePracticesSemantic(store, 'anything', {
      embed,
      cosineSimilarity: () => 1,
    });
    expect(hits).toEqual([]);
    expect(embed).not.toHaveBeenCalled();
  });

  it('falls back when the query embedding is empty', async () => {
    const store = new InMemoryPracticeStore([card('p1', ['parse', 'json'])]);
    const keywordSpy = vi.spyOn(store, 'retrieve');
    const emptyVec: SemanticRetriever = { embed: async () => [], cosineSimilarity: () => 1 };
    await retrievePracticesSemantic(store, 'parse json', emptyVec);
    expect(keywordSpy).toHaveBeenCalled();
  });
});
