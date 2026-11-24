/**
 * Corpus-novelty — the plan-F novelty-distance axis on the live embedding
 * seam: how far each candidate idea sits from the NEAREST PRIOR solution in
 * the fleet's semantic store.
 *
 * The in-set ideaDistance (ideation.ts) detects hivemind clustering between
 * the candidates of ONE artifact; it cannot see retreads — a set can be
 * maximally disjoint internally and still be the fleet's hundredth
 * variation on a known theme. corpusDistance is the missing half: for each
 * candidate, embed it as a retrieval query and measure 1 - top similarity
 * against the long-term memory collections. Near 0: the idea re-treads
 * ground the corpus already covers. Near 1: no prior art nearby.
 *
 * Contract — fail-OPEN with an explicit reason, never silently degraded:
 *   ok: true   perCandidate/mean/min are measured distances
 *   ok: false  reason says why (no real embedding provider, backend
 *              unreachable, no collections, no prior art indexed) and the
 *              numbers are NOT returned — an unavailable axis and a zero
 *              axis are different facts (the qdrant-search doctrine).
 *
 * Async + networked BY DESIGN. The deterministic extractor
 * (extractIdeationVector) stays pure — no RNG, no clocks, no network — so
 * tier vectors remain reproducible; corpus-novelty is a curation-time
 * overlay on `uap ideate`, not a stored axis.
 */
import { loadUapConfig } from '../utils/config-loader.js';
import {
  generateEmbedding,
  getActiveEmbeddingProviderName,
  isFallbackEmbeddingProvider,
} from '../memory/embeddings.js';
import { getQdrantClientClass } from '../utils/lazy-imports.js';
import { searchByVector, isDimensionMismatch } from '../memory/qdrant-search.js';
import { dimensionedName } from '../memory/long-term.js';

/** A candidate to measure: prose as the ideation sections carry it. */
export interface CorpusCandidate {
  prose: string;
}

/** The store as corpus-novelty needs it: searchable + listable. The real
 *  Qdrant client satisfies this structurally; tests inject stubs. */
export type CorpusStore = {
  search?: (
    collection: string,
    params: never
  ) => Promise<unknown>;
  query?: (
    collection: string,
    params: never
  ) => Promise<unknown>;
  getCollections: () => Promise<{ collections: Array<{ name: string }> }>;
};

/** Injected-seam overrides (tests). Defaults are the live services. */
export interface CorpusNoveltyOpts {
  cwd?: string;
  collection?: string;
  limitPerCollection?: number;
  embed?: (text: string) => Promise<number[]>;
  search?: (
    client: unknown,
    collection: string,
    vector: number[],
    limit: number
  ) => Promise<Array<{ score: number; payload?: Record<string, unknown> | null }>>;
  listCollections?: (client: unknown) => Promise<string[]>;
  providerName?: () => string | null;
}

export interface CorpusNoveltyResult {
  ok: boolean;
  reason?: string;
  provider: string | null;
  collections: string[];
  /** 1 - top prior-art similarity per candidate (ok only). */
  perCandidate?: number[];
  /** Mean over candidates (ok only). */
  mean?: number;
  /** The candidate closest to prior art (ok only). */
  min?: number;
}

const r5 = (x: number): number => Math.round(x * 1e5) / 1e5;

/** Measure corpus-novelty of a candidate set against the memory store. */
export async function corpusNovelty(
  candidates: CorpusCandidate[],
  opts: CorpusNoveltyOpts = {}
): Promise<CorpusNoveltyResult> {
  if (candidates.length === 0) {
    return { ok: false, reason: 'no candidates', provider: null, collections: [] };
  }

  const embed = opts.embed ?? generateEmbedding;

  // Embed FIRST (generateEmbedding initializes the service — the provider
  // is unresolved until then), THEN read the active provider name. The
  // first embed also fixes the dimension for the sibling collection name.
  const vectors: number[][] = [];
  for (const c of candidates) {
    try {
      vectors.push(await embed(`search_query: ${c.prose}`));
    } catch (error) {
      return {
        ok: false,
        reason: `embedding failed: ${String((error as { message?: string })?.message ?? error)}`,
        provider: (opts.providerName ?? getActiveEmbeddingProviderName)(),
        collections: [],
      };
    }
  }
  const provider = (opts.providerName ?? getActiveEmbeddingProviderName)();
  if (!provider || isFallbackEmbeddingProvider(provider)) {
    return {
      ok: false,
      reason: provider
        ? `embedding provider '${provider}' is degraded — corpus distance would be meaningless`
        : 'no embedding provider available',
      provider,
      collections: [],
    };
  }

  const config = loadUapConfig(opts.cwd ?? process.cwd());
  const endpoint = config?.memory?.longTerm?.endpoint || 'localhost:6333';
  const url = endpoint.startsWith('http://') || endpoint.startsWith('https://')
    ? endpoint
    : `http://${endpoint}`;
  const apiKey = config?.memory?.longTerm?.qdrantCloud?.apiKey || process.env.QDRANT_API_KEY;
  const configuredCollection = opts.collection ?? config?.memory?.longTerm?.collection ?? 'agent_memory';
  const limit = opts.limitPerCollection ?? 5;

  const search = opts.search ?? searchByVector;

  let client: CorpusStore;
  let list: (c: unknown) => Promise<string[]>;
  if (opts.listCollections) {
    list = opts.listCollections;
    client = null as unknown as CorpusStore; // injected seam never touches the real client
  } else {
    const QdrantClientClass = await getQdrantClientClass();
    client = new QdrantClientClass({ url, apiKey, checkCompatibility: false }) as CorpusStore;
    list = async (c) => (await (c as CorpusStore).getCollections()).collections.map((x) => x.name);
  }

  const dim = vectors[0]?.length ?? 0;
  const wanted = [
    configuredCollection,
    `${configuredCollection}_prepopulated`,
    dimensionedName(configuredCollection, dim),
  ];
  const available = (await list(client)).filter((name) => wanted.includes(name));
  if (available.length === 0) {
    return {
      ok: false,
      reason: `no long-term collections among [${wanted.join(', ')}] — nothing to compare against`,
      provider,
      collections: [],
    };
  }

  const per: number[] = [];
  let sawHit = false;
  for (const vector of vectors) {
    let top = -1;
    for (const col of available) {
      try {
        const hits = await search(client, col, vector, limit);
        for (const h of hits) {
          if (h.payload?.content) top = Math.max(top, h.score);
        }
      } catch (error) {
        if (isDimensionMismatch(error)) continue; // expected width skew
        return {
          ok: false,
          reason: `search failed on ${col}: ${String((error as { message?: string })?.message ?? error)}`,
          provider,
          collections: available,
        };
      }
    }
    if (top >= 0) {
      sawHit = true;
      per.push(r5(1 - top));
    } else {
      // No prior art near THIS candidate — not an error; maximally novel.
      per.push(1);
    }
  }
  if (!sawHit) {
    return {
      ok: false,
      reason: 'no prior art indexed — every candidate had zero hits; the corpus is empty',
      provider,
      collections: available,
    };
  }
  const mean = per.reduce((a, b) => a + b, 0) / per.length;
  const min = per.reduce((a, b) => Math.min(a, b), Infinity);
  return {
    ok: true,
    provider,
    collections: available,
    perCandidate: per,
    mean: r5(mean),
    min: r5(min),
  };
}
