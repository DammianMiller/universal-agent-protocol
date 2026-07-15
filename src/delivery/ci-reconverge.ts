/**
 * CI Watch + Re-converge — the `--watch-ci` boundary extracted from
 * deliver.ts behind seams (the last sizeable untested policy closure after
 * the orchestrated- and epic-mission extractions).
 *
 * Once local tiers are green, the caller's `commitAndWatch` commits/pushes
 * the branch and watches the CI run. On CI/deploy failure, the sanitized
 * feedback is fed into a fresh convergence pass (`reconverge`), bounded by
 * `ciPasses`. `skipped`/`no-run` end the watch without failing the mission;
 * exhausting the passes (or a re-converge that cannot reach local-green)
 * fails it with the CI feedback attached.
 */

import type { DeliveryResult } from './convergence-loop.js';
import { foldDeliveryResult } from './delivery-result.js';

export interface CiWatchOutcome {
  status: 'green' | 'failed' | 'timeout' | 'skipped' | 'no-run';
  feedback?: string;
  runUrl?: string;
}

export interface CiReconvergeDeps {
  /** The mission text (re-converge prompts are `instruction + feedback`). */
  instruction: string;
  /** The locally-green mission result the watch starts from. */
  initial: DeliveryResult;
  /** Max CI re-converge passes before the mission is declared failed. */
  ciPasses: number;
  /** Commit + push the given files and watch the CI run to a terminal state. */
  commitAndWatch: (files: string[]) => Promise<CiWatchOutcome>;
  /** Explicit changed-file list fallback: the agentic executor reports no
   * applied files (it mutates the repo directly), and the watcher must never
   * fall back to a blanket `git add -A`. */
  changedFiles: () => string[];
  /** One fresh convergence pass against the CI feedback (baseline off —
   * local gates already pass, turn 1 must run the model). */
  reconverge: (prompt: string) => Promise<DeliveryResult>;
  /** Suffix for the green line (e.g. " (staging/prod deploy verified)"). */
  greenDetail?: string;
  /** Progress lines (the caller decorates with chalk). */
  note?: (line: string) => void;
}

/** Run the CI watch loop; returns the final mission result. */
export async function runCiReconverge(deps: CiReconvergeDeps): Promise<DeliveryResult> {
  const note = deps.note ?? ((): void => undefined);
  let result = deps.initial;
  let pass = 0;
  for (;;) {
    // Prefer the loop's applied-file set; fall back to the explicit
    // git-status list when the executor reported none.
    let files = [...new Set(result.history.flatMap((h) => h.filesApplied ?? []))];
    if (files.length === 0) files = deps.changedFiles();
    if (files.length === 0) {
      // NEVER hand the watcher an empty set: its blanket-staging fallback
      // (`git add -A`) would bypass the caller's exclusion filters — the
      // exact thing the explicit-file seam exists to prevent. Nothing to
      // commit means nothing to watch.
      note('  ⚠ watch-ci: no changed files to commit — skipping the CI watch');
      return result;
    }
    const watch = await deps.commitAndWatch(files);

    if (watch.status === 'green') {
      note(`  ✓ CI green${deps.greenDetail ?? ''}`);
      return result;
    }
    if (watch.status === 'skipped' || watch.status === 'no-run') {
      note(`  ⚠ watch-ci ${watch.status}: ${watch.feedback ?? ''}`);
      return result;
    }

    // failed | timeout
    pass++;
    note(`  ✗ CI ${watch.status} (re-converge pass ${pass}/${deps.ciPasses})`);
    if (pass >= deps.ciPasses) {
      note(`  watch-ci: exhausted ${deps.ciPasses} pass(es); CI still not green.`);
      return { ...result, success: false, finalFeedback: watch.feedback ?? result.finalFeedback };
    }
    note('  ⟲ re-converging against CI feedback…');
    const rerun = await deps.reconverge(`${deps.instruction}\n\n${watch.feedback ?? ''}`);
    // FOLD rather than replace: the initial run's history/turns must survive
    // into task records, practices, and telemetry. Clone lazily so the
    // caller's `initial` object is never mutated.
    if (result === deps.initial) {
      result = { ...deps.initial, history: [...deps.initial.history] };
    }
    foldDeliveryResult(result, rerun);
    result.success = rerun.success;
    if (!rerun.success) {
      note('  re-converge did not reach local-green; stopping watch-ci.');
      return result;
    }
  }
}
