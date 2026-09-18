/**
 * `uap review` — deterministic review pre-pass (uplift 0.2).
 *
 *   prepass    scan the changed surface with the deterministic ruleset and
 *              report line-anchored findings before any LLM reviewer runs
 *
 * The parallel-expert-review skill runs this first and embeds the findings
 * into the review artifact (.uap/reviews/<branch>.json, `pre_pass` block),
 * so reviewers spend tokens on judgment, not pattern-matching.
 */
import chalk from 'chalk';
import {
  runPrePass,
  writePrePassArtifact,
  type PrePassFinding,
} from '../review/prepass.js';

export interface ReviewOptions {
  projectDir?: string;
  json?: boolean;
  files?: string;
  write?: boolean;
}

function printFindings(findings: PrePassFinding[]): void {
  for (const f of findings) {
    const sev = f.severity === 'high' ? chalk.red('HIGH') : chalk.yellow('MED ');
    console.log(`${sev} ${f.file}:${f.line} [${f.rule}] ${f.message}`);
    console.log(`     ${chalk.dim(f.snippet)}`);
  }
}

export async function reviewCommand(
  sub: string | undefined,
  options: ReviewOptions,
): Promise<void> {
  if (sub !== undefined && sub !== 'prepass') {
    console.log('Usage: uap review prepass [--files a,b] [--write] [--json]');
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
