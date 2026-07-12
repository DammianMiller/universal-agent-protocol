/**
 * LLM Self-Tuning — the autonomous run loop + profile persistence (P2/P3).
 *
 * `runTuningLoop` drives multiple `runTuningIteration` steps under a search-phase
 * schedule (coarse → medium → fine → combinatorial, design §3.3.2), commits each
 * ACCEPTED config to `.uap.json`/`.uap/proxy.env` via the flag-writer (only when
 * `apply` is set), advances the model's versioned `TuningProfile`, and stops on
 * budget exhaustion or a quality plateau (N consecutive rejections). Cross-model
 * bundled/stored profiles seed the optimizer as transfer priors.
 *
 * The `validate` dependency is injected, so the whole loop runs end-to-end in a
 * test with a deterministic stub — no live model required.
 */

import { normalizeModel } from '../self-harness/weakness.js';
import { FlagConfig } from './flags.js';
import { applyFlagChanges } from './flag-writer.js';
import type { JudgeClient } from './judge.js';
import type { Observation, SearchPhase } from './search-reducer.js';
import { TunerOptions } from './llm-tuner.js';
import {
  TuningValidator,
  TuningDecisionOptions,
  TuningIterationResult,
  runTuningIteration,
} from './orchestrator.js';
import {
  TuningProfile,
  TuningProfileStore,
  crossModelPriors,
  recordStep,
  seedProfile,
} from './tuning-profile.js';

const DEFAULT_PHASES: SearchPhase[] = ['coarse', 'medium', 'fine', 'combinatorial'];

export interface TuningLoopDeps {
  /** Executor model family being tuned. */
  model: string;
  /** The injected paired-bench validator (candidate vs current). */
  validate: TuningValidator;
  /** Judge/tuner model client; null → the GP-BO path. */
  judge?: JudgeClient | null;
  /** Starting config; defaults to the model's seeded profile config. */
  startConfig?: FlagConfig;
  /** Max iterations (token/time budget). Default 6. */
  maxIterations?: number;
  /** Consecutive rejections before declaring a plateau and stopping. Default 3. */
  plateauLimit?: number;
  /** Search-phase schedule (cycled). Default coarse→medium→fine→combinatorial. */
  phaseSchedule?: SearchPhase[];
  decision?: TuningDecisionOptions;
  tuner?: TunerOptions;
  /** Extra transfer priors on top of the cross-model bundled/stored profiles. */
  priors?: FlagConfig[];
  validationSuites?: string[];
  /** Stable timestamp (host may lack Date). */
  now: string;
  /** Physically persist accepted configs + the profile snapshot. */
  apply: boolean;
  /** Project dir for the flag-writer + profile store base. Required when apply. */
  cwd?: string;
  /** Profile store; when omitted, a fresh in-memory profile is used. */
  profileStore?: TuningProfileStore;
  log?: (msg: string) => void;
}

export interface TuningLoopResult {
  model: string;
  iterations: TuningIterationResult[];
  accepted: TuningIterationResult[];
  finalConfig: FlagConfig;
  finalQuality: number;
  profile: TuningProfile;
  committed: boolean;
  stoppedBecause: 'budget' | 'plateau';
}

export async function runTuningLoop(deps: TuningLoopDeps): Promise<TuningLoopResult> {
  const log = deps.log ?? (() => {});
  const maxIter = deps.maxIterations ?? 6;
  const plateauLimit = deps.plateauLimit ?? 3;
  const phases = deps.phaseSchedule ?? DEFAULT_PHASES;

  let profile: TuningProfile = deps.profileStore
    ? deps.profileStore.loadOrSeed(deps.model, deps.now)
    : seedProfile(deps.model, deps.now);

  let currentConfig: FlagConfig = deps.startConfig ?? { ...profile.config };
  let bestQuality = profile.quality;

  // Observations seed the GP: the profile's accepted history + a synthetic
  // baseline point for the starting config at its recorded quality.
  const observations: Observation[] = [];
  if (bestQuality > 0) observations.push({ config: { ...currentConfig }, quality: bestQuality });

  // Cross-model priors (bundled + other stored profiles) for transfer learning.
  const priors: FlagConfig[] = [
    ...crossModelPriors(deps.model, deps.profileStore),
    ...(deps.priors ?? []),
  ];

  const iterations: TuningIterationResult[] = [];
  const accepted: TuningIterationResult[] = [];
  let committed = false;
  let plateau = 0;
  let stoppedBecause: 'budget' | 'plateau' = 'budget';

  for (let i = 0; i < maxIter; i++) {
    const phase = phases[i % phases.length];
    log(`— iteration ${i + 1}/${maxIter} [${phase}] —`);

    const result = await runTuningIteration({
      ctx: {
        model: normalizeModel(deps.model),
        currentConfig,
        observations: [...observations],
        priors,
        validationSuites: deps.validationSuites,
      },
      validate: deps.validate,
      tuner: { ...deps.tuner, judge: deps.judge },
      decision: deps.decision,
      phase,
      log,
    });
    iterations.push(result);
    if (result.observation) observations.push(result.observation);

    if (result.accepted && result.decision) {
      accepted.push(result);
      plateau = 0;
      const q = result.observation?.quality ?? bestQuality + result.decision.qualityDelta;
      bestQuality = Math.max(bestQuality, q);
      currentConfig = result.config;

      // Commit: persist the accepted flag changes + advance the profile.
      if (deps.apply) {
        if (!deps.cwd) throw new Error('runTuningLoop: apply set but no cwd for the flag-writer');
        const res = applyFlagChanges(deps.cwd, result.proposal.changes);
        if (res.skipped.length) log(`  (skipped ${res.skipped.length} change(s) on commit)`);
        committed = true;
      }
      profile = recordStep(
        profile,
        {
          at: deps.now,
          changes: result.proposal.changes,
          quality: q,
          delta: result.decision.qualityDelta,
          accepted: true,
          provenance: `tune ${phase} via ${result.proposal.source}`,
        },
        currentConfig,
      );
      if (deps.apply && deps.profileStore) deps.profileStore.save(profile);
    } else {
      plateau++;
      if (result.decision) {
        profile = recordStep(
          profile,
          {
            at: deps.now,
            changes: result.proposal.changes,
            quality: result.observation?.quality ?? NaN,
            delta: result.decision.qualityDelta,
            accepted: false,
            provenance: `tune ${phase} via ${result.proposal.source} (rejected)`,
          },
          currentConfig,
        );
      }
      if (plateau >= plateauLimit) {
        stoppedBecause = 'plateau';
        log(`plateau: ${plateau} consecutive non-accepts — stopping`);
        break;
      }
    }
  }

  if (deps.apply && deps.profileStore) deps.profileStore.save(profile);

  return {
    model: normalizeModel(deps.model),
    iterations,
    accepted,
    finalConfig: currentConfig,
    finalQuality: bestQuality,
    profile,
    committed,
    stoppedBecause,
  };
}
