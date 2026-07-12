/**
 * LLM Self-Tuning — the LLM Tuner (P1): LLM-guided flag-space exploration.
 *
 * The tuner is the "LLM as tuner, not executor" principle (design §3.1): a
 * stronger model reasons over the quality history + flag interactions and
 * proposes the next configuration; the small model then executes under it and
 * the paired bench validates. Two production paths:
 *
 *   - LLM path (a judge model configured): the tuner sends the active flag
 *     domains, the current config, and the past (config → quality) attempts, and
 *     asks for a small, interpretable change set with a rationale. Every
 *     proposed change is validated against the flag domain + dependency graph
 *     before it can reach the flag-writer — a hallucinated key or out-of-range
 *     value is dropped, never applied.
 *   - GP path (no judge, or the LLM proposes nothing usable): the Gaussian-
 *     process Bayesian optimizer (`search-reducer`) picks the next config by
 *     Expected Improvement. This is the deterministic, network-free fallback.
 *
 * Both return the same `TuningProposal`, so the orchestrator is agnostic to how
 * the next config was chosen.
 */

import type { JudgeClient } from './judge.js';
import { parseJsonLenient } from './judge.js';
import {
  FlagChange,
  FlagConfig,
  TUNABLE_FLAGS,
  applyChanges,
  coerceToDomain,
  diffConfigs,
  flagValue,
  getTunableFlag,
  isFlagActive,
} from './flags.js';
import {
  Observation,
  SearchPhase,
  proposeNext,
} from './search-reducer.js';

export interface TuningProposal {
  /** The flags to change and their new values (validated, ≤ maxChanges). */
  changes: FlagChange[];
  /** Why (LLM rationale, or a GP summary). */
  rationale: string;
  /** Expected composite-quality improvement (LLM estimate or GP mean gain). */
  expectedDelta: number;
  /** Confidence in the proposal, 0-1. */
  confidence: number;
  /** Model family this proposal is optimized for. */
  targetModel: string;
  /** Benchmark suites the orchestrator should validate against. */
  validationSuites: string[];
  /** How the proposal was produced. */
  source: 'llm' | 'gp' | 'gp-fallback';
}

export interface TuningContext {
  /** Executor model family being tuned. */
  model: string;
  /** The configuration currently in effect. */
  currentConfig: FlagConfig;
  /** Past (config, quality) trials — the GP conditioning set + LLM history. */
  observations: Observation[];
  /** Cross-model transfer priors (good configs from other models). */
  priors?: FlagConfig[];
  /** Suites to stamp on the proposal for validation. */
  validationSuites?: string[];
}

export interface TunerOptions {
  /** A resolved judge/tuner client. When null/omitted, the GP path is used. */
  judge?: JudgeClient | null;
  /** Max flags to change per proposal (interpretability bound). Default 4. */
  maxChanges?: number;
  /** Search phase (biases the GP candidate generation + the LLM guidance). */
  phase?: SearchPhase;
  /** RNG seed for the GP path. Default 1. */
  seed?: number;
}

/** The current best-known quality (from observations), for delta estimates. */
function currentQuality(ctx: TuningContext): number {
  if (ctx.observations.length === 0) return 0;
  return ctx.observations.reduce((a, o) => Math.max(a, o.quality), 0);
}

/** Compact human/LLM-readable description of the ACTIVE flag domains. */
export function describeActiveFlags(cfg: FlagConfig): string {
  const lines: string[] = [];
  for (const f of TUNABLE_FLAGS) {
    if (!isFlagActive(f, cfg)) continue;
    const d = f.domain;
    const dom =
      d.kind === 'bool'
        ? 'true|false'
        : d.kind === 'enum'
          ? d.values.join('|')
          : `${d.min}..${d.max}${d.int ? ' (int)' : ''}`;
    lines.push(`- ${f.key} = ${JSON.stringify(flagValue(cfg, f.key))}  [${dom}]`);
  }
  return lines.join('\n');
}

function historyForPrompt(observations: Observation[], limit = 8): string {
  if (!observations.length) return '(none yet)';
  return observations
    .slice(-limit)
    .map((o, i) => {
      const changed = TUNABLE_FLAGS.filter((f) => isFlagActive(f, o.config))
        .map((f) => `${f.key}=${flagValue(o.config, f.key)}`)
        .join(', ');
      return `#${i + 1} quality=${o.quality.toFixed(1)} :: ${changed.slice(0, 240)}`;
    })
    .join('\n');
}

/** Build the tuner prompt (design §Phase 1). */
export function buildTunerPrompt(ctx: TuningContext, opts: TunerOptions): string {
  const maxChanges = opts.maxChanges ?? 4;
  return [
    'You are a configuration optimizer for the Universal Agent Protocol (UAP).',
    `Your goal: raise the composite quality (0-100) of the executor model by tuning UAP flags.`,
    '',
    `EXECUTOR MODEL: ${ctx.model}`,
    `PHASE: ${opts.phase ?? 'combinatorial'} (coarse=toggle enablers, medium=enums, fine=numbers, combinatorial=interactions)`,
    '',
    'ACTIVE FLAGS (key = current value  [domain]):',
    describeActiveFlags(ctx.currentConfig),
    '',
    'PAST ATTEMPTS (most recent last):',
    historyForPrompt(ctx.observations),
    '',
    'RULES:',
    `- Change only ${maxChanges} or fewer flags (keep it interpretable).`,
    '- Only use keys from ACTIVE FLAGS above; respect each domain.',
    '- Prefer changes that plausibly lift quality given the history.',
    '- A dependent flag (e.g. recipes.fusionN) only helps if its parent is enabled.',
    '',
    'Respond with ONLY this JSON, no prose:',
    '{"changes":[{"key":"<flag>","to":<value>}],"rationale":"<why>","expectedDelta":<number>,"confidence":<0-1>}',
  ].join('\n');
}

interface RawProposal {
  changes?: Array<{ key?: unknown; to?: unknown }>;
  rationale?: unknown;
  expectedDelta?: unknown;
  confidence?: unknown;
}

/**
 * Validate raw LLM-proposed changes into a clean `FlagChange[]`: keep only
 * tunable keys, coerce each value into its domain, drop no-ops and changes to a
 * flag whose parent won't be active after the change set is applied, and cap to
 * `maxChanges`.
 */
export function sanitizeChanges(
  currentConfig: FlagConfig,
  raw: Array<{ key?: unknown; to?: unknown }>,
  maxChanges: number,
): FlagChange[] {
  const cleaned: FlagChange[] = [];
  for (const c of raw) {
    if (typeof c?.key !== 'string') continue;
    const flag = getTunableFlag(c.key);
    if (!flag) continue;
    if (c.to === undefined || c.to === null) continue;
    const to = coerceToDomain(c.key, c.to as never);
    if (to === null) continue;
    const from = flagValue(currentConfig, c.key) ?? null;
    if (to === from) continue; // no-op
    cleaned.push({ key: c.key, from, to, category: flag.category });
    if (cleaned.length >= maxChanges) break;
  }
  // Drop changes to a flag whose dependencies aren't satisfied by the RESULT.
  const result = applyChanges(currentConfig, cleaned);
  return cleaned.filter((c) => {
    const flag = getTunableFlag(c.key)!;
    return isFlagActive(flag, result);
  });
}

/** GP-path proposal: next config by Expected Improvement. */
function gpProposal(ctx: TuningContext, opts: TunerOptions, source: 'gp' | 'gp-fallback'): TuningProposal {
  const suggestion = proposeNext(ctx.observations, {
    seed: opts.seed,
    phase: opts.phase,
    priors: ctx.priors,
    seedConfig: ctx.currentConfig,
  });
  const base = currentQuality(ctx);
  if (!suggestion) {
    return {
      changes: [],
      rationale: 'no candidates to explore (empty search space or no observations)',
      expectedDelta: 0,
      confidence: 0,
      targetModel: ctx.model,
      validationSuites: ctx.validationSuites ?? [],
      source,
    };
  }
  const changes = diffConfigs(ctx.currentConfig, suggestion.config).slice(0, opts.maxChanges ?? 4);
  const expectedDelta = Number.isFinite(suggestion.mean) ? suggestion.mean - base : 0;
  // Confidence from predictive certainty: tighter std → higher confidence.
  const confidence = suggestion.std > 0 ? Math.max(0, Math.min(1, 1 - suggestion.std / 50)) : 0.5;
  return {
    changes,
    rationale: `GP-BO: EI=${Number.isFinite(suggestion.ei) ? suggestion.ei.toFixed(3) : '∞'}, predicted quality ${suggestion.mean.toFixed(1)}±${suggestion.std.toFixed(1)}`,
    expectedDelta,
    confidence,
    targetModel: ctx.model,
    validationSuites: ctx.validationSuites ?? [],
    source,
  };
}

/**
 * Propose the next configuration to try. Uses the judge (LLM) when available and
 * it returns usable changes; otherwise the Gaussian-process optimizer. Never
 * throws — an LLM/parse failure degrades to the GP path.
 */
export async function proposeTuning(ctx: TuningContext, opts: TunerOptions = {}): Promise<TuningProposal> {
  const maxChanges = opts.maxChanges ?? 4;
  if (!opts.judge) return gpProposal(ctx, opts, 'gp');

  let raw: RawProposal | null = null;
  try {
    const text = await opts.judge.complete(buildTunerPrompt(ctx, opts), { json: true, temperature: 0.2 });
    raw = parseJsonLenient<RawProposal>(text);
  } catch {
    raw = null;
  }
  if (!raw || !Array.isArray(raw.changes)) return gpProposal(ctx, opts, 'gp-fallback');

  const changes = sanitizeChanges(ctx.currentConfig, raw.changes, maxChanges);
  if (changes.length === 0) return gpProposal(ctx, opts, 'gp-fallback');

  const expectedDelta = typeof raw.expectedDelta === 'number' && Number.isFinite(raw.expectedDelta)
    ? raw.expectedDelta
    : 0;
  const confidence = typeof raw.confidence === 'number' && Number.isFinite(raw.confidence)
    ? Math.max(0, Math.min(1, raw.confidence))
    : 0.5;
  return {
    changes,
    rationale: typeof raw.rationale === 'string' ? raw.rationale.slice(0, 400) : 'LLM tuner proposal',
    expectedDelta,
    confidence,
    targetModel: ctx.model,
    validationSuites: ctx.validationSuites ?? [],
    source: 'llm',
  };
}
