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
import { TransferStore, modKey, makeEntry } from './transfer.js';

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
  /** Optional cross-model transfer store; outcomes are recorded into it (P3). */
  transferStore?: TransferStore;
  /** ISO timestamp + provenance string stamped on recorded transfer entries. */
  validatedAt?: string;
  provenance?: string;
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
    // Record the outcome (accept OR reject) into the transfer store, attributed
    // to the weakness whose heuristic produced this Mod, so the fix transfers to
    // future models and known-bad Mods aren't re-proposed.
    if (opts.transferStore) {
      const w = attributeWeakness(mod, weaknesses, proposer, profile);
      if (w) {
        opts.transferStore.record(
          makeEntry({
            signature: w.signature,
            kind: w.kind,
            model: opts.model,
            mod,
            delta: Number.isFinite(decision.validationDelta) ? decision.validationDelta : 0,
            accepted: ok,
            validatedAt: opts.validatedAt ?? '',
            provenance: opts.provenance ?? 'self-harness iteration',
          }),
        );
      }
    }
  }

  return { weaknesses, proposed, outcomes, accepted, profile };
}

/**
 * Attribute a Mod back to the weakness that produced it, by re-running the
 * proposer on each single weakness and matching by structural key. Works for the
 * heuristic and transfer proposers (deterministic kind -> Mod mapping).
 */
function attributeWeakness(
  mod: Mod,
  weaknesses: WeaknessReport[],
  proposer: Proposer,
  profile: HarnessProfile,
): WeaknessReport | null {
  const target = modKey(mod);
  for (const w of weaknesses) {
    if (proposer.propose([w], profile).some((m) => modKey(m) === target)) return w;
  }
  return null;
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
    case 'config':
      // A settings-registry change lives in .uap.json / proxy.env, not in the
      // in-memory harness profile — the self-tuning flag-writer applies it.
      return profile;
  }
}
