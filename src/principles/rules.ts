/**
 * Engineering principles — the rule set itself, as data.
 *
 * Source: a widely-circulated AGENTS.md distilled from ~60B tokens of
 * agent-driven coding (x.com/MarcosHernanz/status/2083954734487212511). Its
 * author explicitly scopes it to side projects ("don't use it in production if
 * you don't want to destroy your codebase"), which is why rule 1 is not a fixed
 * stance here — see `stance.ts`.
 *
 * Rules 2-8 are unconditional. Rule 1 (backward compatibility) is resolved per
 * project per session, and even under `remove` it never applies to the surfaces
 * other people's code is bound to (COMPAT_CARVE_OUTS).
 */

/** Whether obsolete paths get deleted or kept working. */
export type CompatStance = 'preserve' | 'remove';

/** How much a wrong call costs — tunes how absolute the wording is. */
export type Maturity = 'greenfield' | 'production';

export interface Principle {
  id: number;
  /** Full statement, used in the policy / CLAUDE.md render. */
  text: string;
  /** One-line form for the deliver prompt, where every line costs budget. */
  short: string;
  /** Appended on a production-maturity project. */
  productionNote?: string;
}

/**
 * Surfaces where compatibility is preserved even when the stance is `remove`.
 *
 * Deleting an obsolete path is cheap when the only caller is this repo. These
 * are the ones with callers you cannot see or update: users' scripts, other
 * agents' tool calls, and data already on disk. `remove` that reaches them is
 * not simplification, it is a breaking change with no migration.
 */
export const COMPAT_CARVE_OUTS: readonly string[] = [
  'the public CLI surface — command names, flags, and their output contracts',
  'MCP tool names and input schemas',
  'database, config, and on-disk state schemas, including their migrations',
  'exported types and public module entry points',
];

/** Rule 1, whose wording follows the resolved stance. */
export function compatRule(stance: CompatStance): Principle {
  return stance === 'remove'
    ? {
        id: 1,
        text:
          'Do not preserve backward compatibility. Remove obsolete paths instead of adding compatibility layers, fallbacks, or migrations.',
        short: 'Delete obsolete paths — no compat shims, fallbacks, or migrations.',
      }
    : {
        id: 1,
        text:
          'Preserve backward compatibility. Keep existing paths working and migrate callers before removing anything.',
        short: 'Keep existing paths working; migrate callers before removing anything.',
      };
}

/** Rules 2-8: unconditional, in the order they were published. */
export const CORE_PRINCIPLES: readonly Principle[] = [
  {
    id: 2,
    text: 'Choose the simplest implementation that fully meets the current requirements. Avoid speculative abstractions, configuration, and indirection.',
    short: 'Simplest implementation that fully meets the requirement — no speculative abstraction.',
    productionNote: 'Extension points that existing callers already rely on are requirements, not speculation.',
  },
  {
    id: 3,
    text: 'Grow the system in layers. Start from the smallest version that works end to end, and add each new capability on top of a product that already works. Never trade a working product for unfinished complexity.',
    short: 'Build the smallest end-to-end version first; never trade working code for unfinished complexity.',
  },
  {
    id: 4,
    text: 'Keep components modular and concerns clearly separated.',
    short: 'Keep components modular and concerns separated.',
  },
  {
    id: 5,
    text: 'Prefer established, well-maintained libraries when they reduce overall complexity or improve reliability. Do not reimplement common functionality without a clear reason.',
    short: 'Prefer established libraries over reimplementing common functionality.',
    productionNote: 'Weigh a new dependency against its supply-chain and upgrade cost before adding it.',
  },
  {
    id: 6,
    text: 'Lean on the dependencies already in the project before writing your own implementation or adding packages. Do not assume a library lacks a capability without checking its documentation and types.',
    short: 'Use deps already in the project; check their docs/types before hand-rolling or adding one.',
  },
  {
    id: 7,
    text: 'Make architectural decisions for the long term. Do not accept a stopgap that only works for now and is meant to be replaced later.',
    short: 'Decide for the long term — no stopgaps meant to be replaced later.',
  },
  {
    id: 8,
    text: 'Study how established products solve the problem before designing a solution. Adopt their proven patterns and conventions rather than inventing an approach from scratch.',
    short: 'Study how established products solve it before designing; adopt proven patterns.',
  },
];

/** The full ordered rule set for a resolved stance. */
export function principlesFor(stance: CompatStance): Principle[] {
  return [compatRule(stance), ...CORE_PRINCIPLES];
}

/**
 * The rules a code reviewer can actually judge from a diff, as one line.
 *
 * Deliberately a SUBSET. Rule 1 depends on a project stance the judge is not
 * told, and rules 3 and 4 are properties of a codebase over time rather than of
 * a candidate patch — asking a judge to score those invites confident noise.
 * What is left is visible in the code in front of it: reuse over reinvention,
 * simplicity, and stopgaps.
 */
export const JUDGEABLE_PRINCIPLE_IDS: readonly number[] = [2, 5, 6, 7];

export function judgeablePrinciples(): string {
  return CORE_PRINCIPLES.filter((p) => JUDGEABLE_PRINCIPLE_IDS.includes(p.id))
    .map((p) => p.short.replace(/\.$/, ''))
    .join('; ');
}
