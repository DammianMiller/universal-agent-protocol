/**
 * Wiring active reconstruction to UAP's real memory stores (harness plan E3).
 *
 * Resolves where the graph lives, fills it from the stores UAP already writes
 * (short-term SQLite AND the long-term semantic store), and exposes the entry
 * point callers use: `recallActive`.
 *
 * The graph is a DERIVED index, never a source of truth: it can be deleted and
 * rebuilt at any time. (It is not side-effect free, though — opening the
 * short-term store runs `ensureShortTermSchema`, which creates indexes and can
 * backfill FTS. That means a build needs a writable store.)
 *
 * COVERAGE IS THE CORRECTNESS PROPERTY HERE. The passive path queries short-term
 * FTS *and* the long-term semantic store. If active recall indexed only the
 * short-term store — a rolling ~50-entry window — then routing a query here
 * would silently drop every durable memory the project has, which is a
 * regression wearing a feature's clothes. So ingestion covers both tiers, and
 * `recallActive` reports what it covered.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadUapConfig } from '../utils/config-loader.js';
import {
  MemoryGraph,
  reconstruct,
  heuristicPolicy,
  activeReconstructionEnabled,
  type ReconstructionResult,
  type ReconstructionPolicy,
} from './reconstruct.js';
import { ingestItems, itemKey, type IngestItem, type IngestResult } from './reconstruct-ingest.js';

/** Where the derived graph lives, alongside the stores it indexes. */
export function memoryGraphPath(cwd: string): string {
  return join(cwd, 'agents', 'data', 'memory', 'memory-graph.db');
}

/**
 * Resolve short-term store + project id the way `uap memory query` does.
 *
 * Reading these from the config rather than hardcoding defaults matters: a
 * project with a configured store path, or any project not literally named
 * "project", was otherwise indexing zero rows while reporting success — because
 * `getRecent` filters on `project_id`.
 */
export function resolveStoreConfig(
  cwd: string,
  opts: BuildOptions = {},
): { shortTermPath: string; projectId: string } {
  const config = loadUapConfig(cwd);
  return {
    shortTermPath:
      opts.shortTermPath ||
      config?.memory?.shortTerm?.path ||
      join(cwd, 'agents', 'data', 'memory', 'short_term.db'),
    projectId: opts.projectId ?? config?.project?.name ?? 'project',
  };
}

export function openMemoryGraph(cwd: string): MemoryGraph {
  return new MemoryGraph(memoryGraphPath(cwd));
}

export function memoryGraphExists(cwd: string): boolean {
  return existsSync(memoryGraphPath(cwd));
}

export interface BuildOptions {
  /** Max short-term entries to pull. Default 2000. */
  limit?: number;
  /** Project id for the short-term store. */
  projectId?: string;
  /** Explicit short-term DB path (else the standard location). */
  shortTermPath?: string;
  /** Extra items from a caller (e.g. a long-term export). */
  extra?: IngestItem[];
  /** Rebuild from scratch (truncates the graph) instead of incrementally. */
  rebuild?: boolean;
  /** Skip the long-term tier (tests, or an intentionally short-term-only index). */
  includeLongTerm?: boolean;
}

export interface BuildReport extends IngestResult {
  /** Items offered to the graph (before dedupe). */
  considered: number;
  graphPath: string;
  /**
   * Which memory tiers the graph actually covers. Reported because recall over a
   * partial corpus is worse than no recall if the caller believes it is
   * complete.
   */
  coverage: { shortTerm: number; longTerm: number };
}

/**
 * Read UAP's short-term store into `IngestItem`s.
 *
 * Isolated and best-effort: a missing or unreadable store yields an empty list
 * rather than failing the build, because the graph is derived and a partial
 * index is more useful than none.
 */
export async function itemsFromShortTerm(
  cwd: string,
  opts: BuildOptions = {},
): Promise<IngestItem[]> {
  const { shortTermPath: dbPath, projectId } = resolveStoreConfig(cwd, opts);
  if (!existsSync(dbPath)) return [];
  const { SQLiteShortTermMemory } = await import('./short-term/sqlite.js');
  let store: InstanceType<typeof SQLiteShortTermMemory> | null = null;
  try {
    store = new SQLiteShortTermMemory({
      dbPath,
      projectId,
      maxEntries: opts.limit ?? 2000,
    });
    const rows = (await store.getRecent(opts.limit ?? 2000)) ?? [];
    return rows.map((r) => ({
      id: `st:${r.id ?? itemKey({ text: r.content })}`,
      text: r.content,
      type: r.type,
      occurredAt: r.timestamp,
    }));
  } catch {
    return [];
  } finally {
    // A throw in getRecent used to skip close(), leaking the handle (plus WAL and
    // SHM refs) once per query, since recall refreshes on every call.
    try {
      await store?.close();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Read the LONG-TERM semantic store into ingest items.
 *
 * This tier holds everything durable — `memory store`, `sync-files`,
 * `prepopulate`. Omitting it would make active recall a strict downgrade from
 * the passive path it replaces. Best-effort: an unreachable Qdrant yields [] and
 * the caller reports reduced coverage rather than failing.
 */
export async function itemsFromLongTerm(cwd: string, limit = 2000): Promise<IngestItem[]> {
  try {
    const config = loadUapConfig(cwd);
    const endpoint = config?.memory?.longTerm?.endpoint || 'localhost:6333';
    const url = /^https?:\/\//.test(endpoint) ? endpoint : `http://${endpoint}`;
    const collection = config?.memory?.longTerm?.collection || 'agent_memory';
    const apiKey = config?.memory?.longTerm?.qdrantCloud?.apiKey || process.env.QDRANT_API_KEY;

    const { getQdrantClientClass } = await import('../utils/lazy-imports.js');
    const QdrantClientClass = await getQdrantClientClass();
    const client = new QdrantClientClass({ url, apiKey, checkCompatibility: false });
    const collections = await client.getCollections();
    const names = [collection, `${collection}_prepopulated`].filter((c: string) =>
      collections.collections.some((col: { name: string }) => col.name === c),
    );

    const items: IngestItem[] = [];
    for (const name of names) {
      // Scroll the payloads only — the graph indexes text, not vectors.
      let offset: string | number | Record<string, unknown> | null | undefined = undefined;
      while (items.length < limit) {
        const page = await client.scroll(name, {
          limit: Math.min(256, limit - items.length),
          with_payload: true,
          with_vector: false,
          offset,
        });
        for (const point of page.points ?? []) {
          const payload = (point.payload ?? {}) as Record<string, unknown>;
          const text = String(payload.content ?? '');
          if (!text) continue;
          items.push({
            id: `lt:${name}:${String(point.id)}`,
            text,
            type: String(payload.type ?? 'knowledge'),
            tags: Array.isArray(payload.tags) ? (payload.tags as string[]) : undefined,
            occurredAt: typeof payload.timestamp === 'string' ? payload.timestamp : undefined,
          });
        }
        offset = page.next_page_offset as typeof offset;
        if (!offset) break;
      }
    }
    return items;
  } catch {
    return [];
  }
}

/**
 * Build or refresh the graph from the stores.
 *
 * Incremental by default: source keys already ingested are skipped, so this is
 * cheap to re-run and safe to call before a query.
 */
export async function buildMemoryGraph(
  cwd: string,
  opts: BuildOptions = {},
): Promise<BuildReport> {
  const graph = openMemoryGraph(cwd);
  try {
    const shortTerm = await itemsFromShortTerm(cwd, opts);
    const longTerm = opts.includeLongTerm === false ? [] : await itemsFromLongTerm(cwd, opts.limit);
    const items = [...shortTerm, ...longTerm, ...(opts.extra ?? [])];
    if (opts.rebuild) {
      // A real rebuild TRUNCATES. Clearing only the in-memory dedupe set left
      // every row in place and re-inserted the whole corpus under fresh ids, so
      // two rebuilds meant every memory twice — permanently, since the ledger
      // then reported them as already indexed.
      graph.clear();
    }
    const seen = opts.rebuild ? new Set<string>() : graph.ingestedKeys();
    const result = ingestItems(graph, items, { seen });
    // Mark ONLY what was stored — see IngestResult.storedKeys.
    graph.markIngested(result.storedKeys);
    return {
      ...result,
      considered: items.length,
      graphPath: memoryGraphPath(cwd),
      coverage: { shortTerm: shortTerm.length, longTerm: longTerm.length },
    };
  } finally {
    graph.close();
  }
}

export interface RecallOptions {
  policy?: ReconstructionPolicy;
  maxSteps?: number;
  /** Ceiling on admitted context. */
  maxContext?: number;
  /** Build/refresh the graph before querying. Default true. */
  refresh?: boolean;
  buildOptions?: BuildOptions;
}

export interface RecallResult extends ReconstructionResult {
  /** True when there is nothing to traverse — distinct from "nothing matched". */
  graphEmpty: boolean;
  build?: BuildReport;
}

/**
 * Recall by ACTIVE RECONSTRUCTION: traverse the graph while reasoning, pruning
 * weak paths before they cost context, instead of one passive top-k pull.
 *
 * This is the caller area E was missing. It is invoked by `uap memory query
 * --active` and by anything that opts in; passive retrieval remains the default
 * until the paired bench measures the lift on our own suite.
 */
export async function recallActive(
  cwd: string,
  query: string,
  opts: RecallOptions = {},
): Promise<RecallResult> {
  const build = opts.refresh === false ? undefined : await buildMemoryGraph(cwd, opts.buildOptions);
  const graph = openMemoryGraph(cwd);
  try {
    if (graph.isEmpty()) {
      return {
        context: [],
        steps: [],
        converged: false,
        stopReason: 'exhausted',
        graphEmpty: true,
        build,
      };
    }
    const result = reconstruct(graph, query, {
      policy: opts.policy ?? heuristicPolicy(),
      maxSteps: opts.maxSteps,
      maxContext: opts.maxContext,
    });
    return { ...result, graphEmpty: false, build };
  } finally {
    graph.close();
  }
}

/**
 * Should a caller use active reconstruction?
 *
 * Both conditions must hold: the operator opted in AND the graph actually has
 * content. Routing to an empty graph would silently return nothing where
 * passive retrieval would have answered — a regression dressed as a feature.
 */
export function shouldUseActiveRecall(cwd: string): boolean {
  if (!activeReconstructionEnabled()) return false;
  if (!memoryGraphExists(cwd)) return false;
  const graph = openMemoryGraph(cwd);
  try {
    // Cheap probe, not stats(): this runs on EVERY `uap memory query` and every
    // harness-card render, and stats() is five aggregates over the triples table.
    return !graph.isEmpty();
  } catch {
    return false;
  } finally {
    graph.close();
  }
}

/**
 * The retrieval mode actually in force, for the harness disclosure card.
 *
 * One implementation so the bench card and `uap harness card` cannot disagree —
 * two call sites computing this independently is how a card starts lying.
 */
export function describeMemoryMode(cwd: string): string {
  try {
    return shouldUseActiveRecall(cwd) ? 'active reconstruction' : 'semantic retrieval';
  } catch {
    return 'semantic retrieval';
  }
}
