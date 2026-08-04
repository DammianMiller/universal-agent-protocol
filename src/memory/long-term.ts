/**
 * Long-term semantic memory — the durable tier.
 *
 * Until now `uap memory store` wrote only to short-term SQLite, which is a
 * rolling window pruned on every write, and printed "Long-term semantic storage
 * requires Qdrant + embedding service (not yet integrated)". Qdrant was running
 * with zero collections, so `uap memory query` reported nothing to search and
 * every recorded learning expired as soon as the window filled.
 *
 * The read path already existed (queryQdrant in cli/memory.ts). This is its
 * missing counterpart, and it matches that path's conventions exactly:
 *   * collection `memory.longTerm.collection` (default `agent_memory`);
 *   * nomic asymmetric retrieval — documents embedded with a `search_document:`
 *     prefix, queries with `search_query:`. Mismatching the two silently
 *     destroys recall quality, which is why it is spelled out at both ends.
 *
 * Fail-soft throughout: memory is a side effect of doing the work, and must
 * never be the reason a command fails.
 */
import { randomUUID } from 'crypto';
import { getQdrantClientClass } from '../utils/lazy-imports.js';
import { generateEmbedding } from './embeddings.js';
import type { AgentContextConfig } from '../types/index.js';

export interface LongTermEntry {
  content: string;
  type: string;
  importance: number;
  tags?: string[];
  project?: string;
}

export interface LongTermResult {
  stored: boolean;
  reason?: string;
  collection?: string;
}

function endpointUrl(config: AgentContextConfig): string {
  const endpoint = config.memory?.longTerm?.endpoint || 'localhost:6333';
  return endpoint.startsWith('http://') || endpoint.startsWith('https://')
    ? endpoint
    : `http://${endpoint}`;
}

/**
 * Store one memory in the semantic tier. Returns why it was skipped rather
 * than throwing, so the caller can report honestly instead of claiming success.
 */
export async function storeLongTerm(
  config: AgentContextConfig,
  entry: LongTermEntry
): Promise<LongTermResult> {
  const collection = config.memory?.longTerm?.collection || 'agent_memory';

  let vector: number[];
  try {
    // Document side of the asymmetric pair — see queryQdrant for the query side.
    vector = await generateEmbedding(`search_document: ${entry.content}`);
  } catch (error) {
    return { stored: false, reason: `embedding service unavailable: ${String(error).slice(0, 120)}` };
  }
  if (!Array.isArray(vector) || vector.length === 0) {
    return { stored: false, reason: 'embedding service returned an empty vector' };
  }

  try {
    const QdrantClientClass = await getQdrantClientClass();
    const client = new QdrantClientClass({
      url: endpointUrl(config),
      apiKey: config.memory?.longTerm?.qdrantCloud?.apiKey || process.env.QDRANT_API_KEY,
      // Tolerate client/server minor-version skew, as the read path does — the
      // hard compatibility check silently breaks recall.
      checkCompatibility: false,
    });

    const target = await resolveCollection(client, collection, vector.length);
    if (!target.name) {
      return { stored: false, reason: target.reason };
    }

    await client.upsert(target.name, {
      wait: true,
      points: [
        {
          id: randomUUID(),
          vector,
          payload: {
            content: entry.content,
            type: entry.type,
            importance: entry.importance,
            tags: entry.tags ?? [],
            project: entry.project ?? 'unknown',
            stored_at: new Date().toISOString(),
          },
        },
      ],
    });

    return { stored: true, collection: target.name };
  } catch (error) {
    return { stored: false, reason: `qdrant unavailable: ${String(error).slice(0, 120)}` };
  }
}

/** Suffix for a collection pinned to a specific embedding width. */
export function dimensionedName(base: string, dim: number): string {
  return `${base}_v${dim}`;
}

/**
 * Pick a collection whose vector width matches the live embedding model.
 *
 * Embedding models change — this store holds a 384-wide `agent_memory` from an
 * older model alongside a 768-wide one from the current nomic model. Writing a
 * 768 vector into the 384 collection is rejected outright, and SEARCHING it is
 * worse: the read path catches the dimension error per collection and moves on,
 * so those 1551 points are simply unreachable while looking present.
 *
 * So the width is resolved rather than assumed, and a mismatched collection is
 * left untouched rather than recreated — dropping someone's memories to fix a
 * write is not a trade this should make silently. A width-suffixed sibling is
 * used instead, and the caller reports which one it landed in.
 */
type QdrantLike = InstanceType<Awaited<ReturnType<typeof getQdrantClientClass>>>;

async function resolveCollection(
  client: QdrantLike,
  base: string,
  dim: number
): Promise<{ name?: string; reason?: string }> {
  const existing = (await client.getCollections()).collections.map((c) => c.name);

  const widthOf = async (name: string): Promise<number | undefined> => {
    try {
      const info = (await client.getCollection(name)) as {
        config?: { params?: { vectors?: { size?: number } | Record<string, { size?: number }> } };
      };
      const vectors = info.config?.params?.vectors as { size?: number } | undefined;
      return typeof vectors?.size === 'number' ? vectors.size : undefined;
    } catch {
      return undefined;
    }
  };

  // Preferred: the configured name, when its width already matches.
  if (existing.includes(base)) {
    if ((await widthOf(base)) === dim) return { name: base };
  } else {
    await client.createCollection(base, { vectors: { size: dim, distance: 'Cosine' } });
    return { name: base };
  }

  // The configured name exists at a different width. Use a width-pinned sibling.
  const sibling = dimensionedName(base, dim);
  if (!existing.includes(sibling)) {
    await client.createCollection(sibling, { vectors: { size: dim, distance: 'Cosine' } });
  } else if ((await widthOf(sibling)) !== dim) {
    return { reason: `collection ${sibling} exists with a different vector width` };
  }
  return { name: sibling };
}
