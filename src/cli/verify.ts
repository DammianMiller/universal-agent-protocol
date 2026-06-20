/**
 * `uap verify` — run the project's completion gates against whatever is on disk
 * and report pass/fail, independent of `uap deliver`.
 *
 * Why this exists: deliver's convergence loop verifies what IT produced, but an
 * agentic/opencode/Claude session that edits files directly never goes through
 * that loop — so a crash-class bug (the octopus TDZ) ships unverified. `uap
 * verify` closes that hole: it can be run manually, in CI, or from the Stop hook
 * (--strict, --runtime-only) to block a session from finishing on broken code.
 */

import { detectRungs, runTieredLadder, tierOf, type GateRung, type GateTier, type LadderResult } from '../delivery/verifier-ladder.js';

export interface VerifyOptions {
  /** Project directory to verify (default: cwd). */
  dir?: string;
  /** Treat "no verifiable gates" as a failure (fail-closed). */
  strict?: boolean;
  /** Run ONLY the runtime execution gate — cheap, for the Stop hook. */
  runtimeOnly?: boolean;
  /** Include the expensive integration / deploy-dev tiers (default: stop at runtime). */
  full?: boolean;
  /** Comma-separated rung-id subset filter. */
  gates?: string;
  /** Emit JSON instead of a text report. */
  json?: boolean;
  /** Per-rung timeout override (ms). */
  timeoutMs?: number;
}

export interface VerifyResult {
  passed: boolean;
  exitCode: number;
  /** True when there were no gates to run at all. */
  empty: boolean;
  report: string;
  ladder?: LadderResult;
  rungs: GateRung[];
}

/** Core verify logic — pure-ish (no process.exit), so it is unit-testable. */
export async function runVerify(opts: VerifyOptions = {}): Promise<VerifyResult> {
  const dir = opts.dir ?? process.cwd();
  let rungs = detectRungs(dir);

  if (opts.gates) {
    const want = new Set(opts.gates.split(',').map((s) => s.trim()).filter(Boolean));
    rungs = rungs.filter((r) => want.has(r.id));
  }
  if (opts.runtimeOnly) {
    rungs = rungs.filter((r) => tierOf(r) === 'runtime');
  }

  if (rungs.length === 0) {
    // Fail-closed in strict mode: refuse to report "verified" when nothing could
    // actually be checked. Otherwise it's an honest no-op, not a failure.
    const passed = !opts.strict;
    const msg = opts.runtimeOnly
      ? 'no runnable artifact detected — nothing to execute'
      : 'no verifiable gates detected (no build/test/runnable artifact)';
    return {
      passed,
      exitCode: passed ? 0 : 1,
      empty: true,
      report: `${opts.strict && !passed ? 'UNVERIFIED' : 'SKIP'}: ${msg}`,
      rungs,
    };
  }

  const maxTier: GateTier = opts.full ? 'deploy-dev' : 'runtime';
  const ladder = await runTieredLadder(rungs, dir, {
    maxTier,
    ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
  });

  const report = formatReport(ladder);
  // Exit-code contract for the Stop hook: 0 = verified, 1 = a REAL gate failure
  // (the code is broken), 3 = INFRA failure (gate timed out / could not spawn /
  // killed by signal). The hook hard-blocks only on 1; 3 fails OPEN so a flaky
  // runner or a hung browser can never wedge a session on broken tooling.
  let exitCode = 0;
  if (!ladder.passed) {
    const realFailures = ladder.results.filter(
      (r) => !r.passed && !r.skipped && r.failureReason === 'exit'
    );
    exitCode = realFailures.length > 0 ? 1 : 3;
  }
  return {
    passed: ladder.passed,
    exitCode,
    empty: false,
    report,
    ladder,
    rungs,
  };
}

function formatReport(ladder: LadderResult): string {
  const lines: string[] = [];
  for (const r of ladder.results) {
    const mark = r.skipped ? 'SKIP' : r.passed ? 'PASS' : 'FAIL';
    lines.push(`  [${mark}] ${r.name}${r.failureReason ? ` — ${r.failureReason}` : ''}`);
    if (!r.passed && !r.skipped && r.outputTail) {
      lines.push(
        r.outputTail
          .split('\n')
          .slice(0, 12)
          .map((l) => `        ${l}`)
          .join('\n')
      );
    }
  }
  const header = ladder.passed
    ? `VERIFIED ✓ (${Math.round(ladder.score * 100)}% of gates passed)`
    : `NOT VERIFIED ✗ (${Math.round(ladder.score * 100)}% of gates passed)`;
  return `${header}\n${lines.join('\n')}`;
}

/** CLI entry: print the report and exit with the gate-derived code. */
export async function verifyCommand(options: VerifyOptions): Promise<void> {
  const result = await runVerify(options);
  if (options.json) {
    process.stdout.write(
      JSON.stringify(
        {
          passed: result.passed,
          empty: result.empty,
          score: result.ladder?.score ?? null,
          results: result.ladder?.results ?? [],
        },
        null,
        2
      ) + '\n'
    );
  } else {
    process.stdout.write(result.report + '\n');
  }
  process.exit(result.exitCode);
}
