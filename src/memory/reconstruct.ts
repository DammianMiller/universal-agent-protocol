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
  /** Content ids reached but pruned as irrelevant. */
  pruned: number[];
  /** Whether the model declared the evidence sufficient after this step. */
  sufficient: boolean;
}

export interface ReconstructionResult {
  /** Content, in the order it was admitted — this is what goes to the model. */
  context: ContentNode[];
  steps: ReconstructionStep[];
  /** True when the loop stopped because evidence sufficed, not because it ran out of steps. */
  converged: boolean;
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
export function heuristicPolicy(opts: { keepThreshold?: number; sufficientAt?: number } = {}): ReconstructionPolicy {
  const keepThreshold = opts.keepThreshold ?? 0.12;
  const sufficientAt = opts.sufficientAt ?? 3;
  return {
    selectCues(_query, activeCues) {
      // Expand everything currently active: the pruning happens at routing, so
      // narrowing here would discard paths before their evidence is seen.
      return [...activeCues];
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
  const policy = options.policy ?? heuristicPolicy();

  const seeds = options.seedCues ?? seedCuesFromQuery(graph, query);
  let active = new Set(seeds.map(norm));
  const visitedCues = new Set<string>();
  const context: ContentNode[] = [];
  const admitted = new Set<number>();
  const steps: ReconstructionStep[] = [];
  let converged = false;

  for (let step = 1; step <= maxSteps; step++) {
    const toExpand = policy
      .selectCues(query, [...active], context)
      .map(norm)
      .filter((c) => !visitedCues.has(c));
    if (toExpand.length === 0) break;

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
    for (const node of candidates) {
      if (keepSet.has(node.id)) {
        context.push(node);
        admitted.add(node.id);
        kept.push(node.id);
      } else {
        // Pruned BEFORE it costs context — the token saving the paper measures.
        pruned.push(node.id);
      }
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

    steps.push({ step, expandedCues: toExpand, tags: [...tags], kept, pruned, sufficient });
    if (sufficient) {
      converged = true;
      break;
    }
    if (active.size === 0) break;
  }

  return { context, steps, converged };
}

/** Seed cues = query tokens that exist in the graph; else every cue. */
export function seedCuesFromQuery(graph: MemoryGraph, query: string): string[] {
  const tokens = [...tokenize(query)];
  const known = new Set(graph.allCues());
  const hits = tokens.filter((t) => known.has(t));
  return hits.length > 0 ? hits : [...known];
}

/**
 * Is active reconstruction enabled? Off by default — the lift is measured on our
 * own suite before it becomes the default retrieval path.
 */
export function activeReconstructionEnabled(): boolean {
  return process.env.UAP_MEMORY_ACTIVE === '1';
}
