/**
 * Practice Store (Phase 4)
 *
 * Best-practice "cards" learned from past deliveries and injected into future
 * prompts for similar tasks. A card records guidance distilled from a
 * *successful* run — the winning strategy seed and how many turns it took —
 * keyed by task keywords.
 *
 * Provenance matters: cards are derived from the harness's own strategy seeds
 * and gate outcomes, never from raw model output. This keeps the long-term
 * store free of model-authored text (a stored-prompt-injection vector).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

export interface PracticeCard {
  id: string;
  /** Winning strategy seed id (provenance anchor — never model text) */
  strategy: string;
  /** Lowercased keywords that gate retrieval relevance */
  keywords: string[];
  /** Guidance injected into prompts — always regenerated from strategy+bestTurns */
  guidance: string;
  /** Times this practice has been reinforced by a successful delivery */
  successCount: number;
  /** Fewest turns a delivery using this practice took (lower = stronger) */
  bestTurns: number;
}

/** Input to record a successful delivery as a practice. */
export interface PracticeInput {
  strategy: string;
  keywords: string[];
  turns: number;
}

export interface PracticeStore {
  /** Retrieve the most relevant cards for a task instruction */
  retrieve(instruction: string, limit?: number): PracticeCard[];
  /** Reinforce or create a card from a successful delivery */
  record(input: PracticeInput): void;
}

/** Strategy ids are harness-owned seed labels; this guards the template
 * against injection if a tampered store supplies an arbitrary string. */
const STRATEGY_RE = /^[a-z][a-z0-9-]{0,31}$/;

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'to', 'of', 'and', 'or', 'in', 'on', 'for', 'with', 'that',
  'returns', 'return', 'create', 'add', 'make', 'write', 'into', 'from', 'as',
  'is', 'it', 'be', 'should', 'when', 'this', 'each', 'two', 'using',
]);

/** Extract lowercased keyword tokens from a task instruction. */
export function extractKeywords(text: string, max = 12): string[] {
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3 || STOP_WORDS.has(raw) || seen.has(raw)) continue;
    seen.add(raw);
    tokens.push(raw);
    if (tokens.length >= max) break;
  }
  return tokens;
}

/** Jaccard-ish overlap: shared keywords / query keywords. */
function relevance(card: PracticeCard, queryKeywords: string[]): number {
  if (queryKeywords.length === 0) return 0;
  const cardSet = new Set(card.keywords);
  const shared = queryKeywords.filter((k) => cardSet.has(k)).length;
  return shared / queryKeywords.length;
}

const MIN_RELEVANCE = 0.25;

/** In-memory store — the base implementation; the file store persists it. */
export class InMemoryPracticeStore implements PracticeStore {
  protected cards: PracticeCard[];

  constructor(cards: PracticeCard[] = []) {
    this.cards = cards;
  }

  retrieve(instruction: string, limit = 3): PracticeCard[] {
    const keywords = extractKeywords(instruction);
    return this.cards
      .map((card) => ({ card, score: relevance(card, keywords) }))
      .filter(({ score }) => score >= MIN_RELEVANCE)
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        if (b.card.successCount !== a.card.successCount) return b.card.successCount - a.card.successCount;
        return a.card.bestTurns - b.card.bestTurns;
      })
      .slice(0, limit)
      .map(({ card }) => card);
  }

  record(input: PracticeInput): void {
    const strategy = STRATEGY_RE.test(input.strategy) ? input.strategy : 'direct';
    // Dedup on strategy, not rendered guidance (which varies by turn count).
    const existing = this.cards.find((c) => c.strategy === strategy);
    if (existing) {
      existing.successCount += 1;
      existing.bestTurns = Math.min(existing.bestTurns, input.turns);
      existing.keywords = [...new Set([...existing.keywords, ...input.keywords])];
      existing.guidance = distillPractice(strategy, existing.bestTurns);
      return;
    }
    this.cards.push({
      id: this.nextId(),
      strategy,
      keywords: input.keywords,
      guidance: distillPractice(strategy, input.turns),
      successCount: 1,
      bestTurns: input.turns,
    });
  }

  /** Smallest unused pN id — robust to merges and dropped (corrupt) cards. */
  private nextId(): string {
    const used = new Set(this.cards.map((c) => c.id));
    for (let i = 1; ; i++) {
      const id = `p${i}`;
      if (!used.has(id)) return id;
    }
  }

  all(): PracticeCard[] {
    return this.cards;
  }
}

/** File-backed practice store (JSON). Self-heals on missing/corrupt files. */
export class FilePracticeStore extends InMemoryPracticeStore {
  private readonly path: string;

  constructor(path: string) {
    super(FilePracticeStore.load(path));
    this.path = path;
  }

  /**
   * Load cards from disk, validating every field. The on-disk file is NOT
   * trusted to supply guidance text — guidance is regenerated from the
   * validated strategy + bestTurns via distillPractice, so a tampered file
   * cannot inject prompt text (the read path enforces the same provenance
   * the write path guarantees). Structurally-invalid cards are dropped.
   */
  private static load(path: string): PracticeCard[] {
    if (!existsSync(path)) return [];
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf-8'));
    } catch {
      return [];
    }
    if (!Array.isArray(parsed)) return [];

    const cards: PracticeCard[] = [];
    for (const raw of parsed) {
      if (typeof raw !== 'object' || raw === null) continue;
      const c = raw as Record<string, unknown>;
      if (typeof c.strategy !== 'string' || !STRATEGY_RE.test(c.strategy)) continue;
      if (!Array.isArray(c.keywords) || !c.keywords.every((k) => typeof k === 'string')) continue;
      const successCount = Number(c.successCount);
      const bestTurns = Number(c.bestTurns);
      if (!Number.isFinite(successCount) || successCount < 1) continue;
      if (!Number.isFinite(bestTurns) || bestTurns < 1) continue;
      cards.push({
        id: typeof c.id === 'string' ? c.id : `p${cards.length + 1}`,
        strategy: c.strategy,
        keywords: c.keywords as string[],
        guidance: distillPractice(c.strategy, bestTurns), // regenerated, never trusted from disk
        successCount: Math.floor(successCount),
        bestTurns: Math.floor(bestTurns),
      });
    }
    return cards;
  }

  record(input: PracticeInput): void {
    super.record(input);
    this.persist();
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      // Atomic write: temp file + rename, so a crash mid-write cannot corrupt
      // the store and we never follow a pre-planted symlink at the final path.
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.all(), null, 2), 'utf-8');
      renameSync(tmp, this.path);
    } catch {
      // Persistence is best-effort; in-memory state remains valid
    }
  }
}

/** Default on-disk location for a project's learned practices. */
export function defaultPracticePath(projectRoot: string): string {
  return join(projectRoot, '.uap', 'delivery-practices.json');
}

/**
 * Distill a one-line practice from a successful delivery. Provenance-safe:
 * built only from the winning strategy and turn count, not model output.
 */
export function distillPractice(winningStrategy: string | undefined, turns: number): string {
  const strategy = winningStrategy ?? 'direct';
  if (turns === 1) {
    return `A '${strategy}' approach solved a similar task on the first attempt — lead with it.`;
  }
  return `A '${strategy}' approach converged on a similar task in ${turns} turns — prefer it and verify against the gates early.`;
}
