/**
 * Interaction gate — runs the artifact's own promises against real input.
 *
 * Sits between the execution smoke gate and the visual gate:
 *
 *   build → execution smoke (does it load) → INTERACTION (does it do what it
 *   promised) → visual (does it look right) → acceptance (is anything missing)
 *
 * Before vision, for two reasons. A vision judge grades a FRAME, and a frozen
 * frame is indistinguishable from a working one — so a broken build can collect
 * a passing aesthetic score, and the fix loop then chases palette notes instead
 * of the defect. And the vision pass costs a headless render plus a model call,
 * which is waste on a build that cannot be played.
 *
 * SECURITY NOTE: manifest expression strings are interpolated into script that
 * runs in the driving browser, so the manifest is a code-bearing input. It is
 * kept under `.uap/interaction/` — which the self-protect enforcer denies to the
 * agent — and every expression is checked for mutation before use. Both are load
 * bearing: the write-protection is a security control, not just an integrity one.
 */

import { mkdirSync, rmSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { detectArtifactType, findWebEntryDir } from './execution-gate.js';
import { coverageOf, loadManifestDetailed, manifestIsStale } from './interaction/manifest.js';
import { runProbe } from './interaction/runner.js';
import { judgeInteraction, skippedVerdict } from './interaction/verdict.js';
import {
  judgeWatchdog,
  parseWatchdogSample,
  watchdogSampleScript,
  type WatchdogSample,
} from './interaction/watchdog.js';
import { WebInteractionDriver, evidenceDir } from './interaction/web-driver.js';
import type { InteractionDriver } from './interaction/driver.js';
import { delay } from './interaction/driver.js';
import type {
  InteractionManifest,
  InteractionVerdict,
  ProbeMode,
  ProbeResult,
} from './interaction/types.js';

export interface InteractionGateOptions {
  /** Supply the manifest directly (tests, or a caller that just mined one). */
  manifest?: InteractionManifest;
  /** Which probe modes to run. Default: core only. */
  modes?: ProbeMode[];
  /** Max fidelity: uncovered requirements block. */
  strictCoverage?: boolean;
  /** Injected driver (tests). Default: the real web driver. */
  driverFactory?: (manifest: InteractionManifest) => InteractionDriver;
  /** Overall budget; probes still running when it expires are reported skipped. */
  budgetMs?: number;
  /** Per-probe wall-clock bound. */
  probeTimeoutMs?: number;
  /** Requirements text, so a manifest mined from older requirements is flagged. */
  specText?: string;
}

export const DEFAULT_BUDGET_MS = 300_000;

/** Sample the watchdog without letting a failure there break the run. */
async function sampleWatchdog(
  driver: InteractionDriver,
  watchExprs: string[]
): Promise<WatchdogSample | null> {
  try {
    const raw = driver.watchdogSample
      ? await driver.watchdogSample(watchExprs)
      : await driver.read(`(${watchdogSampleScript(watchExprs)})()`);
    return parseWatchdogSample(raw);
  } catch {
    return null;
  }
}

/** Evidence path that cannot escape the evidence directory. */
export function evidencePathFor(dir: string, probeId: string): string | null {
  const candidate = resolve(dir, `${probeId}.png`);
  const root = resolve(dir);
  return candidate === root || candidate.startsWith(root + sep) ? candidate : null;
}

async function runGate(
  projectRoot: string,
  options: InteractionGateOptions
): Promise<InteractionVerdict> {
  let manifest = options.manifest;
  if (!manifest) {
    const loaded = loadManifestDetailed(projectRoot);
    if (loaded.status === 'absent') {
      return skippedVerdict(
        'no interaction manifest — run `uap interaction mine` to derive probes from the requirements'
      );
    }
    if (loaded.status === 'invalid') {
      // NOT a skip. An invalid manifest is a tampered or broken acceptance
      // criterion; reporting it as "no manifest" would tell the operator to
      // re-mine and launder the problem away.
      return {
        passed: false,
        skipped: false,
        results: [],
        coverage: { total: 0, covered: 0, uncovered: [] },
        feedback:
          `interaction gate: the manifest at .uap/interaction/manifest.json is INVALID and was not run:\n` +
          loaded.problems.map((p) => `  · ${p}`).join('\n'),
      };
    }
    manifest = loaded.manifest;
  }

  const modes = options.modes ?? (['core'] as ProbeMode[]);
  const probes = manifest.probes.filter((p) => modes.includes(p.mode));
  // Coverage over the probes that will RUN, not the whole manifest.
  const coverage = coverageOf(manifest, probes);
  if (probes.length === 0) {
    return skippedVerdict(`manifest has no probes for mode(s) ${modes.join(', ')}`, coverage);
  }

  // Only the web adapter exists. Silently handing a `cli`/`http` manifest to the
  // web driver would spin up a static server and a browser for an artifact that
  // is neither, and report the resulting mess as an artifact defect.
  if (manifest.kind !== 'web') {
    return skippedVerdict(
      `no driver for artifact kind '${manifest.kind}' yet — only 'web' is implemented`,
      coverage
    );
  }
  const webRoot = findWebEntryDir(projectRoot);
  if (!webRoot && detectArtifactType(projectRoot) !== 'web') {
    return skippedVerdict('manifest declares a web artifact but no web entry point was found', coverage);
  }

  const evidence = evidenceDir(projectRoot);
  try {
    // Clear stale evidence so screenshots always describe THIS run — leftovers
    // from probes that no longer exist read as current evidence.
    rmSync(evidence, { recursive: true, force: true });
    mkdirSync(evidence, { recursive: true });
  } catch {
    /* evidence is best-effort */
  }

  const driver =
    options.driverFactory?.(manifest) ??
    new WebInteractionDriver({
      projectRoot,
      entry: manifest.entry,
      ...(webRoot ? { webRoot } : {}),
    });

  const budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS;
  const startedAt = Date.now();
  const results: ProbeResult[] = [];
  const samples: WatchdogSample[] = [];
  const watchExprs = manifest.watch ?? [];
  let ranAny = false;
  let segment = 0;
  const resetProblems: string[] = [];

  try {
    try {
      await driver.start();
    } catch (e) {
      const probe = driver as unknown as { didLaunch?: () => boolean };
      const launched = typeof probe.didLaunch === 'function' && probe.didLaunch();
      if (!launched) {
        // Infrastructure: no browser, no server. The gate has no opinion.
        return skippedVerdict(`driver unavailable (${String(e).slice(0, 160)})`, coverage);
      }
      // The browser came up and the ARTIFACT failed to load. That is a defect.
      return {
        passed: false,
        skipped: false,
        results: [],
        coverage,
        feedback:
          `interaction gate: the artifact failed to load in a real browser — ` +
          `${String(e).slice(0, 200)}\n` +
          `Nothing could be driven, so no behaviour was verified. Check the entry ` +
          `path (${manifest.entry}) resolves and the page reaches 'load'.`,
      };
    }

    const first = await sampleWatchdog(driver, watchExprs);
    if (first) samples.push({ ...first, segment });

    for (const probe of probes) {
      if (Date.now() - startedAt > budgetMs) {
        results.push({
          probeId: probe.id,
          description: probe.description,
          mode: probe.mode,
          requirementIds: probe.requirementIds ?? [],
          passed: false,
          skipped: true,
          skipReason: `interaction budget of ${budgetMs}ms exhausted before this probe ran`,
          assertions: [],
          errors: [],
          durationMs: 0,
        });
        continue;
      }
      // Fresh page per probe: shared state makes results order-dependent and
      // reports one probe's damage as the next probe's defect.
      if (ranAny) {
        if (driver.reset) {
          try {
            await driver.reset();
            segment++;
          } catch (e) {
            // Silence here would read exactly like a properly isolated run,
            // while every later probe inherits the previous probe's state.
            resetProblems.push(`before ${probe.id}: ${String(e).slice(0, 120)}`);
          }
        } else {
          resetProblems.push(`before ${probe.id}: this driver cannot reset between probes`);
        }
      }
      ranAny = true;
      const evPath = evidencePathFor(evidence, probe.id);
      results.push(
        await runProbe(driver, probe, {
          ...(evPath ? { evidencePath: evPath } : {}),
          // Leave room inside the overall budget so a single probe cannot eat it.
          ...(options.probeTimeoutMs ? { timeoutMs: options.probeTimeoutMs } : {}),
        })
      );
      const s = await sampleWatchdog(driver, watchExprs);
      if (s) samples.push({ ...s, segment });
    }

    // A final short window so "is the loop still ticking NOW" is answered by
    // fresh frames rather than a cumulative count from earlier in the run.
    await delay(600);
    const last = await sampleWatchdog(driver, watchExprs);
    if (last) samples.push({ ...last, segment });

    let driverErrors: string[] = [];
    try {
      driverErrors = driver.errors();
    } catch {
      /* an unreadable error channel must not abort the verdict */
    }
    const watchdog = samples.length > 0 ? judgeWatchdog(samples, driverErrors) : undefined;
    // Coverage from the probes that actually RAN — a probe skipped for budget
    // exhaustion must not mark its requirement covered.
    const ranIds = new Set(results.filter((r) => !r.skipped).map((r) => r.probeId));
    const ranCoverage = coverageOf(
      manifest,
      probes.filter((p) => ranIds.has(p.id))
    );
    const verdict = judgeInteraction(manifest, results, ranCoverage, watchdog, {
      ...(options.strictCoverage ? { strictCoverage: true } : {}),
    });
    if (resetProblems.length > 0) {
      verdict.feedback +=
        `\n⚠ ${resetProblems.length} probe(s) ran WITHOUT a clean reset, so they inherited the ` +
        `previous probe's state and their results may be order-dependent:\n  ` +
        resetProblems.slice(0, 5).join('\n  ');
    }
    if (options.specText && manifestIsStale(manifest, options.specText)) {
      verdict.feedback +=
        `\n⚠ these probes were mined from DIFFERENT requirements than the current ones — ` +
        `re-run \`uap interaction mine\`. A pass here is evidence about the old requirements.`;
    }
    return verdict;
  } finally {
    // Guarded: a rejecting stop() in a bare `finally` REPLACES the computed
    // verdict with a throw, which would escape runVerify and destroy its
    // documented exit-code contract.
    try {
      await driver.stop();
    } catch {
      /* teardown failure must not lose the verdict */
    }
  }
}

export async function runInteractionGate(
  projectRoot: string,
  options: InteractionGateOptions = {}
): Promise<InteractionVerdict> {
  try {
    return await runGate(projectRoot, options);
  } catch (e) {
    // Never let this gate crash `uap verify`. The visual gate degrades the same
    // way; an exception here would bypass the 0/1/3 exit contract the Stop hook
    // depends on and abort the session with a stack trace.
    return skippedVerdict(`interaction gate error: ${String(e).slice(0, 200)}`);
  }
}

/** One-line summary for the verify report. */
export function interactionSummary(v: InteractionVerdict): string {
  if (v.skipped) return `interaction gate: SKIPPED (${v.skipReason ?? 'no reason'})`;
  const ran = v.results.filter((r) => !r.skipped).length;
  const ok = v.results.filter((r) => !r.skipped && r.passed).length;
  return `interaction gate: ${v.passed ? 'PASS' : 'FAIL'} — ${ok}/${ran} probe(s), requirements covered ${v.coverage.covered}/${v.coverage.total}`;
}
