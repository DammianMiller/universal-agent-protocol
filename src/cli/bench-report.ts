// ---------------------------------------------------------------------------
// `uap bench report` — the paired-report reader (bridge P5: the delta report
// as an operator surface). Reports accumulate under benchmark-results/paired-*/;
// the operator's questions are "what did the latest run measure" and "did the
// delta HOLD since the last run" — and per the reliability-ladder rule, a delta
// is never cited without its discrimination status.
//
// Split from bench.ts (the paired-run driver) at review: the reader and the
// driver are separable commands, and the repo pattern is one command per file.
// ---------------------------------------------------------------------------

import chalk from 'chalk';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { basename, join, resolve } from 'path';
import { termSafe } from '../utils/terminal-safe.js';

/** One report file read is bounded (P5 polish): these are small harness
 *  artifacts, and a multi-GB or planted file must not be slurped whole. */
const MAX_REPORT_BYTES = 4 * 1024 * 1024;

export interface BenchReportOptions {
  /** A specific paired-run dir (default: the newest under benchmark-results). */
  dir?: string;
  /** Compare the two newest runs: which deltas held, flipped, narrowed. */
  compare?: boolean;
  /** Print the full stored report.md instead of the compact delta summary. */
  full?: boolean;
  json?: boolean;
  /** Test/odd-layout seam: pin the benchmark-results root. */
  root?: string;
}

export interface LoadedReport {
  dir: string;
  mtimeMs: number;
  report: {
    meta?: {
      model?: string;
      adapter?: string;
      epochs?: number;
      taskCount?: number;
      baseline?: string;
      startedAt?: string;
    };
    perCondition?: Array<{ label: string; successRate: number; n: number }>;
    comparisons?: Array<{
      label: string;
      baseline?: string;
      correctness?: {
        delta?: { meanDelta?: number; ci?: { lower?: number; upper?: number }; pValue?: number };
        verdict?: string;
        mcnemar?: { b?: number; c?: number };
      };
      metrics?: Record<string, { meanDelta?: number; ci?: { lower?: number; upper?: number }; verdict?: string }>;
    }>;
    discrimination?: { status?: string; usable?: boolean; reason?: string; efficiencyUsable?: boolean };
  };
}

/**
 * Paired-run dirs that hold a report.json, newest-first. One bad entry (a
 * dangling symlink, a vanished dir) must not hide the good reports behind a
 * misleading "no reports found" — fail-soft per entry, not per directory.
 */
export function listPairedReportDirs(root = join(process.cwd(), 'benchmark-results')): Array<{ dir: string; mtimeMs: number }> {
  let entries: string[] = [];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }
  const found: Array<{ dir: string; mtimeMs: number }> = [];
  for (const e of entries) {
    const dir = join(root, e);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue; // dangling symlink / unreadable entry — skip it, keep the rest
    }
    const reportPath = join(dir, 'report.json');
    if (!existsSync(reportPath)) continue;
    try {
      found.push({ dir, mtimeMs: statSync(reportPath).mtimeMs });
    } catch {
      /* unreadable mtime — skip */
    }
  }
  // Newest-first. Ties (e.g. a bulk copy resets mtimes) fall back to the dir
  // name — paired-run dirs are ISO-timestamped, so lexical order is dated too.
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs || b.dir.localeCompare(a.dir));
}

/** Read one paired-run dir's report.json; null when unreadable.
 * The harness writes `{ ablation, report: AnalysisReport }` — the reader
 * unwraps that shape and also accepts a bare report for hand-made fixtures. */
export function loadReport(dir: string): LoadedReport | null {
  try {
    const reportPath = join(dir, 'report.json');
    const st = statSync(reportPath);
    // Bounded read (P5 polish): these are small harness artifacts — a huge
    // or planted report.json must not be slurped whole. Oversized is NAMED
    // and skipped, never a silent drop or a crash.
    if (st.size > MAX_REPORT_BYTES) {
      console.warn(
        `[bench report] ${basename(dir)}/report.json is ${st.size} bytes (over the ${MAX_REPORT_BYTES / (1024 * 1024)} MiB read cap) — skipped`
      );
      return null;
    }
    const raw = JSON.parse(readFileSync(reportPath, 'utf-8')) as LoadedReport['report'] & {
      report?: LoadedReport['report'];
    };
    const report = raw.report ?? raw;
    return { dir, mtimeMs: st.mtimeMs, report };
  } catch {
    return null;
  }
}

const pp = (x: number | undefined): string =>
  Number.isFinite(x) ? `${(x! * 100).toFixed(1)}pp` : '—';
const sign = (x: number | undefined): string =>
  !Number.isFinite(x) ? '—' : `${x! >= 0 ? '+' : ''}${(x! * 100).toFixed(1)}pp`;

/** Compact delta summary of ONE report — deltas WITH their status, always. */
export function renderReportSummary(loaded: LoadedReport): string {
  const r = loaded.report;
  const meta = r.meta ?? {};
  const disc = r.discrimination ?? {};
  const lines: string[] = [];
  lines.push(chalk.bold(`Paired bench report — ${termSafe(basename(loaded.dir))}`));
  lines.push(
    chalk.dim(
      `  model=${termSafe(String(meta.model ?? '?'))} adapter=${termSafe(String(meta.adapter ?? '?'))} epochs=${meta.epochs ?? '?'} ` +
        `tasks=${meta.taskCount ?? '?'} started=${termSafe(String(meta.startedAt ?? '?'))}`
    )
  );
  lines.push(
    `  discrimination: ${disc.usable ? chalk.green('usable') : chalk.red('NOT usable')} ` +
      `(${termSafe(String(disc.status ?? '?'))}${disc.reason ? chalk.dim(` — ${termSafe(String(disc.reason))}`) : ''})`
  );
  for (const c of r.comparisons ?? []) {
    const corr = c.correctness ?? {};
    const d = corr.delta ?? {};
    const verdict = corr.verdict ?? '—';
    const verdictColor =
      verdict === 'win' ? chalk.green : verdict === 'loss' ? chalk.red : chalk.yellow;
    lines.push(
      `  ${chalk.cyan(termSafe(c.label))} vs ${chalk.dim(termSafe(String(c.baseline ?? 'baseline')))}: correctness ` +
        `${sign(d.meanDelta)} CI [${pp(d.ci?.lower)}, ${pp(d.ci?.upper)}] p=${Number.isFinite(d.pValue) ? d.pValue!.toFixed(3) : '—'} ` +
        `→ ${verdictColor(termSafe(verdict))}${chalk.dim(` (McNemar discordant ${(corr.mcnemar?.b ?? 0) + (corr.mcnemar?.c ?? 0)})`)}`
    );
    const metrics = Object.entries(c.metrics ?? {});
    if (metrics.length > 0) {
      const parts = metrics
        .slice(0, 4)
        .map(([name, m]) => `${termSafe(name)}: ${sign(m.meanDelta)}${m.verdict ? ` (${termSafe(String(m.verdict))})` : ''}`);
      lines.push(chalk.dim(`    metrics: ${parts.join(' · ')}`));
    }
  }
  lines.push(
    chalk.dim(
      disc.usable
        ? '  (deltas above carry their CI and verdict; see report.md for the full analysis)'
        : '  (an unusable run is NO MEASUREMENT — fix the suite/adapter before citing any delta)'
    )
  );
  return lines.join('\n');
}

/** Two-run delta drift: which deltas held, flipped, or narrowed. */
export function renderComparison(a: LoadedReport, b: LoadedReport): string {
  // `b` is the NEWER run by caller convention.
  const lines: string[] = [];
  lines.push(chalk.bold('Paired bench delta drift — two most recent runs'));
  lines.push(chalk.dim(`  now:    ${termSafe(basename(b.dir))} (${termSafe(String(b.report.meta?.startedAt ?? '?'))})`));
  lines.push(chalk.dim(`  prev:   ${termSafe(basename(a.dir))} (${termSafe(String(a.report.meta?.startedAt ?? '?'))})`));
  const discA = a.report.discrimination ?? {};
  const discB = b.report.discrimination ?? {};
  lines.push(
    `  discrimination now/prev: ${discB.usable ? 'usable' : 'NOT usable'}/${discA.usable ? 'usable' : 'NOT usable'} ` +
      `(${termSafe(String(discB.status ?? '?'))}/${termSafe(String(discA.status ?? '?'))})`
  );
  if (!discB.usable || !discA.usable) {
    lines.push(
      chalk.yellow('  ⚠ at least one run could not measure — drift between unusable runs is NO MEASUREMENT.')
    );
  }
  const byLabel = (r: LoadedReport) =>
    new Map((r.report.comparisons ?? []).map((c) => [c.label, c]));
  const prev = byLabel(a);
  const now = byLabel(b);
  for (const [label, nowC] of now) {
    const prevC = prev.get(label);
    if (!prevC) {
      lines.push(chalk.dim(`  ${termSafe(label)}: no previous comparison to drift against`));
      continue;
    }
    const pd = prevC.correctness?.delta?.meanDelta;
    const nd = nowC.correctness?.delta?.meanDelta;
    const pv = prevC.correctness?.verdict ?? '—';
    const nv = nowC.correctness?.verdict ?? '—';
    const flipped = pv !== nv;
    const drift =
      Number.isFinite(pd) && Number.isFinite(nd)
        ? `${(nd! - pd!) * 100 >= 0 ? '+' : ''}${((nd! - pd!) * 100).toFixed(1)}pp`
        : '—';
    lines.push(
      `  ${chalk.cyan(termSafe(label))}: correctness ${sign(pd)} (${termSafe(pv)}) → ${sign(nd)} (${termSafe(nv)})` +
        ` drift ${drift}${flipped ? chalk.yellow(` — VERDICT FLIPPED`) : ''}`
    );
  }
  return lines.join('\n');
}

/**
 * Print the stored report.md. The harness writes report.json THEN report.md —
 * an interrupted run can leave the first without the second. That is a
 * missing-file degradation, never a stack trace: say so, fall back to the
 * delta summary, exit non-zero. An oversized report.md is the same
 * degradation (bounded read, P5 polish): named, never slurped.
 */
function printFullReport(loaded: LoadedReport): void {
  try {
    const mdPath = join(loaded.dir, 'report.md');
    const st = statSync(mdPath);
    if (st.size > MAX_REPORT_BYTES) {
      console.error(
        chalk.red(`report.md in ${basename(loaded.dir)}/ is ${st.size} bytes (over the ${MAX_REPORT_BYTES / (1024 * 1024)} MiB read cap) — showing the summary instead.`)
      );
      console.log(renderReportSummary(loaded));
      process.exitCode = 1;
      return;
    }
    console.log(readFileSync(mdPath, 'utf-8'));
  } catch {
    console.error(
      chalk.red(`No report.md stored in ${basename(loaded.dir)}/ — the run may have been interrupted; showing the summary instead.`)
    );
    console.log(renderReportSummary(loaded));
    process.exitCode = 1;
  }
}

export async function benchReportCommand(options: BenchReportOptions = {}): Promise<void> {
  const root = options.root ? resolve(options.root) : join(process.cwd(), 'benchmark-results');

  if (options.dir) {
    if (options.compare) {
      console.log(chalk.dim('  (--dir pins a single run; --compare is ignored)'));
    }
    const one = loadReport(resolve(options.dir));
    if (!one) {
      console.error(chalk.red(`No readable report.json under '${options.dir}'.`));
      process.exitCode = 1;
      return;
    }
    if (options.json) {
      console.log(JSON.stringify(one.report, null, 2));
      return;
    }
    if (options.full) {
      printFullReport(one);
      return;
    }
    console.log(renderReportSummary(one));
    return;
  }

  const dirs = listPairedReportDirs(root);
  if (dirs.length === 0) {
    console.error(
      chalk.red('No paired reports found under benchmark-results/ — run `uap bench paired` first.')
    );
    process.exitCode = 1;
    return;
  }

  if (options.compare) {
    if (dirs.length < 2) {
      console.error(chalk.red('Only one paired report exists — nothing to compare yet.'));
      process.exitCode = 1;
      return;
    }
    const [newer, older] = [loadReport(dirs[0].dir), loadReport(dirs[1].dir)];
    if (!newer || !older) {
      console.error(chalk.red('The two newest report.json files were not readable.'));
      process.exitCode = 1;
      return;
    }
    if (options.json) {
      console.log(JSON.stringify({ now: newer.report, prev: older.report }, null, 2));
      return;
    }
    console.log(renderComparison(older, newer));
    return;
  }

  const latest = loadReport(dirs[0].dir);
  if (!latest) {
    console.error(chalk.red(`The newest report (${dirs[0].dir}) was not readable.`));
    process.exitCode = 1;
    return;
  }
  if (options.json) {
    console.log(JSON.stringify(latest.report, null, 2));
    return;
  }
  if (options.full) {
    printFullReport(latest);
    return;
  }
  console.log(renderReportSummary(latest));
  console.log(chalk.dim(`\n  (${dirs.length} report(s) on disk — \`uap bench report --compare\` for run-to-run drift, --full for the stored markdown)`));
}
