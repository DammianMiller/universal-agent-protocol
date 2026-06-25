/**
 * `uap design` — DESIGN.md integration.
 *
 *   interrogate   reverse-engineer a DESIGN.md from existing UI code
 *   sync          regenerate .uap/design-tokens.json from DESIGN.md (gate source)
 *   lint          validate DESIGN.md via the OSS @google/design.md CLI
 *   diff          compare two DESIGN.md files via @google/design.md
 *   context       print the reactor guidance summary (UI work injection)
 *   check         scan a file's content for off-token colors/spacing (gate parity)
 *
 * Validation/diff reuse Google's OSS CLI (no re-implementation). Interrogation
 * and the token gate are net-new.
 */
import chalk from 'chalk';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join, isAbsolute } from 'path';
import { spawnSync } from 'child_process';
import { interrogate, renderDesignMd } from '../design/interrogate.js';
import {
  loadDesign,
  parseDesignMd,
  buildAllowList,
  writeAllowList,
  findDesignFile,
  summarizeForReactor,
  allowListPath,
} from '../design/tokens.js';
import { scanOffToken, formatGateMessage } from '../design/gate.js';

export interface DesignOptions {
  projectDir?: string;
  out?: string;
  force?: boolean;
  json?: boolean;
  file?: string;
}

function resolveDir(o: DesignOptions): string {
  return o.projectDir || process.cwd();
}

/** Run the OSS @google/design.md CLI; returns {ok, stdout}. */
function runGoogleCli(args: string[]): { ok: boolean; stdout: string; stderr: string; missing: boolean } {
  const r = spawnSync('npx', ['--yes', '@google/design.md', ...args], { encoding: 'utf-8', timeout: 120_000 });
  const stderr = r.stderr || '';
  const missing = r.status === null || /not found|could not determine|E404/i.test(stderr);
  return { ok: r.status === 0, stdout: r.stdout || '', stderr, missing };
}

export async function designCommand(sub: string | undefined, options: DesignOptions): Promise<void> {
  const dir = resolveDir(options);
  switch (sub) {
    case 'interrogate':
      return interrogateCmd(dir, options);
    case 'sync':
      return syncCmd(dir, options);
    case 'lint':
      return lintCmd(dir, options);
    case 'diff':
      return diffCmd(options);
    case 'context':
      return contextCmd(dir);
    case 'check':
      return checkCmd(dir, options);
    default:
      console.log(chalk.bold('uap design — DESIGN.md integration\n'));
      console.log('  interrogate   Generate DESIGN.md from existing UI code');
      console.log('  sync          Regenerate .uap/design-tokens.json (gate source)');
      console.log('  lint [file]   Validate DESIGN.md (uses @google/design.md)');
      console.log('  diff a b      Compare two DESIGN.md files');
      console.log('  context       Print the reactor guidance summary');
      console.log('  check --file  Scan a file for off-token colors/spacing');
  }
}

function interrogateCmd(dir: string, options: DesignOptions): void {
  const outPath = options.out
    ? isAbsolute(options.out) ? options.out : join(dir, options.out)
    : join(dir, 'DESIGN.md');

  const existing = findDesignFile(dir);
  if (existing && !options.force && (!options.out || existsSync(outPath))) {
    console.log(chalk.yellow(`  DESIGN.md already exists (${existing}). Use --force to overwrite, or edit it directly.`));
    // Still (re)generate the allow-list so the gate is in sync.
    syncCmd(dir, options);
    return;
  }

  console.log(chalk.dim('  Scanning UI sources…'));
  const result = interrogate(dir);
  if (result.stats.source === 'none') {
    console.log(chalk.yellow('  No UI design signals found (no colors/fonts/spacing in CSS/Tailwind/components).'));
    return;
  }
  const md = renderDesignMd(result);
  writeFileSync(outPath, md);
  console.log(chalk.green(`  ✓ Wrote ${outPath}`));
  console.log(
    chalk.dim(
      `    scanned ${result.stats.filesScanned} files · source: ${result.stats.source} · ` +
        `${result.stats.colorsFound} colors, ${result.stats.fontsFound} fonts, ${result.stats.spacingFound} spacings`
    )
  );

  // Generate the gate allow-list from the freshly written file.
  const parsed = parseDesignMd(md);
  const allow = buildAllowList(parsed, outPath, dir);
  const ap = writeAllowList(dir, allow);
  console.log(chalk.green(`  ✓ Wrote ${ap} (${allow.colors.length} colors, ${allow.spacing.length} spacings)`));
  console.log(chalk.dim('\n  Next: refine the prose + token roles, then `uap design lint`.'));
}

function syncCmd(dir: string, options: DesignOptions): void {
  const loaded = loadDesign(dir);
  if (!loaded) {
    console.log(chalk.yellow('  No DESIGN.md found. Run `uap design interrogate` first.'));
    return;
  }
  const allow = buildAllowList(loaded.parsed, loaded.path, dir);
  const ap = writeAllowList(dir, allow);
  if (!options.json) {
    console.log(chalk.green(`  ✓ Synced ${ap}`));
    console.log(chalk.dim(`    ${allow.colors.length} colors · ${allow.spacing.length} spacing · ${allow.radii.length} radii`));
  } else {
    console.log(JSON.stringify(allow, null, 2));
  }
}

function lintCmd(dir: string, options: DesignOptions): void {
  const file = options.file || findDesignFile(dir);
  if (!file || !existsSync(file)) {
    console.log(chalk.yellow('  No DESIGN.md to lint. Run `uap design interrogate` first.'));
    process.exitCode = 1;
    return;
  }
  const res = runGoogleCli(['lint', file, '--json']);
  if (res.missing) {
    console.log(chalk.yellow('  @google/design.md CLI unavailable (offline / npx blocked). Skipping spec lint.'));
    console.log(chalk.dim('  Install/online: npx @google/design.md lint ' + file));
    return;
  }
  if (options.json) {
    process.stdout.write(res.stdout);
    return;
  }
  try {
    const parsed = JSON.parse(res.stdout);
    const s = parsed.summary || {};
    console.log(chalk.bold(`\n  DESIGN.md lint: ${file}`));
    for (const f of parsed.findings ?? []) {
      const icon = f.severity === 'error' ? chalk.red('✗') : f.severity === 'warning' ? chalk.yellow('⚠') : chalk.dim('ℹ');
      console.log(`  ${icon} ${chalk.dim(f.path || '')} ${f.message}`);
    }
    console.log(`\n  ${s.errors ?? 0} errors · ${s.warnings ?? 0} warnings · ${s.info ?? 0} info\n`);
    if ((s.errors ?? 0) > 0) process.exitCode = 1;
  } catch {
    process.stdout.write(res.stdout || res.stderr);
  }
}

function diffCmd(options: DesignOptions): void {
  const [a, b] = (options.file || '').split(',');
  if (!a || !b) {
    console.log(chalk.yellow('  Usage: uap design diff --file <old>,<new>'));
    process.exitCode = 1;
    return;
  }
  const res = runGoogleCli(['diff', a, b]);
  if (res.missing) {
    console.log(chalk.yellow('  @google/design.md CLI unavailable (offline). Skipping diff.'));
    return;
  }
  process.stdout.write(res.stdout || res.stderr);
}

function contextCmd(dir: string): void {
  const loaded = loadDesign(dir);
  if (!loaded) {
    console.log(chalk.yellow('  No DESIGN.md found.'));
    return;
  }
  console.log(summarizeForReactor(loaded.parsed));
}

function checkCmd(dir: string, options: DesignOptions): void {
  if (!options.file) {
    console.log(chalk.yellow('  Usage: uap design check --file <path> [content on stdin]'));
    process.exitCode = 1;
    return;
  }
  const ap = allowListPath(dir);
  if (!existsSync(ap)) {
    console.log(chalk.dim('  No .uap/design-tokens.json — gate inactive (run `uap design sync`).'));
    return;
  }
  const allow = JSON.parse(readFileSync(ap, 'utf-8'));
  let content = '';
  if (!process.stdin.isTTY) {
    try {
      content = readFileSync(0, 'utf-8');
    } catch {
      /* empty */
    }
  }
  if (!content && existsSync(options.file)) content = readFileSync(options.file, 'utf-8');

  const findings = scanOffToken(content, options.file, allow);
  if (findings.length === 0) {
    console.log(chalk.green('  ✓ on-token'));
    return;
  }
  console.log(chalk.red(formatGateMessage(findings, allow)));
  process.exitCode = 2;
}
