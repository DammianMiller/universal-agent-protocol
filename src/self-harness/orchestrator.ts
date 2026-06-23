/**
 * Self-Harness — the P1 orchestrator: one autonomous mine -> propose -> validate
 * -> decide iteration.
 *
 * The `validate` dependency is INJECTED so the loop is testable without the slow
 * paired bench: tests pass a stub; the CLI wires a real validator that runs
 * `runPaired` + `analyze` on the validation and held-out suites (and, for env
 * Mods, physically applies the env edit + restarts the server around the run).
 * Each candidate is validated in isolation; rejected Mods are reverted, accepted
 * Mods are recorded into the profile and logged. Budget-bounded.
 *
 * See docs/design/SELF_HARNESS.md §3, §7, §11 (P1).
 */

import type { RunRecord } from '../benchmarks/paired/types.js';
import type { Comparison } from '../benchmarks/paired/report.js';
import { Mod, describeMod } from './mods.js';
import { WeaknessReport } from './weakness.js';
import { mineFromRecords } from './mine.js';
import { Proposer, heuristicProposer } from './propose.js';
import { decideAccept, Decision, DecisionOptions } from './decide.js';
import { HarnessProfile } from './profile.js';

export interface ValidationOutcome {
  validation: Comparison;
  /** Held-out comparison; null when the held-out suite was skipped. */
  heldout: Comparison | null;
}

export type Validator = (mod: Mod) => Promise<ValidationOutcome>;

export interface OrchestratorOptions {
  model: string;
  /** Records mined for weaknesses (e.g. a prior baseline bench). */
  records: RunRecord[];
  profile: HarnessProfile;
  validate: Validator;
  proposer?: Proposer;
  /** Max candidate Mods to validate this iteration (token/time budget). Default 3. */
  maxCandidates?: number;
  decision?: DecisionOptions;
  minFrequency?: number;
  log?: (msg: string) => void;
}

export interface CandidateOutcome {
  mod: Mod;
  decision: Decision;
  accepted: boolean;
}

export interface IterationResult {
  weaknesses: WeaknessReport[];
  proposed: Mod[];
  outcomes: CandidateOutcome[];
  accepted: Mod[];
  /** Profile after applying all accepted Mods. */
  profile: HarnessProfile;
}

/** Run one self-harness iteration. */
export async function runIteration(opts: OrchestratorOptions): Promise<IterationResult> {
  const log = opts.log ?? (() => {});
  const proposer = opts.proposer ?? heuristicProposer;
  const maxC = opts.maxCandidates ?? 3;

  // Stage 1 — mine
  const weaknesses = mineFromRecords(opts.records, {
    model: opts.model,
    minFrequency: opts.minFrequency,
  });
  log(`mined ${weaknesses.length} weakness(es): ${weaknesses.map((w) => w.kind).join(', ') || '(none)'}`);

  // Stage 2 — propose (bounded, minimal)
  const proposed = proposer.propose(weaknesses, opts.profile).slice(0, maxC);
  log(`proposed ${proposed.length} candidate Mod(s) via ${proposer.id}`);

  // Stage 3+4 — validate + decide, each candidate in isolation
  const outcomes: CandidateOutcome[] = [];
  const accepted: Mod[] = [];
  let profile = opts.profile;

  for (const mod of proposed) {
    log(`validating: ${describeMod(mod)}`);
    let decision: Decision;
    try {
      const { validation, heldout } = await opts.validate(mod);
      decision = decideAccept(validation, heldout, opts.decision);
    } catch (e) {
      decision = {
        verdict: 'reject',
        reason: `validation error: ${e instanceof Error ? e.message : String(e)}`,
        validationDelta: NaN,
        heldoutDelta: null,
      };
    }
    const ok = decision.verdict === 'accept';
    log(`  -> ${decision.verdict.toUpperCase()}: ${decision.reason}`);
    outcomes.push({ mod, decision, accepted: ok });
    if (ok) {
      accepted.push(mod);
      profile = applyAcceptedToProfile(profile, mod);
    }
  }

  return { weaknesses, proposed, outcomes, accepted, profile };
}

/** Fold an accepted Mod into the in-memory profile (env/scaffold/middleware). */
function applyAcceptedToProfile(profile: HarnessProfile, mod: Mod): HarnessProfile {
  switch (mod.kind) {
    case 'env':
      return { ...profile, env: { ...profile.env, [mod.key]: mod.to } };
    case 'scaffold': {
      const prev = profile.scaffold[mod.component] ?? '';
      const text = mod.op === 'append' ? `${prev}\n${mod.text}`.trim() : mod.text;
      return { ...profile, scaffold: { ...profile.scaffold, [mod.component]: text } };
    }
    case 'middleware':
      return {
        ...profile,
        middleware: { ...profile.middleware, [mod.id]: { ...mod.params } },
      };
  }
}
