/**
 * GEPA-style reflect phase (S6).
 *
 * Upgrades the loop's reflection from "fix-list for the next turn" (critic.ts)
 * to "reflect on WHY the approach failed → rewrite the approach/instruction →
 * retry", with a Pareto archive of the best reflected candidates so the loop
 * reseeds from proven approaches instead of always mutating the latest one
 * (which collapses to a local optimum — the same anti-Goodhart insight as the
 * per-phase Generator≠Evaluator rule).
 *
 * This module is pure: the archive + the rewrite parser. The live wiring
 * (a reflect turn before model escalation, feeding IterationDirective
 * .mutateInstruction into the PromptBuilder) is the consumption step.
 */

export interface ApproachRewrite {
  /** Reflection: why the prior approach/reasoning failed. */
  why: string;
  /** The rewritten instruction/approach to try next. */
  newInstruction: string;
}

export interface ReflectCandidate {
  /** The (possibly rewritten) approach/instruction. */
  instruction: string;
  /** The acceptance/quality score this approach achieved. */
  score: number;
  /** The turn it was produced on (tie-break: prefer earlier). */
  turn: number;
}

/**
 * A bounded best-K archive of reflected candidates by score. Deterministic:
 * dedupes by instruction (keeping the higher score), sorts by score desc then
 * earlier turn, and truncates to K. Pure — no I/O, no clock.
 */
export class ReflectArchive {
  private items: ReflectCandidate[] = [];

  constructor(private readonly k: number = 4) {
    this.k = Math.max(1, Math.floor(k));
  }

  add(c: ReflectCandidate): void {
    const i = this.items.findIndex((x) => x.instruction === c.instruction);
    if (i >= 0) {
      if (c.score > this.items[i].score) this.items[i] = c;
    } else {
      this.items.push(c);
    }
    this.items.sort((a, b) => b.score - a.score || a.turn - b.turn);
    if (this.items.length > this.k) this.items = this.items.slice(0, this.k);
  }

  best(): ReflectCandidate | undefined {
    return this.items[0];
  }

  all(): ReflectCandidate[] {
    return [...this.items];
  }

  size(): number {
    return this.items.length;
  }

  /**
   * The best archived candidate whose instruction differs from `current` — so a
   * reflect turn tries a proven-but-DIFFERENT approach rather than re-deriving
   * the one that just stalled. Returns undefined when the archive holds nothing
   * new to try.
   */
  reseedFrom(current: string): ReflectCandidate | undefined {
    return this.items.find((x) => x.instruction !== current);
  }
}

/**
 * Parse a reflect model's output into an ApproachRewrite. Fail-soft: returns
 * null when no usable rewrite is present, so a flaky reflect turn never wedges
 * the loop (the caller falls back to model escalation).
 */
export function parseApproachRewrite(raw: string): ApproachRewrite | null {
  try {
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const o = JSON.parse(m[0]) as { why?: unknown; newInstruction?: unknown };
    if (typeof o.newInstruction === 'string' && o.newInstruction.trim() !== '') {
      return { why: typeof o.why === 'string' ? o.why : '', newInstruction: o.newInstruction };
    }
    return null;
  } catch {
    return null;
  }
}
