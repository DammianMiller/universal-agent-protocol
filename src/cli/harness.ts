import chalk from 'chalk';
import { existsSync, readFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { isHaloTracingEnabled, haloTracePath } from '../observability/halo-exporter.js';

export interface HarnessOptions {
  traces?: string;
  prompt?: string;
  json?: boolean;
}

/** True when the `halo` CLI (halo-engine) is resolvable on PATH. */
function haloInstalled(): boolean {
  const probe = spawnSync('halo', ['--help'], { stdio: 'ignore' });
  return probe.status === 0 || probe.status === 2; // 2 = usage/help on some CLIs
}

function countLines(path: string): number {
  try {
    const txt = readFileSync(path, 'utf-8').trim();
    return txt.length === 0 ? 0 : txt.split('\n').length;
  } catch {
    return 0;
  }
}

/**
 * `uap harness analyze` — run the HALO engine over collected UAP traces to
 * surface systemic harness failure modes. Thin wrapper over the `halo` CLI.
 *
 * HALO contract: ask about the trace data; never ask it to write code.
 */
export async function harnessAnalyze(options: HarnessOptions = {}): Promise<void> {
  const traces = options.traces || haloTracePath();
  const prompt = options.prompt || 'What are the most common systemic failure modes in these traces?';

  if (!existsSync(traces)) {
    console.error(chalk.red(`No trace file at ${traces}.`));
    console.error(
      chalk.dim(
        'Enable trace collection first: set UAP_HALO_TRACE=1 (optionally UAP_HALO_TRACE_PATH) and re-run your workflow.'
      )
    );
    process.exit(2);
  }

  if (!haloInstalled()) {
    console.error(chalk.yellow('The `halo` CLI is not installed.'));
    console.error(chalk.dim('Install it (Python ≥3.10):  pip install halo-engine'));
    console.error(chalk.dim('Then run:'));
    console.error(chalk.cyan(`  halo ${traces} -p "${prompt}"`));
    process.exit(2);
  }

  const args = [traces, '-p', prompt];
  if (options.json) args.push('--json');
  const res = spawnSync('halo', args, { stdio: 'inherit' });
  process.exit(res.status ?? 0);
}

/** `uap harness status` — report HALO trace collection state. */
export async function harnessStatus(options: HarnessOptions = {}): Promise<void> {
  const enabled = isHaloTracingEnabled();
  const path = haloTracePath();
  const exists = existsSync(path);
  const spans = exists ? countLines(path) : 0;

  if (options.json) {
    process.stdout.write(
      JSON.stringify(
        { tracingEnabled: enabled, tracePath: path, traceFileExists: exists, spanCount: spans },
        null,
        2
      ) + '\n'
    );
    return;
  }

  console.log(chalk.bold('\n🔭 HALO Trace Status\n'));
  console.log(
    `  ${chalk.dim('Tracing:')}    ${enabled ? chalk.green('enabled') : chalk.yellow('disabled (set UAP_HALO_TRACE=1)')}`
  );
  console.log(`  ${chalk.dim('Trace file:')} ${path}`);
  console.log(
    `  ${chalk.dim('Status:')}     ${exists ? chalk.green(`${spans} spans`) : chalk.dim('no traces collected yet')}`
  );
  console.log('');
}

/** Dispatch for the `uap harness <subcommand>` group. */
export async function harnessCommand(
  sub: 'analyze' | 'status',
  options: HarnessOptions = {}
): Promise<void> {
  if (sub === 'status') return harnessStatus(options);
  return harnessAnalyze(options);
}
