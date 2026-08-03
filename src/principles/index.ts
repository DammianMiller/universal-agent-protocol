/**
 * Engineering principles — public surface.
 *
 * The rules themselves live in `rules.ts`; how rule 1 is resolved lives in
 * `stance.ts`; how they are worded for each audience lives in `render.ts`.
 */
import { readPrinciplesConfig } from './config.js';
import { renderCompact, renderFull } from './render.js';
import { resolveStance, stanceForUnattended } from './stance.js';

export * from './rules.js';
export * from './stance.js';
export * from './render.js';
export { readPrinciplesConfig } from './config.js';
export { maybePrinciplesInjection, isCodeWork } from './reactor-inject.js';

/**
 * The compact principles block for a deliver run, or undefined when it should
 * not be injected.
 *
 * Unattended by construction: a run never stops to ask for the stance, it
 * proceeds on `preserve` and says so in the prompt.
 */
export function resolvePrinciplesSection(cwd: string): string | undefined {
  const config = readPrinciplesConfig(cwd);
  if (!config.enabled || !config.injectDeliver) return undefined;

  const { compat, maturity, assumed } = stanceForUnattended(resolveStance(cwd));
  return renderCompact({ compat, maturity, assumed });
}

/** The full principles body for the policy / CLAUDE.md block. */
export function resolvePrinciplesBody(cwd: string): string {
  const { compat, maturity } = stanceForUnattended(resolveStance(cwd));
  return renderFull({ compat, maturity });
}
