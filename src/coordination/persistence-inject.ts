/**
 * Persistence reactor injection (Option D) — inject the "keep going, here is
 * what remains" directive into interactive sessions each prompt, so any model
 * (not just Fable, and not only inside `uap deliver`) is continuously told to
 * persist toward the whole multi-epic build's completion. The directive also
 * carries QUESTION DISCIPLINE: the replacement behavior for asking (observed
 * 2026-11-26: a 9-hour hands-free aerialocean session still ended turns with
 * "If you want, I can X, or Y first?" — a prohibition with no replacement
 * behavior loses to 40+ compactions of conversational turn-boundary habit;
 * the clause tells the model exactly what to do instead of asking).
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
      'QUESTION DISCIPLINE — what to do instead of asking: a question you end a',
      'turn with here goes unanswered and stops the build; the next event is a',
      'human reply, possibly hours later. "Do you want me to continue?", "Which',
      'should I do first?", "Should I also...?" — all of these are stops. When',
      'you notice yourself about to ask one: make the best-guess decision',
      'yourself, act on it immediately in the same turn, and record the',
      'assumption (and the alternative you rejected) in your output. Only a',
      'decision that is genuinely the human\'s to make — spending money,',
      'publishing externally, deleting unrecoverable data — is worth stopping',
      'for, and even then prepare everything preparable first so the stop costs',
      'one decision, not a to-do list.',
      '',
      formatRemaining(ledger),
    ].join('\n');
  } catch {
    return null;
  }
}
