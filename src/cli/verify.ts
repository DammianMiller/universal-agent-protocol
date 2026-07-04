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
import { runAcceptanceGate, formatAcceptanceReport, type AcceptanceResult } from '../delivery/acceptance-judge.js';
import { runVisualGate, discoverEntryPages, type VisualVerdict } from '../delivery/visual-gate.js';
import type { LoopExecutor } from '../delivery/convergence-loop.js';

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
  /** Spec text to judge behavioral completeness against (the acceptance gate). */
  acceptanceSpec?: string;
  /** Model executor for the acceptance gate (injected; verifyCommand builds it). */
  acceptanceExecutor?: LoopExecutor;
  /** Visual gate: render entry pages, check blank/static/errors, save
   * screenshots (default ON for web artifacts; false disables; fail-open
   * without a browser). */
  visual?: boolean;
}

export interface VerifyResult {
  passed: boolean;
  exitCode: number;
  /** True when there were no gates to run at all. */
  empty: boolean;
  report: string;
  ladder?: LadderResult;
  rungs: GateRung[];
  acceptance?: AcceptanceResult;
  visual?: VisualVerdict;
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

  // The acceptance gate (behavioral completeness) can run with or without
  // runtime gates; compute it once and fold it into the result below.
  const acceptance =
    opts.acceptanceSpec && opts.acceptanceExecutor
      ? await runAcceptanceGate({ spec: opts.acceptanceSpec, projectRoot: dir, executor: opts.acceptanceExecutor })
      : undefined;
  // Acceptance is a JUDGMENT: it only affects the exit code under --strict, so
  // its nondeterminism never hard-blocks a session by default.
  const acceptanceBlocks = Boolean(acceptance && !acceptance.passed && opts.strict);
  const acceptanceReport = acceptance ? `\n${formatAcceptanceReport(acceptance)}` : '';

  if (rungs.length === 0) {
    // Fail-closed in strict mode: refuse to report "verified" when nothing could
    // actually be checked. Otherwise it's an honest no-op, not a failure.
    const gatePassed = !opts.strict;
    const passed = gatePassed && !acceptanceBlocks;
    const msg = opts.runtimeOnly
      ? 'no runnable artifact detected — nothing to execute'
      : 'no verifiable gates detected (no build/test/runnable artifact)';
    return {
      passed,
      exitCode: passed ? 0 : 1,
      empty: true,
      report: `${opts.strict && !gatePassed ? 'UNVERIFIED' : 'SKIP'}: ${msg}${acceptanceReport}`,
      rungs,
      acceptance,
    };
  }

  const maxTier: GateTier = opts.full ? 'deploy-dev' : 'runtime';
  const ladder = await runTieredLadder(rungs, dir, {
    maxTier,
    ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
  });

  // Visual gate: the rendered truth. Runs by default whenever the project has
  // entry pages (opts.visual === false disables); fail-open without a browser.
  // --runtime-only (the Stop hook's cheap path) skips it unless explicitly
  // forced with visual: true — sampling frames in a real browser is not cheap,
  // and minimal fixtures legitimately render near-blank.
  let visual: VisualVerdict | undefined;
  const visualWanted = opts.visual === true || (opts.visual !== false && !opts.runtimeOnly);
  if (visualWanted && discoverEntryPages(dir).length > 0) {
    visual = await runVisualGate(dir);
  }
  const visualBlocks = Boolean(visual && !visual.skipped && !visual.passed);
  let visualReport = visual ? `\n${visual.feedback}` : '';
  // Vision review (advisory): when a vision model is configured, score the
  // saved screenshots against the acceptance spec (or a generic quality bar).
  if (visual && !visual.skipped) {
    try {
      const { judgeScreenshots, visionSummary, visionJudgeConfigured } = await import('../delivery/vision-judge.js');
      if (visionJudgeConfigured()) {
        const shots = visual.pages.flatMap((pg) => pg.screenshots.slice(-1));
        const verdict = await judgeScreenshots(shots, opts.acceptanceSpec ?? 'A polished, working application UI.');
        const summary = visionSummary(verdict);
        if (summary) visualReport += `\n${summary}`;
      }
    } catch {
      // vision review is best-effort
    }
  }

  const report = formatReport(ladder) + visualReport + acceptanceReport;
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
  if (acceptanceBlocks && exitCode === 0) exitCode = 1;
  // Visual problems are REAL failures (blank canvas, static rAF scene,
  // runtime errors observed while watching) — they gate like broken code.
  if (visualBlocks && exitCode === 0) exitCode = 1;
  return {
    passed: ladder.passed && !acceptanceBlocks && !visualBlocks,
    exitCode,
    empty: false,
    report,
    ladder,
    rungs,
    acceptance,
    visual,
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

/** Build a text executor (prompt → completion) for the acceptance judge. */
async function buildAcceptanceExecutor(modelPreset?: string, endpoint?: string): Promise<LoopExecutor> {
  const { OpenAICompatClient } = await import('../models/openai-compat-client.js');
  const { ModelPresets } = await import('../models/types.js');
  const presetId = modelPreset ?? process.env.UAP_DELIVER_MODEL ?? 'qwen35-a3b';
  const model = ModelPresets[presetId];
  if (!model) {
    throw new Error(`Unknown model preset '${presetId}'. Available: ${Object.keys(ModelPresets).join(', ')}`);
  }
  const resolved = endpoint ? { ...model, endpoint } : model;
  // Privacy signal: the acceptance gate ships project source to the model. Warn
  // when that endpoint is NOT local so a remote target is a conscious choice.
  const ep = resolved.endpoint ?? process.env.UAP_INFERENCE_ENDPOINT ?? '';
  if (ep && !/^https?:\/\/(localhost|127\.|0\.0\.0\.0|\[?::1\]?|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(ep)) {
    process.stderr.write(`uap verify: acceptance gate will send project source to a NON-LOCAL endpoint (${ep}).\n`);
  }
  const client = new OpenAICompatClient();
  return async (prompt: string) => {
    const r = await client.complete(resolved, prompt, { temperature: 0.1 });
    return r.content;
  };
}

/** CLI entry: print the report and exit with the gate-derived code. */
export async function verifyCommand(
  options: VerifyOptions & { acceptanceFile?: string; model?: string; endpoint?: string }
): Promise<void> {
  // Resolve the acceptance spec (a file path) + model executor lazily so the
  // common `uap verify` path never touches the model layer.
  let opts: VerifyOptions = options;
  if (options.acceptanceFile) {
    const { readFileSync } = await import('fs');
    let spec: string;
    try {
      spec = readFileSync(options.acceptanceFile, 'utf-8');
    } catch {
      process.stderr.write(`uap verify: cannot read acceptance spec '${options.acceptanceFile}'\n`);
      process.exit(2);
      return;
    }
    const executor = await buildAcceptanceExecutor(options.model, options.endpoint);
    opts = { ...options, acceptanceSpec: spec, acceptanceExecutor: executor };
  }
  const result = await runVerify(opts);
  if (options.json) {
    process.stdout.write(
      JSON.stringify(
        {
          passed: result.passed,
          empty: result.empty,
          score: result.ladder?.score ?? null,
          results: result.ladder?.results ?? [],
          acceptance: result.acceptance ?? null,
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
