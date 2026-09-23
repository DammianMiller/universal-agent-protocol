/**
 * Inference-stack health analysis — the deterministic core.
 *
 * Written after a live incident on 2026-09-21. A llama.cpp server that had
 * been up 18 hours was still reporting `active (running)` and GREEN from
 * `uap doctor`, while its prefill throughput had fallen roughly 8x and five
 * client requests had blown a 1800s deadline overnight. Liveness checks could
 * not see it, because nothing was down.
 *
 * Three things were wrong, and each needs a different kind of evidence:
 *
 *   1. Throughput decayed with uptime. Invisible in any single sample — and
 *      invisible in an hourly average too, because prefill tok/s depends
 *      heavily on prompt length. It only showed up once the samples were
 *      BUCKETED BY PROMPT SIZE and compared across time.
 *   2. Context checkpoints were starved. `--ctx-checkpoints` is per slot, and
 *      at 1 the checkpoint froze at n_past=11903 while 43k+ tokens were
 *      reusable, so ~32k tokens were re-prefilled every single turn.
 *   3. KV was pinned at the VBR floor, i.e. the pool was saturated and the
 *      cache had silently dropped to its lowest quality tier.
 *
 * Everything here is pure: callers supply already-collected samples. That
 * keeps the judgment testable without a GPU, a systemd unit, or a journal.
 */

export type InferenceHealth = 'GREEN' | 'WARN' | 'RED' | 'UNKNOWN';

/** One completed `prompt eval time` record scraped from the server log. */
export interface PrefillSample {
  /** Epoch ms, or any monotonically increasing clock. */
  at: number;
  /** Tokens actually prefilled (excludes cache/checkpoint reuse). */
  tokens: number;
  /** Reported throughput for that prefill. */
  tokensPerSecond: number;
}

/** A turn's cache/checkpoint divergence accounting. */
export interface CheckpointSample {
  /** Prompt tokens the client sent. */
  incoming: number;
  /** Tokens that COULD have been reused (longest common prefix). */
  reusable: number;
  /** Tokens actually recovered from a restored checkpoint. */
  restored: number;
}

export interface InferenceSnapshot {
  /** Seconds the server process has been running, when known. */
  uptimeSeconds?: number;
  /** Parallel rails (`-np`). */
  rails?: number;
  /** Shared KV pool size in cells (`-c`). Under --kv-unified this is TOTAL. */
  poolCells?: number;
  /** Per-slot checkpoint allowance (`--ctx-checkpoints`). */
  ctxCheckpoints?: number;
  /** Realized KV bits-per-value, and the floor it degrades toward. */
  kvBitsPerValue?: number;
  kvFloorBitsPerValue?: number;
  /** Size-bucketed prefill history, oldest first. */
  prefill: PrefillSample[];
  /** Recent turns' checkpoint accounting. */
  checkpoints: CheckpointSample[];
  /** Client-visible generation timeouts in the window. */
  generationTimeouts?: number;
  /** Distinct server PIDs seen in the window. >1 means it spans a restart. */
  processCount?: number;
}

export interface Thresholds {
  /** Ratio of recent to early prefill below which we call it degraded. */
  degradeRatioRed: number;
  degradeRatioWarn: number;
  /** Minimum samples per era before a trend claim is allowed. */
  minSamplesPerEra: number;
  /** Fraction of reusable tokens that must actually be restored. */
  checkpointRecoveryWarn: number;
  /** How close to the VBR floor counts as "pinned". */
  kvFloorSlack: number;
  /** Any timeout in the window is at least a WARN. */
  timeoutsWarn: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  // Measured 2026-09-21: 682 -> 77 tok/s (ratio 0.11) was a hard failure;
  // 682 -> 375 (0.55) was already visibly hurting turn latency.
  degradeRatioRed: 0.35,
  degradeRatioWarn: 0.65,
  minSamplesPerEra: 4,
  // Restoring under half of what was reusable means most of the prefix is
  // being recomputed every turn.
  checkpointRecoveryWarn: 0.5,
  kvFloorSlack: 0.15,
  timeoutsWarn: 1,
};

/** Prompt-size buckets. Prefill tok/s is strongly size-dependent, so an
 * average across mixed sizes is not comparable over time. */
export function sizeBucket(tokens: number): string {
  if (tokens < 5_000) return '<5k';
  if (tokens < 15_000) return '5-15k';
  if (tokens < 30_000) return '15-30k';
  return '>30k';
}

export interface BucketTrend {
  bucket: string;
  earlyMean: number;
  recentMean: number;
  /** recentMean / earlyMean. Below 1 means it got slower. */
  ratio: number;
  earlyCount: number;
  recentCount: number;
}

export interface TrendResult {
  /** The WORST qualifying bucket — the one the findings are based on. */
  bucket?: string;
  earlyMean?: number;
  recentMean?: number;
  ratio?: number;
  earlyCount: number;
  recentCount: number;
  /** Every qualifying bucket, worst ratio first. */
  buckets?: BucketTrend[];
  /** Why no verdict was possible, when ratio is undefined. */
  note?: string;
}

/**
 * Compare early-life against recent prefill throughput WITHIN a size bucket.
 *
 * Splitting the samples in half and averaging each side would be wrong: if
 * the workload's prompt sizes drift (and they do — conversations grow), the
 * mean moves for reasons that have nothing to do with the server. So pick the
 * bucket that has enough samples on BOTH sides and compare only within it.
 */
export function analyzeTrend(
  samples: PrefillSample[],
  thresholds: Thresholds = DEFAULT_THRESHOLDS,
): TrendResult {
  if (samples.length < thresholds.minSamplesPerEra * 2) {
    return { earlyCount: 0, recentCount: 0, note: 'not enough prefill samples for a trend' };
  }

  // Bucket FIRST, then split each bucket at its OWN median time.
  //
  // This used to split every sample at the GLOBAL median and bucket the two
  // halves. That silently dropped any bucket whose samples were skewed in
  // time — and a real agent workload skews hard, because conversations grow,
  // so large prompts arrive late. Measured on a live 6h journal:
  //
  //   bucket   early recent  outcome
  //   <5k         41     17  reported: 0.78 (mild)
  //   15-30k       2     21  EXCLUDED — needed 4 per era
  //
  // The excluded bucket had gone 616 -> 73 tok/s across its 23 samples. An 8x
  // collapse, invisible, while the report showed a benign 0.78. A bucket's own
  // chronology is what "did this get slower" means; the other buckets' arrival
  // times are irrelevant to it.
  const byBucket = new Map<string, PrefillSample[]>();
  for (const r of samples) {
    // A NaN or negative reading is a parse artefact, not a measurement.
    if (!Number.isFinite(r.tokensPerSecond) || r.tokensPerSecond < 0) continue;
    const b = sizeBucket(r.tokens);
    (byBucket.get(b) ?? byBucket.set(b, []).get(b)!).push(r);
  }

  const buckets: BucketTrend[] = [];
  for (const [bucket, rows] of byBucket) {
    if (rows.length < thresholds.minSamplesPerEra * 2) continue;
    const ordered = [...rows].sort((a, b) => a.at - b.at);
    const mid = Math.floor(ordered.length / 2);
    const ev = ordered.slice(0, mid).map((x) => x.tokensPerSecond);
    const rv = ordered.slice(mid).map((x) => x.tokensPerSecond);
    if (ev.length < thresholds.minSamplesPerEra || rv.length < thresholds.minSamplesPerEra) continue;

    const earlyMean = ev.reduce((a, b) => a + b, 0) / ev.length;
    const recentMean = rv.reduce((a, b) => a + b, 0) / rv.length;
    // An all-zero early era cannot produce a meaningful ratio.
    if (!(earlyMean > 0) || !Number.isFinite(recentMean)) continue;
    buckets.push({
      bucket,
      earlyMean,
      recentMean,
      ratio: recentMean / earlyMean,
      earlyCount: ev.length,
      recentCount: rv.length,
    });
  }

  if (buckets.length === 0) {
    return {
      earlyCount: 0,
      recentCount: 0,
      note: 'no prompt-size bucket had enough samples to split — cannot compare like with like',
    };
  }

  // Rank by SEVERITY, not by sample count. Picking the fattest bucket hid the
  // worst one: on a real 30h journal the 5-15k bucket sat at 0.289 (RED) while
  // the reported >30k bucket showed 0.522 (WARN) purely because it had more
  // samples — understating severity and flipping the remedy from "restart" to
  // "watch it". A thin bucket collapsing 10x emitted nothing at all.
  buckets.sort((a, b) => a.ratio - b.ratio || b.earlyCount + b.recentCount - (a.earlyCount + a.recentCount));
  const worst = buckets[0];
  return { ...worst, buckets };
}

export interface CheckpointResult {
  /** Mean fraction of reusable tokens actually recovered. */
  recovery?: number;
  /** Mean tokens re-prefilled that a checkpoint could have supplied. */
  wastedTokens?: number;
  samples: number;
}

/** How much of the reusable prefix the checkpoints actually deliver. */
export function analyzeCheckpoints(samples: CheckpointSample[]): CheckpointResult {
  const usable = samples.filter((s) => s.reusable > 0);
  if (usable.length === 0) return { samples: 0 };
  const recoveries = usable.map((s) => Math.min(1, s.restored / s.reusable));
  const wasted = usable.map((s) => Math.max(0, s.reusable - s.restored));
  return {
    recovery: recoveries.reduce((a, b) => a + b, 0) / recoveries.length,
    wastedTokens: wasted.reduce((a, b) => a + b, 0) / wasted.length,
    samples: usable.length,
  };
}

export interface Finding {
  health: Exclude<InferenceHealth, 'UNKNOWN'>;
  /** Stable id so monitors can match on it without parsing prose. */
  code: string;
  message: string;
  /** What to do about it. */
  remedy?: string;
}

export interface InferenceReport {
  health: InferenceHealth;
  findings: Finding[];
  trend: TrendResult;
  checkpoints: CheckpointResult;
}

/** Name the other slowed buckets, so a single headline number does not read
 *  as though only one prompt size is affected. */
function alsoAffected(trend: TrendResult): string {
  const others = (trend.buckets ?? []).filter((b) => b.bucket !== trend.bucket && b.ratio < 1);
  if (others.length === 0) return '';
  return `; also down in ${others.map((b) => `${b.bucket} (${Math.round((1 - b.ratio) * 100)}%)`).join(', ')}`;
}

const rank: Record<InferenceHealth, number> = { GREEN: 0, WARN: 1, RED: 2, UNKNOWN: 0 };

/** Roll a snapshot up into a verdict. Pure; no I/O, no clock. */
export function assessInference(
  snap: InferenceSnapshot,
  thresholds: Thresholds = DEFAULT_THRESHOLDS,
): InferenceReport {
  const findings: Finding[] = [];
  const trend = analyzeTrend(snap.prefill, thresholds);
  const checkpoints = analyzeCheckpoints(snap.checkpoints);

  // 1. Throughput decay over this process's life.
  if (trend.ratio !== undefined) {
    const pct = Math.round((1 - trend.ratio) * 100);
    if (trend.ratio < thresholds.degradeRatioRed) {
      findings.push({
        health: 'RED',
        code: 'prefill-decay',
        message:
          `prefill in the ${trend.bucket} bucket fell ${pct}% over this process's life ` +
          `(${Math.round(trend.earlyMean!)} -> ${Math.round(trend.recentMean!)} tok/s)` +
          alsoAffected(trend),
        remedy: 'restart the inference server; if it returns within days, investigate the prompt cache and idle-slot caching',
      });
    } else if (trend.ratio < thresholds.degradeRatioWarn) {
      findings.push({
        health: 'WARN',
        code: 'prefill-decay',
        message:
          `prefill in the ${trend.bucket} bucket is down ${pct}% ` +
          `(${Math.round(trend.earlyMean!)} -> ${Math.round(trend.recentMean!)} tok/s)` +
          alsoAffected(trend),
        remedy: 'watch it; a restart restores throughput if the decay continues',
      });
    }
  }

  // 2. Checkpoint starvation — reusable prefix that is not actually reused.
  if (checkpoints.recovery !== undefined && checkpoints.recovery < thresholds.checkpointRecoveryWarn) {
    const cp = snap.ctxCheckpoints;
    findings.push({
      health: checkpoints.wastedTokens! > 20_000 ? 'RED' : 'WARN',
      code: 'checkpoint-starved',
      message:
        `checkpoints recover only ${Math.round(checkpoints.recovery * 100)}% of the reusable prefix ` +
        `(~${Math.round(checkpoints.wastedTokens!).toLocaleString()} tokens re-prefilled per turn)`,
      remedy:
        cp !== undefined && cp <= 2
          ? `raise --ctx-checkpoints (currently ${cp}); it is per SLOT, so a low value cannot track a growing conversation`
          : 'check --ctx-checkpoints and --checkpoint-min-step against the conversation length',
    });
  }

  // 3. KV pinned at the VBR floor = the pool is saturated.
  if (snap.kvBitsPerValue !== undefined && snap.kvFloorBitsPerValue !== undefined) {
    if (snap.kvBitsPerValue <= snap.kvFloorBitsPerValue + thresholds.kvFloorSlack) {
      findings.push({
        health: 'WARN',
        code: 'kv-at-floor',
        message:
          `KV is pinned at the VBR floor (${snap.kvBitsPerValue} bpv, floor ${snap.kvFloorBitsPerValue}) ` +
          '— the pool is saturated and cache quality is at its lowest tier',
        remedy: 'reduce the context pool, the rail count, or the per-session cap; or raise --vbr-vram if VRAM allows',
      });
    }
  }

  // 4. Client-visible timeouts. A symptom, but the one users actually feel.
  if ((snap.generationTimeouts ?? 0) >= thresholds.timeoutsWarn) {
    findings.push({
      health: 'RED',
      code: 'generation-timeouts',
      message: `${snap.generationTimeouts} generation timeout(s) in the window — clients lost work`,
      remedy: 'fix the cause (prefill decay / checkpoint starvation) rather than raising the deadline',
    });
  }

  // 5. A window spanning a restart makes the early/recent split meaningless:
  //    the "decay" may simply be the boundary between two processes.
  if ((snap.processCount ?? 1) > 1 && trend.ratio !== undefined) {
    findings.push({
      health: 'WARN',
      code: 'spans-restart',
      message:
        `the window spans ${snap.processCount} server processes — a trend across a restart ` +
        'compares different process lifetimes, not decay within one',
      remedy: 'narrow --since/--until to a single process, or omit them to use the current one',
    });
  }

  // 6. Rail/pool sanity: under --kv-unified the pool is SHARED, so N rails
  //    each believing they own it is an overcommit waiting to happen.
  if (snap.rails !== undefined && snap.rails > 1 && snap.poolCells !== undefined) {
    findings.push({
      health: 'GREEN',
      code: 'shared-pool',
      message:
        `${snap.rails} rails share one ${snap.poolCells.toLocaleString()}-cell pool ` +
        `(${Math.floor(snap.poolCells / snap.rails).toLocaleString()} each if evenly divided)`,
    });
  }

  const worst = findings.reduce<InferenceHealth>(
    (acc, f) => (rank[f.health] > rank[acc] ? f.health : acc),
    findings.length > 0 ? 'GREEN' : 'UNKNOWN',
  );
  // No evidence at all is UNKNOWN, never a fabricated GREEN — the same
  // fail-open posture the capacity doctor uses.
  //
  // But "no evidence" is about the SAMPLED signals (trend, checkpoints, KV).
  // A finding that fired is itself evidence, so an actionable one must never
  // be masked by an UNKNOWN rollup: generation timeouts are counted from the
  // proxy journal and can fire with none of the sampled signals present,
  // which let a RED finding pass --strict with exit 0.
  const actionable = findings.some((f) => f.health !== 'GREEN');
  const noSampledEvidence =
    trend.ratio === undefined && checkpoints.samples === 0 && snap.kvBitsPerValue === undefined;
  const health: InferenceHealth = actionable || !noSampledEvidence ? worst : 'UNKNOWN';

  return { health, findings, trend, checkpoints };
}
