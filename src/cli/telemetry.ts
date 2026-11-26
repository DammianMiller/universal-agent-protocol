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
 *   uap telemetry ingest-droid F...   # parse droid client sessions into the
 *                                     # corpus (the fleet-visibility bridge)
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
import { ingestDroidSession } from '../telemetry/droid-sessions.js';

export interface TelemetryOptions {
  days?: string;
  json?: boolean;
}

export async function telemetryCommand(
  action: string = 'report',
  options: TelemetryOptions = {},
  paths: string[] = []
): Promise<void> {
  if (action === 'ingest-droid') {
    return ingestDroidCmd(paths, options);
  }
  if (action && action !== 'report') {
    console.error(chalk.red(`unknown subcommand '${action}' — supported: report, ingest-droid`));
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

/**
 * `uap telemetry ingest-droid <session.jsonl...>` (wave 6, item 2) — parse
 * Droid client session transcripts into corpus rows, through the same
 * classification path as live traffic. The client fleet is the class the
 * corpus was blind to (a 9.5-hour round-5 session: 155 tool calls, zero
 * rows); this is the bridge. Idempotent per session (rows are replaced by
 * run_id), so re-ingesting after a transcript grows is safe.
 */
async function ingestDroidCmd(paths: string[], options: TelemetryOptions): Promise<void> {
  if (paths.length === 0) {
    console.error(
      chalk.red('ingest-droid needs at least one session .jsonl path (globs expand in your shell)'),
    );
    process.exitCode = 1;
    return;
  }
  const results = [];
  for (const p of paths) {
    try {
      results.push(ingestDroidSession(p));
    } catch (e) {
      console.error(chalk.red(`ingest failed: ${p}: ${e instanceof Error ? e.message : String(e)}`));
      process.exitCode = 1;
    }
  }
  if (options.json) {
    console.log(
      JSON.stringify(
        {
          sessions: results.map((r) => ({
            session: r.sessionFile,
            runId: r.sessionId,
            cwd: r.cwd ?? null,
            toolCalls: r.toolCalls.length,
            unpaired: r.unpaired,
            replacedRows: r.replacedRows,
            outcomes: r.outcomes,
          })),
        },
        null,
        2,
      ),
    );
    return;
  }
  for (const r of results) {
    const classes = Object.entries(r.outcomes)
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${n}x ${k}`)
      .join(', ');
    console.log(
      `  ${r.sessionId}  ${String(r.toolCalls.length).padStart(4)} calls  ` +
        (r.replacedRows > 0 ? chalk.dim(`(replaced ${r.replacedRows} prior rows) `) : '') +
        (r.cwd ? chalk.dim(`${r.cwd}  `) : '') +
        (classes || chalk.dim('no paired tool calls')),
    );
    if (r.unpaired > 0) {
      console.log(chalk.dim(`    ${r.unpaired} call(s) cut off without a result — not ingested`));
    }
  }
  console.log('');
}
