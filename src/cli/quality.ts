/**
 * `uap quality` — quality-metrics gate.
 *
 *   init       write .uap/quality-metrics.json with the default thresholds
 *   check      scan files for metric violations; ratchet against the baseline
 *   baseline   regenerate .uap/quality-baseline.json (--update)
 *   report     full report including grandfathered violations and skips
 *   mutate     Stryker incremental mutation run scoped to changed files
 *
 * Gate parity: the Python proxy enforcer `quality_metrics_gate.py` mirrors the fast
 * path (LOC, complexity, any-types) so agent edits are blocked pre-exec with
 * the same thresholds and baseline this CLI enforces at commit/CI time.
 */
import chalk from 'chalk';
import { existsSync, readFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { isAbsolute, relative } from 'path';
import {
  QualityConfig, configPath, defaultConfig, loadQualityConfig, writeDefaultConfig,
} from '../quality/config.js';
import { baselinePath, loadBaseline, writeBaseline } from '../quality/baseline.js';
import { buildReport, changedFiles, QualityReport } from '../quality/report.js';
import { scanContent } from '../quality/scanner.js';

export interface QualityOptions {
  projectDir?: string;
  json?: boolean;
  files?: string;
  staged?: boolean;
  update?: boolean;
  changed?: boolean;
  file?: string;
}

function resolveDir(o: QualityOptions): string {
  return o.projectDir || process.cwd();
}

export async function qualityCommand(sub: string | undefined, options: QualityOptions): Promise<void> {
  const dir = resolveDir(options);
  switch (sub) {
    case 'init':
      return initCmd(dir);
    case 'check':
      return checkCmd(dir, options);
    case 'baseline':
      return baselineCmd(dir, options);
    case 'report':
      return reportCmd(dir, options);
    case 'mutate':
      return mutateCmd(dir, options);
    default:
      console.log(chalk.bold('uap quality — quality-metrics gate\n'));
      console.log('  init                Write .uap/quality-metrics.json (activates the gate)');
      console.log('  check               Scan + ratchet; exit 2 on blocking violations');
      console.log('  check --staged      Scan only files changed vs upstream base');
      console.log('  check --file <f>    Scan one file (content may come from stdin)');
      console.log('  baseline --update   Regenerate .uap/quality-baseline.json (ratchet)');
      console.log('  report              Verbose report incl. grandfathered + skipped');
      console.log('  mutate --changed    Stryker incremental on changed files');
  }
}

function initCmd(dir: string): void {
  const p = configPath(dir);
  if (existsSync(p)) {
    console.log(chalk.yellow(`  ${p} already exists — edit it directly to change thresholds.`));
    return;
  }
  writeDefaultConfig(dir);
  console.log(chalk.green(`  ✓ Wrote ${p}`));
  const t = defaultConfig().thresholds;
  console.log(chalk.dim(`    cyclomatic<${t.maxCyclomatic} · cognitive<${t.maxCognitive} · halstead<${t.maxHalsteadDifficulty}` +
    ` · LOC/file<${t.maxLocPerFile} · coverage≥${t.minCoveragePct}% · CRAP<${t.maxCrap}`));
  console.log(chalk.dim(`    mutants=${t.maxSurvivingMutants} · duplicates=${t.maxDuplicateBlocks} · deadCode=${t.maxDeadCode} · any=${t.maxAnyTypes}`));
  console.log(chalk.dim('\n  Next: `uap quality baseline --update` to freeze current debt, then `uap quality check`.'));
}

function fileList(dir: string, config: QualityConfig, options: QualityOptions): string[] | undefined {
  if (options.file) return [options.file];
  if (options.files) return options.files.split(',').map((f) => f.trim()).filter(Boolean);
  if (options.staged || options.changed) return changedFiles(dir, config);
  return undefined; // full scan
}

function printReport(report: QualityReport, verbose: boolean): void {
  const { blocking, grandfathered, improved, skipped } = report;
  console.log(chalk.bold(`\n  quality gate: ${report.filesScanned} file(s) scanned`));
  for (const v of blocking) console.log(`  ${chalk.red('✗')} ${v.message}`);
  if (verbose) {
    for (const v of grandfathered) console.log(`  ${chalk.dim('◦')} ${chalk.dim(v.message + ' (grandfathered)')}`);
    for (const i of improved) {
      console.log(`  ${chalk.green('↓')} ${i.violation.message} ${chalk.green(`improved from ${i.baselineValue}`)}`);
    }
    for (const s of skipped) console.log(`  ${chalk.yellow('–')} skipped ${s.metric}: ${chalk.dim(s.reason)}`);
  }
  console.log(
    `\n  ${blocking.length} blocking · ${grandfathered.length} grandfathered · ${improved.length} improved\n`
  );
  if (blocking.length === 0) {
    console.log(chalk.green('  ✓ quality gate PASS'));
  } else {
    console.log(chalk.red('  ✗ quality gate FAIL — new or worsened violations block. Fix them, or regenerate'));
    console.log(chalk.red('    the baseline deliberately with `uap quality baseline --update` (reviewable in git).'));
    console.log(chalk.dim('    Escape hatch for agents: UAP_QUALITY_GATE_OFF=1'));
  }
}

function checkCmd(dir: string, options: QualityOptions): void {
  const config = loadQualityConfig(dir);
  if (!config) {
    console.log(chalk.dim('  No .uap/quality-metrics.json — quality gate inactive (run `uap quality init`).'));
    return;
  }

  // Single-file stdin mode mirrors `uap design check` (enforcer parity path).
  if (options.file && !existsSync(options.file) && !process.stdin.isTTY) {
    let content = '';
    try {
      content = readFileSync(0, 'utf-8');
    } catch {
      /* empty */
    }
    // Signatures are root-relative; an absolute --file would never match the
    // baseline's relative entries and would false-block.
    const relFile = isAbsolute(options.file) ? relative(dir, options.file) : options.file;
    const violations = scanContent(relFile, content, config);
    const baseline = loadBaseline(dir);
    const blocked = violations.filter((v) => {
      const e = baseline?.entries.find((x) => x.signature === v.signature);
      return e === undefined || v.value > e.value;
    });
    if (blocked.length === 0) {
      console.log(chalk.green('  ✓ within quality thresholds'));
      return;
    }
    for (const v of blocked) console.log(chalk.red(`  ✗ ${v.message}`));
    process.exitCode = 2;
    return;
  }

  const report = buildReport(dir, config, {
    files: fileList(dir, config, options),
    builtinOnly: false,
  });
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printReport(report, false);
  }
  if (!report.pass) process.exitCode = 2;
}

function baselineCmd(dir: string, options: QualityOptions): void {
  const config = loadQualityConfig(dir);
  if (!config) {
    console.log(chalk.yellow('  No .uap/quality-metrics.json. Run `uap quality init` first.'));
    process.exitCode = 1;
    return;
  }
  if (!options.update) {
    const p = baselinePath(dir);
    if (!existsSync(p)) {
      console.log(chalk.dim('  No baseline. Run `uap quality baseline --update` to create one.'));
      return;
    }
    const b = loadBaseline(dir);
    console.log(`  ${p}: ${b?.entries.length ?? 0} entr(ies), generated ${b?.generatedAt || 'unknown'}`);
    return;
  }
  const report = buildReport(dir, config, { builtinOnly: false });
  const p = writeBaseline(dir, report.violations);
  console.log(chalk.green(`  ✓ Wrote ${p} (${report.violations.length} entr(ies) from a fresh scan)`));
  console.log(chalk.dim('    Commit this file — the diff is the reviewable record of tolerated debt.'));
}

function reportCmd(dir: string, options: QualityOptions): void {
  const config = loadQualityConfig(dir);
  if (!config) {
    console.log(chalk.dim('  No .uap/quality-metrics.json — quality gate inactive.'));
    return;
  }
  const report = buildReport(dir, config, { files: fileList(dir, config, options) });
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  printReport(report, true);
}

/**
 * Stryker incremental, scoped to files changed vs the upstream base so a
 * per-commit run stays in minutes. Advisory when Stryker is not installed.
 */
function mutateCmd(dir: string, options: QualityOptions): void {
  const config = loadQualityConfig(dir);
  if (!config) {
    console.log(chalk.dim('  No .uap/quality-metrics.json — quality gate inactive.'));
    return;
  }
  const strykerCheck = spawnSync('npx', ['--no-install', 'stryker', '--version'], {
    cwd: dir, encoding: 'utf-8', timeout: 30_000,
  });
  if (strykerCheck.status !== 0) {
    console.log(chalk.yellow('  Stryker not installed. Add it to try mutation testing:'));
    console.log(chalk.dim('    npm i -D @stryker-mutator/core @stryker-mutator/vitest-runner'));
    console.log(chalk.dim('  Then re-run `uap quality mutate --changed`.'));
    return;
  }
  const files = options.changed !== false ? changedFiles(dir, config) : [];
  if (files.length === 0) {
    console.log(chalk.green('  No changed source files vs upstream — nothing to mutate.'));
    return;
  }
  const mutateGlobs = files.filter((f) => /\.(ts|tsx|js|jsx|mts|cts)$/.test(f)).join(',');
  if (!mutateGlobs) {
    console.log(chalk.yellow('  Changed files are not JS/TS — Stryker covers ts/js/cs/scala here; skipping.'));
    return;
  }
  console.log(chalk.dim(`  Mutating changed files: ${mutateGlobs}`));
  const r = spawnSync(
    'npx',
    ['--no-install', 'stryker', 'run', '--incremental', '--mutate', mutateGlobs],
    { cwd: dir, encoding: 'utf-8', stdio: 'inherit', timeout: 30 * 60_000 }
  );
  if (r.status !== 0) {
    console.log(chalk.red(`  ✗ Mutation run failed or surviving mutants exceeded thresholds.`));
    process.exitCode = 2;
  }
}
