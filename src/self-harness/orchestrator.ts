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
import {
  ManifestStore,
  makeManifest,
  attributeManifest,
  decideManifest,
  type ChangeManifest,
  type ManifestAttribution,
  type ManifestDecision,
  type ManifestPolicyOptions,
} from './manifest.js';

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
  /**
   * Change-manifest store (harness plan C). Supplied -> every accepted Mod is
   * recorded as a falsifiable prediction, and any manifest left open by a PRIOR
   * iteration is attributed against this iteration's records first. Omitted ->
   * the loop behaves exactly as before.
   */
  manifests?: ManifestStore;
  /**
   * The records the PREVIOUS iteration saw, needed to attribute open manifests
   * (before vs after). Omit on the first iteration.
   */
  priorRecords?: RunRecord[];
  /** Policy for turning an attribution into keep/revert. */
  manifestPolicy?: ManifestPolicyOptions;
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
  /**
   * Manifests from prior iterations whose predictions failed this round, with
   * the inverse Mod already applied to `profile` (harness plan C). The caller
   * physically applies each `revert` through the same seam it uses to apply an
   * accepted Mod.
   */
  reverted: RevertedChange[];
}

export interface RevertedChange {
  manifest: ChangeManifest;
  attribution: ManifestAttribution;
  decision: ManifestDecision;
}

/** Run one self-harness iteration. */
export async function runIteration(opts: OrchestratorOptions): Promise<IterationResult> {
  const log = opts.log ?? (() => {});
  const proposer = opts.proposer ?? heuristicProposer;
  const maxC = opts.maxCandidates ?? 3;

  // Stage 0 — attribute prior manifests BEFORE proposing anything new
  // (harness plan C). Order matters: a change that failed its own prediction
  // must be undone before this round mines weaknesses from records it polluted,
  // or the loop proposes fixes for damage it is about to revert anyway.
  const reverted: RevertedChange[] = [];
  let profile = opts.profile;
  if (opts.manifests && opts.priorRecords) {
    for (const manifest of opts.manifests.open()) {
      const attribution = attributeManifest(manifest, opts.priorRecords, opts.records);
      const decision = decideManifest(manifest, attribution, opts.manifestPolicy);
      opts.manifests.close(manifest, attribution, decision);
      log(`manifest ${manifest.id}: ${decision.verdict.toUpperCase()} — ${decision.reason}`);
      if (decision.verdict === 'revert' && decision.revert) {
        profile = applyAcceptedToProfile(profile, decision.revert);
        reverted.push({ manifest, attribution, decision });
      }
    }
  }

  // Stage 1 — mine
  const weaknesses = mineFromRecords(opts.records, {
    model: opts.model,
    minFrequency: opts.minFrequency,
  });
  log(`mined ${weaknesses.length} weakness(es): ${weaknesses.map((w) => w.kind).join(', ') || '(none)'}`);

  // Stage 2 — propose (bounded, minimal)
  // `profile`, not `opts.profile`: stage 0 may have reverted a knob, and
  // proposing against the pre-revert value would immediately re-propose the
  // change just undone and record a `from` that was never in force.
  const proposed = proposer.propose(weaknesses, profile).slice(0, maxC);
  log(`proposed ${proposed.length} candidate Mod(s) via ${proposer.id}`);

  // Stage 3+4 — validate + decide, each candidate in isolation
  const outcomes: CandidateOutcome[] = [];
  const accepted: Mod[] = [];

  for (const mod of proposed) {
    log(`validating: ${describeMod(mod)}`);
    // Attribute BEFORE anything mutates the profile. attributeWeakness works by
    // re-running the proposer and matching the Mod it emits; once the accepted
    // Mod has been folded into the profile the proposer no longer re-derives it,
    // so attribution silently returns null. (That ordering bug also cost the
    // transfer store its attribution — both call sites now share this value.)
    const weakness = attributeWeakness(mod, weaknesses, proposer, profile);
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
      // Acceptance is PROVISIONAL: record the prediction so the next iteration
      // can falsify it (harness plan C). The tasks this Mod's weakness was mined
      // from are its predicted fixes — that is the claim it is making.
      if (opts.manifests) {
        opts.manifests.record(
          makeManifest({
            id: `${modKey(mod)}@${opts.validatedAt ?? outcomes.length}`,
            mod,
            now: opts.validatedAt ?? '',
            predictedFixes: weakness?.affectedTasks ?? [],
          }),
        );
      }
    }
    // Record the outcome (accept OR reject) into the transfer store, attributed
    // to the weakness whose heuristic produced this Mod, so the fix transfers to
    // future models and known-bad Mods aren't re-proposed.
    if (opts.transferStore) {
      const w = weakness;
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

  return { weaknesses, proposed, outcomes, accepted, profile, reverted };
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
    case 'tool':
      // A SEPARATE field from `env`: tool knobs are executor-side and disjoint
      // from the server's launch env, and `profileFromEnvFile` filters `env` on
      // `isKnownKnob`, so folding them together dropped them on every reload.
      return { ...profile, tool: { ...(profile.tool ?? {}), [mod.key]: mod.to } };
  }
}
