/**
 * Recall health — the honesty layer for memory recall.
 *
 * A degraded backend must never present as healthy silence. When Qdrant is
 * unreachable, or the embedding chain has degraded to its fallback tier,
 * semantic recall is impossible BY CONSTRUCTION: the TF-IDF fallback emits
 * 384-dim vectors while the nomic-built collections are 768-dim, so a query
 * in that state returns "No results in long-term memory" while the store
 * holds the answer. This module detects that state, says so loudly, and
 * degrades recall to a deterministic keyword scan over the durable
 * daily-log store instead.
 *
 * All logic is generalized: no project, model, or machine is special-cased.
 */

import Database from 'better-sqlite3';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import type { AgentContextConfig } from '../types/index.js';
import { getEmbeddingService, isFallbackEmbeddingProvider } from './embeddings.js';
import { shortTermDbPath } from './paths.js';

export type ShortTermDbState = 'ok' | 'missing';
export type QdrantRecallState = 'ok' | 'unreachable';
export type EmbeddingRecallState = 'ok' | 'fallback' | 'error';

export interface RecallDegradation {
  component: 'short-term-db' | 'qdrant' | 'embeddings';
  state: string;
  detail: string;
}

export interface RecallHealth {
  shortTermDb: ShortTermDbState;
  shortTermDbPath: string;
  qdrant: QdrantRecallState;
  qdrantEndpoint: string;
  embeddings: EmbeddingRecallState;
  activeEmbeddingProvider: string | null;
  degraded: RecallDegradation[];
}

export interface RecallPlan {
  /** Semantic vector search is viable (Qdrant reachable AND real embeddings). */
  useVectorSearch: boolean;
  /** Degrade to the deterministic keyword scan over the daily-log store. */
  useKeywordFallback: boolean;
  /**
   * Never print "No results in long-term memory" while degraded — the
   * store may hold the answer; the backend does not.
   */
  suppressEmptyLongTerm: boolean;
}

/** Single source of truth for whether semantic recall is viable at all. */
export function planRecall(health: RecallHealth): RecallPlan {
  const vectorViable = health.qdrant === 'ok' && health.embeddings === 'ok';
  return {
    useVectorSearch: vectorViable,
    useKeywordFallback: !vectorViable,
    suppressEmptyLongTerm: !vectorViable,
  };
}

/**
 * Check if Qdrant is reachable by polling its health endpoint.
 * Optionally waits up to `timeoutMs` for it to become available.
 *
 * Moved from src/cli/memory.ts (which re-exports it) so the health probe
 * and the CLI share one implementation; existing importers and test
 * mocks keep working unchanged.
 */
export async function isQdrantReachable(
  endpoint = 'http://localhost:6333',
  timeoutMs = 0
): Promise<boolean> {
  const url = endpoint.startsWith('http') ? endpoint : `http://${endpoint}`;
  const deadline = Date.now() + timeoutMs;
  const pollInterval = 1000;

  do {
    try {
      const res = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return true;
    } catch {
      // Not yet available
    }
    if (Date.now() + pollInterval > deadline) break;
    await new Promise((r) => setTimeout(r, pollInterval));
  } while (Date.now() < deadline);

  return false;
}

/** Probe every recall substrate; `degraded` lists only the broken ones. */
export async function probeRecallHealth(
  cwd: string,
  config?: AgentContextConfig | null
): Promise<RecallHealth> {
  const dbPath = shortTermDbPath(cwd, config?.memory?.shortTerm?.path);
  const shortTermDb: ShortTermDbState = existsSync(dbPath) ? 'ok' : 'missing';

  const endpoint = config?.memory?.longTerm?.endpoint || 'localhost:6333';
  const qdrantEndpoint =
    endpoint.startsWith('http://') || endpoint.startsWith('https://')
      ? endpoint
      : `http://${endpoint}`;
  const qdrant: QdrantRecallState = (await isQdrantReachable(qdrantEndpoint, 0))
    ? 'ok'
    : 'unreachable';

  let embeddings: EmbeddingRecallState = 'ok';
  let activeEmbeddingProvider: string | null = null;
  try {
    const service = getEmbeddingService();
    await service.initialize();
    activeEmbeddingProvider = service.getActiveProviderName();
    if (activeEmbeddingProvider === null) {
      embeddings = 'error';
    } else if (isFallbackEmbeddingProvider(activeEmbeddingProvider)) {
      embeddings = 'fallback';
    }
  } catch {
    embeddings = 'error';
  }

  const degraded: RecallDegradation[] = [];
  if (qdrant === 'unreachable') {
    degraded.push({
      component: 'qdrant',
      state: 'unreachable',
      detail: `semantic long-term search skipped (${qdrantEndpoint} not answering)`,
    });
  }
  if (embeddings === 'fallback') {
    degraded.push({
      component: 'embeddings',
      state: 'fallback',
      detail: `active provider '${activeEmbeddingProvider}' (no embedding server) — semantic vectors unavailable`,
    });
  } else if (embeddings === 'error') {
    degraded.push({
      component: 'embeddings',
      state: 'error',
      detail: 'embedding service failed to initialize',
    });
  }
  if (shortTermDb === 'missing') {
    degraded.push({
      component: 'short-term-db',
      state: 'missing',
      detail: `no short-term/daily-log store at ${dbPath} — keyword recall has nothing to scan`,
    });
  }

  return {
    shortTermDb,
    shortTermDbPath: dbPath,
    qdrant,
    qdrantEndpoint,
    embeddings,
    activeEmbeddingProvider,
    degraded,
  };
}

/** The visible honesty: one banner naming every degraded component. */
export function formatRecallBanner(health: RecallHealth): string[] {
  const lines = ['⚠ Memory recall is degraded:'];
  for (const d of health.degraded) {
    lines.push(`    ${d.component}: ${d.detail}`);
  }
  lines.push(
    '    Falling back to keyword recall over the daily-log store — results are NOT semantic.'
  );
  return lines;
}

// ---------------------------------------------------------------------------
// Keyword fallback (deterministic, dependency-free)
// ---------------------------------------------------------------------------

/** Lowercase alnum tokens; single characters are noise. */
export function tokenizeForRecall(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
}

/** Overlap score: share of query tokens present in the entry (0..1). */
export function keywordOverlapScore(query: string, content: string): number {
  const q = new Set(tokenizeForRecall(query));
  if (q.size === 0) return 0;
  const c = new Set(tokenizeForRecall(content));
  let hit = 0;
  for (const t of q) if (c.has(t)) hit++;
  return hit / q.size;
}

export interface KeywordRecallEntry {
  content: string;
  type: string;
  timestamp: string;
  score: number;
}

/** Upper bound on rows scanned per query; the daily log is a full scan. */
const KEYWORD_SCAN_ROW_CAP = 5000;

/**
 * Degraded-mode long-term recall: deterministic keyword scan over the
 * daily-log table (every memory lands there first, promoted or not).
 * A missing store or missing table is an empty result, never an error.
 */
export function keywordRecallLongTerm(
  cwd: string,
  config: AgentContextConfig | null | undefined,
  query: string,
  limit: number
): KeywordRecallEntry[] {
  const dbPath = shortTermDbPath(cwd, config?.memory?.shortTerm?.path);
  if (!existsSync(dbPath)) return [];
  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch {
    return [];
  }
  try {
    const rows = db
      .prepare('SELECT content, type, timestamp FROM daily_log ORDER BY id DESC LIMIT ?')
      .all(KEYWORD_SCAN_ROW_CAP) as Array<{
      content: string;
      type: string;
      timestamp: string;
    }>;
    return rows
      .map((r) => ({
        content: r.content,
        type: r.type,
        timestamp: r.timestamp,
        score: keywordOverlapScore(query, r.content),
      }))
      .filter((r) => r.score > 0)
      .sort(
        (a, b) =>
          b.score - a.score ||
          (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0) ||
          (a.content < b.content ? -1 : a.content > b.content ? 1 : 0)
      )
      .slice(0, limit);
  } catch {
    // No daily_log table yet (fresh store) — nothing to scan.
    return [];
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Health telemetry (machine-scoped, state transitions only)
// ---------------------------------------------------------------------------

/**
 * Machine-scoped telemetry root. UAP_MEMORY_TELEMETRY_DIR overrides it —
 * the same convention as UAP_TOOL_CORPUS_DIR in src/telemetry/tool-calls.ts
 * (operators relocate the corpus; tests redirect it away from the real
 * machine store).
 */
export function recallHealthTelemetryPath(): string {
  const root = process.env.UAP_MEMORY_TELEMETRY_DIR || join(homedir(), '.uap', 'telemetry');
  return join(root, 'memory-health.jsonl');
}

function lastTelemetrySignature(path: string): string | null {
  try {
    const text = readFileSync(path, 'utf-8');
    const lines = text.trimEnd().split('\n');
    const last = lines[lines.length - 1];
    if (!last) return null;
    return (JSON.parse(last) as { signature?: string }).signature ?? null;
  } catch {
    return null;
  }
}

/**
 * Record a degraded-recall state transition (machine-scoped). Appends at
 * most one line per DISTINCT degraded signature: a crash-looping backend
 * degrades every query, and the log must record the outage, not every query.
 */
export function recordRecallHealthEvent(health: RecallHealth): void {
  if (health.degraded.length === 0) return;
  const signature = health.degraded
    .map((d) => d.component)
    .sort()
    .join(',');
  const path = recallHealthTelemetryPath();
  if (lastTelemetrySignature(path) === signature) return;
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(
    path,
    JSON.stringify({
      ts: new Date().toISOString(),
      signature,
      qdrant: health.qdrant,
      embeddings: health.embeddings,
      embeddingProvider: health.activeEmbeddingProvider,
      shortTermDb: health.shortTermDb,
    }) + '\n'
  );
}
