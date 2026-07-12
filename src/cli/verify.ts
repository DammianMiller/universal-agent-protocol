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
import { resolveFidelity, type ResolvedFidelity } from '../delivery/fidelity.js';
import { createUserValidationRunner, synthesizeUserValidationRung } from '../delivery/user-validation.js';
import { compareVisualBaseline, driftSummary, approveVisualBaseline } from '../delivery/visual-baseline.js';
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
  /** Override the resolved fidelity mode (default: resolveFidelity(dir)). Test seam. */
  fidelity?: ResolvedFidelity;
  /** Approve the current run's screenshots as the regression baseline (no gating). */
  approveVisual?: boolean;
  /** Run the user-path validation gate (.uap/user-paths.json journeys through
   * the real client). Standalone flag; deliver wires it as the terminal rung. */
  userPaths?: boolean;
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
  const fidelity = opts.fidelity ?? resolveFidelity(dir);
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
  // Acceptance is a JUDGMENT: by default it only affects the exit code under
  // --strict, so its nondeterminism never hard-blocks a session. Under max
  // fidelity the acceptance judge is REQUIRED — a failing verdict blocks.
  const acceptanceBlocks = Boolean(acceptance && !acceptance.passed && (opts.strict || fidelity.max));
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

  // Cheap-first floor. Max fidelity promotes past `runtime` into `integration`
  // so integration-tier gates run before "done" (standard stops at runtime).
  const maxTier: GateTier = opts.full ? 'deploy-dev' : fidelity.max ? 'integration' : 'runtime';
  if (opts.userPaths) {
    const uvRung = synthesizeUserValidationRung('block');
    if (uvRung && !rungs.some((r) => r.id === uvRung.id)) rungs = [...rungs, uvRung];
  }
  const ladder = await runTieredLadder(rungs, dir, {
    maxTier,
    ...(opts.userPaths ? { userValidationRunner: createUserValidationRunner() } : {}),
    ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
  });

  // Visual gate: the rendered truth. Runs by default whenever the project has
  // entry pages (opts.visual === false disables); fail-open without a browser.
  // --runtime-only (the Stop hook's cheap path) skips it unless explicitly
  // forced with visual: true — sampling frames in a real browser is not cheap,
  // and minimal fixtures legitimately render near-blank.
  let visual: VisualVerdict | undefined;
  // Under max fidelity the visual gate runs even on the runtime-only (Stop-hook)
  // path — a UI that renders wrong is a real failure regardless of how cheap the
  // caller wanted to be.
  const visualWanted = opts.visual === true || (opts.visual !== false && (!opts.runtimeOnly || fidelity.max));
  const hasEntryPages = discoverEntryPages(dir).length > 0;
  if (visualWanted && hasEntryPages) {
    visual = await runVisualGate(dir);
  }
  // Standard: a no-browser SKIP fails open. Max: fail CLOSED — a project with
  // entry pages that could not be visually observed is NOT verified.
  const visualBlocks = Boolean(visual && !visual.passed && (fidelity.max || !visual.skipped));
  let visualReport = visual ? `\n${visual.feedback}` : '';

  // Visual regression baselines. --approve-visual pins the current look; otherwise
  // (when baselines are enabled and the gate actually rendered) compare against the
  // approved baseline and, under max fidelity, block on drift beyond threshold.
  let baselineBlocks = false;
  if (visual && !visual.skipped) {
    if (opts.approveVisual) {
      const approved = approveVisualBaseline(dir);
      visualReport += `\n✓ visual baseline approved (${approved.length} page(s)) → .uap/visual/baseline/`;
    } else if (fidelity.visualBaselines) {
      const drifts = compareVisualBaseline(dir);
      const summary = driftSummary(drifts);
      if (summary) visualReport += `\n${summary}`;
      if (fidelity.max && drifts.some((d) => d.drifted)) baselineBlocks = true;
    }
  }
  if (fidelity.max && visual?.skipped) {
    visualReport += '\n⚠ max fidelity: entry pages exist but no headless browser was available — visual verification could not run (fail-closed).';
  }
  // Vision aesthetic review. Standard: advisory (adds context to the report).
  // Max: BLOCKING — a rendered UI that scores below fidelity.visionMinScore is a
  // real failure. Bridges the resolved vision endpoint/model into the env the
  // vision judge reads, so `fidelity.visionEndpoint` config works without export.
  let visionBlocks = false;
  if (visual && !visual.skipped) {
    if (fidelity.visionEndpoint && !process.env.UAP_VISION_ENDPOINT) process.env.UAP_VISION_ENDPOINT = fidelity.visionEndpoint;
    if (fidelity.visionModel && !process.env.UAP_VISION_MODEL) process.env.UAP_VISION_MODEL = fidelity.visionModel;
    try {
      const { judgeScreenshots, visionSummary, visionJudgeConfigured, readDesignContext } = await import('../delivery/vision-judge.js');
      if (visionJudgeConfigured()) {
        const shots = visual.pages.flatMap((pg) => pg.screenshots.slice(-1));
        const verdict = await judgeScreenshots(
          shots,
          opts.acceptanceSpec ?? 'A polished, working application UI.',
          readDesignContext(dir)
        );
        const summary = visionSummary(verdict);
        if (summary) visualReport += `\n${summary}`;
        if (fidelity.max && verdict && verdict.score < fidelity.visionMinScore) {
          visionBlocks = true;
          visualReport += `\n✗ max fidelity: aesthetic score ${verdict.score}/10 is below the ${fidelity.visionMinScore} threshold.`;
        }
      } else if (fidelity.max) {
        visualReport += '\n⚠ max fidelity: no vision model configured — aesthetic review skipped. Set UAP_VISION_ENDPOINT/MODEL (uap setup) to enable blocking review.';
      }
    } catch {
      // vision review is best-effort; never let it throw out of verify
    }
  }

  // Record a visual-verification marker so the commit-time enforcer can tell
  // whether the UI on disk has been visually observed since it last changed.
  // Written whenever the gate actually rendered (not on a no-browser skip).
  if (visual && !visual.skipped) {
    try {
      const { writeFileSync, mkdirSync } = await import('fs');
      const { join } = await import('path');
      const visualPassed = visual.passed && !visionBlocks && !baselineBlocks;
      const markerDir = join(dir, '.uap', 'visual');
      mkdirSync(markerDir, { recursive: true });
      writeFileSync(
        join(markerDir, 'last-verdict.json'),
        JSON.stringify(
          { passed: visualPassed, mode: fidelity.mode, at: Math.floor(Date.now() / 1000), pages: visual.pages.map((p) => p.file) },
          null,
          2
        )
      );
    } catch {
      // marker is best-effort; a missing marker just makes the enforcer block (fail-closed)
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
  // visionBlocks (max fidelity, low aesthetic score) and baselineBlocks (visual
  // regression drift) gate the same way.
  if ((visualBlocks || visionBlocks || baselineBlocks) && exitCode === 0) exitCode = 1;
  return {
    passed: ladder.passed && !acceptanceBlocks && !visualBlocks && !visionBlocks && !baselineBlocks,
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
