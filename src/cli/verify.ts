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
import {
  checkUserValidationFreshness,
  createUserValidationRunner,
  resolveUserValidationMode,
  synthesizeUserValidationRung,
} from '../delivery/user-validation.js';
import { loadUapConfigRaw } from '../utils/config-loader.js';
import { compareVisualBaseline, driftSummary, approveVisualBaseline } from '../delivery/visual-baseline.js';
import type { LoopExecutor } from '../delivery/convergence-loop.js';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join as joinPath } from 'node:path';

/**
 * Does the project render via <canvas>? Used to append canvas-specific aesthetic
 * guidance when the vision gate fails. Bounded shallow scan of .html/.js source
 * for `<canvas` or a 2D/WebGL context grab. Fail-soft: any error → false.
 */
export function projectUsesCanvas(dir: string): boolean {
  const SKIP = new Set(['node_modules', '.git', '.uap', 'dist', 'build', '.worktrees']);
  let filesRead = 0;
  const scan = (d: string, depth: number): boolean => {
    if (depth > 3 || filesRead > 80) return false;
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      return false;
    }
    for (const e of entries) {
      if (SKIP.has(e)) continue;
      const p = joinPath(d, e);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (scan(p, depth + 1)) return true;
      } else if (/\.(html?|js|mjs|cjs|jsx|ts|tsx)$/.test(e) && st.size < 512_000) {
        filesRead++;
        try {
          const txt = readFileSync(p, 'utf-8');
          if (/<canvas\b/i.test(txt) || /\.getContext\s*\(\s*['"](2d|webgl2?)['"]/i.test(txt)) return true;
        } catch {
          /* unreadable — skip */
        }
      }
    }
    return false;
  };
  return scan(dir, 0);
}

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
  /** Stop-hook mode: run the user-path gate ONLY when the done-claim is not
   * already covered — i.e. delivery.userValidation is on, a manifest exists,
   * and the last report is missing/stale/failed for the CURRENT tree. A
   * fresh-pass report (code unchanged since validation) skips the cost. */
  userPathsAuto?: boolean;
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

  let uvMode: 'block' | 'advisory' | null = opts.userPaths ? 'block' : null;
  if (!uvMode && opts.userPathsAuto) {
    const raw = (() => { try { return loadUapConfigRaw(dir) ?? {}; } catch { return {}; } })();
    const mode = resolveUserValidationMode(
      ((raw as Record<string, unknown>).delivery as Record<string, unknown> | undefined)?.userValidation
    );
    if (mode !== 'off') {
      const fresh = checkUserValidationFreshness(dir);
      // fresh-pass: the CURRENT tree already validated green — no cost, no rung.
      // na: no manifest/paths — nothing to run.
      if (fresh.status !== 'fresh-pass' && fresh.status !== 'na') uvMode = mode;
    }
  }
  if (uvMode) {
    const uvRung = synthesizeUserValidationRung(uvMode);
    if (uvRung && !rungs.some((r) => r.id === uvRung.id)) rungs = [...rungs, uvRung];
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

  // A RENDERABLE deliverable is verifiable even with zero build/test rungs. This
  // early-return used to fire on `rungs.length === 0` alone, skipping the visual,
  // vision and behavioral gates outright and exiting 0 — so a static page with no
  // package.json (the common single-file web app) sailed through the DONE gate
  // having been validated by nothing at all, even at fidelity:max. Bail out only
  // when there is genuinely nothing to look at AND nothing to run.
  const entryPages = discoverEntryPages(dir);
  const hasEntryPages = entryPages.length > 0;
  if (rungs.length === 0 && !hasEntryPages) {
    // Fail-closed under --strict or max fidelity: "we could not check anything"
    // must never be reported as "verified". Otherwise it's an honest no-op.
    const gatePassed = !(opts.strict || fidelity.max);
    const passed = gatePassed && !acceptanceBlocks;
    const msg = opts.runtimeOnly
      ? 'no runnable artifact detected — nothing to execute'
      : 'no verifiable gates detected (no build/test/runnable artifact, no entry page)';
    return {
      passed,
      exitCode: passed ? 0 : 1,
      empty: true,
      report: `${!gatePassed ? 'UNVERIFIED' : 'SKIP'}: ${msg}${acceptanceReport}`,
      rungs,
      acceptance,
    };
  }

  // Cheap-first floor. Max fidelity promotes past `runtime` into `integration`
  // so integration-tier gates run before "done" (standard stops at runtime).
  const maxTier: GateTier = opts.full ? 'deploy-dev' : fidelity.max ? 'integration' : 'runtime';
  const ladder = await runTieredLadder(rungs, dir, {
    maxTier,
    // At max fidelity, a test rung that ran ZERO tests is not a pass: "there
    // were no tests" must never be reported as "the tests passed".
    requireTestsRan: fidelity.max,
    ...(uvMode ? { userValidationRunner: createUserValidationRunner() } : {}),
    ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
  });

  // Even below max fidelity, say so plainly rather than let a green tick imply
  // the code was tested when nothing ran.
  const untested = ladder.results.filter((r) => r.zeroTests).map((r) => r.name);
  const untestedReport =
    untested.length > 0
      ? `\n⚠ ${untested.join(', ')} ran ZERO tests — passing because there is nothing to run is not evidence the code works.${fidelity.max ? ' (max fidelity: this BLOCKS)' : ' Write tests.'}`
      : '';

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
  // ORDER MATTERS: build/run/test FIRST, rendered truth only after they pass.
  // Pixels of an artifact that does not compile or does not run are not evidence
  // of anything, and grading them is actively HARMFUL: the vision reviewer
  // returns confident, specific aesthetic complaints (palette, typography,
  // spacing) about a screen that only exists because the app is broken, and the
  // fix loop then chases those instead of the real defect. Observed live
  // (octopus_invaders_v3, 2026-07-22): several iterations spent on palette
  // notes for a game that had NO render loop at all. It also wastes a headless
  // browser pass plus a vision-model call on every failing turn.
  const ladderGreen = ladder.passed;
  const visualSkippedForLadder = visualWanted && hasEntryPages && !ladderGreen;
  if (visualWanted && hasEntryPages && ladderGreen) {
    visual = await runVisualGate(dir);
  }
  // Standard: a no-browser SKIP fails open. Max: fail CLOSED — a project with
  // entry pages that could not be visually observed is NOT verified.
  const visualBlocks = Boolean(visual && !visual.passed && (fidelity.max || !visual.skipped));
  let visualReport = visual ? `\n${visual.feedback}` : '';
  // Say plainly that rendering was NOT checked — silence here would read as
  // "the visuals are fine" on exactly the runs where nothing was observed.
  if (visualSkippedForLadder) {
    visualReport +=
      '\nvisual + aesthetic review SKIPPED — the build/run gates must pass first. ' +
      'Fix the failing gate above; rendering is only judged once the artifact compiles and runs.';
  }

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
      const { judgeScreenshots, visionSummary, visionJudgeConfigured, autodetectLocalVision, readDesignContext } = await import('../delivery/vision-judge.js');
      // Default the judge to the ACTIVE local model when it isn't explicitly
      // configured — a local vision-capable model (Qwen3.6 + mmproj) should be
      // used rather than reporting "no vision model".
      if (!visionJudgeConfigured()) await autodetectLocalVision();
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
          // Canvas apps score low most often because the render loop is gated on an
          // active/'playing' state, so the FIRST screen the judge grades (menu/attract)
          // shows a blank <canvas>. Append the concrete, general fix so a weak model
          // gets an action, not just a score. (Board finding: draw the scene in every
          // state; keep any full-screen overlay transparent so it does not dim the canvas.)
          if (projectUsesCanvas(dir)) {
            visualReport +=
              '\nThe judge grades the FIRST screen a user sees. For a <canvas> app, run the render loop ' +
              'from load and DRAW THE SCENE (background, key sprites/preview) in EVERY state — including the ' +
              'menu/start/attract state — not only during active play; a blank canvas on the first screen is ' +
              'the most common cause of a low score. Keep any full-screen DOM overlay background transparent ' +
              'so the canvas shows through and is not dimmed, and use the vibrant on-theme palette.';
          }
        }
      } else if (fidelity.max) {
        visualReport += '\n⚠ max fidelity: no vision model available — aesthetic review skipped. No local vision-capable model was detected (llama-server /props modalities.vision) and UAP_VISION_ENDPOINT/MODEL is unset. Launch the model with an --mmproj projector, or set UAP_VISION_ENDPOINT/MODEL (uap setup).';
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

  // The header must reflect the OVERALL verdict, not just the objective ladder:
  // the ladder can pass while the visual/vision/acceptance/baseline gate blocks
  // (a broken-but-loading UI). Printing "VERIFIED ✓" then problems + exit 1 is
  // exactly how an agent mis-reads a failure as success and claims done.
  const blockedBy = [
    visualBlocks && 'visual/behavioral render',
    visionBlocks && 'aesthetic score',
    baselineBlocks && 'visual regression',
    acceptanceBlocks && 'acceptance criteria',
  ].filter(Boolean) as string[];
  const overallPassed = ladder.passed && blockedBy.length === 0;
  const report = formatReport(ladder, overallPassed, blockedBy) + untestedReport + visualReport + acceptanceReport;
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

function formatReport(ladder: LadderResult, overallPassed?: boolean, blockedBy: string[] = []): string {
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
  // Default to the ladder verdict, but let callers force NOT VERIFIED when a
  // non-ladder gate (visual/vision/acceptance) blocks even though the ladder
  // passed — so the header never says VERIFIED while the exit code is a failure.
  const passed = overallPassed ?? ladder.passed;
  const pct = Math.round(ladder.score * 100);
  const header = passed
    ? `VERIFIED ✓ (${pct}% of gates passed)`
    : `NOT VERIFIED ✗ (${pct}% of gates passed${blockedBy.length ? `; blocked by: ${blockedBy.join(', ')}` : ''})`;
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

/**
 * Auto-discover an acceptance/requirements spec for a DONE gate that has no
 * explicit --acceptance file (the completion gate / Stop hook). Priority:
 *   1. Explicit acceptance-criteria files (.uap/acceptance.md, REQUIREMENTS.md…)
 *   2. The completion ledger / TodoWrite plan — the agent's own declared plan of
 *      record for THIS session, so "did you actually finish what you set out to
 *      do?" is judged even in an interactive run with no deliver mission.
 * Returns spec text, or null when nothing usable is found (→ acceptance skipped).
 */
export function resolveAcceptanceSpecAuto(dir: string): string | null {
  const read = (rel: string): string | null => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const p = require('path').join(dir, rel);
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const t = (require('fs').readFileSync(p, 'utf-8') as string).trim();
      return t || null;
    } catch {
      return null;
    }
  };
  for (const rel of ['.uap/acceptance.md', '.uap/requirements.md', 'ACCEPTANCE.md', 'REQUIREMENTS.md', 'SPEC.md']) {
    const t = read(rel);
    if (t) return t;
  }
  // The completion ledger is the agent's declared plan of record.
  const raw = read('.uap/completion-ledger.json') ?? read('.uap/completion_ledger.json');
  if (raw) {
    try {
      const j = JSON.parse(raw);
      const items: unknown[] = Array.isArray(j) ? j : (j.items ?? j.todos ?? j.entries ?? []);
      const lines = items
        .map((i) => (typeof i === 'string' ? i : String((i as Record<string, unknown>)?.text ?? (i as Record<string, unknown>)?.content ?? (i as Record<string, unknown>)?.title ?? (i as Record<string, unknown>)?.task ?? '')))
        .map((s) => s.trim())
        .filter(Boolean);
      if (lines.length) {
        return 'The delivered work must actually satisfy EVERY requirement below (the agent\'s own plan of record):\n' + lines.map((l) => `- ${l}`).join('\n');
      }
    } catch {
      /* unparseable ledger → no auto spec */
    }
  }
  return null;
}

/** CLI entry: print the report and exit with the gate-derived code. */
export async function verifyCommand(
  options: VerifyOptions & { acceptanceFile?: string; acceptanceAuto?: boolean; model?: string; endpoint?: string }
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
  } else if (options.acceptanceAuto) {
    // DONE-gate mode: judge behavioral requirements-completeness against an
    // auto-discovered spec. Fail OPEN if nothing to judge or no model is
    // configured — never wedge a DONE claim on missing spec/model, only on a
    // genuine unmet-requirement verdict (which blocks under max/strict fidelity).
    const dir = options.dir || process.cwd();
    const spec = resolveAcceptanceSpecAuto(dir);
    if (spec) {
      try {
        const executor = await buildAcceptanceExecutor(options.model, options.endpoint);
        opts = { ...options, acceptanceSpec: spec, acceptanceExecutor: executor };
      } catch {
        process.stderr.write('uap verify: --acceptance-auto found a spec but no acceptance model is configured — skipping the requirements judge (set UAP_INFERENCE_ENDPOINT/UAP_DELIVER_MODEL).\n');
      }
    }
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
