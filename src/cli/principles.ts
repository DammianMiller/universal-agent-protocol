/**
 * `uap principles` — inspect and answer the engineering-principles stance.
 *
 * Rule 1 ("do not preserve backward compatibility") is the one rule that cannot
 * be a fixed setting: it is correct on a side project and destructive on a
 * published one. So it is asked, once per project per session, and this command
 * is where the answer is given and read back.
 */
import chalk from 'chalk';
import { modifyUapConfig } from '../utils/config-loader.js';
import { createClackUI, createNonInteractiveUI } from './prompt-ui.js';
import { renderCompact, renderFull } from '../principles/render.js';
import {
  needsAsking,
  recordStance,
  resolveStance,
  stanceForUnattended,
} from '../principles/stance.js';
import type { CompatStance, Maturity } from '../principles/rules.js';

export interface PrinciplesOptions {
  projectDir?: string;
  /** Persist as the project default (.uap.json) as well as this session. */
  save?: boolean;
  json?: boolean;
}

type Subcommand = 'status' | 'ask' | 'compat' | 'maturity' | 'show';

function sourceLabel(source: string): string {
  return source === 'unresolved' ? chalk.yellow('unresolved') : chalk.dim(`from ${source}`);
}

function printStatus(cwd: string, json?: boolean): void {
  const stance = resolveStance(cwd);
  if (json) {
    console.log(JSON.stringify(stance, null, 2));
    return;
  }

  console.log(chalk.bold('\nEngineering principles\n'));
  console.log(
    `  backward compatibility  ${chalk.cyan(stance.compat ?? '—')}  ${sourceLabel(stance.compatSource)}`
  );
  console.log(
    `  project maturity        ${chalk.cyan(stance.maturity ?? '—')}  ${sourceLabel(stance.maturitySource)}`
  );

  if (needsAsking(stance)) {
    const assumed = stanceForUnattended(stance);
    console.log(
      chalk.dim(
        `\n  Not answered for this session. Unattended runs assume ${assumed.compat}/${assumed.maturity}.`
      )
    );
    console.log(chalk.dim('  Answer it: ') + chalk.cyan('uap principles ask'));
  }
  console.log('');
}

async function ask(cwd: string, opts: PrinciplesOptions): Promise<void> {
  // Non-interactive callers (CI, a piped shell) must not hang on a TTY prompt;
  // they get the explicit `compat`/`maturity` subcommands instead.
  const ui = process.stdin.isTTY ? await createClackUI() : createNonInteractiveUI();
  if (!process.stdin.isTTY) {
    console.log(
      chalk.yellow('Not a TTY — use `uap principles compat <preserve|remove>` instead.')
    );
    return;
  }

  ui.intro('Engineering principles');

  const compat = await ui.select<CompatStance>({
    message: 'Backward compatibility — what should happen to obsolete paths?',
    options: [
      {
        label: 'Preserve them',
        value: 'preserve',
        hint: 'keep working, migrate callers first — safe for anything published',
      },
      {
        label: 'Remove them',
        value: 'remove',
        hint: 'delete obsolete paths outright, no shims or fallbacks',
      },
    ],
    initialValue: 'preserve',
  });

  const maturity = await ui.select<Maturity>({
    message: 'What does breaking a caller cost here?',
    options: [
      {
        label: 'Greenfield',
        value: 'greenfield',
        hint: 'nothing depends on this yet — optimise for simplicity',
      },
      {
        label: 'Production',
        value: 'production',
        hint: 'real users or systems depend on it',
      },
    ],
    initialValue: 'production',
  });

  recordStance(cwd, { compat, maturity });
  if (opts.save) {
    modifyUapConfig(cwd, (config: Record<string, unknown>) => {
      const principles = (config.principles ?? {}) as Record<string, unknown>;
      config.principles = { ...principles, compat, maturity };
      return config;
    });
  }

  ui.outro(
    opts.save
      ? `Recorded for this session and saved as the project default (${compat}/${maturity}).`
      : `Recorded for this session (${compat}/${maturity}). Add --save to make it the project default.`
  );
}

function setValue(
  cwd: string,
  key: 'compat' | 'maturity',
  value: string | undefined,
  opts: PrinciplesOptions
): void {
  const valid =
    key === 'compat' ? ['preserve', 'remove'] : ['greenfield', 'production'];
  if (!value || !valid.includes(value)) {
    console.log(chalk.red(`Usage: uap principles ${key} <${valid.join('|')}>`));
    process.exitCode = 1;
    return;
  }

  recordStance(cwd, { [key]: value } as { compat?: CompatStance; maturity?: Maturity });
  if (opts.save) {
    modifyUapConfig(cwd, (config: Record<string, unknown>) => {
      const principles = (config.principles ?? {}) as Record<string, unknown>;
      config.principles = { ...principles, [key]: value };
      return config;
    });
  }

  console.log(
    chalk.green(`✓ ${key} = ${value}`) +
      chalk.dim(opts.save ? ' (session + project default)' : ' (this session)')
  );
}

function show(cwd: string): void {
  const { compat, maturity, assumed } = stanceForUnattended(resolveStance(cwd));

  console.log(chalk.bold('\nFull (policy / CLAUDE.md):\n'));
  console.log(renderFull({ compat, maturity }));

  console.log(chalk.bold('\n\nCompact (injected into deliver prompts):\n'));
  console.log(renderCompact({ compat, maturity, assumed }));
  console.log('');
}

export async function principlesCommand(
  subcommand: Subcommand | undefined,
  value: string | undefined,
  options: PrinciplesOptions = {}
): Promise<void> {
  const cwd = options.projectDir || process.cwd();

  switch (subcommand) {
    case 'ask':
      await ask(cwd, options);
      return;
    case 'compat':
      setValue(cwd, 'compat', value, options);
      return;
    case 'maturity':
      setValue(cwd, 'maturity', value, options);
      return;
    case 'show':
      show(cwd);
      return;
    case 'status':
    case undefined:
      printStatus(cwd, options.json);
      return;
    default:
      console.log(chalk.red(`Unknown subcommand: ${subcommand}`));
      console.log(chalk.dim('Usage: uap principles [status|ask|compat|maturity|show]'));
      process.exitCode = 1;
  }
}

export default principlesCommand;
