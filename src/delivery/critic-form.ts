/**
 * P39 fixed-form critic — the fresh critic's output contract for the
 * quality-tier uplift (0.3): a verdict of yes or no, at most five faults,
 * each ranked with a number, one line each, each marked blocking or minor.
 *
 * The critic is ADVISORY above the deterministic tier gate (0.2's compileGap
 * stays the floor): a missing or malformed critic report never changes the
 * acceptance verdict, it only fails to advise. Parsing is therefore
 * fail-soft-by-design (null), unlike the tier gate's fail-closed refusals.
 */

export interface CriticFault {
  /** 1 = the single biggest gap; the loop fixes rank 1 first. */
  rank: number;
  /** One line, actionable, no prose walls. */
  note: string;
  severity: 'blocking' | 'minor';
}

export interface CriticReport {
  verdict: 'yes' | 'no';
  faults: CriticFault[];
}

/** Max faults in the fixed form. */
export const CRITIC_MAX_FAULTS = 5;

/**
 * Prompt section appended to the acceptance judge when a DISTINCT critic is
 * active. Asks for the fixed form INSIDE the existing JSON verdict so the
 * loop-facing contract (criteria + pass) never changes.
 */
export const CRITIC_FORM_SECTION = [
  '',
  '=== CRITIC FORM (P39) ===',
  'You are also the fresh critic. In the SAME JSON object, add a "critic" field:',
  '{"critic":{"verdict":"yes|no","faults":[{"rank":1,"note":"<one line>","severity":"blocking|minor"}]}}',
  'Rules: "verdict" is "yes" only when no blocking fault remains. At most five',
  'faults, ranked most-important first (rank 1 = the single biggest gap), one',
  'line each, every fault marked "blocking" or "minor". A clean delivery is',
  '"verdict":"yes" with an empty faults array. Judge only what the evidence shows.',
].join('\n');

/**
 * Parse the critic out of an already-extracted acceptance JSON object.
 * Returns null for anything that is not the fixed form — advisory, never
 * blocking: a malformed critic must not wedge delivery.
 */
export function parseCriticReport(parsed: Record<string, unknown> | null): CriticReport | null {
  if (!parsed) return null;
  const c = parsed.critic as Record<string, unknown> | undefined;
  if (!c || typeof c !== 'object') return null;
  if (c.verdict !== 'yes' && c.verdict !== 'no') return null;
  const rawFaults = Array.isArray(c.faults) ? (c.faults as unknown[]) : [];
  const faults: CriticFault[] = [];
  for (const f of rawFaults.slice(0, CRITIC_MAX_FAULTS)) {
    const o = (f ?? {}) as Record<string, unknown>;
    const note = typeof o.note === 'string' ? o.note.trim().slice(0, 300) : '';
    const severity = o.severity === 'blocking' || o.severity === 'minor' ? o.severity : null;
    if (!note || !severity) continue; // not the fixed form — drop the fault, keep the report
    faults.push({ rank: typeof o.rank === 'number' && o.rank >= 1 ? o.rank : faults.length + 1, note, severity });
  }
  return { verdict: c.verdict, faults: faults.slice(0, CRITIC_MAX_FAULTS) };
}

/** Render the critic report for loop feedback and logs — rank 1 first. */
export function formatCriticReport(c: CriticReport): string {
  const head = c.verdict === 'yes' ? 'CRITIC ✓ (no blocking fault)' : 'CRITIC ✗';
  const lines = [...c.faults]
    .sort((a, b) => a.rank - b.rank)
    .map((f) => `  ${f.rank}) ${f.note} [${f.severity}]`);
  return [head, ...lines].join('\n');
}
