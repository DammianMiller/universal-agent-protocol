/**
 * `uap orchestrator [on|off|auto|status]` — toggle the long multi-turn deliver
 * orchestrator (the blackboard coordinator that runs decomposed tasks in
 * minimal per-task context). Persists to `.uap.json` under `deliver.orchestrate`:
 *   on / auto  → orchestrator engages automatically for decomposed missions
 *   off        → decomposed missions use the sequential phase runner instead
 * With no argument (or `status`), prints the current effective setting.
 */

import chalk from 'chalk';
import { loadUapConfigRaw, findUapConfigPath, modifyUapConfig } from '../utils/config-loader.js';

type State = 'on' | 'auto' | 'off';

function currentSetting(): { value: State; source: string } {
  if (process.env.UAP_DELIVER_ORCHESTRATE === '0') return { value: 'off', source: 'env UAP_DELIVER_ORCHESTRATE=0' };
  if (process.env.UAP_DELIVER_ORCHESTRATE === '1') return { value: 'on', source: 'env UAP_DELIVER_ORCHESTRATE=1' };
  let raw: Record<string, unknown> = {};
  try {
    raw = loadUapConfigRaw() ?? {};
  } catch {
    raw = {};
  }
  const d = (raw.deliver as Record<string, unknown> | undefined)?.orchestrate;
  if (d === false || d === 'off') return { value: 'off', source: '.uap.json deliver.orchestrate' };
  if (d === 'on' || d === true) return { value: 'on', source: '.uap.json deliver.orchestrate' };
  return { value: 'auto', source: 'default (auto-on for decomposed missions)' };
}

export async function orchestratorToggleCommand(state?: string): Promise<void> {
  const norm = (state ?? 'status').toLowerCase();

  if (norm === 'status' || norm === '') {
    const cur = currentSetting();
    const on = cur.value !== 'off';
    console.log(
      `Orchestrator: ${on ? chalk.green(cur.value.toUpperCase()) : chalk.red('OFF')} ${chalk.dim(`(${cur.source})`)}`
    );
    console.log(
      chalk.dim(
        on
          ? '  Decomposed missions run through the blackboard orchestrator (minimal per-task context).'
          : '  Decomposed missions run through the sequential phase runner.'
      )
    );
    console.log(chalk.dim('  Toggle: uap orchestrator on | off | auto'));
    return;
  }

  if (norm !== 'on' && norm !== 'off' && norm !== 'auto') {
    console.error(chalk.red(`Unknown state '${state}'. Use: on | off | auto | status`));
    process.exitCode = 1;
    return;
  }

  if (!findUapConfigPath()) {
    console.error(chalk.yellow('No .uap.json found — run `uap init` first, then re-run.'));
    process.exitCode = 1;
    return;
  }
  // 'auto' clears the explicit key (falls back to the default auto-on behavior).
  const value: unknown = norm === 'auto' ? undefined : norm;
  modifyUapConfig(process.cwd(), (cfg) => {
    const deliver = { ...((cfg as Record<string, unknown>).deliver as Record<string, unknown> | undefined) };
    if (value === undefined) delete deliver.orchestrate;
    else deliver.orchestrate = value;
    return { ...cfg, deliver };
  });
  console.log(chalk.green(`✓ Orchestrator set to ${chalk.bold(norm.toUpperCase())} (.uap.json deliver.orchestrate).`));
  if (norm === 'off') console.log(chalk.dim('  Decomposed missions will use the sequential phase runner.'));
}
