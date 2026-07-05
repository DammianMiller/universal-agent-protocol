/**
 * Persistence reactor injection (Option D) — inject the "keep going, here is
 * what remains" directive into interactive sessions each prompt, so any model
 * (not just Fable, and not only inside `uap deliver`) is continuously told to
 * persist toward the whole multi-epic build's completion.
 *
 * Fires ONLY when hands-free is enabled AND an active completion ledger has
 * remaining items — casual sessions with no build in progress see nothing.
 * Deduped per session by the reactor via a surfaced key; fail-soft.
 */

import { loadLedger, remainingItems, formatRemaining } from '../delivery/completion-ledger.js';
import { loadPersistenceConfig, resolveActiveModel } from '../delivery/handsfree-config.js';
import { resolvePersistenceProfile } from '../delivery/persistence-profile.js';

/**
 * Return the persistence directive for injection, or null when hands-free is
 * off, there is no ledger, or the build is already complete.
 */
export function maybePersistenceInjection(cwd: string): string | null {
  try {
    const cfg = loadPersistenceConfig(cwd);
    if (cfg.enabled === false) return null;
    const ledger = loadLedger(cwd);
    if (!ledger) return null;
    const remaining = remainingItems(ledger);
    if (remaining.length === 0) return null;

    const profile = resolvePersistenceProfile(resolveActiveModel(cwd), cfg);
    if (!profile.injectAutonomy) return null;

    return [
      'A multi-epic build is IN PROGRESS and is NOT complete. Work hands-free to',
      '100% completion: do not stop to ask, do not hand back partial work, and do',
      'not declare done while items remain. Finish the current item, then continue',
      'to the next until the whole build is complete and its gates pass.',
      '',
      formatRemaining(ledger),
    ].join('\n');
  } catch {
    return null;
  }
}
