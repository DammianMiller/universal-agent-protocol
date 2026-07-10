/**
 * `uap config wizard` — the interactive expert configurator (a.k.a.
 * `uap setup --profile custom`). Walks every setting category with its
 * description + recommendation, writes choices via the shared apply path, then
 * offers scenario-based policy selection.
 *
 * Non-TTY safe: with no interactive terminal it prints how to configure headless
 * (`uap config set` / `uap policy install`) and returns without prompting.
 */

import chalk from 'chalk';
import { spawnSync } from 'child_process';

import {
  CATEGORIES,
  settingsByCategory,
  type SettingCategoryId,
} from '../config/settings-registry.js';
import { CORE, SCENARIOS, recommendedFor } from '../config/policy-recommendations.js';
import { applySetting, currentValue } from './config-command.js';
import { createClackUI } from './prompt-ui.js';

function toBool(v: unknown): boolean {
  if (typeof v === 'boolean') return v;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}

function nonInteractiveGuidance(): void {
  console.log(chalk.bold('\nUAP expert configuration (non-interactive)\n'));
  console.log('No interactive terminal detected. Configure headless with:');
  console.log('  ' + chalk.cyan('uap config list') + '                 # every setting + current value');
  console.log('  ' + chalk.cyan('uap config explain <key>') + '        # learn one setting');
  console.log('  ' + chalk.cyan('uap config set <key> <value>') + '    # change it');
  console.log('  ' + chalk.cyan('uap config doctor') + '               # flag risky settings');
  console.log('  ' + chalk.cyan('uap policy recommend <scenario>') + ' # recommended policies for your workflow');
  console.log('');
}

export async function runConfigWizard(
  cwd: string,
  opts: { policies?: boolean } = {}
): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    nonInteractiveGuidance();
    return;
  }

  const ui = await createClackUI();
  ui.intro('UAP expert configuration — tune every setting for your environment');

  const catOptions = CATEGORIES.filter((c) => settingsByCategory(c.id).length > 0).map((c) => ({
    value: c.id,
    label: c.title,
    hint: c.blurb,
  }));

  const chosen = await ui.multiselect<SettingCategoryId>({
    message: 'Which areas do you want to configure? (space to select, enter to confirm)',
    options: catOptions,
    initialValues: [],
    required: false,
  });

  const applied: string[] = [];

  for (const catId of chosen) {
    const cat = CATEGORIES.find((c) => c.id === catId)!;
    ui.note(cat.blurb, cat.title);
    for (const s of settingsByCategory(catId)) {
      const cur = currentValue(cwd, s).value;
      const prompt = `${s.key}\n${chalk.dim(s.description)}\n${chalk.dim('Recommended: ' + s.recommendation)}`;
      let raw: string | null = null;

      if (s.type === 'boolean') {
        const val = await ui.confirm({ message: prompt, initialValue: toBool(cur) });
        // Unchanged → leave as-is (don't materialize a default into the config).
        raw = val === toBool(cur) ? null : val ? 'true' : 'false';
      } else if (s.type === 'enum') {
        const val = await ui.select<string>({
          message: prompt,
          options: (s.enumValues ?? []).map((v) => ({ value: v, label: v })),
          initialValue: cur != null ? String(cur) : undefined,
        });
        raw = cur != null && val === String(cur) ? null : val;
      } else {
        const val = await ui.text({
          message: prompt,
          placeholder: cur != null ? String(cur) : '',
          initialValue: cur != null ? String(cur) : '',
        });
        // Blank or unchanged → leave as-is.
        raw = val.trim() === '' || val === String(cur) ? null : val.trim();
      }

      if (raw !== null) {
        const res = applySetting(cwd, s, raw);
        applied.push(res.message);
      }
    }
  }

  if (opts.policies !== false) {
    await runPolicyStep(cwd, ui);
  }

  if (applied.length) {
    ui.note(applied.join('\n'), `Applied ${applied.length} setting change(s)`);
  }
  ui.outro(
    'Done. Review with `uap config list`, sanity-check with `uap config doctor`, and restart the proxy if you changed proxy settings.'
  );
}

async function runPolicyStep(cwd: string, ui: Awaited<ReturnType<typeof createClackUI>>): Promise<void> {
  const scenario = await ui.select<string>({
    message: 'Recommend policies for which kind of work?',
    options: [
      ...SCENARIOS.map((sc) => ({ value: sc.id, label: sc.title, hint: sc.blurb })),
      { value: '__skip__', label: 'Skip policy selection', hint: 'keep current policies' },
    ],
    initialValue: 'solo-local',
  });
  if (scenario === '__skip__') return;

  const recs = recommendedFor(scenario);
  const coreSlugs = new Set(CORE.map((c) => c.slug));
  const picks = await ui.multiselect<string>({
    message: 'Install these recommended policies? (core policies pre-selected)',
    options: recs.map((r) => ({
      value: r.slug,
      label: `${r.slug}${coreSlugs.has(r.slug) ? ' (core)' : ''}`,
      hint: r.why,
    })),
    initialValues: recs.map((r) => r.slug),
    required: false,
  });

  if (!picks.length) return;
  const cli = process.argv[1]; // the running cli.js
  const installed: string[] = [];
  const failed: string[] = [];
  for (const slug of picks) {
    const r = spawnSync(process.execPath, [cli, 'policy', 'install', slug], { cwd, encoding: 'utf-8' });
    if (r.status === 0) installed.push(slug);
    else failed.push(slug);
  }
  const lines = [
    installed.length ? chalk.green(`✓ installed: ${installed.join(', ')}`) : '',
    failed.length ? chalk.yellow(`⚠ could not install: ${failed.join(', ')} (try: uap policy install <slug>)`) : '',
  ].filter(Boolean);
  ui.note(lines.join('\n'), 'Policies');
}
