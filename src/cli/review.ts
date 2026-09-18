/**
 * `uap review` — deterministic review support (uplifts 0.2 + 0.3).
 *
 *   prepass           scan the changed surface with the deterministic ruleset
 *                     and report line-anchored findings before any LLM
 *                     reviewer runs
 *   captures add      register a before/after capture pair for a UI diff
 *   captures [check]  validate that the current UI diff is covered by fresh
 *                     before/after captures (exit 1 when not)
 *
 * The parallel-expert-review skill runs the pre-pass first and embeds the
 * findings into the review artifact (.uap/reviews/<branch>.json, `pre_pass`
 * block), so reviewers spend tokens on judgment, not pattern-matching. UI
 * diffs additionally require captures (uplift 0.3), enforced at ship time by
 * the expert-review enforcer.
 */
import chalk from 'chalk';
import {
  runPrePass,
  writePrePassArtifact,
  type PrePassFinding,
} from '../review/prepass.js';
import {
  recordCapture,
  validateCaptures,
} from '../review/visual-captures.js';

export interface ReviewOptions {
  projectDir?: string;
  json?: boolean;
  files?: string;
  write?: boolean;
  before?: string;
  after?: string;
  tool?: string;
  note?: string;
}

function printFindings(findings: PrePassFinding[]): void {
  for (const f of findings) {
    const sev = f.severity === 'high' ? chalk.red('HIGH') : chalk.yellow('MED ');
    console.log(`${sev} ${f.file}:${f.line} [${f.rule}] ${f.message}`);
    console.log(`     ${chalk.dim(f.snippet)}`);
  }
}

const USAGE =
  'Usage: uap review prepass [--files a,b] [--write] [--json]\n' +
  '       uap review captures add --before <img> --after <img> [--tool t] [--note n]\n' +
  '       uap review captures [check] [--json]';

async function capturesCommand(action: string | undefined, options: ReviewOptions): Promise<void> {
  const projectDir = options.projectDir ?? process.cwd();

  if (action === 'add') {
    if (!options.before || !options.after || !options.tool?.trim()) {
      console.log('captures add requires --before <img>, --after <img>, and --tool <name>');
      process.exitCode = 1;
      return;
    }
    const result = recordCapture(projectDir, {
      tool: options.tool,
      before: options.before,
      after: options.after,
      ...(options.note ? { note: options.note } : {}),
    });
    if ('error' in result) {
      console.log(chalk.red(`captures add: ${result.error}`));
      process.exitCode = 1;
      return;
    }
    console.log(chalk.green(`recorded capture pair (${result.artifact.captures.length} total)`));
    console.log(chalk.dim(`artifact: ${result.path}`));
    return;
  }

  if (action !== undefined && action !== 'check') {
    console.log(USAGE);
    process.exitCode = 1;
    return;
  }

  // check (also the bare `uap review captures`): blocking semantics — a UI
  // diff without fresh captures exits 1 so CI and agents can gate on it.
  const v = validateCaptures(projectDir);
  if (options.json) {
    console.log(JSON.stringify(v, null, 2));
  } else {
    const head = v.required
      ? `UI diff: ${v.uiFiles.length} file(s) require captures`
      : 'no UI files in the diff — captures not required';
    console.log(chalk.bold(`review captures: ${head}`));
    for (const r of v.reasons) console.log(`  ${v.ok ? chalk.dim(r) : chalk.red(r)}`);
    if (v.required && v.ok) console.log(chalk.green('covered — capture paths belong in the review artifact'));
    if (v.required) console.log(chalk.dim(`artifact: ${v.artifactPath}`));
  }
  if (v.required && !v.ok) process.exitCode = 1;
}

export async function reviewCommand(
  subs: string[],
  options: ReviewOptions,
): Promise<void> {
  const [sub, action] = subs;
  if (sub === 'captures') {
    await capturesCommand(action, options);
    return;
  }
  if (sub !== undefined && sub !== 'prepass') {
    console.log(USAGE);
    process.exitCode = 1;
    return;
  }
  const projectDir = options.projectDir ?? process.cwd();
  const files = options.files?.split(',').map((f) => f.trim()).filter(Boolean);
  const { findings, filesScanned } = runPrePass({
    projectDir,
    files: files && files.length > 0 ? files : undefined,
  });

  let artifactPath: string | undefined;
  if (options.write) {
    const written = writePrePassArtifact(projectDir, findings, filesScanned.length);
    artifactPath = written?.path;
  }

  // Advisory by design: findings inform reviewers; blocking stays with the
  // expert-review enforcer. High-severity findings flip the exit code so CI
  // and scripts can gate on it — this must hold on the --json path too,
  // which is exactly the path CI consumes.
  if (findings.some((f) => f.severity === 'high')) process.exitCode = 1;

  if (options.json) {
    console.log(JSON.stringify({ files_scanned: filesScanned.length, findings, artifact: artifactPath ?? null }, null, 2));
    return;
  }

  console.log(chalk.bold(`review pre-pass: ${filesScanned.length} files scanned, ${findings.length} findings`));
  printFindings(findings);
  if (artifactPath) console.log(chalk.dim(`artifact: ${artifactPath}`));
  if (findings.length === 0) console.log(chalk.green('clean — hand off to the LLM reviewers'));
}
