/**
 * Version-tolerant vector search for the Qdrant JS client.
 *
 * WHY THIS EXISTS. `@qdrant/js-client-rest` **removed `.search()` in 1.19** in
 * favour of `.query()`. The repo's lockfile resolves 1.17, so tests and CI pass;
 * a global install resolves 1.19, where every `client.search(...)` throws
 * `TypeError: client.search is not a function`.
 *
 * That alone would be loud. What made it silent is that the caller wrapped each
 * per-collection search in a bare `catch {}` — there to tolerate a collection
 * built at a different vector width — so a missing METHOD was swallowed exactly
 * like an incompatible dimension. The store path uses `upsert()`, which still
 * exists, so writes kept succeeding.
 *
 * Net effect, observed 2026-08-06: `uap memory store` reported success while
 * `uap memory query` returned "No results in long-term memory" for text stored
 * seconds earlier. Memory was WRITE-ONLY, and nothing in the output said so.
 *
 * Pinning the dependency would fix today and rot tomorrow; supporting both
 * shapes is what survives the next rename.
 */

/**
 * One scored hit, in the shape both client versions ultimately return.
 *
 * `id` and `vector` are carried even though the memory-query path ignores them:
 * the cloud backend builds MemoryEntry.id from the POINT id, and normalising
 * them away silently turned every entry's id into an empty string.
 */
export interface QdrantHit {
  id?: string | number;
  score: number;
  payload?: Record<string, unknown> | null;
  vector?: number[] | null;
}

/**
 * The slice of the client this module needs. Typed loosely on purpose: the two
 * client versions declare incompatible parameter types for these methods, so a
 * structural interface cannot accept both. The whole point here is to survive
 * that difference, and the shape is verified at runtime before either is called.
 */
type SearchFn = (collection: string, params: never) => Promise<unknown>;
export interface QdrantSearchCapable {
  search?: SearchFn;
  query?: SearchFn;
}

export class QdrantSearchUnsupportedError extends Error {
  constructor() {
    super(
      'Qdrant client exposes neither query() nor search(). The installed ' +
        '@qdrant/js-client-rest is incompatible with this build.'
    );
    this.name = 'QdrantSearchUnsupportedError';
  }
}

/** True when the failure is a collection whose vector width differs — expected. */
export function isDimensionMismatch(error: unknown): boolean {
  const msg = String((error as { message?: string })?.message ?? error);
  return /dimension error|expected dim|Bad Request|Wrong input/i.test(msg);
}

function normalize(raw: unknown): QdrantHit[] {
  // 1.19 `query()` -> { points: [...] }; 1.17 `search()` -> [...]
  const rows = Array.isArray(raw)
    ? raw
    : ((raw as { points?: unknown[] } | null)?.points ?? []);
  type Row = {
    id?: string | number;
    score?: number;
    payload?: Record<string, unknown> | null;
    vector?: unknown;
  };
  return (rows as Row[]).map((r) => ({
    id: r.id,
    score: typeof r.score === 'number' ? r.score : 0,
    payload: r.payload ?? null,
    vector: Array.isArray(r.vector) ? (r.vector as number[]) : null,
  }));
}

/**
 * Search `collection` by vector, using whichever API the client provides.
 *
 * Throws QdrantSearchUnsupportedError when neither exists — deliberately NOT
 * returning an empty array, because "no method" and "no matches" are different
 * facts and conflating them is what hid this bug for a day.
 */
export async function searchByVector(
  client: QdrantSearchCapable,
  collection: string,
  vector: number[],
  limit: number,
  scoreThreshold?: number
): Promise<QdrantHit[]> {
  // Kept server-side rather than filtering the results here: Qdrant applies the
  // threshold BEFORE `limit`, so filtering afterwards would silently return
  // fewer than `limit` relevant hits. Both client versions accept the field.
  const extra = scoreThreshold === undefined ? {} : { score_threshold: scoreThreshold };
  const call = (fn: SearchFn, params: Record<string, unknown>): Promise<unknown> =>
    fn.call(client, collection, params as never);

  if (typeof client.query === 'function') {
    // 1.19+ : the vector goes in `query`.
    return normalize(
      await call(client.query, { query: vector, limit, with_payload: true, ...extra })
    );
  }
  if (typeof client.search === 'function') {
    // <=1.18 : the vector goes in `vector`.
    return normalize(await call(client.search, { vector, limit, with_payload: true, ...extra }));
  }
  throw new QdrantSearchUnsupportedError();
}
