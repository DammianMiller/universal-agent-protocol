/**
 * `uap inference health` — is the local inference stack actually WORKING?
 *
 * `uap doctor` answers "is it up and inside its declared budgets". That is a
 * different question, and on 2026-09-21 it was GREEN while the server's
 * prefill throughput had fallen ~8x and five client requests had blown a
 * 1800s deadline overnight. Nothing was down; everything was slow.
 *
 * This command looks at the things that go wrong without anything failing:
 * throughput decaying over a long-lived process, context checkpoints too few
 * to track a growing conversation, and a KV cache quietly pinned at its
 * lowest quality tier.
 */
import chalk from 'chalk';
import {
  DEFAULT_THRESHOLDS,
  assessInference,
  type InferenceHealth,
  type Thresholds,
} from '../inference/analysis.js';
import { collect, type ProbeDeps } from '../inference/probe.js';

export interface InferenceOptions {
  serverUnit?: string;
  proxyUnit?: string;
  url?: string;
  since?: string;
  until?: string;
  json?: boolean;
  strict?: boolean;
}

const COLORS: Record<InferenceHealth, (s: string) => string> = {
  GREEN: chalk.green,
  WARN: chalk.yellow,
  RED: chalk.red,
  UNKNOWN: chalk.gray,
};

const DEFAULTS = {
  serverUnit: 'uap-gsq-rco-server.service',
  proxyUnit: 'uap-anthropic-proxy.service',
  url: 'http://127.0.0.1:8080',
};

function fmtDuration(seconds?: number): string {
  if (seconds === undefined) return 'unknown';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export async function inferenceHealthCommand(
  options: InferenceOptions = {},
  deps?: ProbeDeps,
  thresholds: Thresholds = DEFAULT_THRESHOLDS,
): Promise<void> {
  const serverUnit = options.serverUnit ?? DEFAULTS.serverUnit;
  const proxyUnit = options.proxyUnit ?? DEFAULTS.proxyUnit;
  const baseUrl = options.url ?? DEFAULTS.url;

  const { snapshot, unit, slots, metrics, unavailable } = await collect(
    { serverUnit, proxyUnit, baseUrl, since: options.since, until: options.until },
    deps,
  );
  const report = assessInference(snapshot, thresholds);

  if (options.json) {
    // reportVersion pins the shape before monitors start parsing it.
    console.log(
      JSON.stringify(
        {
          reportVersion: 1,
          health: report.health,
          unit: { name: serverUnit, active: unit?.active, uptimeSeconds: unit?.uptimeSeconds },
          snapshot: {
            rails: snapshot.rails,
            poolCells: snapshot.poolCells,
            ctxCheckpoints: snapshot.ctxCheckpoints,
            kvBitsPerValue: snapshot.kvBitsPerValue,
            kvFloorBitsPerValue: snapshot.kvFloorBitsPerValue,
            generationTimeouts: snapshot.generationTimeouts,
            prefillSamples: snapshot.prefill.length,
            checkpointSamples: snapshot.checkpoints.length,
          },
          trend: report.trend,
          checkpoints: report.checkpoints,
          findings: report.findings,
          metrics,
          unavailable,
        },
        null,
        2,
      ),
    );
  } else {
    const historical = Boolean(options.until);
    console.log(chalk.bold(`inference health: ${serverUnit}`));
    if (historical) {
      // The journal window is in the past but /slots, uptime and the unit's
      // flags are read NOW. Printing them together would describe the wrong
      // process — during an incident review that is worse than silence.
      console.log(
        chalk.yellow(
          `REPLAY  journal window ${options.since ?? '(default)'} .. ${options.until} — ` +
            'live readings below are omitted; they describe the CURRENT process, not the window',
        ),
      );
      console.log(`${COLORS[report.health](report.health.padEnd(7))} findings for that window`);
    } else {
      console.log(
        `${COLORS[report.health](report.health.padEnd(7))} ` +
          `${unit?.active ?? 'unknown'}, up ${fmtDuration(unit?.uptimeSeconds)}` +
          (slots?.slots ? `, ${slots.slots} rail(s)` : ''),
      );
    }

    if (!historical && snapshot.poolCells !== undefined) {
      const per =
        snapshot.rails && snapshot.rails > 0
          ? ` (${Math.floor(snapshot.poolCells / snapshot.rails).toLocaleString()}/rail if split)`
          : '';
      console.log(chalk.dim(`  pool        ${snapshot.poolCells.toLocaleString()} cells shared${per}`));
    }
    if (!historical && snapshot.ctxCheckpoints !== undefined) {
      console.log(chalk.dim(`  checkpoints ${snapshot.ctxCheckpoints} per slot`));
    }
    if (!historical && snapshot.kvBitsPerValue !== undefined) {
      const floor = snapshot.kvFloorBitsPerValue;
      console.log(
        chalk.dim(`  kv          ${snapshot.kvBitsPerValue} bpv${floor !== undefined ? ` (floor ${floor})` : ''}`),
      );
    }

    const t = report.trend;
    if (t.ratio !== undefined) {
      const arrow = t.ratio < 1 ? '↓' : '↑';
      console.log(
        chalk.dim(
          `  prefill     ${Math.round(t.earlyMean!)} → ${Math.round(t.recentMean!)} tok/s ${arrow} ` +
            `in the ${t.bucket} bucket (n=${t.earlyCount}/${t.recentCount})`,
        ),
      );
    } else if (t.note) {
      console.log(chalk.dim(`  prefill     ${t.note}`));
    }

    if (report.checkpoints.recovery !== undefined) {
      console.log(
        chalk.dim(
          `  reuse       ${Math.round(report.checkpoints.recovery * 100)}% of the reusable prefix restored ` +
            `(~${Math.round(report.checkpoints.wastedTokens!).toLocaleString()} tok/turn re-prefilled)`,
        ),
      );
    }
    if (!historical && metrics?.busySlotsPerDecode !== undefined) {
      console.log(
        chalk.dim(
          `  concurrency ${metrics.busySlotsPerDecode.toFixed(3)} busy slots/decode ` +
            `(>1 means the extra rail is actually being used)`,
        ),
      );
    }

    console.log();
    for (const f of report.findings) {
      if (f.health === 'GREEN') {
        console.log(chalk.dim(`  · ${f.message}`));
        continue;
      }
      console.log(`${COLORS[f.health](f.health.padEnd(7))} ${f.message}`);
      if (f.remedy) console.log(chalk.dim(`        → ${f.remedy}`));
    }
    if (report.findings.every((f) => f.health === 'GREEN')) {
      console.log(chalk.green('  no problems detected'));
    }
    if (unavailable.length > 0) {
      console.log();
      console.log(chalk.gray(`  unverified (probe unavailable): ${unavailable.join(', ')}`));
    }
  }

  if (options.strict && (report.health === 'RED' || report.health === 'WARN')) {
    process.exitCode = 1;
  }
}
