/**
 * One typed read of the `principles` block in `.uap.json`.
 *
 * Read RAW rather than through `PrinciplesSchema`, for one specific reason:
 * the schema defaults `compat`/`maturity` to `'ask'`, and this feature's whole
 * premise is that an unanswered stance stays visibly unanswered. Going through
 * the parser would hand every caller a value where the user supplied none.
 *
 * Shared because three call sites each grew their own copy of the same cast —
 * which is the duplication rule 6 is about, in the module that ships rule 6.
 */
import { loadUapConfigRaw } from '../utils/config-loader.js';

export interface PrinciplesConfig {
  enabled: boolean;
  injectDeliver: boolean;
  /** Raw stance values; only 'preserve'/'remove' and 'greenfield'/'production'
   * are meaningful — 'ask', absent, and anything else mean "not answered". */
  compat?: unknown;
  maturity?: unknown;
}

export function readPrinciplesConfig(cwd: string): PrinciplesConfig {
  let block: Record<string, unknown> = {};
  try {
    const raw = loadUapConfigRaw(cwd);
    block = (raw?.principles ?? {}) as Record<string, unknown>;
  } catch {
    // An unreadable config means "nothing configured", never a crash: this is
    // consulted on prompt paths that must not fail.
    block = {};
  }
  return {
    // Both default ON when absent, so the feature works without configuration.
    enabled: block.enabled !== false,
    injectDeliver: block.injectDeliver !== false,
    compat: block.compat,
    maturity: block.maturity,
  };
}
