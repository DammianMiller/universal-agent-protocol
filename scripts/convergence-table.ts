#!/usr/bin/env tsx
/**
 * convergence-table — E.1 (wave 2.1 of the quality-tier uplift plan): the
 * convergence telemetry table published in docs/performance/convergence-table.md.
 *
 * Per model per source, with quality-class coverage noted:
 *   - iterations-to-done: mean turns on correct attempts (paired corpus),
 *     mean turns per run (delivery corpus)
 *   - escalation frequency: from .uap/quality/escalations.jsonl (uplift 1.4,
 *     PR #906 — absent until an uplift loop first escalates)
 *   - cut rate: error share of attempts (paired) / stopped+not-delivered
 *     share of runs (delivery)
 *   - best-of-N win rate: pass@epochs − pass@1 per task, using the harness's
 *     own unbiased passAtK estimator (src/benchmarks/paired/stats.ts)
 *
 * House rule: every paired number carries its run's discrimination status
 * verbatim; the delivery corpus is descriptive by construction (proof-plan
 * O1) and is never quoted as a finding. Class coverage is a column, not a
 * promise — the harness and delivery corpora are not yet class-tagged, so
 * rows show "—" until the anchor (E.2) and vision-promotion (E.4) waves make
 * class-tagged runs available.
 *
 *   npx tsx scripts/convergence-table.ts            # markdown to stdout
 *   npx tsx scripts/convergence-table.ts --json     # machine-readable
 *   npx tsx scripts/convergence-table.ts --write    # refresh the doc block
 *   npx tsx scripts/convergence-table.ts --results-dir <path>
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { passAtK } from '../src/benchmarks/paired/stats.js';

// ---------------------------------------------------------------------------
// Paired-corpus convergence (benchmark-results/)
// ---------------------------------------------------------------------------

/** One task attempt as the convergence metrics consume it. */
export interface AttemptRow {
  taskId: string;
  condition: string;
  correct: boolean;
  turns: number;
  error: boolean;
}

export interface ConditionConvergence {
  condition: string;
  /** Distinct tasks contributing attempts to this condition. */
  tasks: number;
  /** Attempts observed (task × epoch cells that recorded). */
  attempts: number;
  /** pass@1, mean over tasks (unbiased estimator). Null when no tasks. */
  pass1: number | null;
  /** pass@all-attempts, mean over tasks. Null when no tasks. */
  passN: number | null;
  /** best-of-N win rate = passN − pass1 (>= 0 by construction). */
  bestOfNWin: number | null;
  /** Mean turns on CORRECT attempts — iterations the working path needed.
   *  Null when nothing passed: iterations-to-done is undefined then, not 0. */
  iterationsToDone: number | null;
  /** Correct attempts (the denominator of iterationsToDone). */
  correctAttempts: number;
  /** Share of attempts cut by error (metrics.error). Null when no attempts. */
  cutRate: number | null;
}

/** Converge raw attempts into per-condition metrics. Pure. */
export function converge(attempts: AttemptRow[]): ConditionConvergence[] {
  const byCondition = new Map<string, AttemptRow[]>();
  for (const a of attempts) {
    const list = byCondition.get(a.condition) ?? [];
    list.push(a);
    byCondition.set(a.condition, list);
  }
  const out: ConditionConvergence[] = [];
  for (const [condition, rows] of byCondition) {
    const byTask = new Map<string, AttemptRow[]>();
    for (const r of rows) {
      const list = byTask.get(r.taskId) ?? [];
      list.push(r);
      byTask.set(r.taskId, list);
    }
    let pass1Sum = 0;
    let passNSum = 0;
    for (const taskRows of byTask.values()) {
      const n = taskRows.length;
      const c = taskRows.filter((r) => r.correct).length;
      // k=1 and k=n (best of every recorded attempt for this task).
      pass1Sum += passAtK(n, c, 1);
      passNSum += passAtK(n, c, n);
    }
    const tasks = byTask.size;
    const pass1 = tasks > 0 ? pass1Sum / tasks : null;
    const passN = tasks > 0 ? passNSum / tasks : null;
    const correct = rows.filter((r) => r.correct);
    const turnsOnCorrect =
      correct.length > 0 ? correct.reduce((s, r) => s + r.turns, 0) / correct.length : null;
    const errorShare = rows.length > 0 ? rows.filter((r) => r.error).length / rows.length : null;
    out.push({
      condition,
      tasks,
      attempts: rows.length,
      pass1,
      passN,
      bestOfNWin: pass1 != null && passN != null ? passN - pass1 : null,
      iterationsToDone: turnsOnCorrect,
      correctAttempts: correct.length,
      cutRate: errorShare,
    });
  }
  // Stable, readable order: by condition name.
  out.sort((a, b) => a.condition.localeCompare(b.condition));
  return out;
}

// ---------------------------------------------------------------------------
// Escalation ledger (.uap/quality/escalations.jsonl, uplift 1.4)
// ---------------------------------------------------------------------------

export interface EscalationSummary {
  total: number;
  byTier: { tier: string; count: number; meanRound: number }[];
}

/** Summarize escalation ledger lines (one JSON object per line, tier+round).
 *  Malformed lines are skipped, never crash the table. */
export function summarizeEscalations(lines: string[]): EscalationSummary | null {
  const rows: { tier: string; round: number }[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    try {
      const o = JSON.parse(t) as { tier?: unknown; round?: unknown };
      if (typeof o.tier === 'string' && typeof o.round === 'number' && Number.isFinite(o.round)) {
        rows.push({ tier: o.tier, round: o.round });
      }
    } catch {
      // skip malformed ledger line
    }
  }
  if (rows.length === 0) return null;
  const byTier = new Map<string, { count: number; roundSum: number }>();
  for (const r of rows) {
    const acc = byTier.get(r.tier) ?? { count: 0, roundSum: 0 };
    acc.count++;
    acc.roundSum += r.round;
    byTier.set(r.tier, acc);
  }
  return {
    total: rows.length,
    byTier: [...byTier.entries()]
      .map(([tier, a]) => ({ tier, count: a.count, meanRound: a.roundSum / a.count }))
      .sort((x, y) => y.count - x.count),
  };
}

// ---------------------------------------------------------------------------
// Delivery corpus (uap memory outcomes, proof-plan O1 — descriptive)
// ---------------------------------------------------------------------------

export interface DeliverRow {
  outcome: string;
  turns: number;
  gatesPct: number;
  model: string;
  task: string;
  source: string;
}

export interface ModelDeliveryConvergence {
  model: string;
  runs: number;
  delivered: number;
  stopped: number;
  notDelivered: number;
  /** Cut rate: share of runs that did NOT deliver (stopped + not-delivered). */
  cutRate: number;
  /** Mean turns per run (iterations spent, delivered or not). */
  meanTurns: number;
  /** Mean best share of gates reached (the tier-progress proxy, 0..100). */
  meanGatesPct: number;
}

/** Converge the O1 deliver rows into per-model convergence. Pure. */
export function convergeDelivery(rows: DeliverRow[]): ModelDeliveryConvergence[] {
  const byModel = new Map<string, DeliverRow[]>();
  for (const r of rows) {
    const list = byModel.get(r.model) ?? [];
    list.push(r);
    byModel.set(r.model, list);
  }
  const out: ModelDeliveryConvergence[] = [];
  for (const [model, runs] of byModel) {
    const n = runs.length;
    const stopped = runs.filter((r) => r.outcome === 'stopped').length;
    const notDelivered = runs.filter((r) => r.outcome === 'not-delivered').length;
    const delivered = n - stopped - notDelivered;
    out.push({
      model,
      runs: n,
      delivered,
      stopped,
      notDelivered,
      cutRate: (stopped + notDelivered) / n,
      meanTurns: runs.reduce((s, r) => s + r.turns, 0) / n,
      meanGatesPct: runs.reduce((s, r) => s + r.gatesPct, 0) / n,
    });
  }
  out.sort((a, b) => b.runs - a.runs || a.model.localeCompare(b.model));
  return out;
}

// ---------------------------------------------------------------------------
// Run discovery (both layouts: flat <run>/report.json and nested <run>/<arm>/)
// ---------------------------------------------------------------------------

export interface PairedRunConvergence {
  /** Run identity: the directory holding report.json, and its parent when the
   *  layout is nested (o7-pilot/armB-gateloop → run "o7-pilot", arm "armB"). */
  run: string;
  arm: string | null;
  model: string;
  adapter: string;
  epochs: number;
  taskCount: number;
  discriminationStatus: string;
  discriminationUsable: boolean;
  conditions: ConditionConvergence[];
}

interface ReportLike {
  meta?: {
    model?: unknown;
    adapter?: unknown;
    epochs?: unknown;
    taskCount?: unknown;
  };
  discrimination?: { status?: unknown; usable?: unknown };
}

interface RecordLike {
  taskId?: unknown;
  condition?: unknown;
  metrics?: { correct?: unknown; turns?: unknown; error?: unknown };
}

/** Every directory under root (depth <= 2) holding BOTH report.json and
 *  records.jsonl — a run dir with only a report is an incomplete artifact,
 *  not a readable run. */
export function findRunDirs(root: string): string[] {
  const found: string[] = [];
  let level1: string[] = [];
  try {
    level1 = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => join(root, e.name));
  } catch {
    return found;
  }
  const isRun = (d: string): boolean =>
    existsSync(join(d, 'report.json')) && existsSync(join(d, 'records.jsonl'));
  for (const dir of level1) {
    if (isRun(dir)) {
      found.push(dir);
      continue; // flat run dir: do not also descend into it
    }
    try {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory() && isRun(join(dir, e.name))) {
          found.push(join(dir, e.name));
        }
      }
    } catch {
      // unreadable subdir — skip
    }
  }
  return found.sort();
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function str(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v : fallback;
}

/** Read one run dir into convergence rows. Null when unreadable/empty.
 *  `root` is the results root: a dir directly under it is a FLAT run; a dir
 *  one level deeper (under <root>/<run>/) is a NESTED arm dir. */
export function readRun(dir: string, root: string): PairedRunConvergence | null {
  const reportPath = join(dir, 'report.json');
  const recordsPath = join(dir, 'records.jsonl');
  if (!existsSync(reportPath) || !existsSync(recordsPath)) return null;
  let report: ReportLike;
  try {
    const raw = JSON.parse(readFileSync(reportPath, 'utf-8')) as ReportLike | { report: ReportLike };
    report = ((raw as { report?: ReportLike }).report ?? raw) as ReportLike;
  } catch {
    return null;
  }
  const attempts: AttemptRow[] = [];
  for (const line of readFileSync(recordsPath, 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as RecordLike;
      if (typeof r.taskId !== 'string' || typeof r.condition !== 'string') continue;
      attempts.push({
        taskId: r.taskId,
        condition: r.condition,
        correct: r.metrics?.correct === true,
        turns: num(r.metrics?.turns, 0),
        error: r.metrics?.error === true,
      });
    } catch {
      // skip malformed record
    }
  }
  if (attempts.length === 0) return null;
  const dirParts = dir.split('/');
  const name = dirParts[dirParts.length - 1];
  const isNested = join(dir, '..') !== root;
  const run = isNested ? dirParts[dirParts.length - 2] : name;
  const arm = isNested ? name : null;
  return {
    run,
    arm,
    model: str(report.meta?.model, 'unknown'),
    adapter: str(report.meta?.adapter, 'unknown'),
    epochs: num(report.meta?.epochs, 0),
    taskCount: num(report.meta?.taskCount, 0),
    discriminationStatus: str(report.discrimination?.status, 'unknown'),
    discriminationUsable: report.discrimination?.usable === true,
    conditions: converge(attempts),
  };
}

// ---------------------------------------------------------------------------
// Assembly + rendering
// ---------------------------------------------------------------------------

/**
 * Locate benchmark-results/: it is git-ignored, so a worktree never contains
 * it — fall back to the main checkout (via the shared git dir), exactly as
 * reliability-ladder.ts does.
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
    const there = join(common, '..', 'benchmark-results');
    if (existsSync(there)) return there;
  } catch {
    // non-git context
  }
  return null;
}

/** The escalation ledger, searching cwd then the main checkout. Null when absent. */
function readEscalationLedger(cwd: string): string[] | null {
  const candidates = [join(cwd, '.uap', 'quality', 'escalations.jsonl')];
  try {
    const common = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd,
      encoding: 'utf-8',
    }).trim();
    candidates.push(join(common, '..', '.uap', 'quality', 'escalations.jsonl'));
  } catch {
    // non-git context
  }
  for (const p of candidates) {
    if (existsSync(p) && statSync(p).isFile()) {
      return readFileSync(p, 'utf-8').split('\n');
    }
  }
  return null;
}

/** The O1 delivery corpus via the memory CLI. Null when unreachable. */
function readDeliverCorpus(cwd: string): DeliverRow[] | null {
  try {
    const raw = execFileSync('uap', ['memory', 'outcomes', '--json'], {
      cwd,
      encoding: 'utf-8',
      timeout: 60_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    const parsed = JSON.parse(raw) as { rows?: unknown };
    if (!Array.isArray(parsed.rows)) return null;
    const rows: DeliverRow[] = [];
    for (const r of parsed.rows) {
      if (
        typeof r === 'object' && r !== null &&
        typeof (r as DeliverRow).model === 'string' &&
        typeof (r as DeliverRow).turns === 'number' &&
        typeof (r as DeliverRow).gatesPct === 'number'
      ) {
        rows.push({
          outcome: String((r as DeliverRow).outcome ?? 'unknown'),
          turns: (r as DeliverRow).turns,
          gatesPct: (r as DeliverRow).gatesPct,
          model: (r as DeliverRow).model,
          task: String((r as DeliverRow).task ?? ''),
          source: String((r as DeliverRow).source ?? ''),
        });
      }
    }
    return rows.length > 0 ? rows : null;
  } catch {
    return null;
  }
}

export interface ConvergenceReport {
  generatedAt: string;
  pairedRuns: PairedRunConvergence[];
  delivery: ModelDeliveryConvergence[];
  deliveryReachable: boolean;
  escalations: EscalationSummary | null;
}

export function buildReport(
  resultsDir: string | null,
  delivery: DeliverRow[] | null,
  ledgerLines: string[] | null,
  now = new Date().toISOString()
): ConvergenceReport {
  const pairedRuns = resultsDir
    ? findRunDirs(resultsDir)
        .map((d) => readRun(d, resultsDir))
        .filter((r): r is PairedRunConvergence => r !== null)
    : [];
  return {
    generatedAt: now,
    pairedRuns,
    delivery: delivery ? convergeDelivery(delivery) : [],
    deliveryReachable: delivery != null,
    escalations: ledgerLines ? summarizeEscalations(ledgerLines) : null,
  };
}

function pct(x: number | null): string {
  return x == null ? '—' : `${(x * 100).toFixed(1)}%`;
}

function fixed(x: number | null): string {
  return x == null ? '—' : x.toFixed(1);
}

export function renderMarkdown(r: ConvergenceReport): string {
  const L: string[] = [];
  L.push(`Generated ${r.generatedAt.slice(0, 10)} by \`scripts/convergence-table.ts\` (E.1, wave 2.1).`);

  // --- Paired corpus -----------------------------------------------------
  L.push('');
  L.push('## Paired-harness convergence (benchmark-results/)');
  L.push('');
  if (r.pairedRuns.length === 0) {
    L.push('_No paired runs with report.json + records.jsonl found._');
  } else {
    L.push('| Run | Arm | Model | Condition | Tasks | pass@1 | pass@N | best-of-N win | Iterations-to-done (correct attempts) | Cut rate | Discrimination |');
    L.push('|---|---|---|---|--:|--:|--:|--:|--:|--:|---|');
    for (const run of r.pairedRuns) {
      for (const c of run.conditions) {
        const disc = run.discriminationUsable
          ? `**${run.discriminationStatus}**`
          : `${run.discriminationStatus} (⚠)`;
        L.push(
          `| ${run.run} | ${run.arm ?? '—'} | ${run.model} | ${c.condition} | ${c.tasks} | ` +
          `${pct(c.pass1)} | ${pct(c.passN)} | ${pct(c.bestOfNWin)} | ` +
          `${fixed(c.iterationsToDone)} (n=${c.correctAttempts}) | ${pct(c.cutRate)} | ${disc} |`
        );
      }
    }
    L.push('');
    L.push(
      'pass@1 / pass@N use the unbiased estimator (the harness `passAtK`); N is each task\'s own attempt count. ' +
      'Iterations-to-done is mean turns on **correct** attempts only — it is undefined (—) when nothing passed. ' +
      'Cut rate is the share of attempts that errored. Discrimination is the run\'s own verdict; rows not marked ' +
      '**usable** support cost claims, never a quality claim.'
    );
  }

  // --- Delivery corpus ---------------------------------------------------
  L.push('');
  L.push('## Delivery-gate convergence (O1 corpus, descriptive)');
  L.push('');
  if (!r.deliveryReachable) {
    L.push('_`uap memory outcomes` unreachable — no delivery corpus in this table._');
  } else if (r.delivery.length === 0) {
    L.push('_No recorded deliver outcomes._');
  } else {
    L.push('| Model | Runs | Delivered | Stopped | Not delivered | Cut rate | Mean turns | Mean best gates |');
    L.push('|---|--:|--:|--:|--:|--:|--:|--:|');
    for (const m of r.delivery) {
      L.push(
        `| ${m.model} | ${m.runs} | ${m.delivered} | ${m.stopped} | ${m.notDelivered} | ` +
        `${pct(m.cutRate)} | ${fixed(m.meanTurns)} | ${fixed(m.meanGatesPct)}% |`
      );
    }
    L.push('');
    L.push(
      'Descriptive by construction (no paired arm): observational counts of recorded lessons. ' +
      'It directs where paired runs should spend; it proves nothing about cause.'
    );
  }

  // --- Escalations --------------------------------------------------------
  L.push('');
  L.push('## Escalation ledger (.uap/quality/escalations.jsonl)');
  L.push('');
  if (!r.escalations) {
    L.push('_No escalations recorded yet — the ledger appears when an uplift loop first fires `onEscalate` (uplift 1.4)._');
  } else {
    L.push(`${r.escalations.total} escalation(s):`);
    L.push('');
    L.push('| Tier | Count | Mean round |');
    L.push('|---|--:|--:|');
    for (const t of r.escalations.byTier) {
      L.push(`| ${t.tier} | ${t.count} | ${t.meanRound.toFixed(1)} |`);
    }
  }

  // --- Class coverage ----------------------------------------------------
  L.push('');
  L.push('## Quality-class coverage');
  L.push('');
  L.push(
    'None yet: neither corpus tags runs with a quality class (visual-scene, doc-style, …). ' +
    'Class-tagged rows arrive with anchor harvesting (E.2) and vision promotion (E.4); the table schema carries the column so they land without a migration.'
  );
  return L.join('\n');
}

function main(): void {
  const args = process.argv.slice(2);
  const explicit = args.includes('--results-dir')
    ? args[args.indexOf('--results-dir') + 1]
    : undefined;
  const cwd = process.cwd();
  const resultsDir = resolveResultsDir(cwd, explicit);
  const report = buildReport(resultsDir, readDeliverCorpus(cwd), readEscalationLedger(cwd));
  if (args.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  const md = renderMarkdown(report);
  if (args.includes('--write')) {
    const docPath = join(cwd, 'docs', 'performance', 'convergence-table.md');
    if (!existsSync(docPath)) {
      console.error(`${docPath} not found — create the doc with the CONVERGENCE markers first`);
      process.exitCode = 1;
      return;
    }
    const doc = readFileSync(docPath, 'utf-8');
    const begin = '<!-- CONVERGENCE:BEGIN -->';
    const end = '<!-- CONVERGENCE:END -->';
    const i = doc.indexOf(begin);
    const j = doc.indexOf(end);
    if (i < 0 || j < 0 || j < i) {
      console.error(`${docPath} is missing well-ordered ${begin} / ${end} markers`);
      process.exitCode = 1;
      return;
    }
    writeFileSync(docPath, `${doc.slice(0, i + begin.length)}\n${md}\n${doc.slice(j)}`);
    console.log(`updated ${docPath} (${report.pairedRuns.length} paired runs, ${report.delivery.length} delivery models)`);
    return;
  }
  console.log(md);
}

if (process.argv[1]?.endsWith('convergence-table.ts')) main();
