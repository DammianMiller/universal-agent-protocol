#!/usr/bin/env tsx
/**
 * reliability-ladder — aggregate benchmark-results/ into the measured
 * technique-selection ladder (uplift 0.1).
 *
 * Reads every `benchmark-results/<run>/report.json` (+ records.jsonl for
 * per-task token/file detail), pools by suite tier × condition, and emits the
 * markdown table published in docs/performance/reliability-ladder.md.
 *
 *   npx tsx scripts/reliability-ladder.ts            # markdown to stdout
 *   npx tsx scripts/reliability-ladder.ts --json     # machine-readable
 *   npx tsx scripts/reliability-ladder.ts --write    # refresh the doc
 *
 * Evidence rules (the "Measured" principle): correctness deltas are reported
 * only with the run's discrimination status; runs the harness itself flags
 * underpowered are marked as such in the table, never silently cited.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';

interface PerCondition {
  label: string;
  n: number;
  successRate: number;
  meanTokens: number;
  meanTurns: number;
  meanLatencyMs: number;
  errorRate: number;
}

interface RunReport {
  dir: string;
  model: string;
  tier: string;
  taskCount: number;
  epochs: number;
  usable: boolean;
  discriminationStatus: string;
  conditions: PerCondition[];
}

interface RecordLine {
  taskId: string;
  condition: string;
  metrics: { correct: boolean; tokens: number; turns: number; latencyMs: number };
  attribution?: { turnTrace?: { files?: number }[] };
}

interface TierRow {
  tier: string;
  condition: string;
  runs: string[];
  n: number;
  successRate: number; // pooled (weighted by n)
  meanTokens: number;
  meanFiles: number | null; // from records.jsonl turnTrace, when available
  tokenMin: number | null;
  tokenMax: number | null;
  /** Distinct discrimination statuses across contributing runs — 'usable'
   * only when every run says so; legacy runs have NO discrimination block
   * and must render 'unknown', never be conflated with 'underpowered'. */
  statuses: string[];
}

/** Tier from the run directory name. Keyword-based; unknown → 'other'. */
export function tierOf(dirName: string): string {
  const d = dirName.toLowerCase();
  for (const tier of ['medium', 'brutal', 'heldout', 'games', 'uplift', 'power', 'deliver', 'hard', 'smoke']) {
    if (d.includes(tier)) return tier;
  }
  return 'other';
}

function readReport(dir: string): RunReport | null {
  const reportPath = join(dir, 'report.json');
  if (!existsSync(reportPath)) return null;
  try {
    const raw = JSON.parse(readFileSync(reportPath, 'utf-8'));
    const r = raw.report ?? raw;
    const meta = r.meta ?? {};
    const disc = r.discrimination; // may be ABSENT on legacy runs — not "underpowered"
    return {
      dir,
      model: String(meta.model ?? 'unknown'),
      tier: tierOf(dir),
      taskCount: Number(meta.taskCount ?? 0),
      epochs: Number(meta.epochs ?? 1),
      usable: disc?.usable === true,
      discriminationStatus: disc ? String(disc.status ?? 'unknown') : 'unknown',
      conditions: (r.perCondition ?? []) as PerCondition[],
    };
  } catch {
    return null; // a corrupt report must not kill the aggregation
  }
}

function readRecords(dir: string): RecordLine[] {
  const p = join(dir, 'records.jsonl');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l) as RecordLine;
      } catch {
        return null;
      }
    })
    .filter((r): r is RecordLine => r !== null);
}

/** Aggregate a results directory into pooled tier × condition rows. */
export function aggregate(resultsDir: string): TierRow[] {
  const rows = new Map<string, TierRow & { successSum: number; tokenSum: number; tokenN: number; fileSum: number; fileN: number; tokensSeen: number[] }>();
  for (const entry of readdirSync(resultsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(resultsDir, entry.name);
    // tierOf buckets by the run DIRECTORY NAME only — passing the full path
    // would let a parent component containing a keyword ('/tmp/hard-runs')
    // misbucket every run in it.
    const report = readReport(dir);
    if (!report || report.conditions.length === 0) continue;
    report.tier = tierOf(entry.name);
    const records = readRecords(dir);

    for (const cond of report.conditions) {
      const key = `${report.tier}|${cond.label}`;
      const row = rows.get(key) ?? {
        tier: report.tier,
        condition: cond.label,
        runs: [],
        n: 0,
        successRate: 0,
        meanTokens: 0,
        meanFiles: null,
        tokenMin: null,
        tokenMax: null,
        statuses: [],
        successSum: 0,
        tokenSum: 0,
        tokenN: 0,
        fileSum: 0,
        fileN: 0,
        tokensSeen: [],
      };
      row.runs.push(entry.name);
      row.n += cond.n;
      row.successSum += cond.successRate * cond.n;
      // Older runs recorded meanTokens as 0 (token accounting predates them);
      // a 0 would silently drag the pooled mean, so weight only real numbers.
      if (cond.meanTokens > 0) {
        row.tokenSum += cond.meanTokens * cond.n;
        row.tokenN += cond.n;
      }
      if (!row.statuses.includes(report.discriminationStatus)) {
        row.statuses.push(report.discriminationStatus);
      }

      for (const rec of records.filter((r) => r.condition === cond.label)) {
        const files = rec.attribution?.turnTrace?.reduce((s, t) => s + (t.files ?? 0), 0) ?? 0;
        // Records with 0 files carry no files signal (single-turn tasks);
        // dropping them biases the mean UP slightly — documented, accepted.
        if (files > 0) {
          row.fileSum += files;
          row.fileN += 1;
        }
        if (Number.isFinite(rec.metrics?.tokens) && rec.metrics.tokens > 0) {
          row.tokensSeen.push(rec.metrics.tokens);
        }
      }
      row.successRate = row.n > 0 ? row.successSum / row.n : 0;
      row.meanTokens = row.tokenN > 0 ? row.tokenSum / row.tokenN : 0;
      row.meanFiles = row.fileN > 0 ? row.fileSum / row.fileN : null;
      row.tokenMin = row.tokensSeen.length ? Math.min(...row.tokensSeen) : null;
      row.tokenMax = row.tokensSeen.length ? Math.max(...row.tokensSeen) : null;
      rows.set(key, row);
    }
  }
  const tierOrder = ['smoke', 'medium', 'uplift', 'hard', 'brutal', 'power', 'heldout', 'games', 'deliver', 'other'];
  return [...rows.values()]
    .map(({ successSum: _s, tokenSum: _t, tokenN: _tn, fileSum: _f, fileN: _n, tokensSeen: _tok, ...row }) => row)
    .sort(
      (a, b) =>
        tierOrder.indexOf(a.tier) - tierOrder.indexOf(b.tier) || a.condition.localeCompare(b.condition),
    );
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const num = (x: number | null, d = 0) => (x === null ? '—' : x.toFixed(d));

/** Stats column: 'usable' only when every contributing run measured it;
 * 'underpowered' and 'unknown' (legacy runs without a discrimination block)
 * stay distinguishable — they carry different evidentiary weight. */
function statsLabel(statuses: string[]): string {
  if (statuses.length > 0 && statuses.every((s) => s === 'usable' || s === 'ok')) return 'usable';
  if (statuses.every((s) => s === 'unknown')) return '⚠ unknown';
  return '⚠ underpowered';
}

/** Render the pooled rows as the published markdown table. */
export function renderMarkdown(rows: TierRow[]): string {
  const lines: string[] = [
    '<!-- GENERATED by scripts/reliability-ladder.ts — regenerate with: npm run bench:ladder -->',
    '',
    '## Measured results (pooled from `benchmark-results/`)',
    '',
    '| Tier | Condition | n | Success | Mean tokens | Token range | Mean files | Runs | Stats |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const r of rows) {
    const range = r.tokenMin === null ? '—' : `${num(r.tokenMin)}–${num(r.tokenMax)}`;
    const tokens = r.meanTokens > 0 ? num(r.meanTokens) : '—';
    const stats = statsLabel(r.statuses);
    lines.push(
      `| ${r.tier} | ${r.condition} | ${r.n} | ${pct(r.successRate)} | ${tokens} | ${range} | ${num(r.meanFiles, 1)} | ${r.runs.length} | ${stats} |`,
    );
  }
  lines.push(
    '',
    // Stable, machine-independent label — never the resolved absolute path
    // (a worktree regeneration would otherwise churn the doc and leak the
    // local checkout layout into a committed file).
    'Source: `benchmark-results/`. Rows not marked "usable" support',
    'token/latency cost claims only — never cite a success delta without its',
    'discrimination status ("underpowered" = measured but inconclusive;',
    '"unknown" = legacy run without a discrimination block).',
  );
  return lines.join('\n');
}

/**
 * Locate benchmark-results/: it is git-ignored, so a worktree never contains
 * it — fall back to the main checkout (via the shared git dir) before giving
 * up. `--results-dir <path>` overrides both.
 */
export function resolveResultsDir(cwd: string, explicit?: string): string | null {
  if (explicit) return existsSync(explicit) ? explicit : null;
  const local = join(cwd, 'benchmark-results');
  if (existsSync(local)) return local;
  try {
    const common = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd,
      encoding: 'utf-8',
    }).trim();
    const mainCheckout = join(common, '..');
    const there = join(mainCheckout, 'benchmark-results');
    if (existsSync(there)) return there;
  } catch {
    // non-git context — fall through to null
  }
  return null;
}

function main(): void {
  const args = process.argv.slice(2);
  const explicit = args.includes('--results-dir') ? args[args.indexOf('--results-dir') + 1] : undefined;
  const resultsDir = resolveResultsDir(process.cwd(), explicit);
  if (!resultsDir) {
    console.error('benchmark-results/ not found (checked cwd and the main checkout); use --results-dir <path>');
    process.exitCode = 1;
    return;
  }
  const rows = aggregate(resultsDir);
  if (args.includes('--json')) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  const md = renderMarkdown(rows);
  if (args.includes('--write')) {
    // --write refreshes ONLY the generated block inside the published doc; the
    // guidance prose around it is hand-maintained.
    const docPath = join(process.cwd(), 'docs', 'performance', 'reliability-ladder.md');
    const doc = readFileSync(docPath, 'utf-8');
    const begin = '<!-- LADDER:BEGIN -->';
    const end = '<!-- LADDER:END -->';
    const i = doc.indexOf(begin);
    const j = doc.indexOf(end);
    if (i < 0 || j < 0 || j < i) {
      console.error(`${docPath} is missing well-ordered ${begin} / ${end} markers`);
      process.exitCode = 1;
      return;
    }
    writeFileSync(docPath, `${doc.slice(0, i + begin.length)}\n${md}\n${doc.slice(j)}`);
    console.log(`updated ${docPath} (${rows.length} rows)`);
    return;
  }
  console.log(md);
}

if (process.argv[1]?.endsWith('reliability-ladder.ts')) main();
