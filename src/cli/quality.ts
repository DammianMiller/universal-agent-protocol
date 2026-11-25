/**
 * `uap quality` — quality-metrics gate.
 *
 *   init       write .uap/quality-metrics.json with the default thresholds
 *   check      scan files for metric violations; ratchet against the baseline
 *   baseline   regenerate .uap/quality-baseline.json (--update)
 *   report     full report including grandfathered violations and skips
 *   mutate     Stryker incremental mutation run scoped to changed files
 *   anchor     measure PNG exemplar(s) into tier anchors (0.1)
 *   profile    measure one PNG capture into a deterministic vector (0.1)
 *   derive     derive a tier (thresholds) from a class's anchors (0.2)
 *   gap        gap a capture against a tier; verdict + critique (0.2)
 *   approve    pin a run's outputs as anchors + re-derive the tier (E.2, wave 2.2)
 *
 * Gate parity: the Python proxy enforcer `quality_metrics_gate.py` mirrors the fast
 * path (LOC, complexity, any-types) so agent edits are blocked pre-exec with
 * the same thresholds and baseline this CLI enforces at commit/CI time.
 */
import chalk from 'chalk';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { spawnSync } from 'child_process';
import { isAbsolute, join, relative } from 'path';
import {
  QualityConfig, configPath, defaultConfig, loadQualityConfig, writeDefaultConfig,
} from '../quality/config.js';
import { baselinePath, loadBaseline, writeBaseline } from '../quality/baseline.js';
import { buildReport, changedFiles, QualityReport } from '../quality/report.js';
import { scanContent } from '../quality/scanner.js';
import { TierVector } from '../quality/tier.js';
import { resolveClass, storeArtifactAnchor } from '../quality/classes.js';
import {
  TierLadderCandidate,
  recordLadderRun,
  runTierLadder,
  summarizeLadderRuns,
} from '../quality/tier-ladder.js';
import { classSamplingProfile, tierContractText, tierKeysFor } from '../quality/tier-contract.js';
import { DEFAULT_TOLERANCE, deriveTier, gapReport, loadTiers, saveGlobalTier } from '../quality/tiers.js';
import { CorpusNoveltyOpts, corpusNovelty } from '../quality/ideation-corpus.js';
import { sectionsOf } from '../quality/ideation.js';

export interface QualityOptions {
  projectDir?: string;
  json?: boolean;
  files?: string;
  staged?: boolean;
  update?: boolean;
  changed?: boolean;
  file?: string;
  /** Anchor class when invoked as `uap quality anchor <class>` (mapped from the positional target). */
  target?: string;
  /** Tier key (class/name) for the gap subcommand. */
  tier?: string;
  /** Gap: corpus-novelty advisory overlay (wave 4 H) — live embedding seam. */
  corpus?: boolean;
  /** Tier name for the derive subcommand. */
  name?: string;
  /** Multiplicative tolerance floor for the derive subcommand (default 0.75). */
  tolerance?: string;
  /** Outcome class for the profile subcommand (default: visual-scene). */
  class?: string;
  /** Rounds directory for the ladder subcommand (roundNN/ subdirectories). */
  roundsDir?: string;
  /** Round ceiling for the ladder subcommand. */
  maxRounds?: string;
  /** Candidates per round for the ladder subcommand. */
  candidates?: string;
  /** Rounds without improvement before the ladder escalates. */
  plateauRounds?: string;
  /** Run-outputs directory for the approve subcommand (E.2): every readable
   *  artifact file in it becomes an anchor for the class. `fromDir` is the
   *  programmatic name; commander maps the `--from` flag onto `from`. */
  fromDir?: string;
  from?: string;
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
    case 'anchor':
      return anchorCmd(dir, options);
    case 'profile':
      return profileCmd(options);
    case 'derive':
      return deriveCmd(dir, options);
    case 'gap':
      return gapCmd(dir, options);
    case 'approve':
      return approveCmd(dir, options);
    case 'ladder':
      return ladderCmd(dir, options);
    case 'convergence':
      return convergenceCmd(dir, options);
    case 'contract':
      return contractCmd(dir, options);
    case 'publish':
      return publishCmd(dir, options);
    default:
      console.log(chalk.bold('uap quality — quality-metrics gate\n'));
      console.log('  init                Write .uap/quality-metrics.json (activates the gate)');
      console.log('  check               Scan + ratchet; exit 2 on blocking violations');
      console.log('  check --staged      Scan only files changed vs upstream base');
      console.log('  check --file <f>    Scan one file (content may come from stdin)');
      console.log('  baseline --update   Regenerate .uap/quality-baseline.json (ratchet)');
      console.log('  report              Verbose report incl. grandfathered + skipped');
      console.log('  mutate --changed    Stryker incremental on changed files');
      console.log('  anchor <class>      Measure exemplar artifact(s) into tier anchors (--file/--files)');
      console.log('  profile --file <f>  Measure one artifact into a deterministic vector (--class)');
      console.log('  derive <class>      Derive a tier from a class\'s anchors (--name, --tolerance)');
      console.log('  gap --file <f>      Gap an artifact against a tier (--tier <class/name>, --corpus for the advisory novelty overlay); exit 2 below tier');
      console.log('  ladder --rounds-dir Rank harvested best-of-N rounds against a tier (--tier); escalation + honest cut');
      console.log('  approve --from <d>  Pin a run\'s outputs as anchors + re-derive the tier (approveVisualBaseline precedent)');
      console.log('  convergence         Per-tier convergence telemetry — the tier-gate promotion budget');
      console.log('  contract --tier <k>  Print the tier contract (the injectable executor-prompt block)');
      console.log('  publish <class/name> Copy a project tier into the fleet-global store — it then auto-applies');
      console.log('                      (UAP_TIER_STORE or ~/.uap/quality/tiers.json; project tiers override on collision)');
      console.log(chalk.dim('  Classes: visual-scene (PNG), api-behavior (API transcript JSON), bench-score (bench results JSON),'));
      console.log(chalk.dim('  doc-style (Markdown), ideation-outcome (Markdown, one ## section per candidate).'));
      console.log(chalk.dim('  Anchors are project-local, gitignored, measuring-only (P39).'));
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

// ─── Tier layer (quality-tier uplift plan, 2026-11-16) ──────────────────────

function anchorPaths(options: QualityOptions): string[] {
  const paths: string[] = [];
  if (options.file) paths.push(options.file);
  if (options.files) paths.push(...options.files.split(',').map((f) => f.trim()).filter(Boolean));
  return [...new Set(paths)];
}

const summaryLine = (v: TierVector): string =>
  `colors=${v.colors12} sat=${v.satMean} val=${v.valMean} contrast=${v.contrast} ` +
  `edge=${v.edgeFrac} glow=${v.glowFrac} dark=${v.darkFrac}`;

/** Class-generic one-liner: visual keeps the named-field line, others list scalars. */
function vectorSummary(v: TierVector, cls: string): string {
  if (cls === 'visual-scene') return summaryLine(v);
  const scalars = Object.entries(v.scalars ?? {})
    .map(([k, x]) => `${k}=${x}`)
    .join(' ');
  return scalars || `extractor=v${v.extractorVersion}`;
}

/**
 * `uap quality anchor <class> --file a.png [--files a.png,b.png]` — measure
 * exemplar(s) and store them as tier anchors under .uap/quality/anchors/.
 * The class picks the extractor: visual-scene reads PNG captures, api-behavior
 * reads API transcripts, bench-score reads bench results. Anchors are measuring
 * references only: project-local, gitignored, never shipped (P39). Unreadable
 * inputs are reported and fail the command.
 */
function anchorCmd(dir: string, options: QualityOptions): void {
  const paths = anchorPaths(options);
  if (!options.target || paths.length === 0) {
    console.log(chalk.yellow('  Usage: uap quality anchor <class> --file <artifact> [--files <a,b>]'));
    process.exitCode = 2;
    return;
  }
  const spec = resolveClass(options.target);
  const vectors: TierVector[] = [];
  let failed = 0;
  for (const p of paths) {
    const rec = storeArtifactAnchor(dir, options.target, p);
    if (!rec) {
      console.log(chalk.red(`  ✗ ${p} — not a readable ${spec.artifact} (class '${options.target}')`));
      failed += 1;
      continue;
    }
    vectors.push(rec.vector);
    console.log(chalk.green(`  ✓ anchor ${rec.cls}/${rec.name}`));
    console.log(chalk.dim(`    ${vectorSummary(rec.vector, rec.cls)}`));
    console.log(chalk.dim(`    ${rec.profilePath}`));
  }
  if (options.json) console.log(JSON.stringify(vectors, null, 2));
  if (failed > 0) process.exitCode = 2;
}

/** `uap quality profile --file <f> [--class <cls>]` — print one artifact's deterministic vector. */
function profileCmd(options: QualityOptions): void {
  const paths = anchorPaths(options);
  const target = options.file || paths[0];
  if (!target) {
    console.log(chalk.yellow('  Usage: uap quality profile --file <artifact> [--class <class>]'));
    process.exitCode = 2;
    return;
  }
  const cls = options.class || 'visual-scene';
  const spec = resolveClass(cls);
  const v = spec.extract(target);
  if (!v) {
    console.log(chalk.red(`  ✗ ${target} — not a readable ${spec.artifact} (class '${cls}')`));
    process.exitCode = 2;
    return;
  }
  if (options.json) {
    console.log(JSON.stringify(v, null, 2));
    return;
  }
  console.log(chalk.bold(`\n  tier vector: ${target}`));
  console.log(`    ${vectorSummary(v, cls)}`);
  if (cls === 'visual-scene' && v.dominant) {
    console.log(chalk.dim(`    dominant: ${v.dominant.map((d) => `#${d.hex.toString(16).padStart(6, '0')} ${Math.round(d.frac * 100)}%`).join(' · ')}`));
  }
  console.log(chalk.dim(`    sha256=${v.sha256.slice(0, 16)}… extractor=v${v.extractorVersion}`));
}

/** `uap quality derive <class> --name <tier> [--tolerance 0.75]` — anchors -> thresholds policy. */
function deriveCmd(dir: string, options: QualityOptions): void {
  const cls = options.target;
  if (!cls) {
    console.log(chalk.yellow('  Usage: uap quality derive <class> --name <tier> [--tolerance 0.75]'));
    process.exitCode = 2;
    return;
  }
  const tolerance = options.tolerance === undefined ? DEFAULT_TOLERANCE : Number(options.tolerance);
  if (!Number.isFinite(tolerance) || tolerance <= 0 || tolerance > 1) {
    console.log(chalk.red('  ✗ --tolerance must be a multiplicative floor in (0, 1], e.g. 0.75'));
    process.exitCode = 2;
    return;
  }
  const tier = deriveTier(dir, cls, options.name || 'default', tolerance);
  if (!tier) {
    console.log(chalk.red(`  ✗ class '${cls}' has no anchors at the current extractor version.`));
    console.log(chalk.dim(`    Add measuring references first: uap quality anchor <class> --file <artifact of ${resolveClass(cls).artifact}>`));
    process.exitCode = 2;
    return;
  }
  if (options.json) {
    console.log(JSON.stringify(tier, null, 2));
    return;
  }
  console.log(chalk.green(`  ✓ tier ${tier.key} (from ${tier.anchorCount} anchor(s), tolerance ${tier.tolerance})`));
  for (const [axis, th] of Object.entries(tier.thresholds)) {
    const band = th.min !== undefined && th.max !== undefined
      ? `${th.min}..${th.max}`
      : th.min !== undefined
        ? `>= ${th.min}`
        : `<= ${th.max}`;
    console.log(`    ${axis.padEnd(10)} ${band}`);
  }
  console.log(chalk.dim('    Review and edit the policy file: .uap/quality/tiers.json'));
}

/**
 * `uap quality approve <class> --from <runOutputsDir> [--name <tier>]` — the
 * approveVisualBaseline precedent for quality classes (E.2, wave 2.2): one
 * operator action pins a run's outputs as the anchors for their class, then
 * re-derives the tier — every approved frontier-grade artifact raises the bar
 * for free. Reads every FILE in --from (non-recursive, sorted): files the
 * class extractor cannot read (report.json, logs, dotfiles) count as skipped,
 * not failures — run-output directories are mixed. Exit 2 when the directory
 * is missing, or when nothing was anchored (nothing approved, no bar change).
 */
export function approveCmd(dir: string, options: QualityOptions): void {
  const cls = options.target;
  const fromRaw = options.fromDir ?? options.from;
  if (!cls || !fromRaw) {
    console.log(
      chalk.yellow('  Usage: uap quality approve <class> --from <runOutputsDir> [--name <tier>] [--tolerance 0.75]')
    );
    process.exitCode = 2;
    return;
  }
  const root = isAbsolute(fromRaw) ? fromRaw : join(dir, fromRaw);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    console.log(chalk.red(`  ✗ ${root} — not a directory`));
    process.exitCode = 2;
    return;
  }
  const files = readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isFile() && !e.name.startsWith('.'))
    .map((e) => join(root, e.name))
    .sort();
  if (files.length === 0) {
    console.log(chalk.red(`  ✗ ${root} — no files to approve`));
    process.exitCode = 2;
    return;
  }
  const spec = resolveClass(cls);
  const tolerance = options.tolerance === undefined ? DEFAULT_TOLERANCE : Number(options.tolerance);
  if (!Number.isFinite(tolerance) || tolerance <= 0 || tolerance > 1) {
    console.log(chalk.red('  ✗ --tolerance must be a multiplicative floor in (0, 1], e.g. 0.75'));
    process.exitCode = 2;
    return;
  }

  console.log(chalk.bold(`\n  Approving ${files.length} file(s) from ${root} as '${cls}' anchors\n`));
  let stored = 0;
  let skipped = 0;
  for (const p of files) {
    const rec = storeArtifactAnchor(dir, cls, p);
    if (!rec) {
      skipped += 1;
      console.log(chalk.dim(`  – skipped ${p} — not a readable ${spec.artifact}`));
      continue;
    }
    stored += 1;
    console.log(chalk.green(`  ✓ anchor ${rec.cls}/${rec.name}`));
    console.log(chalk.dim(`    ${rec.profilePath}`));
  }
  if (stored === 0) {
    console.log(chalk.red(`\n  ✗ nothing anchored — no tier change (${skipped} file(s) skipped)`));
    process.exitCode = 2;
    return;
  }

  // Re-derive so the approved anchors raise the bar immediately ("for free").
  const tier = deriveTier(dir, cls, options.name || 'default', tolerance);
  if (!tier) {
    console.log(chalk.red('\n  ✗ anchors stored but the tier could not be re-derived (extractor mismatch?)'));
    process.exitCode = 2;
    return;
  }
  console.log(
    chalk.green(`\n  ✓ approved: ${stored} anchor(s) added (${skipped} skipped) — tier ${tier.key} re-derived`)
  );
  if (options.json) {
    console.log(JSON.stringify({ cls, stored, skipped, tier }, null, 2));
    return;
  }
  for (const [axis, th] of Object.entries(tier.thresholds)) {
    const band = th.min !== undefined && th.max !== undefined
      ? `${th.min}..${th.max}`
      : th.min !== undefined
        ? `>= ${th.min}`
        : `<= ${th.max}`;
    console.log(`    ${axis.padEnd(10)} ${band}`);
  }
  console.log(chalk.dim('    Review and edit the policy file: .uap/quality/tiers.json'));
}

/** `uap quality gap --file <png> --tier <class/name>` — verdict + per-axis critique. */
export async function gapCmd(
  dir: string,
  options: QualityOptions,
  corpusSeam: CorpusNoveltyOpts = {}
): Promise<void> {
  const file = options.file || (options.files ? options.files.split(',')[0] : undefined);
  if (!file || !options.tier) {
    console.log(chalk.yellow('  Usage: uap quality gap --file <artifact> --tier <class/name>'));
    process.exitCode = 2;
    return;
  }
  const res = gapReport(dir, file, options.tier);
  if (res.kind === 'no-tier') {
    console.log(chalk.red(`  ✗ unknown tier '${options.tier}'`));
    console.log(chalk.dim(`    known: ${res.known.length ? res.known.join(', ') : '(none — derive one first: uap quality derive <class>)'}`));
    process.exitCode = 2;
    return;
  }
  if (res.kind === 'stale-tier') {
    console.log(chalk.red(`  ✗ tier '${options.tier}' was derived by extractor v${res.tierVersion}; the current extractor differs. Re-derive it (fail closed): uap quality derive <class>`));
    process.exitCode = 2;
    return;
  }
  if (res.kind === 'unreadable') {
    console.log(chalk.red(`  ✗ ${file} — not a readable ${resolveClass(res.cls).artifact} (class '${res.cls}')`));
    process.exitCode = 2;
    return;
  }
  const report = res.report;
  // Wave 4 H — corpus-novelty overlay: the retread axis the deterministic
  // extractors cannot see. Distance of each ideation candidate from the
  // fleet's nearest prior solution, measured live on the embedding seam.
  // ADVISORY by construction: it never changes this command's exit code —
  // the tier thresholds stay deterministic; promotion to a gating axis is
  // an explicit operator act once the advisory has evidence behind it.
  // Fail-open: an unavailable seam says why and the gap still reports.
  let corpus: Awaited<ReturnType<typeof corpusNovelty>> | null = null;
  if (options.corpus) {
    const cls = report.tier.split('/')[0];
    if (cls !== 'ideation-outcome') {
      console.log(chalk.dim(`  ◦ corpus-novelty overlay applies to ideation-outcome artifacts (gapping '${cls}') — skipped`));
    } else {
      const candidates = sectionsOf(readFileSync(file, 'utf-8'));
      if (candidates.length === 0) {
        console.log(chalk.dim('  ◦ corpus_novelty: no candidate sections — skipped (advisory)'));
      } else {
        corpus = await corpusNovelty(
          candidates.map((s) => ({ prose: s.prose })),
          { cwd: dir, ...corpusSeam }
        );
        if (!corpus.ok) {
          console.log(chalk.dim(`  ◦ corpus_novelty: unavailable — ${corpus.reason ?? 'unknown'} (advisory, non-gating)`));
          corpus = null;
        }
      }
    }
  }
  if (options.json) {
    console.log(JSON.stringify(corpus ? { ...report, corpus } : report, null, 2));
  } else {
    const head = report.pass ? chalk.green(`  ✓ tier ${report.tier}`) : chalk.red(`  ✗ tier ${report.tier}`);
    console.log(chalk.bold(`\n  ${head} — ${file}`));
    for (const a of report.axes) {
      const mark = a.status === 'pass' ? chalk.green('✓') : chalk.red('✗');
      const band = a.threshold.min !== undefined && a.threshold.max !== undefined
        ? `[${a.threshold.min}, ${a.threshold.max}]`
        : a.threshold.min !== undefined ? `>= ${a.threshold.min}` : `<= ${a.threshold.max}`;
      console.log(`    ${mark} ${a.axis.padEnd(10)} ${a.value} (tier ${band})`);
      if (a.directive) console.log(chalk.dim(`      → ${a.directive}`));
    }
    console.log(`\n    ${report.failing} of ${report.axes.length} axes below tier${report.worst ? ` · worst: ${report.worst}` : ''}`);
    if (corpus) {
      console.log(chalk.dim(
        `    ◦ corpus_novelty (advisory, non-gating): mean ${corpus.mean} · closest-to-prior ${corpus.min} · store ${corpus.collections.join(', ') || '(empty)'}`
      ));
    }
  }
  if (!report.pass) process.exitCode = 2;
}

/* ─── Tier ladder (Wave 1.2): best-of-N rounds, escalation, honest cut ────── */

/** Round directories `roundNN` sorted numerically; files within sorted by name. */
function discoverRounds(roundsRoot: string): string[] {
  if (!existsSync(roundsRoot)) return [];
  const out: Array<{ n: number; dir: string }> = [];
  for (const entry of readdirSync(roundsRoot)) {
    const m = /^round(\d+)$/.exec(entry);
    if (!m) continue;
    const full = join(roundsRoot, entry);
    if (statSync(full).isDirectory()) out.push({ n: Number(m[1]), dir: full });
  }
  return out.sort((a, b) => a.n - b.n).map((x) => x.dir);
}

function ladderInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const v = raw === undefined ? fallback : Number(raw);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, Math.round(v)));
}

/**
 * `uap quality convergence` — Wave 2.1: per-tier convergence telemetry from
 * the recorded ladder runs. This is the promotion-budget evidence for the
 * tier gate's shadow→block decision (the System-1 rule): a tier with a
 * measured cut-rate/winner-pass budget is promotable; a tier with no runs
 * is not, no matter how long it has been in shadow.
 */
function convergenceCmd(dir: string, options: QualityOptions): void {
  const { summaries, totalRuns, logPath } = summarizeLadderRuns(dir);
  if (options.json) {
    console.log(JSON.stringify({ totalRuns, logPath, summaries }, null, 2));
    return;
  }
  console.log(chalk.bold(`\n  Tier-ladder convergence (${totalRuns} recorded run(s))`));
  console.log(chalk.dim(`    log: ${logPath}`));
  if (totalRuns === 0) {
    console.log(chalk.dim('\n    No ladder runs recorded yet — run `uap quality ladder` first.'));
    console.log(
      chalk.dim(
        '    The tier gate stays in shadow until this log holds the measured budget (UAP_TIER_GATE=block promotes).'
      )
    );
    return;
  }
  console.log(
    `\n    ${'tier'.padEnd(28)}${'runs'.padStart(5)}  ${'reached'.padStart(7)}  ${'cut%'.padStart(6)}  ` +
      `${'escal%'.padStart(7)}  ${'rounds→tier'.padStart(11)}  ${'win%'.padStart(6)}  cand/run  ${'agree'.padStart(5)}  ${'FP%'.padStart(4)}`
  );
  for (const s of summaries) {
    const rtt = s.meanRoundsToTier === null ? '—' : s.meanRoundsToTier.toFixed(1);
    const cut = `${(s.cutRate * 100).toFixed(0)}%`;
    const escal = `${(s.escalationRate * 100).toFixed(0)}%`;
    const win = `${(s.winnerPassRate * 100).toFixed(0)}%`;
    const agree = s.agreementRuns > 0 ? String(s.agreementRuns) : '—';
    // The shadow false-positive rate is THE promotion input: the share of
    // dual-arm turns where the tier flagged below-tier but the judge passed
    // — exactly the good work a block-mode promotion would start refusing.
    const fp =
      s.shadowFalsePositiveRate === null
        ? '—'
        : `${(s.shadowFalsePositiveRate * 100).toFixed(0)}%${s.shadowFalsePositives > 0 ? chalk.yellow('⚠') : ''}`;
    const mark = s.cutRate >= 0.5 ? chalk.red : s.cutRate > 0 ? chalk.yellow : chalk.green;
    console.log(
      `    ${s.tier.padEnd(28)}${String(s.runs).padStart(5)}  ${String(s.tierReached).padStart(7)}  ` +
        `${mark(cut.padStart(6))}  ${escal.padStart(7)}  ${rtt.padStart(11)}  ${win.padStart(6)}  ` +
        `${s.meanCandidates.toFixed(1)}  ${agree.padStart(5)}  ${fp.padStart(4)}`
    );
  }
  console.log(
    chalk.dim(
      '\n    agree/FP% = runs carrying a judge verdict (wave 5 K dual-arm records) and the\n' +
        '    shadow false-positive rate among them — below-tier tier flags on turns the\n' +
        '    judge passed. Promotion to block needs the budget AND a low FP rate; an\n' +
        '    em-dash means no dual-arm evidence yet (pre-K records have no judge arm).\n' +
        '    Descriptive (no controlled arm).'
    )
  );
  console.log('');
}

/**
 * `uap quality ladder --tier <class/name> --rounds-dir <dir>` — rank harvested
 * best-of-N candidate artifacts against a tier, round by round: each
 * roundNN/ subdirectory holds that round's N variants (the operator's model
 * runs, saved to disk). The best survivor per round is measured, the ladder
 * fires on a plateau, and exhaustion below tier cuts with the gap documented.
 */
async function ladderCmd(dir: string, options: QualityOptions): Promise<void> {
  if (!options.roundsDir || !options.tier) {
    console.log(chalk.yellow('  Usage: uap quality ladder --tier <class/name> --rounds-dir <dir> [--max-rounds N] [--candidates N] [--plateau-rounds K]'));
    process.exitCode = 2;
    return;
  }
  const roundsRoot = isAbsolute(options.roundsDir) ? options.roundsDir : join(dir, options.roundsDir);
  const roundDirs = discoverRounds(roundsRoot);
  if (roundDirs.length === 0) {
    console.log(chalk.red(`  ✗ ${roundsRoot} — no roundNN/ subdirectories (round01/, round02/, … each holding that round's candidate artifacts)`));
    process.exitCode = 2;
    return;
  }
  const maxRounds = ladderInt(options.maxRounds, roundDirs.length, 1, roundDirs.length);
  const candidates = ladderInt(options.candidates, 3, 1, 8);
  const plateauRounds = ladderInt(options.plateauRounds, 2, 1, maxRounds);

  const candidatesOf = (roundDir: string): TierLadderCandidate[] => {
    if (!existsSync(roundDir)) return [];
    return readdirSync(roundDir)
      .filter((f) => statSync(join(roundDir, f)).isFile())
      .sort()
      .map((f) => ({ id: f, artifactPath: join(roundDir, f) }));
  };

  const result = await runTierLadder({
    projectRoot: dir,
    tierKey: options.tier,
    maxRounds,
    candidatesPerRound: candidates,
    plateauRounds,
    generate: (round) => candidatesOf(roundDirs[round - 1] ?? ''),
  });

  // Wave 2.1: every completed run lands in the convergence log — the
  // evidence the tier gate's shadow→block promotion decision reads.
  recordLadderRun(dir, {
    tier: result.tier,
    outcome: result.outcome,
    rounds: result.rounds.length,
    candidatesMeasured: result.rounds.reduce((a, r) => a + r.candidates.length, 0),
    winnerPassed: result.winner === null ? null : result.outcome === 'tier-reached',
    escalationFired: result.escalationFired,
    model: null, // the harvested-runs CLI does not attribute the executor
  });

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    const head = result.outcome === 'tier-reached'
      ? chalk.green(`  ✓ ${result.summary}`)
      : chalk.red(`  ✗ ${result.summary}`);
    console.log(chalk.bold(`\n  ${head}`));
    const contract = tierContractText(dir, options.tier);
    if (contract) {
      const axes = contract.split('\n').filter((l) => l.startsWith('- ')).length;
      console.log(chalk.dim(`    contract carried by the executor prompt: ${axes} axis(es) · sampling ${classSamplingProfile(options.tier.split('/')[0] ?? '')?.temperature ?? 'executor default'}`));
    }
    for (const r of result.rounds) {
      const best = r.best ? `best ${r.best}` : 'no measurable candidate';
      const esc = r.escalated ? chalk.yellow(' · ↑ escalation fired') : '';
      const cut = r.cut ? chalk.red(` · cut: ${r.cut.reason}`) : '';
      console.log(`    round ${String(r.round).padStart(2, '0')}  ${r.candidates.length} candidate(s) · ${best}${esc}${cut}`);
    }
    if (result.finalGap) {
      const gap = result.finalGap;
      console.log(chalk.dim(`    final: ${gap.failing} of ${gap.axes.length} axes below tier${gap.worst ? ` · worst: ${gap.worst}` : ''}`));
      for (const a of gap.axes.filter((x) => x.status === 'fail').slice(0, 5)) {
        console.log(`      ${chalk.red('✗')} ${a.axis} ${a.value} → ${a.directive ?? 'below tier'}`);
      }
    }
    if (result.escalationFired) {
      console.log(chalk.dim(`    escalation recorded for the operator: ${join(dir, '.uap', 'quality', 'escalations.jsonl')}`));
    }
  }
  if (result.outcome !== 'tier-reached') process.exitCode = 2;
}

/**
 * `uap quality contract --tier <class/name>` — print the tier contract: the
 * measured axes with thresholds, the failure directives, the evidence guard,
 * and the class sampling profile. This is the block an executor prompt
 * carries (Wave 1.3: the model climbs toward the bar, not through failed gates).
 */
function contractCmd(dir: string, options: QualityOptions): void {
  if (!options.tier) {
    const known = tierKeysFor(dir);
    console.log(chalk.yellow('  Usage: uap quality contract --tier <class/name>'));
    if (known.length > 0) console.log(chalk.dim(`    known tiers: ${known.join(', ')}`));
    process.exitCode = 2;
    return;
  }
  const contract = tierContractText(dir, options.tier);
  if (!contract) {
    const known = tierKeysFor(dir);
    console.log(chalk.red(`  ✗ unknown tier '${options.tier}'`));
    console.log(chalk.dim(`    known: ${known.length ? known.join(', ') : '(none — derive one first: uap quality derive <class>)'}`));
    process.exitCode = 2;
    return;
  }
  const cls = options.tier.split('/')[0] ?? options.tier;
  const sampling = classSamplingProfile(cls);
  console.log(chalk.bold(`\n  tier contract: ${options.tier}`));
  console.log(contract.split('\n').map((l) => `    ${l}`).join('\n'));
  if (!sampling) {
    console.log(chalk.dim('\n    sampling: no class profile declared — the executor keeps its own default'));
  }
}

/**
 * `uap quality publish <class/name>` — copy a project-derived tier into the
 * fleet-global store (UAP_TIER_STORE or ~/.uap/quality/tiers.json). The
 * published tier then auto-applies: every project's tier gate, contract
 * composer, and gap resolution see it through resolveTiers (project tiers
 * still override on key collision). Publishing is the explicit opt-in —
 * the global store does not exist until an operator does this.
 */
function publishCmd(dir: string, options: QualityOptions): void {
  const key = options.tier || options.target;
  if (!key || !key.includes('/')) {
    console.log(chalk.yellow('  Usage: uap quality publish <class/name>'));
    console.log(chalk.dim('    Copies the tier from this project\'s store into the fleet-global store;'));
    console.log(chalk.dim('    every project then resolves it (project tiers override on collision).'));
    process.exitCode = 2;
    return;
  }
  // The project store only — publishing reads what THIS project derived
  // (never the global store itself: re-publishing a borrowed tier is a no-op
  // at best and laundering at worst).
  const tier = loadTiers(dir).tiers[key];
  if (!tier) {
    const known = tierKeysFor(dir);
    console.log(chalk.red(`  ✗ tier '${key}' is not in this project's store`));
    console.log(chalk.dim(`    known here: ${known.length ? known.join(', ') : '(none — derive one first: uap quality derive <class>)'}`));
    console.log(chalk.dim('    (a fleet-global tier can be published by the project that derived it)'));
    process.exitCode = 2;
    return;
  }
  const path = saveGlobalTier(tier);
  console.log(chalk.green(`  ✓ published tier ${key} to the fleet-global store`));
  console.log(chalk.dim(`    ${path}`));
  console.log(chalk.dim(`    every project now resolves it — tier gate (shadow), contract, and gap — until a`));
  console.log(chalk.dim(`    project derives its own '${key}' (project policy overrides on collision).`));
  console.log(chalk.dim('    anchor paths stay absolute (machine-local); re-derive on the deriving machine.'));
}
