/**
 * Policy ordering — decide the FIRING ORDER of policies to minimize wasted agent
 * turns and maximize compliance.
 *
 * Principle: a policy that will STOP or redirect an agent should fire as early
 * and as cheaply as possible, so the agent is corrected before it burns turns on
 * work the gate would reject anyway. Concretely we rank by, in order:
 *   1. enforcement stage — pre-exec (gate BEFORE the action) before post-exec/review,
 *   2. level — REQUIRED (hard blocks) before RECOMMENDED before OPTIONAL,
 *   3. category "early-exit weight" — cheap fail-fast gates (safety/worktree/task)
 *      before expensive semantic ones (docs/quality),
 *   4. name, for stable output.
 *
 * `heuristicOrder` is deterministic and always available. `buildOrderPrompt` /
 * `parseOrderResponse` power the optional AI refinement, where a model re-ranks
 * the same list with a written rationale (see aiRefineOrder in the dashboard).
 *
 * Priority is the stored sort key (higher = fires earlier); assignPriorities maps
 * an ordered list to a descending priority ladder.
 */

export interface OrderablePolicy {
  id?: string;
  name: string;
  category: string;
  /** REQUIRED | RECOMMENDED | OPTIONAL */
  level: string;
  /** pre-exec | always | post-exec | review */
  stage: string;
  description?: string;
}

const STAGE_RANK: Record<string, number> = { 'pre-exec': 0, always: 1, 'post-exec': 2, review: 3 };
const LEVEL_RANK: Record<string, number> = { REQUIRED: 0, RECOMMENDED: 1, OPTIONAL: 2 };
// Lower weight = fires earlier. Cheap, high-hit-rate, fail-fast gates first.
const CATEGORY_WEIGHT: Record<string, number> = {
  safety: 0,
  security: 0,
  workflow: 1,
  process: 1,
  routing: 2,
  quality: 3,
  documentation: 4,
  custom: 5,
};

function stageRank(s: string): number {
  return STAGE_RANK[s?.toLowerCase()] ?? 1;
}
function levelRank(l: string): number {
  return LEVEL_RANK[(l ?? '').toUpperCase()] ?? 2;
}
function categoryWeight(c: string): number {
  return CATEGORY_WEIGHT[(c ?? '').toLowerCase()] ?? 5;
}

/** Deterministic best-first ordering (see module doc for the ranking). */
export function heuristicOrder<T extends OrderablePolicy>(policies: T[]): T[] {
  return [...policies].sort((a, b) => {
    const s = stageRank(a.stage) - stageRank(b.stage);
    if (s) return s;
    const l = levelRank(a.level) - levelRank(b.level);
    if (l) return l;
    const c = categoryWeight(a.category) - categoryWeight(b.category);
    if (c) return c;
    return a.name.localeCompare(b.name);
  });
}

/**
 * Map an ordered list of names to descending priorities (first = highest). The
 * ladder leaves gaps so a single policy can be nudged between two others without
 * renumbering everything.
 */
export function assignPriorities(orderedNames: string[], base = 1000, step = 10): Map<string, number> {
  const out = new Map<string, number>();
  orderedNames.forEach((name, i) => out.set(name, Math.max(0, base - i * step)));
  return out;
}

/** Prompt a model to re-rank policies for the wasted-turns / compliance objective. */
export function buildOrderPrompt(policies: OrderablePolicy[]): string {
  const rows = policies
    .map((p) => `- ${p.name} [level=${p.level}, stage=${p.stage}, category=${p.category}]${p.description ? `: ${p.description}` : ''}`)
    .join('\n');
  return [
    'You are ordering the FIRING ORDER of a coding agent\'s policy gates.',
    'Goal: minimize WASTED agent turns and maximize COMPLIANCE — a policy that will',
    'stop or redirect the agent should fire as early and cheaply as possible, so the',
    'agent is corrected before doing work the gate would reject. Prefer: pre-exec',
    'gates before post-exec; hard/REQUIRED blocks before advisory; cheap fail-fast',
    'checks (worktree, task, safety) before expensive semantic ones.',
    '',
    'Policies:',
    rows,
    '',
    'Respond with ONLY JSON: {"order": ["<policy name>", ... every policy exactly once, best-first], "rationale": "<one or two sentences>"}',
  ].join('\n');
}

export interface OrderSuggestion {
  order: string[];
  rationale: string;
}

/**
 * Parse a model ordering response. Keeps only known names, de-dupes, and appends
 * any names the model omitted (in heuristic order) so the result is always a
 * complete permutation. Returns null when no usable order is found.
 */
export function parseOrderResponse(text: string, validNames: string[]): OrderSuggestion | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let parsed: { order?: unknown; rationale?: unknown };
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return null;
  }
  const valid = new Set(validNames);
  const seen = new Set<string>();
  const order: string[] = [];
  if (Array.isArray(parsed.order)) {
    for (const n of parsed.order) {
      const name = String(n);
      if (valid.has(name) && !seen.has(name)) {
        order.push(name);
        seen.add(name);
      }
    }
  }
  if (order.length === 0) return null;
  // Append any omitted policies so the order stays complete.
  for (const n of validNames) if (!seen.has(n)) order.push(n);
  const rationale = typeof parsed.rationale === 'string' ? parsed.rationale.slice(0, 500) : '';
  return { order, rationale };
}
