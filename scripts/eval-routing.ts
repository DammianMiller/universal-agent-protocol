/**
 * CLI: npm run eval:routing [-- --json] [--threshold 0.9] [--verbose]
 *
 * Runs the routing eval over .factory patterns/droids/skills and exits
 * nonzero when rank-1 accuracy drops below the threshold or any negative
 * case false-routes. CI-enforced (routing-evals workflow + vitest test).
 */

import {
  runRoutingEval,
  formatReport,
  DEFAULT_THRESHOLD,
} from '../src/evals/routing-eval.js';

function main(): void {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const verbose = args.includes('--verbose');
  const thresholdIdx = args.indexOf('--threshold');
  const threshold =
    thresholdIdx >= 0 ? Number.parseFloat(args[thresholdIdx + 1]) : DEFAULT_THRESHOLD;
  if (Number.isNaN(threshold) || threshold <= 0 || threshold > 1) {
    console.error(`invalid --threshold value (expected 0 < t <= 1)`);
    process.exit(2);
  }

  const report = runRoutingEval(process.cwd(), { threshold });

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatReport(report));
    if (verbose) {
      const weak = report.weakEntries.length;
      console.log(`\ncorpus weak-description count: ${weak}`);
    }
  }
  process.exit(report.meetsThreshold ? 0 : 1);
}

main();
