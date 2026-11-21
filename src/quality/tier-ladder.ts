/**
 * Tier ladder — best-of-N candidate artifacts per round, ranked
 * deterministically by tier distance, with escalation on a measured plateau
 * and an honest cut when the rounds run out (quality-tier uplift plan 1.2).
 *
 * The loop is what drives a smaller model up to a digitized tier: each round
 * produces N seeded variants of the artifact (diversity by strategy, not
 * temperature — the small-model stability doctrine), every variant is
 * measured against the tier with the CLASS's extractor (api-behavior
 * transcripts, bench results, visual captures), and the best variant
 * becomes the round's survivor. When the survivors stop improving across
 * rounds, the ladder FIRES — escalation is the operator's stronger-model
 * switch — and if the rounds are exhausted below tier, the loop CUTS with
 * the final gap attached: the failure is documented evidence, never a
 * silent pass (P39).
 *
 * Determinism: ranking is a total order on (pass, failing, severity sum,
 * worst severity, worst axis, id) — the same candidates always rank the
 * same, so a ladder re-run reproduces its trace byte-for-byte.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { GapReport, gapReport, GapResult, tiersPath } from './tiers.js';
import { classOfTierKey, resolveClass } from './classes.js';
import { tierContractText } from './tier-contract.js';

/**
 * Record a fired escalation (Wave 1.4, repo-side half): one JSON line in
 * .uap/quality/escalations.jsonl — the operator's explicit, durable queue
 * for quality-model placement. The ladder firing is the SIGNAL; the switch
 * decision stays with the fleet operator (the plan's owner for 1.4).
 * Project-local and gitignored with the rest of the quality store.
 */
export function recordEscalation(
  projectRoot: string,
  tierKey: string,
  round: number,
  summary: string,
): string {
  const file = join(dirname(tiersPath(projectRoot)), 'escalations.jsonl');
  mkdirSync(dirname(file), { recursive: true });
  const line = JSON.stringify({
    tier: tierKey,
    round,
    escalatedAt: new Date().toISOString(),
    summary,
  });
  appendFileSync(file, `${line}\n`);
  return file;
}

/** Wave 2.1 convergence telemetry: one record per ladder RUN (not per escalation). */
export interface LadderRunRecord {
  tier: string;
  outcome: TierLadderOutcome;
  rounds: number;
  /** Total candidates measured across rounds (the best-of-N cost). */
  candidatesMeasured: number;
  /** Winner passed its tier gate; null when nothing was measured. */
  winnerPassed: boolean | null;
  escalationFired: boolean;
  /** Executor model id when the caller knows it; null when unattributed. */
  model?: string | null;
  endedAt: string;
}

/**
 * Record one completed ladder run beside the tiers store
 * (.uap/quality/convergence.jsonl). The per-model/per-class convergence
 * numbers — rounds-to-tier, cut rate, escalation frequency, best-of-N win
 * rate — derive from this log. It is the measured evidence the tier gate's
 * shadow→block promotion decision is made against (the System-1 rule: no
 * promotion without a measured budget).
 */
export function recordLadderRun(
  projectRoot: string,
  record: Omit<LadderRunRecord, 'endedAt'>,
): string {
  const file = join(dirname(tiersPath(projectRoot)), 'convergence.jsonl');
  mkdirSync(dirname(file), { recursive: true });
  const line = JSON.stringify({ ...record, endedAt: new Date().toISOString() });
  appendFileSync(file, `${line}\n`);
  return file;
}

export interface LadderConvergenceSummary {
  tier: string;
  runs: number;
  tierReached: number;
  cutRate: number;
  escalationRate: number;
  /** Mean rounds over runs that reached the tier; null when none did. */
  meanRoundsToTier: number | null;
  /** Share of runs whose winner passed (null winner counts as a miss). */
  winnerPassRate: number;
  /** Mean candidates measured per run — the best-of-N cost line. */
  meanCandidates: number;
}

/** Aggregate the convergence log per tier — the promotion-budget evidence. */
export function summarizeLadderRuns(
  projectRoot: string
): { summaries: LadderConvergenceSummary[]; totalRuns: number; logPath: string } {
  const logPath = join(dirname(tiersPath(projectRoot)), 'convergence.jsonl');
  const summaries: LadderConvergenceSummary[] = [];
  if (!existsSync(logPath)) return { summaries, totalRuns: 0, logPath };
  const byTier = new Map<string, LadderRunRecord[]>();
  let totalRuns = 0;
  try {
    for (const line of readFileSync(logPath, 'utf-8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let rec: LadderRunRecord;
      try {
        rec = JSON.parse(trimmed) as LadderRunRecord;
      } catch {
        continue; // a corrupt line never breaks the aggregate
      }
      const list = byTier.get(rec.tier) ?? [];
      list.push(rec);
      byTier.set(rec.tier, list);
      totalRuns++;
    }
  } catch {
    return { summaries, totalRuns: 0, logPath };
  }
  for (const [tier, runs] of byTier) {
    const reached = runs.filter((r) => r.outcome === 'tier-reached');
    const winnerPasses = runs.filter((r) => r.winnerPassed === true).length;
    const measured = runs.filter((r) => r.winnerPassed !== null).length;
    summaries.push({
      tier,
      runs: runs.length,
      tierReached: reached.length,
      cutRate: 1 - reached.length / runs.length,
      escalationRate: runs.filter((r) => r.escalationFired).length / runs.length,
      meanRoundsToTier:
        reached.length > 0
          ? reached.reduce((a, r) => a + r.rounds, 0) / reached.length
          : null,
      winnerPassRate: measured > 0 ? winnerPasses / measured : 0,
      meanCandidates: runs.reduce((a, r) => a + r.candidatesMeasured, 0) / runs.length,
    });
  }
  summaries.sort((a, b) => b.runs - a.runs || a.tier.localeCompare(b.tier));
  return { summaries, totalRuns, logPath };
}

/** One candidate artifact for a round. The id is stable (ranking tiebreak + trace). */
export interface TierLadderCandidate {
  id: string;
  /** Path to the artifact this round produced (transcript, results file, capture). */
  artifactPath: string;
  /** Which strategy seed produced it (trace only, never affects ranking). */
  strategy?: string;
}

export interface TierLadderMeasurement {
  id: string;
  pass: boolean;
  failing: number;
  /** Sum of failing-axis severities — the climb metric. */
  severity: number;
  worst: string | null;
  strategy?: string;
  /** The gap report when the artifact measured; null when it did not decode. */
  gap: GapReport | null;
}

export interface TierLadderRound {
  /** 1-based. */
  round: number;
  candidates: TierLadderMeasurement[];
  /** The round's best candidate id (null when nothing measured). */
  best: string | null;
  /** True when the round fired the escalation (a measured plateau preceded it). */
  escalated: boolean;
  /** Set when the ladder cut AT this round: the reason + the documented gap. */
  cut?: { reason: string; gap: GapReport | null };
}

export type TierLadderOutcome =
  | 'tier-reached'
  | 'cut-exhausted'
  | 'cut-no-candidates'
  | 'cut-unmeasurable';

export interface TierLadderResult {
  tier: string;
  outcome: TierLadderOutcome;
  rounds: TierLadderRound[];
  /** The tier-reaching (or final best) candidate; null when nothing measured. */
  winner: TierLadderCandidate | null;
  /** The documented gap at the cut (or the passing report at tier). */
  finalGap: GapReport | null;
  /** True when escalation fired at any round. */
  escalationFired: boolean;
  /** Human summary of the outcome for logs and verdict lines. */
  summary: string;
}

export interface TierLadderConfig {
  projectRoot: string;
  /** Tier key (class/name) to climb toward. */
  tierKey: string;
  /**
   * Produce the round's candidate artifacts. `round` is 1-based;
   * `previousBest` is the prior round's survivor (null on round 1). An empty
   * result cuts the ladder with `cut-no-candidates` — never guess a pass.
   * `contract` (Wave 1.3) is the tier contract text — the executor prompt
   * carries it so the model climbs toward the bar instead of discovering it
   * through failed rounds. Null when the tier carries no thresholds.
   */
  generate: (
    round: number,
    previousBest: TierLadderCandidate | null,
    history: TierLadderRound[],
    contract: string | null,
  ) => Promise<TierLadderCandidate[]> | TierLadderCandidate[];
  /** Round ceiling (default 4 — the attempt-farm guard from the plan). */
  maxRounds?: number;
  /** Candidates per round (default 3 — N=3 from the plan's acceptance). */
  candidatesPerRound?: number;
  /** Rounds without best-severity improvement before escalation fires (default 2). */
  plateauRounds?: number;
  /** A severity improvement below this epsilon is a plateau step (default 0.01). */
  plateauEpsilon?: number;
  /** Fires when the ladder escalates — the stronger-model switch lives here. */
  onEscalate?: (round: number) => void | Promise<void>;
  /** Injection point for tests (defaults to the real seam). */
  gap?: typeof gapReport;
}

const DEFAULT_MAX_ROUNDS = 4;
const DEFAULT_CANDIDATES = 3;
const DEFAULT_PLATEAU_ROUNDS = 2;
const DEFAULT_EPSILON = 0.01;

/**
 * Rank measurements deterministically: a pass beats everything, then fewer
 * failing axes, then lower severity sum, then lower worst-axis severity,
 * then worst-axis name, then id. Degenerate-guard failures rank as severity
 * 1 candidates — a wash or an empty transcript is the WORST evidence, never
 * a passing one.
 */
export function rankMeasurements(a: TierLadderMeasurement, b: TierLadderMeasurement): number {
  if (a.pass !== b.pass) return a.pass ? -1 : 1;
  if (a.failing !== b.failing) return a.failing - b.failing;
  if (a.severity !== b.severity) return a.severity - b.severity;
  const aw = a.gap ? severityOfWorst(a.gap) : 1;
  const bw = b.gap ? severityOfWorst(b.gap) : 1;
  if (aw !== bw) return aw - bw;
  const an = a.worst ?? '';
  const bn = b.worst ?? '';
  if (an !== bn) return an < bn ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function severityOfWorst(gap: GapReport): number {
  return gap.axes.find((x) => x.status === 'fail')?.severity ?? 0;
}

function severitySum(gap: GapReport): number {
  return gap.axes.reduce((acc, x) => (x.status === 'fail' ? acc + x.severity : acc), 0);
}

/**
 * Run the ladder. Pure apart from the injected generate/onEscalate/gap seams —
 * the same generation sequence reproduces the same result and trace.
 */
export async function runTierLadder(config: TierLadderConfig): Promise<TierLadderResult> {
  const maxRounds = Math.max(1, config.maxRounds ?? DEFAULT_MAX_ROUNDS);
  const candidatesPerRound = Math.max(1, config.candidatesPerRound ?? DEFAULT_CANDIDATES);
  const plateauRounds = Math.max(1, config.plateauRounds ?? DEFAULT_PLATEAU_ROUNDS);
  const epsilon = config.plateauEpsilon ?? DEFAULT_EPSILON;
  const measure = config.gap ?? gapReport;

  const res = measure(config.projectRoot, '', config.tierKey);
  if (res.kind === 'no-tier') {
    return cut(config.tierKey, 'cut-no-candidates', [], null, null, false, `unknown tier '${config.tierKey}'`);
  }
  if (res.kind === 'stale-tier') {
    return cut(config.tierKey, 'cut-no-candidates', [], null, null, false, `stale tier '${config.tierKey}' (extractor v${res.tierVersion}) — re-derive it first`);
  }
  // A probe 'unreadable' result here is expected (empty artifact path): the
  // probe exists only to fail closed on unknown/stale tier keys early.
  const cls = classOfTierKey(config.tierKey);
  // Wave 1.3: the contract the executor prompt carries — resolved once,
  // from the same store the gates read, so prompt and gate cannot drift.
  const contract = tierContractText(config.projectRoot, config.tierKey);

  const rounds: TierLadderRound[] = [];
  let previousBest: TierLadderCandidate | null = null;
  let bestGap: GapReport | null = null;
  let bestSeverity = Number.POSITIVE_INFINITY;
  let plateau = 0;
  let escalationFired = false;

  for (let round = 1; round <= maxRounds; round++) {
    const allGenerated = await config.generate(round, previousBest, rounds, contract);
    // The N cap is enforced here, not trusted to the generator (the
    // attempt-farm guard: every candidate costs a model call + a measurement).
    const generated = allGenerated.slice(0, candidatesPerRound);
    if (generated.length === 0) {
      rounds.push({ round, candidates: [], best: null, escalated: false, cut: { reason: 'no candidates were generated for this round', gap: bestGap } });
      return cut(config.tierKey, 'cut-no-candidates', rounds, previousBest, bestGap, escalationFired, 'a round produced no candidates');
    }

    const measurements: TierLadderMeasurement[] = [];
    for (const c of generated) {
      const r = measure(config.projectRoot, c.artifactPath, config.tierKey);
      measurements.push(toMeasurement(c, r));
    }

    const ranked = [...measurements].sort(rankMeasurements);
    const top = ranked[0];

    if (top.gap === null) {
      // Nothing measured — a broken probe is a documented failure, not a pass.
      rounds.push({ round, candidates: measurements, best: null, escalated: false, cut: { reason: `no candidate produced a measurable ${resolveClass(cls).artifact}`, gap: null } });
      return cut(config.tierKey, 'cut-unmeasurable', rounds, null, null, escalationFired, 'no candidate was measurable');
    }

    const winner = generated.find((c) => c.id === top.id) ?? generated[0];

    if (top.pass) {
      rounds.push({ round, candidates: measurements, best: top.id, escalated: false });
      return {
        tier: config.tierKey,
        outcome: 'tier-reached',
        rounds,
        winner,
        finalGap: top.gap,
        escalationFired,
        summary: `tier ${config.tierKey} reached on round ${round} by candidate '${top.id}' (${measurements.length} candidate(s) ranked)`,
      };
    }

    // Plateau tracking: improvement below epsilon (or regression) counts
    // toward escalation; a real improvement resets the counter.
    const improved = top.severity < bestSeverity - epsilon;
    if (improved) {
      plateau = 0;
    } else {
      plateau += 1;
    }
    bestSeverity = Math.min(bestSeverity, top.severity);
    bestGap = top.gap;
    previousBest = winner;

    const escalate = plateau >= plateauRounds && round < maxRounds;
    if (escalate) {
      escalationFired = true;
      plateau = 0; // the stronger model gets its own plateau budget
      // Wave 1.4 repo-side half: the firing is recorded durably as the
      // operator's placement queue (the switch itself is operator-owned).
      recordEscalation(
        config.projectRoot,
        config.tierKey,
        round,
        `plateau: best candidate failed ${top.failing} of ${top.gap.axes.length} axes on tier ${config.tierKey} after ${round} round(s) without improvement — worst: ${top.worst}`,
      );
      await config.onEscalate?.(round);
    }

    rounds.push({ round, candidates: measurements, best: top.id, escalated: escalate });
  }

  // Rounds exhausted below tier: CUT with the documented gap.
  const lastRound = rounds[rounds.length - 1];
  if (lastRound) lastRound.cut = { reason: `rounds exhausted (${maxRounds}) below tier`, gap: bestGap };
  return cut(
    config.tierKey,
    'cut-exhausted',
    rounds,
    previousBest,
    bestGap,
    escalationFired,
    `below tier after ${maxRounds} round(s)${escalationFired ? ' (escalation fired)' : ''}`,
  );
}

function toMeasurement(c: TierLadderCandidate, r: GapResult): TierLadderMeasurement {
  if (r.kind === 'ok') {
    return {
      id: c.id,
      pass: r.report.pass,
      failing: r.report.failing,
      severity: severitySum(r.report),
      worst: r.report.worst,
      strategy: c.strategy,
      gap: r.report,
    };
  }
  // Unreadable for the class: worst possible measurement, documented as null gap.
  return { id: c.id, pass: false, failing: Number.POSITIVE_INFINITY, severity: Number.POSITIVE_INFINITY, worst: 'unmeasurable', strategy: c.strategy, gap: null };
}

function cut(
  tier: string,
  outcome: TierLadderOutcome,
  rounds: TierLadderRound[],
  winner: TierLadderCandidate | null,
  finalGap: GapReport | null,
  escalationFired: boolean,
  reason: string,
): TierLadderResult {
  return {
    tier,
    outcome,
    rounds,
    winner,
    finalGap,
    escalationFired,
    summary: `cut below tier ${tier}: ${reason}`,
  };
}
