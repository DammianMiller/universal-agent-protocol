/**
 * `uap config` — inspect, learn, and set every UAP setting from one place.
 *
 * Driven entirely by the settings registry (src/config/settings-registry.ts):
 *   list     — every setting, grouped by category, with current value + recommendation
 *   get      — the current effective value of one setting
 *   set      — write a setting (.uap.json for json-kind, .uap/proxy.env for
 *              proxyEnv-kind; shell-kind prints the export line to add)
 *   explain  — what a setting does + how to pick a value + how to set it
 *   doctor   — flag risky / sub-optimal / inconsistent settings for this project
 */

import type { Command } from 'commander';
import chalk from 'chalk';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

import {
  CATEGORIES,
  SETTINGS,
  findSettings,
  getSetting,
  settingsByCategory,
  type SettingDef,
  type SettingKind,
} from '../config/settings-registry.js';
import { findUapConfigPath, loadUapConfigRaw, modifyUapConfig } from '../utils/config-loader.js';

// ── dotted-path helpers over the raw config object ──────────────────────────

function getPath(obj: Record<string, unknown> | null, path: string): unknown {
  if (!obj) return undefined;
  let cur: unknown = obj;
  for (const part of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function setPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  // Defense-in-depth: never walk into prototype chains (paths are registry
  // constants today, but keep this a hard invariant).
  if (parts.some((p) => p === '__proto__' || p === 'constructor' || p === 'prototype')) return;
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (cur[p] == null || typeof cur[p] !== 'object') cur[p] = {};
    cur = cur[p] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]] = value;
}

// ── .uap/proxy.env single-key upsert ────────────────────────────────────────

function proxyEnvPath(cwd: string): string {
  const cfg = findUapConfigPath(cwd);
  const root = cfg ? dirname(cfg) : cwd;
  return join(root, '.uap', 'proxy.env');
}

function readProxyEnv(cwd: string): Map<string, string> {
  const p = proxyEnvPath(cwd);
  const map = new Map<string, string>();
  if (!existsSync(p)) return map;
  for (const line of readFileSync(p, 'utf-8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m) map.set(m[1], m[2]);
  }
  return map;
}

function upsertProxyEnv(cwd: string, key: string, value: string, secret: boolean): string {
  const p = proxyEnvPath(cwd);
  mkdirSync(dirname(p), { recursive: true });
  const lines = existsSync(p) ? readFileSync(p, 'utf-8').split('\n') : [];
  // Drop trailing blank lines so we append cleanly (no spurious gaps).
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  // Anchored, key-only match (keys are registry identifiers, so no regex-escape needed).
  const idx = lines.findIndex((l) => l.startsWith(`${key}=`));
  if (idx >= 0) lines[idx] = `${key}=${value}`;
  else lines.push(`${key}=${value}`);
  writeFileSync(p, lines.join('\n') + '\n');
  if (secret) {
    try {
      chmodSync(p, 0o600);
    } catch {
      /* best-effort */
    }
  }
  return p;
}

// ── value read / coerce ─────────────────────────────────────────────────────

/** The current effective value of a setting (or its default), and where it came from. */
export function currentValue(cwd: string, s: SettingDef): { value: unknown; source: string } {
  if (s.kind === 'json') {
    const raw = loadUapConfigRaw(cwd);
    const v = getPath(raw, s.key);
    return v === undefined ? { value: s.default, source: 'default' } : { value: v, source: '.uap.json' };
  }
  // env kinds
  if (process.env[s.key] !== undefined) return { value: process.env[s.key], source: 'env' };
  if (s.target === 'proxyEnv') {
    const v = readProxyEnv(cwd).get(s.key);
    if (v !== undefined) return { value: v, source: '.uap/proxy.env' };
  }
  return { value: s.default, source: 'default' };
}

function coerce(s: SettingDef, input: string): { ok: true; value: string | number | boolean } | { ok: false; error: string } {
  // A newline would inject an extra line into .uap/proxy.env (a second, unintended
  // env var) or corrupt the file — reject it for every setting.
  if (/[\r\n]/.test(input)) return { ok: false, error: 'value must not contain a newline' };

  if (s.type === 'boolean') {
    const t = input.toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(t)) return { ok: true, value: s.kind === 'env' ? '1' : true };
    if (['false', '0', 'no', 'off'].includes(t)) return { ok: true, value: s.kind === 'env' ? '0' : false };
    return { ok: false, error: `expected a boolean (true/false), got "${input}"` };
  }
  if (s.type === 'number') {
    const n = Number(input);
    if (!Number.isFinite(n)) return { ok: false, error: `expected a number, got "${input}"` };
    if (s.int && !Number.isInteger(n)) return { ok: false, error: `expected an integer, got "${input}"` };
    // Bounds mirror the .uap.json zod constraints — an out-of-range write would
    // make strict config parse throw and silently reset the whole config.
    if (s.min != null && n < s.min) return { ok: false, error: `must be >= ${s.min}, got ${n}` };
    if (s.max != null && n > s.max) return { ok: false, error: `must be <= ${s.max}, got ${n}` };
    return { ok: true, value: s.kind === 'env' ? String(n) : n };
  }
  if (s.type === 'enum') {
    if (!s.enumValues?.includes(input)) {
      return { ok: false, error: `expected one of ${s.enumValues?.join(' | ')}, got "${input}"` };
    }
    return { ok: true, value: input };
  }
  return { ok: true, value: input };
}

function fmt(v: unknown): string {
  if (v === null || v === undefined) return chalk.dim('(unset)');
  if (typeof v === 'boolean') return v ? chalk.green('true') : chalk.red('false');
  return String(v);
}

function fmtSecret(s: SettingDef, v: unknown): string {
  if (s.secret && v && v !== s.default) return chalk.dim('••••••• (set)');
  return fmt(v);
}

// ── subcommand implementations ──────────────────────────────────────────────

export interface SettingJson {
  key: string;
  kind: SettingKind;
  type: string;
  category: string;
  default: string | number | boolean | null;
  current: unknown;
  source: string;
  secret: boolean;
  /** For secrets: whether a value is set (the value itself is never emitted). */
  isSet?: boolean;
}

/** Machine-readable view of the settings, with secret VALUES masked to null. */
export function listSettingsJson(cwd: string, categoryFilter?: string): SettingJson[] {
  return SETTINGS.filter((s) => !categoryFilter || s.category === categoryFilter).map((s) => {
    const { value, source } = currentValue(cwd, s);
    const isSet = value != null && value !== s.default;
    // Never emit a secret's value in machine output (it lands in logs/CI).
    const current = s.secret && isSet ? null : value;
    return {
      key: s.key,
      kind: s.kind,
      type: s.type,
      category: s.category,
      default: s.default,
      current,
      source,
      secret: !!s.secret,
      ...(s.secret ? { isSet } : {}),
    };
  });
}

function doList(cwd: string, opts: { category?: string; json?: boolean }): void {
  const cats = opts.category
    ? CATEGORIES.filter((c) => c.id === opts.category)
    : CATEGORIES;
  if (opts.category && cats.length === 0) {
    console.error(chalk.red(`Unknown category '${opts.category}'. Categories: ${CATEGORIES.map((c) => c.id).join(', ')}`));
    process.exitCode = 2;
    return;
  }

  if (opts.json) {
    console.log(JSON.stringify(listSettingsJson(cwd, opts.category), null, 2));
    return;
  }

  console.log(chalk.bold('\nUAP settings') + chalk.dim('  —  uap config explain <key> to learn one; uap config set <key> <value> to change\n'));
  for (const cat of cats) {
    const items = settingsByCategory(cat.id);
    if (!items.length) continue;
    console.log(chalk.bold.cyan(`▌ ${cat.title}`) + chalk.dim(`  ${cat.blurb}`));
    for (const s of items) {
      const { value, source } = currentValue(cwd, s);
      const tag = s.kind === 'env' ? chalk.dim(s.target === 'proxyEnv' ? '[proxy.env]' : '[env]') : '';
      const val = fmtSecret(s, value);
      const src = source === 'default' ? '' : chalk.dim(` ← ${source}`);
      console.log(`  ${chalk.yellow(s.key)} ${tag}`);
      console.log(`      ${val}${src}   ${chalk.dim('default:')} ${fmt(s.default)}`);
      console.log(`      ${chalk.dim(s.recommendation)}`);
    }
    console.log('');
  }
}

function resolveOne(key: string): SettingDef | null {
  const exact = getSetting(key);
  if (exact) return exact;
  const matches = findSettings(key);
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) {
    console.error(chalk.red(`No setting matches '${key}'. Try: uap config list`));
  } else {
    console.error(chalk.red(`'${key}' is ambiguous — did you mean:`));
    for (const m of matches.slice(0, 8)) console.error(`  ${m.key}`);
  }
  return null;
}

function doGet(cwd: string, key: string): void {
  const s = resolveOne(key);
  if (!s) {
    process.exitCode = 2;
    return;
  }
  const { value, source } = currentValue(cwd, s);
  console.log(`${chalk.yellow(s.key)} = ${fmtSecret(s, value)} ${chalk.dim(`(${source})`)}`);
}

function doExplain(cwd: string, key: string): void {
  const s = resolveOne(key);
  if (!s) {
    process.exitCode = 2;
    return;
  }
  const { value, source } = currentValue(cwd, s);
  const cat = CATEGORIES.find((c) => c.id === s.category);
  console.log('');
  console.log(chalk.bold.yellow(s.key) + '  ' + chalk.dim(`(${cat?.title ?? s.category})`));
  console.log('');
  console.log(chalk.bold('What it does'));
  console.log('  ' + s.description);
  console.log('');
  console.log(chalk.bold('Recommendation'));
  console.log('  ' + s.recommendation);
  console.log('');
  console.log(chalk.bold('Current') + `   ${fmtSecret(s, value)} ${chalk.dim(`(${source})`)}   ${chalk.dim('default:')} ${fmt(s.default)}`);
  const type = s.type === 'enum' ? `enum: ${s.enumValues?.join(' | ')}` : s.type;
  console.log(chalk.bold('Type') + `      ${type}`);
  const where =
    s.kind === 'json'
      ? '.uap.json → ' + s.key
      : s.target === 'proxyEnv'
        ? '.uap/proxy.env (proxy)'
        : 'shell environment (' + s.key + ')';
  console.log(chalk.bold('Set via') + `   uap config set ${s.key} <value>   ${chalk.dim('→ ' + where)}`);
  console.log('');
}

export interface ApplyResult {
  ok: boolean;
  /** Human-readable confirmation or error, already styled. */
  message: string;
}

/**
 * Validate and persist a single setting. Shared by `uap config set` and the
 * interactive wizard so both paths behave identically.
 */
export function applySetting(cwd: string, s: SettingDef, rawValue: string): ApplyResult {
  const coerced = coerce(s, rawValue);
  if (!coerced.ok) {
    return { ok: false, message: chalk.red(`Invalid value for ${s.key}: ${coerced.error}`) };
  }
  const value = coerced.value;

  if (s.kind === 'json') {
    if (s.secret) {
      return { ok: false, message: chalk.red(`${s.key} is a secret and must not be stored in .uap.json.`) };
    }
    modifyUapConfig(cwd, (cfg) => {
      setPath(cfg, s.key, value);
      return cfg;
    });
    return { ok: true, message: chalk.green('✓') + ` ${s.key} = ${fmt(value)}  ${chalk.dim('→ .uap.json')}` };
  }

  if (s.target === 'proxyEnv') {
    const p = upsertProxyEnv(cwd, s.key, String(value), !!s.secret);
    return {
      ok: true,
      message: chalk.green('✓') + ` ${s.key} = ${fmtSecret(s, value)}  ${chalk.dim('→ ' + p)}\n  ${chalk.dim('Restart the proxy to apply: uap proxy restart')}`,
    };
  }

  // shell-kind: no file the hooks/CLI source, so guide the user.
  const line = `export ${s.key}=${String(value)}`;
  const note = s.secret ? '\n  ' + chalk.dim('(secret — keep it out of version control)') : '';
  return {
    ok: true,
    message:
      chalk.yellow(`${s.key} is a runtime (shell) setting — add this to your shell profile or the agent's launch env:`) +
      '\n  ' + chalk.bold(line) + note,
  };
}

function doSet(cwd: string, key: string, rawValue: string): void {
  const s = resolveOne(key);
  if (!s) {
    process.exitCode = 2;
    return;
  }
  const res = applySetting(cwd, s, rawValue);
  console.log(res.message);
  if (!res.ok) process.exitCode = 2;
}

function doDoctor(cwd: string): void {
  const raw = loadUapConfigRaw(cwd);
  type Finding = { level: 'warn' | 'info' | 'ok'; msg: string; fix?: string };
  const findings: Finding[] = [];

  const val = (key: string) => currentValue(cwd, getSetting(key)!).value;

  // Enforcement disabled
  if (val('delivery.enforcement') === 'off') {
    findings.push({ level: 'warn', msg: 'delivery.enforcement is off — direct source edits are ungated and unverified.', fix: 'uap config set delivery.enforcement block' });
  }
  // Leaked advisory env
  const envEnforce = process.env.UAP_ENFORCE_DELIVERY;
  if (envEnforce && envEnforce !== 'block') {
    findings.push({ level: 'warn', msg: `UAP_ENFORCE_DELIVERY=${envEnforce} is exported in your shell — it overrides delivery.enforcement everywhere and can break the delivery-enforcement tests + version bumps.`, fix: 'unset UAP_ENFORCE_DELIVERY  (and remove it from your shell profile)' });
  }
  // Long-term memory off
  if (val('memory.longTerm.enabled') === false) {
    findings.push({ level: 'info', msg: 'Long-term memory is off — no cross-session recall.', fix: 'uap config set memory.longTerm.enabled true' });
  }
  // Reactor off
  if (val('reactor.enabled') === false) {
    findings.push({ level: 'info', msg: 'Reactor is off — experts/skills/patterns are not auto-injected per prompt.' });
  }
  // Design token gate without design enabled
  if (val('design.tokenGate') === true && val('design.enabled') === false) {
    findings.push({ level: 'warn', msg: 'design.tokenGate is on but design.enabled is off — the token gate needs a DESIGN.md.', fix: 'uap config set design.enabled true' });
  }
  // Secrets in .uap.json
  const secretPaths = ['recipes.judge.apiKey', 'memory.longTerm.qdrantCloud.apiKey', 'memory.longTerm.github.token'];
  for (const sp of secretPaths) {
    if (getPath(raw, sp) != null) {
      findings.push({ level: 'warn', msg: `A secret is stored in .uap.json (${sp}) — move it to .uap/proxy.env or your shell env.` });
    }
  }
  // Multi-model without slot budget
  if (val('multiModel.enabled') === true && val('modelConcurrency.slots') == null) {
    findings.push({ level: 'info', msg: 'Multi-model routing is on but modelConcurrency.slots is unset — parallel agents may exhaust the local server.', fix: 'uap config set modelConcurrency.slots <your llama.cpp --parallel>' });
  }

  console.log(chalk.bold('\nUAP config doctor\n'));
  if (findings.length === 0) {
    console.log(chalk.green('✓ No issues found — your configuration looks healthy.\n'));
    return;
  }
  for (const f of findings) {
    const icon = f.level === 'warn' ? chalk.yellow('⚠') : chalk.cyan('ℹ');
    console.log(`${icon} ${f.msg}`);
    if (f.fix) console.log(`  ${chalk.dim('fix:')} ${chalk.bold(f.fix)}`);
  }
  console.log('');
  if (findings.some((f) => f.level === 'warn')) process.exitCode = 1;
}

/**
 * Render the whole registry as the CONFIGURATION_REFERENCE.md doc, so the docs
 * are generated from the same source of truth as the CLI and can never drift.
 */
export function renderReferenceMarkdown(): string {
  const out: string[] = [];
  out.push('# UAP Configuration Reference');
  out.push('');
  out.push('> **Generated from the settings registry** (`src/config/settings-registry.ts`) via `uap config docs`. Do not edit by hand — change the registry and regenerate.');
  out.push('');
  out.push('Every UAP setting, what it does, its default, and a recommendation. Inspect and change any of these with **`uap config`**:');
  out.push('');
  out.push('```bash');
  out.push('uap config list                 # all settings + current values');
  out.push('uap config explain <key>        # learn one setting');
  out.push('uap config set <key> <value>    # change it (.uap.json / .uap/proxy.env)');
  out.push('uap config doctor               # flag risky / sub-optimal settings');
  out.push('uap config wizard               # interactive expert configurator (also: uap setup --profile custom)');
  out.push('```');
  out.push('');
  out.push('**Where each setting lives:** `json` settings persist to `.uap.json`; `proxy.env` settings persist to `.uap/proxy.env` (loaded by the inference proxy); `shell` settings are runtime environment variables read by the hooks/CLI.');
  out.push('');
  out.push('## Categories');
  out.push('');
  for (const cat of CATEGORIES) {
    if (!settingsByCategory(cat.id).length) continue;
    out.push(`- [${cat.title}](#${cat.id}) — ${cat.blurb}`);
  }
  out.push('');
  for (const cat of CATEGORIES) {
    const items = settingsByCategory(cat.id);
    if (!items.length) continue;
    out.push(`## ${cat.title}`);
    out.push('');
    out.push(`<a id="${cat.id}"></a>${cat.blurb}`);
    out.push('');
    for (const s of items) {
      const where = s.kind === 'json' ? '`.uap.json`' : s.target === 'proxyEnv' ? '`.uap/proxy.env`' : 'shell env';
      const type = s.type === 'enum' ? `enum (${s.enumValues?.join(' \\| ')})` : s.type;
      out.push(`### \`${s.key}\``);
      out.push('');
      out.push(`| | |`);
      out.push(`|---|---|`);
      out.push(`| **Where** | ${where} |`);
      out.push(`| **Type** | ${type} |`);
      out.push(`| **Default** | \`${String(s.default)}\` |`);
      if (s.secret) out.push(`| **Secret** | yes — never store in \`.uap.json\` |`);
      out.push('');
      out.push(s.description);
      out.push('');
      out.push(`**Recommendation:** ${s.recommendation}`);
      out.push('');
    }
  }
  out.push('---');
  out.push('');
  out.push('*Not every environment variable UAP reads is a first-class setting — the inference proxy alone exposes ~130 `PROXY_*` tuning knobs. The registry surfaces the high-impact, commonly-tuned ones; see the proxy source (`tools/agents/scripts/anthropic_proxy.py`) for the full set.*');
  out.push('');
  return out.join('\n');
}

// ── registration ────────────────────────────────────────────────────────────

export function registerConfigCommands(program: Command): void {
  const cwd = () => process.cwd();
  const config = program
    .command('config')
    .description('Inspect, learn, and set every UAP setting (list | get | set | explain | doctor)');

  config
    .command('list')
    .description('List all settings with current values and recommendations')
    .option('-c, --category <id>', 'Only show one category')
    .option('--json', 'Machine-readable output')
    .action((opts: { category?: string; json?: boolean }) => doList(cwd(), opts));

  config
    .command('get <key>')
    .description('Show the current effective value of a setting')
    .action((key: string) => doGet(cwd(), key));

  config
    .command('set <key> <value>')
    .description('Set a setting (writes .uap.json or .uap/proxy.env; shell vars print an export line)')
    .action((key: string, value: string) => doSet(cwd(), key, value));

  config
    .command('explain <key>')
    .description('Explain what a setting does, how to pick a value, and how to set it')
    .action((key: string) => doExplain(cwd(), key));

  config
    .command('doctor')
    .description('Flag risky, sub-optimal, or inconsistent settings for this project')
    .action(() => doDoctor(cwd()));

  config
    .command('wizard')
    .description('Interactive expert configurator — walk every setting with explanations + recommendations')
    .option('--no-policies', 'Skip the policy-selection step')
    .action(async (opts: { policies?: boolean }) => {
      const { runConfigWizard } = await import('./config-wizard.js');
      await runConfigWizard(cwd(), { policies: opts.policies !== false });
    });

  config
    .command('docs')
    .description('Regenerate docs/reference/CONFIGURATION_REFERENCE.md from the registry')
    .option('-o, --out <path>', 'Output path', 'docs/reference/CONFIGURATION_REFERENCE.md')
    .action((opts: { out: string }) => {
      const md = renderReferenceMarkdown();
      const outPath = join(cwd(), opts.out);
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, md);
      console.log(chalk.green('✓') + ` wrote ${opts.out} (${SETTINGS.length} settings)`);
    });
}
