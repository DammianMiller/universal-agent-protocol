/**
 * `uap doctor` — capacity policy report (uplift 0.5).
 *
 * Probes every service declared in the capacity policy against its budgets
 * and prints GREEN/RED/DARK health. Advisory by default (exit 0); --strict
 * exits 1 on RED or DARK so CI and monitor loops can gate on it.
 *
 * Distinct from `uap config doctor`, which diagnoses settings health; this
 * diagnoses running-service capacity against declared policy.
 */
import chalk from 'chalk';
import { loadPolicy, runDoctor, worstHealth, type DoctorDeps } from '../capacity/probe.js';

export interface DoctorOptions {
  projectDir?: string;
  policy?: string;
  json?: boolean;
  strict?: boolean;
}

const COLORS = { GREEN: chalk.green, RED: chalk.red, DARK: chalk.bgRed.white, UNKNOWN: chalk.yellow } as const;

export async function doctorCommand(options: DoctorOptions, deps?: DoctorDeps): Promise<void> {
  const projectDir = options.projectDir ?? process.cwd();
  let loaded: ReturnType<typeof loadPolicy>;
  try {
    loaded = loadPolicy(projectDir, options.policy);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Machine consumers read stdout even on failure — keep it parseable.
    if (options.json) {
      console.log(JSON.stringify({ reportVersion: 1, error: msg }));
    } else {
      console.log(chalk.red(`capacity doctor: ${msg}`));
    }
    process.exitCode = 1;
    return;
  }

  const reports = runDoctor(loaded.policy, deps);
  const worst = worstHealth(reports);

  if (options.json) {
    // reportVersion pins the shape before monitors/dashboards start parsing it.
    console.log(JSON.stringify({ reportVersion: 1, policy: loaded.path, worst, services: reports }, null, 2));
  } else {
    console.log(chalk.bold(`capacity doctor: ${loaded.path}`));
    for (const r of reports) {
      console.log(`${COLORS[r.health](r.health.padEnd(7))} ${r.name}`);
      for (const reason of r.reasons) console.log(`  ${chalk.dim(reason)}`);
    }
  }
  if (options.strict && (worst === 'RED' || worst === 'DARK')) process.exitCode = 1;
}
