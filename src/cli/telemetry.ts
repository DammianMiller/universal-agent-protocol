/**
 * `uap telemetry report` — the reproducible instrument for the tool-call
 * corpus.
 *
 * The 2026-11-14 client-fleet monitoring (20,002 calls: 20.6% failure, 83%
 * in the write/edit family, arm quality the biggest single factor) was an
 * ad-hoc SQL pass. Every uplift round that targets the write path needs the
 * SAME pass reproducible before and after, on any box, without a notebook:
 *
 *   uap telemetry report              # era table + per-tool rates + classes
 *   uap telemetry report --days 30    # wider era window
 *   uap telemetry report --json       # machine-readable (CI, dashboards)
 *
 * The corpus is rolling-capped and machine-scoped — the headline and per-tool
 * tables describe what the corpus holds now. The ERA table is durable: days
 * whose rows turned over (or a wiped tool-calls.db) live on in
 * era-history.jsonl beside the corpus, written when the prune drops them, so
 * a before/after comparison survives the turnover that erased its rows.
 */

import chalk from 'chalk';
import {
  dailyToolCallRates,
  summarizeToolCalls,
  toolFailureRates,
  toolCorpusRoot,
} from '../telemetry/tool-calls.js';

export interface TelemetryOptions {
  days?: string;
  json?: boolean;
}

export async function telemetryCommand(
  action: string = 'report',
  options: TelemetryOptions = {}
): Promise<void> {
  if (action && action !== 'report') {
    console.error(chalk.red(`unknown subcommand '${action}' — supported: report`));
    process.exitCode = 1;
    return;
  }

  const days = options.days ? Math.max(1, parseInt(options.days, 10) || 14) : 14;
  const root = toolCorpusRoot();
  const summary = summarizeToolCalls(undefined, root);
  const tools = toolFailureRates(root);
  const eras = dailyToolCallRates(days, root);

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          corpusRoot: root,
          days,
          headline: {
            totalCalls: summary.totalCalls,
            failedCalls: summary.failedCalls,
            failureRate: summary.failureRate,
          },
          byComponent: summary.byComponent,
          topFailures: summary.topFailures,
          editHealth: summary.editHealth,
          toolRates: tools,
          eras,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(chalk.bold(`\nTool-call corpus — ${root}`));
  if (summary.totalCalls === 0 && eras.length === 0) {
    console.log(chalk.dim('  No tool-call evidence recorded yet.'));
    return;
  }

  if (summary.totalCalls > 0) {
    console.log(
      `  calls ${summary.totalCalls} | failed ${summary.failedCalls} ` +
        `(${(summary.failureRate * 100).toFixed(1)}%)`,
    );
  } else {
    // The live corpus turned over or was wiped; the era table below is
    // era-history.jsonl and is the whole story (found live: the 2026-11-21
    // db wipe printed "No tool-call evidence recorded yet." over a corpus
    // whose era numbers existed in history).
    console.log(chalk.dim('  Live corpus empty — archived eras below.'));
  }

  if (eras.length > 0) {
    console.log(chalk.bold(`\nEra table (last ${days} days, failure rate by day; includes days archived at turnover):`));
    for (const e of eras) {
      const mark = e.failureRate >= 0.2 ? chalk.red : e.failureRate >= 0.1 ? chalk.yellow : chalk.green;
      console.log(
        `  ${e.day}  ${String(e.calls).padStart(6)} calls  ${String(e.failures).padStart(5)} failed  ` +
          mark(`${(e.failureRate * 100).toFixed(1)}%`),
      );
    }
  }

  if (tools.length > 0) {
    console.log(chalk.bold('\nPer-tool rates (highest failure count first):'));
    for (const t of tools) {
      const mark = t.failureRate >= 0.3 ? chalk.red : t.failureRate >= 0.15 ? chalk.yellow : chalk.green;
      console.log(
        `  ${t.tool.padEnd(12)} ${String(t.calls).padStart(6)} calls  ${String(t.failures).padStart(5)} failed  ` +
          mark(`${(t.failureRate * 100).toFixed(1)}%`),
      );
    }
  }

  const e = summary.editHealth;
  if (e.attempts > 0) {
    console.log(
      chalk.bold('\nEdit-tool health:') +
        `  ${e.attempts} attempts | exact ${e.exact} | tolerant ${e.tolerant} | ` +
        `miss ${e.misses} | ambiguous ${e.ambiguous} | success ${(e.successRate * 100).toFixed(1)}%`,
    );
  }

  if (summary.topFailures.length > 0) {
    console.log(chalk.bold('\nTop failure classes:'));
    for (const f of summary.topFailures.slice(0, 10)) {
      console.log(`  ${String(f.count).padStart(5)}x ${f.tool}/${String(f.outcome)} [${f.component}]`);
    }
  }
  console.log('');
}
