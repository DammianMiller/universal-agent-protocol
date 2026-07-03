/**
 * Ideation Seeder — divergent strategy seeds for exploration (open-collider)
 *
 * Connects `uap ideate` divergent ideation to the delivery loop. Instead of
 * the four static DEFAULT_STRATEGY_SEEDS, the seeder produces task-specific,
 * deliberately diverse strategy hints for the best-of-N explorer:
 *
 *  - generateStrategySeeds: one Koestler-bisociation-style model call that
 *    asks for N structurally distinct implementation approaches
 *  - seedsFromIdeas: convert curated ideas (e.g. an open-collider project's
 *    curated_ideas.json) into strategy seeds directly
 *
 * Both are fail-soft: any parse/model failure falls back to the default
 * static seeds so ideation can never block delivery.
 */

import type { LoopExecutor } from './convergence-loop.js';
import type { StrategySeed } from './explorer.js';
import { DEFAULT_STRATEGY_SEEDS, MAX_CANDIDATES } from './explorer.js';

export interface IdeationOptions {
  /** Number of seeds to request (default 4, capped at MAX_CANDIDATES) */
  count?: number;
  /** Model attempts before falling back to the static defaults (default 2).
   * Local-model completions are occasionally empty/degenerate (proxy no-tool
   * turns, sampling flukes); one retry recovers most of them. */
  attempts?: number;
}

const DEFAULT_SEED_COUNT = 4;
const DEFAULT_ATTEMPTS = 2;
const MAX_HINT_CHARS = 400;

function buildIdeationPrompt(instruction: string, count: number): string {
  return [
    'You are a divergent-ideation engine (Koestler bisociation). For the task',
    'below, propose structurally DISTINCT implementation strategies — each one',
    'must approach the problem from a different region of solution space.',
    'Avoid minor variations of the same obvious approach; collide the task',
    'with distant framings (data-flow first, contract first, smallest diff,',
    'rewrite from scratch, defensive edge-case first, etc.).',
    '',
    `TASK: ${instruction}`,
    '',
    `Respond with ONLY a JSON array of exactly ${count} objects:`,
    '[{"id": "<kebab-case-slug>", "hint": "STRATEGY: <one or two imperative sentences>"}]',
  ].join('\n');
}

/** Extract the first JSON array of {id, hint} objects from model output. */
export function parseSeedArray(text: string): StrategySeed[] {
  // Anchor on an array of objects so brackets in surrounding prose
  // ("[done]", markdown links) can't corrupt the slice; try the lazy match
  // first, then the greedy one for arrays whose objects contain ']'.
  let parsed: unknown;
  for (const re of [/\[\s*\{[\s\S]*?\}\s*\]/, /\[\s*\{[\s\S]*\}\s*\]/]) {
    const match = text.match(re);
    if (!match) continue;
    try {
      parsed = JSON.parse(match[0]);
      break;
    } catch {
      parsed = undefined;
    }
  }
  if (!Array.isArray(parsed)) return [];

  const seen = new Set<string>();
  const seeds: StrategySeed[] = [];
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { id, hint } = entry as { id?: unknown; hint?: unknown };
    if (typeof id !== 'string' || typeof hint !== 'string') continue;
    const slug = id.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
    if (!slug || !hint.trim() || seen.has(slug)) continue;
    seen.add(slug);
    seeds.push({ id: slug, hint: hint.trim().slice(0, MAX_HINT_CHARS) });
  }
  return seeds;
}

/**
 * Generate task-specific divergent strategy seeds via one model call.
 * Falls back to DEFAULT_STRATEGY_SEEDS on any failure — ideation is an
 * outcome optimizer, never a blocker.
 */
export async function generateStrategySeeds(
  instruction: string,
  executor: LoopExecutor,
  options: IdeationOptions = {}
): Promise<StrategySeed[]> {
  const count = Math.min(MAX_CANDIDATES, Math.max(2, options.count ?? DEFAULT_SEED_COUNT));
  const attempts = Math.max(1, options.attempts ?? DEFAULT_ATTEMPTS);
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const raw = await executor(buildIdeationPrompt(instruction, count));
      const seeds = parseSeedArray(raw);
      // Require at least two usable seeds — one seed defeats the purpose of
      // divergent exploration and signals a degenerate model response.
      if (seeds.length >= 2) return seeds.slice(0, count);
    } catch {
      // fall through to retry / defaults
    }
  }
  return DEFAULT_STRATEGY_SEEDS;
}

/**
 * Convert curated ideas (plain strings, e.g. from an open-collider project's
 * curated_ideas.json via `uap ideate ideas`) into explorer strategy seeds.
 * Returns [] when no usable ideas are provided so callers can fall back.
 */
export function seedsFromIdeas(ideas: string[], options: IdeationOptions = {}): StrategySeed[] {
  const count = Math.min(MAX_CANDIDATES, Math.max(2, options.count ?? DEFAULT_SEED_COUNT));
  const seeds: StrategySeed[] = [];
  for (let i = 0; i < ideas.length && seeds.length < count; i++) {
    const idea = ideas[i]?.trim();
    if (!idea) continue;
    seeds.push({
      id: `idea-${seeds.length + 1}`,
      hint: `STRATEGY: Apply this curated idea to the task — ${idea.slice(0, MAX_HINT_CHARS)}`,
    });
  }
  return seeds.length >= 2 ? seeds : [];
}
