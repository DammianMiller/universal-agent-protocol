/**
 * Real-gate task-suite loader + verifier.
 *
 * A suite is a directory of task folders:
 *
 *   benchmarks/suites/real-gate/
 *     <task-id>/
 *       task.json        # TaskSpec (without `id`; id derives from folder name)
 *       repo/            # git fixture in a failing state
 *
 * The `verifyCmd` in task.json is the deterministic ground-truth scorer: it runs
 * inside an isolated copy of `repo/` and must exit 0 iff the task is resolved.
 * No LLM judge — coding tasks give us real test execution as ground truth.
 */

import { spawnSync } from 'child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { TaskSpec, TaskSpecSchema } from './types.js';

/** Load and validate a single task folder. The folder name becomes the id. */
export function loadTask(taskDir: string): TaskSpec {
  const specPath = join(taskDir, 'task.json');
  if (!existsSync(specPath)) {
    throw new Error(`Task folder ${taskDir} is missing task.json`);
  }
  const raw = JSON.parse(readFileSync(specPath, 'utf-8')) as Record<string, unknown>;
  // Folder name is the canonical id unless task.json overrides it.
  const id = (raw.id as string) ?? taskDir.split('/').filter(Boolean).pop() ?? 'task';
  const parsed = TaskSpecSchema.parse({ ...raw, id });

  const repoPath = join(taskDir, parsed.repoDir);
  if (!existsSync(repoPath)) {
    throw new Error(`Task ${id}: repo dir '${parsed.repoDir}' not found at ${repoPath}`);
  }
  return parsed;
}

/** Load every task folder under a suite directory (sorted by id for stability). */
export function loadSuite(suiteDir: string): TaskSpec[] {
  if (!existsSync(suiteDir)) {
    throw new Error(`Suite directory not found: ${suiteDir}`);
  }
  const entries = readdirSync(suiteDir)
    .filter((name) => !name.startsWith('.'))
    .map((name) => join(suiteDir, name))
    .filter((p) => statSync(p).isDirectory() && existsSync(join(p, 'task.json')));

  const tasks = entries.map(loadTask).sort((a, b) => a.id.localeCompare(b.id));
  if (tasks.length === 0) {
    throw new Error(`No tasks found in suite ${suiteDir}`);
  }
  return tasks;
}

/** Absolute path to a task's fixture repo, given the suite dir. */
export function taskRepoPath(suiteDir: string, task: TaskSpec): string {
  return join(suiteDir, task.id, task.repoDir);
}

/**
 * Copy a task's fixture repo into a fresh isolated scratch directory so every
 * run starts from the identical failing state (common-random-numbers principle:
 * only the UAP toggle differs between arms).
 */
export function materializeWorkdir(suiteDir: string, task: TaskSpec, workRoot: string): string {
  mkdirSync(workRoot, { recursive: true });
  const scratch = mkdtempSync(join(workRoot, `${task.id}-`));
  const dest = join(scratch, 'repo');
  cpSync(taskRepoPath(suiteDir, task), dest, { recursive: true });
  // The workdir must be a git repository with a baseline commit: deliver's
  // project-preflight REFUSES a non-repo (its candidate workspace is worktree
  // based), so every deliver-adapter cell exited in ~1s with preflightFailed
  // and 0% scored in BOTH arms (paired-uplift-v1204-r2, 2026-08-13). Inert
  // for the other adapters. GIT_* env is stripped for the same reason
  // runVerify strips it — an inherited GIT_DIR would point these commands at
  // an enclosing repo instead of the scratch copy.
  if (!existsSync(join(dest, '.git'))) {
    const git = (...args: string[]): void => {
      const r = spawnSync('git', args, { cwd: dest, encoding: 'utf-8', env: sanitizedEnv() });
      if (r.status !== 0) {
        throw new Error(`workdir git ${args[0]} failed: ${(r.stderr || r.stdout || '').slice(0, 200)}`);
      }
    };
    git('init', '-q');
    git('-c', 'user.email=bench@uap', '-c', 'user.name=bench', 'add', '-A');
    git('-c', 'user.email=bench@uap', '-c', 'user.name=bench', 'commit', '-q', '-m', 'baseline', '--allow-empty');
  }
  return dest;
}

/** Make a fresh scratch dir under the OS tmp (used when no workRoot is given). */
export function tmpWorkRoot(): string {
  return mkdtempSync(join(tmpdir(), 'uap-bench-'));
}

export interface VerifyResult {
  passed: boolean;
  exitCode: number;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

/** Run the task's deterministic verify command inside `workdir`. */
export function runVerify(task: TaskSpec, workdir: string): VerifyResult {
  const res = spawnSync('bash', ['-lc', task.verifyCmd], {
    cwd: workdir,
    encoding: 'utf-8',
    timeout: task.verifyTimeoutSec * 1000,
    // Strip inherited GIT_* env so a verify that shells out to git targets the
    // scratch repo, not an enclosing worktree (known GIT_DIR poisoning hazard).
    env: sanitizedEnv(),
  });
  const timedOut = res.signal === 'SIGTERM' && res.status === null;
  return {
    passed: res.status === 0 && !timedOut,
    exitCode: res.status ?? (timedOut ? 124 : 1),
    timedOut,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
  };
}

/** Run an optional one-time setup command inside `workdir`. */
export function runSetup(task: TaskSpec, workdir: string): VerifyResult | null {
  if (!task.setupCmd) return null;
  const res = spawnSync('bash', ['-lc', task.setupCmd], {
    cwd: workdir,
    encoding: 'utf-8',
    timeout: task.verifyTimeoutSec * 1000,
    env: sanitizedEnv(),
  });
  return {
    passed: res.status === 0,
    exitCode: res.status ?? 1,
    timedOut: false,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
  };
}

/** Copy of process.env with GIT_* repository pointers removed. */
export function sanitizedEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_')) delete env[key];
  }
  return env;
}
