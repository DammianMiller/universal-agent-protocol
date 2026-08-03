/**
 * Rendering the principles for the two places they land.
 *
 * `renderCompact` goes into the deliver prompt, once per turn, alongside the
 * output contract — so it is capped hard. Prompt budget is not free here: the
 * measured first-turn failure mode on the local model is completions truncated
 * by budget, and every line spent on principles is a line not spent on the task.
 *
 * `renderFull` goes into the policy body / CLAUDE.md, read once by a human or
 * loaded once per session, where the reasoning is worth the words.
 */
import { COMPAT_CARVE_OUTS, CORE_PRINCIPLES, compatRule, principlesFor } from './rules.js';
import type { CompatStance, Maturity } from './rules.js';

/** Hard ceiling for the deliver-prompt section, including its header. */
export const COMPACT_MAX_LINES = 12;

export interface RenderOptions {
  compat: CompatStance;
  maturity: Maturity;
  /** Note that the stance was assumed, not answered (unattended runs). */
  assumed?: boolean;
}

/**
 * The carve-out line, shown only when it can actually bite.
 *
 * Under `preserve` there is nothing to carve out of, so the line would be pure
 * prompt cost.
 */
function carveOutLine(compat: CompatStance): string | null {
  if (compat !== 'remove') return null;
  return `  ...except on ${COMPAT_CARVE_OUTS.length} surfaces others depend on: CLI flags/output, MCP tool schemas, DB/config schemas + migrations, exported types. Migrate those, never delete them.`;
}

/** Compact form for the deliver prompt. */
export function renderCompact(opts: RenderOptions): string {
  const lines: string[] = ['ENGINEERING PRINCIPLES — apply these while writing the code:'];

  const rules = principlesFor(opts.compat);
  for (const p of rules) {
    lines.push(`- ${p.short}`);
  }

  const carve = carveOutLine(opts.compat);
  if (carve) lines.push(carve);

  if (opts.assumed) {
    lines.push(
      '  (backward-compatibility stance was not set for this project; assuming preserve)'
    );
  }

  // Never let this section grow past its budget, whatever is added upstream.
  return lines.slice(0, COMPACT_MAX_LINES).join('\n');
}

/** Full form for the policy body / CLAUDE.md block. */
export function renderFull(opts: RenderOptions): string {
  const sections: string[] = [];

  const rule1 = compatRule(opts.compat);
  sections.push(`1. **${rule1.text}**`);
  if (opts.compat === 'remove') {
    sections.push('');
    sections.push('   This never applies to the surfaces other people are bound to:');
    for (const c of COMPAT_CARVE_OUTS) sections.push(`   - ${c}`);
    sections.push('');
    sections.push(
      '   On those, migrate callers first. Removing them is a breaking change, not a simplification.'
    );
  }

  for (const p of CORE_PRINCIPLES) {
    sections.push('');
    sections.push(`${p.id}. ${p.text}`);
    if (opts.maturity === 'production' && p.productionNote) {
      sections.push(`   ${p.productionNote}`);
    }
  }

  return sections.join('\n');
}
