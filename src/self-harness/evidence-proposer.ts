/**
 * Evidence-driven proposer — the D -> B connection (harness plan, 2026-07-31).
 *
 * The plan's load-bearing sequence is D (evidence corpus) THEN B (tool search
 * space): record what the tool layer actually does, then mutate the knobs the
 * evidence implicates. Shipping both halves without this module would leave the
 * corpus written but unread and `ToolMod` defined but never emitted — a search
 * space with nothing searching it.
 *
 * Unlike `heuristicProposer`, which maps a run-level FailureKind to an
 * inference-server knob, this reads per-tool-call outcomes. That is the level
 * the tool layer fails at: an `edit-miss` never surfaces as a run-level failure
 * kind, it just quietly costs a turn, which is exactly why the loop could not
 * see the surface the literature says matters most (tools +3.3pp, arXiv
 * 2604.25850).
 *
 * Every proposal is a HYPOTHESIS with a measurable prediction, not a fix. The
 * paired validator decides, and the change manifest falsifies it next round.
 */

import { Mod, TOOL_KNOB_ALLOWLIST, validateMod, type KnownToolKnob } from './mods.js';
import type { Proposer } from './propose.js';
import type { HarnessProfile } from './profile.js';
import type { WeaknessReport } from './weakness.js';
import { summarizeToolCalls, type EvidenceSummary } from '../telemetry/tool-calls.js';

/** Read a tool knob's in-effect value: profile first, then env, then default. */
function currentToolKnob(profile: HarnessProfile, key: KnownToolKnob, fallback: string): string {
  const fromProfile = (profile.tool ?? {})[key];
  if (fromProfile != null) return fromProfile;
  return process.env[key] ?? fallback;
}

function toolMod(profile: HarnessProfile, key: KnownToolKnob, to: string): Mod | null {
  const spec = TOOL_KNOB_ALLOWLIST[key];
  const from = currentToolKnob(profile, key, spec.type === 'number' ? '' : '1');
  if (from === to) return null;
  const mod: Mod = { kind: 'tool', key, from, to };
  return validateMod(mod).ok ? mod : null;
}

/** Thresholds at which a signal is strong enough to be worth a bench run. */
export interface EvidenceThresholds {
  /** Minimum edit attempts before edit health means anything. */
  minEditAttempts?: number;
  /** Edit success rate below which the edit surface is implicated. */
  editSuccessFloor?: number;
  /** Share of edit attempts landing only via tolerance, above which anchors are stale. */
  tolerantShareCeiling?: number;
}

/**
 * Propose tool-layer Mods from the evidence corpus.
 *
 * `summary` is injected so this is testable without a database, and so a caller
 * can scope it to one run.
 */
export function proposeFromEvidence(
  summary: EvidenceSummary,
  profile: HarnessProfile,
  thresholds: EvidenceThresholds = {},
): Mod[] {
  const minAttempts = thresholds.minEditAttempts ?? 10;
  const successFloor = thresholds.editSuccessFloor ?? 0.8;
  const tolerantCeiling = thresholds.tolerantShareCeiling ?? 0.3;

  const out: Mod[] = [];
  const e = summary.editHealth;
  if (e.attempts < minAttempts) return out; // not enough evidence to act on

  const tolerantShare = e.tolerant / e.attempts;

  // Signal 1 — anchors miss outright. The model's picture of the file is stale,
  // which a bigger read window may fix and tolerance certainly does not.
  if (e.successRate < successFloor && e.misses > 0) {
    const cur = Number(currentToolKnob(profile, 'UAP_READ_WINDOW_BYTES', '8000'));
    if (Number.isFinite(cur)) {
      const next = Math.min(32_000, Math.round(cur * 2));
      const mod = toolMod(profile, 'UAP_READ_WINDOW_BYTES', String(next));
      if (mod) out.push(mod);
    }
    // Diagnostics OFF is the counter-hypothesis worth testing when misses
    // dominate: the nearest-region report costs context on every miss, and if it
    // is not converting misses into successes it is pure overhead.
    if (e.misses > e.attempts * 0.4) {
      const mod = toolMod(profile, 'UAP_EDIT_DIAGNOSTICS', '0');
      if (mod) out.push(mod);
    }
  }

  // Signal 2 — a large share of edits land ONLY through tolerance. That is a
  // success today, but it means the model is routinely wrong about the file, so
  // it is worth measuring whether tolerance is rescuing real edits or masking
  // drift that produces subtly wrong ones.
  if (tolerantShare > tolerantCeiling) {
    const mod = toolMod(profile, 'UAP_EDIT_TOLERANT', '0');
    if (mod) out.push(mod);
  }

  // Signal 3 — the loop is running out of turns rather than failing on tools.
  const roundsPressure = summary.topFailures.some((f) => f.outcome === 'timeout');
  if (roundsPressure) {
    const cur = Number(currentToolKnob(profile, 'UAP_MAX_TOOL_ROUNDS', '12'));
    if (Number.isFinite(cur)) {
      const mod = toolMod(profile, 'UAP_MAX_TOOL_ROUNDS', String(Math.min(40, Math.round(cur * 1.5))));
      if (mod) out.push(mod);
    }
  }

  return out;
}

/**
 * A `Proposer` that reads the live corpus.
 *
 * It ignores `weaknesses` by design: those are run-level failure kinds mined
 * from bench records, and this proposer's whole point is the signal that never
 * reaches that level.
 */
export function evidenceProposer(
  opts: { runId?: string; thresholds?: EvidenceThresholds; summary?: EvidenceSummary } = {},
): Proposer {
  return {
    id: 'evidence',
    propose(_weaknesses: WeaknessReport[], profile: HarnessProfile): Mod[] {
      const summary = opts.summary ?? summarizeToolCalls(opts.runId);
      return proposeFromEvidence(summary, profile, opts.thresholds);
    },
  };
}

/**
 * Run several proposers and concatenate, de-duplicated by structural identity.
 * Lets the loop search the tool layer AND the server layer in one iteration
 * without either proposer knowing about the other.
 */
export function combineProposers(id: string, proposers: Proposer[]): Proposer {
  return {
    id,
    propose(weaknesses, profile) {
      const seen = new Set<string>();
      const out: Mod[] = [];
      for (const p of proposers) {
        for (const mod of p.propose(weaknesses, profile)) {
          const key = JSON.stringify(mod);
          if (seen.has(key)) continue;
          seen.add(key);
          out.push(mod);
        }
      }
      return out;
    },
  };
}
