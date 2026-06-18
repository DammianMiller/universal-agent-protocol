/**
 * CI watcher: the commit/push boundary between local convergence and CI/CD.
 *
 * Once the convergence loop reaches local-green, this module commits the
 * applied files on the current worktree branch, pushes (never force), resolves
 * the CI run triggered for that exact commit (matched by head SHA, not "latest
 * run"), watches it to a conclusion, and — on failure — converts the failed
 * logs into sanitized convergence feedback so the loop can re-converge against
 * what CI/staging/prod actually reported.
 *
 * Honors the repo conventions:
 *  - never pushes `master`/`main` directly (merge-to-master stays in the PR
 *    flow); a protected branch yields `status: 'skipped'`.
 *  - never force-pushes.
 *  - sanitizes secrets out of CI logs before they enter a model prompt.
 */

import { execFile as execFileCb } from 'child_process';

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export type ExecFn = (
  command: string,
  args: string[],
  opts?: { cwd?: string; timeoutMs?: number }
) => Promise<ExecResult>;

export type DeployEnvironment = 'dev' | 'staging' | 'prod';

export interface CiWatchOptions {
  projectRoot: string;
  /** Branch to push. Resolved from HEAD when omitted. */
  branch?: string;
  /** Remote name (default 'origin'). */
  remote?: string;
  commitMessage: string;
  /** Files to stage; empty ⇒ `git add -A`. */
  files: string[];
  /** Poll interval while watching (default 15s). */
  pollIntervalMs?: number;
  /** Overall watch budget (default 20 min). */
  timeoutMs?: number;
  /** Require these environments' deploy jobs to be green (job names `deploy-<env>`). */
  watchEnvironments?: DeployEnvironment[];
  /** Max retries resolving the run after push (default 8). */
  resolveAttempts?: number;
  /** Max chars of failed-log feedback (default 4000). */
  outputTailChars?: number;
  /** Injectable command runner (tests); defaults to a real execFile runner. */
  exec?: ExecFn;
  /** Injectable sleep (tests); defaults to real setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  /** Progress/heartbeat callback (keeps the coordinator from marking stale). */
  onProgress?: (message: string) => void;
}

export type CiWatchStatus = 'green' | 'failed' | 'timeout' | 'no-run' | 'skipped';

export interface CiWatchResult {
  pushed: boolean;
  runId: string | null;
  status: CiWatchStatus;
  /** Sanitized failure feedback for the next convergence pass. */
  feedback?: string;
  runUrl?: string;
}

const PROTECTED_BRANCHES = new Set(['master', 'main']);
const DEFAULT_POLL_MS = 15_000;
const DEFAULT_TIMEOUT_MS = 20 * 60_000;
const DEFAULT_RESOLVE_ATTEMPTS = 8;
const DEFAULT_TAIL_CHARS = 4_000;

const defaultExec: ExecFn = (command, args, opts = {}) =>
  new Promise((resolve) => {
    execFileCb(
      command,
      args,
      { cwd: opts.cwd, timeout: opts.timeoutMs, maxBuffer: 10 * 1024 * 1024, encoding: 'utf-8' },
      (error, stdout, stderr) => {
        const code =
          error && typeof (error as NodeJS.ErrnoException & { code?: number }).code === 'number'
            ? ((error as unknown as { code: number }).code)
            : error
              ? 1
              : 0;
        resolve({ code, stdout: stdout ?? '', stderr: stderr ?? '' });
      }
    );
  });

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Strip secrets out of CI logs before they are injected into a model prompt.
 * Masks common token shapes and `KEY=secret` assignments for sensitive keys.
 */
export function sanitizeCiLog(text: string): string {
  return (
    text
      // GitHub tokens (PAT, OAuth, server, fine-grained) and generic gh* tokens
      .replace(/\b(gh[pousr]|github_pat)_[A-Za-z0-9_]{20,}\b/g, '***')
      // Provider tokens: Slack, Stripe, Google API, npm, OpenAI/Anthropic-style
      .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, '***')
      .replace(/\bsk_(live|test)_[A-Za-z0-9]{16,}\b/g, '***')
      .replace(/\bAIza[0-9A-Za-z_-]{35}\b/g, '***')
      .replace(/\bnpm_[A-Za-z0-9]{36}\b/g, '***')
      .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, '***')
      // JWTs (header.payload.signature) — contain '.'/'-', so the base64 rule misses them
      .replace(/\beyJ[A-Za-z0-9._-]{20,}\b/g, '***')
      // Bearer / token headers (allow base64 chars +/=)
      .replace(/\b(Bearer|token)\s+[A-Za-z0-9._/+=-]{12,}/gi, '$1 ***')
      // AWS access key ids
      .replace(/\bAKIA[0-9A-Z]{16}\b/g, '***')
      // KEY=value / KEY: value assignments for sensitive-looking keys
      .replace(
        /\b([A-Z0-9_]*(?:API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|PWD|CREDENTIAL|PRIVATE_KEY|AUTH|ACCESS_KEY)[A-Z0-9_]*)\s*[=:]\s*\S+/gi,
        '$1=***'
      )
      // long base64-ish blobs (>=40 chars) that look like encoded secrets
      .replace(/\b[A-Za-z0-9+/]{40,}={0,2}\b/g, '***')
  );
}

function truncateTail(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `…(truncated)…\n${trimmed.slice(-maxChars)}`;
}

interface GhRunSummary {
  databaseId: number;
  headSha: string;
  status: string;
  url?: string;
}

interface GhJob {
  name: string;
  conclusion: string | null;
  status: string;
}

/**
 * Commit applied files on the worktree branch, push (non-force), then watch the
 * triggered CI run and report a status the convergence loop can act on.
 */
export async function commitPushAndWatch(options: CiWatchOptions): Promise<CiWatchResult> {
  const exec = options.exec ?? defaultExec;
  const sleep = options.sleep ?? defaultSleep;
  const remote = options.remote ?? 'origin';
  const cwd = options.projectRoot;
  const progress = options.onProgress ?? (() => undefined);
  const tailChars = options.outputTailChars ?? DEFAULT_TAIL_CHARS;

  // 1. Resolve and guard the branch.
  let branch = options.branch;
  if (!branch) {
    const head = await exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd });
    branch = head.stdout.trim();
  }
  if (!branch || PROTECTED_BRANCHES.has(branch)) {
    return {
      pushed: false,
      runId: null,
      status: 'skipped',
      feedback: `CI watch skipped: refusing to push protected branch '${branch || '(unknown)'}'. Merge to master via the PR flow.`,
    };
  }

  // 2. Commit (tolerate "nothing to commit").
  if (options.files.length > 0) {
    await exec('git', ['add', '--', ...options.files], { cwd });
  } else {
    await exec('git', ['add', '-A'], { cwd });
  }
  const commit = await exec('git', ['commit', '-m', options.commitMessage], { cwd });
  if (commit.code !== 0 && !/nothing to commit/i.test(`${commit.stdout}\n${commit.stderr}`)) {
    return {
      pushed: false,
      runId: null,
      status: 'skipped',
      feedback: `CI watch skipped: commit failed — ${sanitizeCiLog(truncateTail(commit.stderr, 500))}`,
    };
  }

  // 3. Resolve the head SHA we are about to push.
  const sha = (await exec('git', ['rev-parse', 'HEAD'], { cwd })).stdout.trim();

  // 4. Push (non-force, never force-with-lease).
  progress(`Pushing ${branch} to ${remote}…`);
  const push = await exec('git', ['push', remote, branch], { cwd });
  if (push.code !== 0) {
    return {
      pushed: false,
      runId: null,
      status: 'skipped',
      feedback: `CI watch skipped: push failed — ${sanitizeCiLog(truncateTail(push.stderr, 500))}`,
    };
  }

  // 5. Resolve the run for this exact commit (match by head SHA).
  const run = await resolveRun(exec, cwd, branch, sha, options.resolveAttempts ?? DEFAULT_RESOLVE_ATTEMPTS, sleep, options.pollIntervalMs ?? DEFAULT_POLL_MS, progress);
  if (!run) {
    return {
      pushed: true,
      runId: null,
      status: 'no-run',
      feedback: `Pushed ${sha.slice(0, 8)} to ${branch}, but no CI run was found for it. CI may be disabled for this branch.`,
    };
  }

  // 6. Watch to conclusion.
  return watchRun(exec, cwd, run, {
    pollIntervalMs: options.pollIntervalMs ?? DEFAULT_POLL_MS,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    watchEnvironments: options.watchEnvironments,
    tailChars,
    sleep,
    progress,
  });
}

async function resolveRun(
  exec: ExecFn,
  cwd: string,
  branch: string,
  sha: string,
  attempts: number,
  sleep: (ms: number) => Promise<void>,
  pollMs: number,
  progress: (m: string) => void
): Promise<GhRunSummary | null> {
  for (let i = 0; i < attempts; i++) {
    const res = await exec(
      'gh',
      ['run', 'list', '--branch', branch, '--json', 'databaseId,headSha,status,url', '--limit', '20'],
      { cwd }
    );
    if (res.code === 0) {
      try {
        const runs = JSON.parse(res.stdout) as GhRunSummary[];
        const match = runs.find((r) => r.headSha === sha);
        if (match) return match;
      } catch {
        /* malformed json — retry */
      }
    }
    progress(`Waiting for CI run on ${sha.slice(0, 8)} (attempt ${i + 1}/${attempts})…`);
    if (i < attempts - 1) await sleep(pollMs);
  }
  return null;
}

interface WatchParams {
  pollIntervalMs: number;
  timeoutMs: number;
  watchEnvironments?: DeployEnvironment[];
  tailChars: number;
  sleep: (ms: number) => Promise<void>;
  progress: (m: string) => void;
}

async function watchRun(
  exec: ExecFn,
  cwd: string,
  run: GhRunSummary,
  params: WatchParams
): Promise<CiWatchResult> {
  const runId = String(run.databaseId);
  const deadline = params.timeoutMs;
  let elapsed = 0;

  for (;;) {
    const res = await exec(
      'gh',
      ['run', 'view', runId, '--json', 'status,conclusion,jobs,url'],
      { cwd }
    );
    let view: { status: string; conclusion: string | null; jobs?: GhJob[]; url?: string } | null = null;
    if (res.code === 0) {
      try {
        view = JSON.parse(res.stdout);
      } catch {
        view = null;
      }
    }

    if (view && view.status === 'completed') {
      const runUrl = view.url ?? run.url;
      const envProblem = requiredEnvFailure(view.jobs ?? [], params.watchEnvironments);
      if (view.conclusion === 'success' && !envProblem) {
        return { pushed: true, runId, status: 'green', runUrl };
      }
      const feedback = await buildFailureFeedback(exec, cwd, runId, envProblem, params.tailChars);
      return { pushed: true, runId, status: 'failed', feedback, runUrl };
    }

    if (elapsed >= deadline) {
      return {
        pushed: true,
        runId,
        status: 'timeout',
        runUrl: view?.url ?? run.url,
        feedback: `CI run ${runId} did not conclude within ${Math.round(deadline / 60000)} min. See ${view?.url ?? run.url ?? 'the run'} for status.`,
      };
    }

    params.progress(`Watching CI run ${runId} (${view?.status ?? 'pending'})…`);
    await params.sleep(params.pollIntervalMs);
    elapsed += params.pollIntervalMs;
  }
}

/** Returns a description when a required environment's deploy job is not green. */
function requiredEnvFailure(jobs: GhJob[], envs?: DeployEnvironment[]): string | null {
  if (!envs || envs.length === 0) return null;
  for (const env of envs) {
    const jobName = `deploy-${env}`;
    const job = jobs.find((j) => j.name === jobName || j.name.startsWith(`${jobName} `));
    if (!job) return `Required ${env} deploy job ('${jobName}') was not found in the CI run.`;
    if (job.conclusion !== 'success') {
      return `Required ${env} deploy job ('${jobName}') concluded '${job.conclusion ?? job.status}'.`;
    }
  }
  return null;
}

async function buildFailureFeedback(
  exec: ExecFn,
  cwd: string,
  runId: string,
  envProblem: string | null,
  tailChars: number
): Promise<string> {
  const logs = await exec('gh', ['run', 'view', runId, '--log-failed'], { cwd });
  const raw = logs.code === 0 ? logs.stdout : `${logs.stdout}\n${logs.stderr}`;
  const sanitized = sanitizeCiLog(truncateTail(raw, tailChars));
  const header = envProblem
    ? `ci-feedback: ${envProblem}`
    : 'ci-feedback: the CI run failed after the change was pushed. Fix the failure below so dev/staging/prod verification passes.';
  return `${header}\n\nFailed CI logs:\n\`\`\`\n${sanitized || '(no log output captured)'}\n\`\`\``;
}
