#!/usr/bin/env node
/**
 * Thin CLI wrapper around runExecutionGate so the synchronous verifier ladder
 * can invoke the (async) execution gate as a normal spawned rung:
 *
 *   node dist/delivery/execution-gate-runner.js <projectRoot>
 *
 * Exits 0 when the artifact runs clean, 1 when it errors. Prints the outputTail
 * to stdout so the ladder captures it as gate feedback.
 */

import { runExecutionGate } from './execution-gate.js';

async function main(): Promise<void> {
  const projectRoot = process.argv[2] ?? process.cwd();
  const result = await runExecutionGate(projectRoot);
  if (result.failureReason) {
    process.stdout.write(`${result.passed ? 'OK' : 'FAIL'} (${result.via}): ${result.failureReason}\n`);
  } else {
    process.stdout.write(`${result.passed ? 'OK' : 'FAIL'} (${result.via})\n`);
  }
  if (result.outputTail) process.stdout.write(result.outputTail + '\n');
  // A passing rung's stdout is dropped by the ladder, so surface a skip/no-run
  // (e.g. ESM web app + no chromium) on stderr too — a required gate that did
  // not actually execute the artifact must not be a silent green.
  if (result.passed && result.via === 'none') {
    process.stderr.write(`execution-gate: NOT EXECUTED — ${result.failureReason ?? 'no artifact'}. Install a headless browser for full web coverage.\n`);
  }
  process.exit(result.passed ? 0 : 1);
}

main().catch((e) => {
  process.stderr.write(`execution-gate-runner crashed: ${String(e)}\n`);
  process.exit(1);
});
