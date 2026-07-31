/**
 * Active memory reconstruction over a Cue–Tag–Content graph
 * (harness plan area E, 2026-07-31).
 *
 * UAP's memory retrieval is passive: embed the query, pull the top-k, reason
 * once. "Memory is Reconstructed, Not Retrieved" (arXiv 2606.06036) shows that
 * paradigm is strictly less expressive than letting the model traverse memory
 * WHILE it reasons — it proves active policies solve a binary-tree
 * needle-in-a-haystack with zero error where passive policies need an
 * exponential budget — and measures the practical gap at up to +23% on LoCoMo
 * with 118k tokens per query against A-Mem's 632k and LangMem's 3.26M.
 *
 * THE TAG LAYER IS THE CONTRIBUTION. Their ablation: cue -> content direct
 * indexing recalls ~65%; cue -> TAG -> content with multi-turn reasoning recalls
 * ~90%. A "graph memory" that skips the associative tag bridge gets none of the
 * benefit, so the schema here makes tags mandatory rather than an optimisation.
 *
 * Off by default. The literature's numbers are theirs, not ours: this ships
 * behind `UAP_MEMORY_ACTIVE=1` until `uap bench paired` measures the lift on our
 * own suite (harness plan constraint 3).
 */

import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** Which memory layer a content node lives in (MRAgent's three granularities). */
export type MemoryLayer =
  /** Event-specific, temporally ordered. */
  | 'episodic'
  /** Stable facts: preferences, attributes, decisions. */
  | 'semantic'
  /** Topic nodes summarising recurring patterns — the top-down entry point. */
  | 'abstraction';

export interface ContentNode {
  id: number;
  layer: MemoryLayer;
  text: string;
  /** ISO timestamp of the source episode, when known. */
  occurredAt?: string;
}

/** One (cue, tag, content) triple — the graph's only edge type. */
export interface Triple {
  cue: string;
  tag: string;
  contentId: number;
}

export interface ReconstructionStep {
  /** 1-based step index. */
  step: number;
  /** Cues the model chose to expand this step. */
  expandedCues: string[];
  /** Tags reached from those cues. */
  tags: string[];
  /** Content ids admitted into the reconstructed context. */
  kept: number[];
  /** Content ids reached but judged IRRELEVANT. */
  pruned: number[];
  /**
   * Content ids the policy kept but that did not fit the context budget.
   * Separate from `pruned`: "judged irrelevant" and "budget full" are different
   * outcomes and want different remedies.
   */
  dropped: number[];
  /** Whether the model declared the evidence sufficient after this step. */
  sufficient: boolean;
}

export interface ReconstructionResult {
  /** Content, in the order it was admitted — this is what goes to the model. */
  context: ContentNode[];
  steps: ReconstructionStep[];
  /** True when the loop stopped because evidence sufficed, not because it ran out of steps. */
  converged: boolean;
  /** Why the traversal stopped, so callers can give accurate advice. */
  stopReason: 'sufficient' | 'context-full' | 'exhausted' | 'step-budget';
}

/**
 * The reasoning seam. Injected so the traversal policy is testable without a
 * model, and so the same graph can be driven by a local or a frontier model.
 */
export interface ReconstructionPolicy {
  /**
   * Choose which of the currently-active cues to expand next. Returning [] ends
   * the traversal.
   */
  selectCues(query: string, activeCues: string[], context: ContentNode[]): string[];
  /**
   * Semantic routing: which reached contents are worth keeping, and is the
   * accumulated evidence now enough to answer?
   */
  route(
    query: string,
    candidates: ContentNode[],
    context: ContentNode[],
  ): { keep: number[]; sufficient: boolean };
}

/**
 * Zero-LLM policy: lexical overlap for routing, breadth-first for expansion.
 *
 * Not a toy — it is the honest default. An active traversal driven by a cheap
 * heuristic is still active (it prunes on accumulated evidence, which is the
 * mechanism the paper isolates); wiring an LLM in raises the ceiling but is not
 * required for the structure to pay off, and a deterministic policy is what
 * makes the loop unit-testable.
 */
export function heuristicPolicy(
  opts: { keepThreshold?: number; sufficientAt?: number; maxExpandPerStep?: number } = {},
): ReconstructionPolicy {
  const keepThreshold = opts.keepThreshold ?? 0.12;
  // 3 was too eager: on any realistic graph step 1 admits >=3 nodes, the loop
  // stops immediately, and the multi-hop discovery that IS the contribution
  // never runs — the shipped default would have been passive retrieval with a
  // worse ranker. 12 lets the second hop happen while staying under maxContext.
  const sufficientAt = opts.sufficientAt ?? 12;
  // Expansion MUST be bounded. Discovery reseeds the active set from every cue
  // sharing a productive tag, so on a real store step 2 expanded 453 cues —
  // effectively a full scan, which would make this slower AND more expensive
  // than the passive top-k it replaces, inverting the paper's whole result.
  const maxExpand = opts.maxExpandPerStep ?? 24;
  return {
    selectCues(query, activeCues, context) {
      if (activeCues.length <= maxExpand) return [...activeCues];
      // Rank by relevance to the query first, then to evidence already
      // accumulated — the second term is what makes this reconstruction rather
      // than retrieval: what to look at next depends on what was just found.
      const q = tokenize(query);
      const ctx = tokenize(context.map((c) => c.text).join(' '));
      const scored = activeCues.map((cue) => {
        const t = tokenize(cue);
        return { cue, score: overlap(t, q) * 2 + overlap(t, ctx) };
      });
      scored.sort((a, b) => b.score - a.score || a.cue.localeCompare(b.cue));
      return scored.slice(0, maxExpand).map((s) => s.cue);
    },
    route(query, candidates, context) {
      const q = tokenize(query);
      const keep = candidates
        .filter((c) => overlap(q, tokenize(c.text)) >= keepThreshold)
        .map((c) => c.id);
      return { keep, sufficient: context.length + keep.length >= sufficientAt };
    },
  };
}

function tokenize(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 2),
  );
}

function overlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  return shared / a.size;
}

/**
 * The Cue–Tag–Content graph.
 *
 * Its own SQLite file rather than a table in the semantic store: the traversal
 * is a different access pattern (many small keyed hops, no vector math) and
 * keeping it separate means enabling the feature cannot slow the existing
 * retrieval path.
 */
export class MemoryGraph {
  private db: Database.Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mg_contents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        layer TEXT NOT NULL,
        text TEXT NOT NULL,
        occurred_at TEXT
      );
      CREATE TABLE IF NOT EXISTS mg_triples (
        cue TEXT NOT NULL,
        tag TEXT NOT NULL,
        content_id INTEGER NOT NULL,
        PRIMARY KEY (cue, tag, content_id)
      );
      CREATE INDEX IF NOT EXISTS idx_mg_triples_cue ON mg_triples(cue);
      CREATE INDEX IF NOT EXISTS idx_mg_triples_cue_tag ON mg_triples(cue, tag);
      -- cuesForTag filters on tag ALONE and runs once per productive tag per
      -- step; without this it full-scans mg_triples in the discovery hot path.
      CREATE INDEX IF NOT EXISTS idx_mg_triples_tag ON mg_triples(tag);
      -- Source keys already ingested. Durable dedupe lives WITH the graph so a
      -- rebuild is incremental and a deleted graph cannot leave a stale ledger
      -- behind claiming everything is already indexed.
      CREATE TABLE IF NOT EXISTS mg_sources (
        key TEXT PRIMARY KEY,
        ingested_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }

  /**
   * Add one memory item and its (cue, tag) index entries.
   *
   * Tags are REQUIRED: an item indexed by cue alone is the ~65%-recall
   * configuration the paper ablates away. Callers with no tags should supply a
   * coarse one (the layer name) rather than none.
   */
  addContent(params: {
    layer: MemoryLayer;
    text: string;
    occurredAt?: string;
    cues: string[];
    tags: string[];
  }): number {
    const info = this.db
      .prepare('INSERT INTO mg_contents (layer, text, occurred_at) VALUES (?, ?, ?)')
      .run(params.layer, params.text, params.occurredAt ?? null);
    const id = Number(info.lastInsertRowid);
    const stmt = this.db.prepare(
      'INSERT OR IGNORE INTO mg_triples (cue, tag, content_id) VALUES (?, ?, ?)',
    );
    const tags = params.tags.length > 0 ? params.tags : [params.layer];
    const insert = this.db.transaction(() => {
      for (const cue of params.cues) {
        for (const tag of tags) stmt.run(norm(cue), norm(tag), id);
      }
    });
    insert();
    return id;
  }

  /** φ_{c→g}: the associative tags a cue activates. */
  tagsForCue(cue: string): string[] {
    const rows = this.db
      .prepare('SELECT DISTINCT tag FROM mg_triples WHERE cue = ?')
      .all(norm(cue)) as Array<{ tag: string }>;
    return rows.map((r) => r.tag);
  }

  /** φ_{(c,g)→v}: contents reachable from a cue THROUGH a specific tag. */
  contentsFor(cue: string, tag: string): ContentNode[] {
    const rows = this.db
      .prepare(
        `SELECT c.id, c.layer, c.text, c.occurred_at
         FROM mg_triples t JOIN mg_contents c ON c.id = t.content_id
         WHERE t.cue = ? AND t.tag = ?`,
      )
      .all(norm(cue), norm(tag)) as Array<{
      id: number;
      layer: string;
      text: string;
      occurred_at: string | null;
    }>;
    return rows.map(toNode);
  }

  /** Cues that co-occur with a tag — how traversal discovers NEW clues. */
  cuesForTag(tag: string): string[] {
    const rows = this.db
      .prepare('SELECT DISTINCT cue FROM mg_triples WHERE tag = ?')
      .all(norm(tag)) as Array<{ cue: string }>;
    return rows.map((r) => r.cue);
  }

  /** Source keys already ingested, for incremental rebuilds. */
  ingestedKeys(): Set<string> {
    const rows = this.db.prepare('SELECT key FROM mg_sources').all() as Array<{ key: string }>;
    return new Set(rows.map((r) => r.key));
  }

  /** Mark source keys as ingested. */
  markIngested(keys: Iterable<string>): void {
    const stmt = this.db.prepare('INSERT OR IGNORE INTO mg_sources (key) VALUES (?)');
    const tx = this.db.transaction((ks: string[]) => {
      for (const k of ks) stmt.run(k);
    });
    tx([...keys]);
  }

  /**
   * Cheap emptiness probe. `stats()` runs five aggregates including two
   * COUNT(DISTINCT) and a GROUP BY — far too expensive for the "should I route
   * here" check that runs on every single query.
   */
  isEmpty(): boolean {
    const row = this.db.prepare('SELECT 1 AS n FROM mg_contents LIMIT 1').get() as
      | { n: number }
      | undefined;
    return row === undefined;
  }

  /** Delete everything — the truncate half of a real rebuild. */
  clear(): void {
    this.db.exec('DELETE FROM mg_triples; DELETE FROM mg_contents; DELETE FROM mg_sources;');
  }

  /** Shape of the graph, for `uap memory graph status` and honest reporting. */
  stats(): { contents: number; cues: number; tags: number; triples: number; bridgingTags: number } {
    const one = (sql: string): number =>
      ((this.db.prepare(sql).get() as { n: number } | undefined)?.n ?? 0);
    return {
      contents: one('SELECT COUNT(*) AS n FROM mg_contents'),
      cues: one('SELECT COUNT(DISTINCT cue) AS n FROM mg_triples'),
      tags: one('SELECT COUNT(DISTINCT tag) AS n FROM mg_triples'),
      triples: one('SELECT COUNT(*) AS n FROM mg_triples'),
      // Tags linking >1 content node are the ones doing associative work — but
      // a tag attached to EVERY memory (a type enum, a month bucket) links
      // everything and discriminates nothing, so counting it as a bridge
      // reports health while the graph is a hairball. Require >1 and <60% of
      // all contents.
      bridgingTags: one(
        `SELECT COUNT(*) AS n FROM (
           SELECT tag FROM mg_triples
           GROUP BY tag
           HAVING COUNT(DISTINCT content_id) > 1
              AND COUNT(DISTINCT content_id) < 0.6 * (SELECT COUNT(*) FROM mg_contents)
         )`,
      ),
    };
  }

  /** Every cue in the graph — the seed set when the query matches nothing. */
  allCues(): string[] {
    const rows = this.db.prepare('SELECT DISTINCT cue FROM mg_triples').all() as Array<{ cue: string }>;
    return rows.map((r) => r.cue);
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* ignore */
    }
  }
}

function norm(s: string): string {
  return s.trim().toLowerCase();
}

function toNode(r: { id: number; layer: string; text: string; occurred_at: string | null }): ContentNode {
  return {
    id: r.id,
    layer: r.layer as MemoryLayer,
    text: r.text,
    occurredAt: r.occurred_at ?? undefined,
  };
}

export interface ReconstructOptions {
  /** Hard step cap. The paper's runs converge in 3–4; 5 leaves headroom. */
  maxSteps?: number;
  policy?: ReconstructionPolicy;
  /** Seed cues. Omitted -> derived from the query's own tokens. */
  seedCues?: string[];
  /**
   * Hard ceiling on admitted context. `sufficient` only stops FURTHER steps —
   * everything kept in the current step is already in context — so without this
   * one step over a well-connected graph can admit thousands of nodes and blow
   * the token budget this whole approach exists to protect.
   */
  maxContext?: number;
  /** Seed cues to draw when the query matches nothing. Default 32. */
  maxSeeds?: number;
  /**
   * Hard cap on cues expanded per step, enforced HERE rather than trusted to the
   * policy. The policy seam exists for an LLM to plug into, and an LLM will
   * happily return 200 cues (or cues that were never active), reproducing the
   * full-scan this bound was added to prevent.
   */
  maxExpandPerStep?: number;
}

/**
 * Reconstruct an answer context by traversing the graph while reasoning.
 *
 * The loop is the paper's three-step iteration: select actions over the active
 * set, traverse (cue -> tags -> contents), then route/prune and update state.
 * The essential difference from retrieval is that step N+1's expansion depends
 * on what step N actually found — cues discovered mid-traversal become new
 * entry points, and weak paths are killed before they consume context.
 */
export function reconstruct(
  graph: MemoryGraph,
  query: string,
  options: ReconstructOptions = {},
): ReconstructionResult {
  const maxSteps = options.maxSteps ?? 5;
  const maxContext = options.maxContext ?? 24;
  const maxExpand = options.maxExpandPerStep ?? 24;
  const policy = options.policy ?? heuristicPolicy();

  const seeds = options.seedCues ?? seedCuesFromQuery(graph, query, options.maxSeeds);
  let active = new Set(seeds.map(norm));
  const visitedCues = new Set<string>();
  const context: ContentNode[] = [];
  const admitted = new Set<number>();
  const steps: ReconstructionStep[] = [];
  let converged = false;
  let stopReason: ReconstructionResult['stopReason'] = 'step-budget';

  for (let step = 1; step <= maxSteps; step++) {
    const toExpand = policy
      .selectCues(query, [...active], context)
      .map(norm)
      // Intersect with the ACTIVE set: a policy may only expand cues the
      // traversal actually reached, never ones it invented.
      .filter((c) => active.has(c) && !visitedCues.has(c))
      .slice(0, maxExpand);
    if (toExpand.length === 0) {
      stopReason = 'exhausted';
      break;
    }

    const tags = new Set<string>();
    const candidates: ContentNode[] = [];
    const seenThisStep = new Set<number>();
    for (const cue of toExpand) {
      visitedCues.add(cue);
      active.delete(cue);
      for (const tag of graph.tagsForCue(cue)) {
        tags.add(tag);
        for (const node of graph.contentsFor(cue, tag)) {
          // Already in context, or already a candidate this step — the graph is
          // many-to-many, so the same content is reached by several paths.
          if (admitted.has(node.id) || seenThisStep.has(node.id)) continue;
          seenThisStep.add(node.id);
          candidates.push(node);
        }
      }
    }

    const { keep, sufficient } = policy.route(query, candidates, context);
    const keepSet = new Set(keep);
    const kept: number[] = [];
    const pruned: number[] = [];
    const dropped: number[] = [];
    for (const node of candidates) {
      if (!keepSet.has(node.id)) {
        // Pruned BEFORE it costs context — the token saving the paper measures.
        pruned.push(node.id);
        continue;
      }
      if (context.length >= maxContext) {
        dropped.push(node.id);
        continue;
      }
      context.push(node);
      admitted.add(node.id);
      kept.push(node.id);
    }

    // Discovery: tags reached by KEPT evidence surface new cues to expand. Only
    // productive tags propagate, or a pruned branch would keep reseeding itself.
    if (kept.length > 0) {
      const productiveTags = new Set<string>();
      for (const cue of toExpand) {
        for (const tag of graph.tagsForCue(cue)) {
          if (graph.contentsFor(cue, tag).some((n) => keepSet.has(n.id))) productiveTags.add(tag);
        }
      }
      for (const tag of productiveTags) {
        for (const cue of graph.cuesForTag(tag)) {
          if (!visitedCues.has(cue)) active.add(cue);
        }
      }
    }

    steps.push({ step, expandedCues: toExpand, tags: [...tags], kept, pruned, dropped, sufficient });
    if (sufficient || context.length >= maxContext) {
      converged = sufficient;
      stopReason = sufficient ? 'sufficient' : 'context-full';
      break;
    }
    if (active.size === 0) {
      stopReason = 'exhausted';
      break;
    }
  }

  return { context, steps, converged, stopReason };
}

/**
 * Seed cues = query tokens present in the graph.
 *
 * When nothing matches we fall back to a BOUNDED sample rather than every cue
 * in the graph: an off-topic query would otherwise load the entire content
 * table on step 1, which is the opposite of what this is for.
 */
export function seedCuesFromQuery(graph: MemoryGraph, query: string, maxSeeds = 32): string[] {
  const tokens = [...tokenize(query)];
  const known = new Set(graph.allCues());
  const hits = tokens.filter((t) => known.has(t));
  if (hits.length > 0) return hits;
  return [...known].sort().slice(0, maxSeeds);
}

/**
 * Is active reconstruction enabled? Off by default — the lift is measured on our
 * own suite before it becomes the default retrieval path.
 */
export function activeReconstructionEnabled(): boolean {
  return process.env.UAP_MEMORY_ACTIVE === '1';
}
