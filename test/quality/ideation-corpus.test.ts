/**
 * Corpus-novelty (plan F, the seam half) — the retread axis.
 *
 * The in-set ideaDistance cannot see retreads; corpusDistance measures each
 * candidate against the fleet's PRIOR art on the live embedding seam. These
 * tests pin the contract through the injected seam (embed/search/list):
 *   * the measured math: distance = 1 - top prior-art score, mean/min
 *   * the `search_query:` asymmetric-retrieval prefix (nomic doctrine)
 *   * collection-variant filtering (configured + _prepopulated + dimensioned)
 *   * dimension-mismatch skip vs real-fault propagation (the qdrant doctrine:
 *     "no method" and "no matches" are different facts)
 *   * fail-OPEN with an explicit reason on every unavailable seam state:
 *     degraded provider, no provider, no candidates, embed failure, no
 *     collections, empty corpus — never silent zeros
 *   * partial hits: a candidate with no nearby prior measures 1.0 while the
 *     set stays measurable
 */
import { describe, expect, it } from 'vitest';
import {
  corpusNovelty,
  CorpusCandidate,
} from '../../src/quality/ideation-corpus.js';

const CAND: CorpusCandidate[] = [
  { prose: 'Move the warm-pixel probe onto local lantern emissives with tight falloff.' },
  { prose: 'A 12-step hue ramp across every material family, one ramp entry each.' },
];

/** A seam bundle: embed captures inputs, search serves fixed hits, list names fixed collections. */
function seam(overrides: {
  scores?: number[][];
  collections?: string[];
  searchThrows?: (col: string) => Error | null;
  embedImpl?: (text: string) => Promise<number[]>;
} = {}) {
  const embedInputs: string[] = [];
  const searchedCollections: string[][] = [];
  const embed = overrides.embedImpl ?? (async (text: string) => {
    embedInputs.push(text);
    // 768-dim like the nomic seam — the dimension selects the collection
    // variant name (agent_memory_v768), so the stub must match reality.
    return new Array<number>(768).fill(0);
  });
  const scores = overrides.scores ?? [[0.9, 0.4], [0.2]];
  const search = async (
    _client: unknown,
    collection: string,
    _vector: number[],
    _limit: number
  ) => {
    searchedCollections.push([collection]);
    const thrower = overrides.searchThrows?.(collection) ?? null;
    if (thrower) throw thrower;
    const row = scores[Math.min(searchedCollections.length - 1, scores.length - 1)] ?? [];
    return row.map((score) => ({ score, payload: { content: 'prior memory' } }));
  };
  const list = async () =>
    overrides.collections ?? ['agent_memory_v768', 'unrelated_collection'];
  return { embed, search, listCollections: list, embedInputs, searchedCollections };
}

describe('corpusNovelty — measured math', () => {
  it('distance is 1 - top prior-art score per candidate, with mean and min', async () => {
    const s = seam({ scores: [[0.9], [0.5]] });
    const r = await corpusNovelty(CAND, {
      ...s,
      providerName: () => 'llama-cpp',
    });
    expect(r.ok).toBe(true);
    expect(r.perCandidate).toEqual([0.1, 0.5]);
    expect(r.mean).toBeCloseTo(0.3, 5);
    expect(r.min).toBeCloseTo(0.1, 5);
  });

  it('takes the CLOSEST prior across collections (max score)', async () => {
    const s = seam({
      scores: [[0.9], [0.95]],
      collections: ['agent_memory', 'agent_memory_v768'],
    });
    const r = await corpusNovelty([CAND[0]], {
      ...s,
      providerName: () => 'llama-cpp',
    });
    expect(r.ok).toBe(true);
    expect(s.searchedCollections.flat()).toEqual(['agent_memory', 'agent_memory_v768']);
    expect(r.perCandidate).toEqual([0.05]);
  });

  it('embeds each candidate with the nomic search_query: prefix', async () => {
    const s = seam({ scores: [[0.7]] });
    await corpusNovelty([CAND[0]], { ...s, providerName: () => 'llama-cpp' });
    expect(s.embedInputs).toHaveLength(1);
    expect(s.embedInputs[0].startsWith('search_query: ')).toBe(true);
    expect(s.embedInputs[0]).toContain('lantern emissives');
  });

  it('searches only the wanted collection variants that exist', async () => {
    const s = seam({ scores: [[0.8]], collections: ['agent_memory_v768', 'unrelated'] });
    await corpusNovelty([CAND[0]], {
      ...s,
      providerName: () => 'llama-cpp',
      collection: 'agent_memory',
    });
    const searched = s.searchedCollections.flat();
    expect(searched).toEqual(['agent_memory_v768']);
  });
});

describe('corpusNovelty — the qdrant doctrine', () => {
  it('skips a dimension-mismatched collection and measures from the sibling', async () => {
    const s = seam({
      scores: [[0.6]],
      collections: ['agent_memory', 'agent_memory_v768'],
      searchThrows: (col) =>
        col === 'agent_memory'
          ? new Error('Wrong input: expected dim 768 got 384 (dimension error)')
          : null,
    });
    const r = await corpusNovelty([CAND[0]], {
      ...s,
      providerName: () => 'llama-cpp',
      collection: 'agent_memory',
    });
    expect(r.ok).toBe(true);
    expect(r.perCandidate).toEqual([0.4]);
  });

  it('propagates a real search fault as ok:false with the collection named', async () => {
    const s = seam({
      scores: [[0.6]],
      searchThrows: () => new Error('connection refused'),
    });
    const r = await corpusNovelty([CAND[0]], { ...s, providerName: () => 'llama-cpp' });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('agent_memory_v768');
    expect(r.reason).toContain('connection refused');
  });

  it('a candidate with no nearby prior measures 1.0 while the set stays measurable', async () => {
    const s = seam({ scores: [[], [0.9]] });
    const r = await corpusNovelty(CAND, { ...s, providerName: () => 'llama-cpp' });
    expect(r.ok).toBe(true);
    expect(r.perCandidate?.[0]).toBe(1);
    expect(r.perCandidate?.[1]).toBeCloseTo(0.1, 5);
  });
});

describe('corpusNovelty — fail-open with an explicit reason', () => {
  it('refuses a degraded embedding provider by name', async () => {
    const r = await corpusNovelty(CAND, { providerName: () => 'tfidf-enhanced' });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('tfidf-enhanced');
    expect(r.reason).toContain('degraded');
  });

  it('refuses when no provider is available', async () => {
    const r = await corpusNovelty(CAND, { providerName: () => null });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('no embedding provider');
  });

  it('refuses an empty candidate set', async () => {
    const r = await corpusNovelty([], { providerName: () => 'llama-cpp' });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('no candidates');
  });

  it('reports embed failure instead of zero distances', async () => {
    const r = await corpusNovelty(CAND, {
      providerName: () => 'llama-cpp',
      embed: async () => {
        throw new Error('endpoint down');
      },
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('embedding failed');
    expect(r.reason).toContain('endpoint down');
  });

  it('reports no-collection and empty-corpus as different facts', async () => {
    const none = await corpusNovelty([CAND[0]], {
      providerName: () => 'llama-cpp',
      ...seam({ collections: [], scores: [[0.5]] }),
    });
    expect(none.ok).toBe(false);
    expect(none.reason).toContain('no long-term collections');

    const empty = await corpusNovelty([CAND[0]], {
      providerName: () => 'llama-cpp',
      ...seam({ scores: [[]] }),
    });
    expect(empty.ok).toBe(false);
    expect(empty.reason).toContain('no prior art indexed');
  });
});
