import { describe, it, expect } from 'vitest';
import { commitPushAndWatch, sanitizeCiLog, type ExecFn, type ExecResult } from '../../src/delivery/ci-watcher.js';

const ok = (stdout = ''): ExecResult => ({ code: 0, stdout, stderr: '' });
const bad = (stderr = 'err'): ExecResult => ({ code: 1, stdout: '', stderr });

interface FakeOpts {
  branch?: string;
  sha?: string;
  runs?: Array<{ databaseId: number; headSha: string; status: string; url?: string }>;
  view?: () => { status: string; conclusion: string | null; jobs?: Array<{ name: string; conclusion: string | null; status: string }>; url?: string };
  failedLog?: string;
  pushFail?: boolean;
}

function makeExec(opts: FakeOpts) {
  const calls: string[][] = [];
  const exec: ExecFn = async (command, args) => {
    calls.push([command, ...args]);
    if (command === 'git' && args[0] === 'rev-parse' && args.includes('--abbrev-ref')) return ok(opts.branch ?? 'feature/x');
    if (command === 'git' && args[0] === 'rev-parse') return ok(opts.sha ?? 'deadbeef');
    if (command === 'git' && args[0] === 'add') return ok();
    if (command === 'git' && args[0] === 'commit') return ok('committed');
    if (command === 'git' && args[0] === 'push') return opts.pushFail ? bad('rejected') : ok();
    if (command === 'gh' && args[0] === 'run' && args[1] === 'list') return ok(JSON.stringify(opts.runs ?? []));
    if (command === 'gh' && args[0] === 'run' && args[1] === 'view' && args.includes('--log-failed'))
      return ok(opts.failedLog ?? 'log');
    if (command === 'gh' && args[0] === 'run' && args[1] === 'view') return ok(JSON.stringify(opts.view?.() ?? {}));
    return ok();
  };
  return { exec, calls };
}

const base = {
  projectRoot: '/tmp/proj',
  commitMessage: 'feat: x',
  files: ['a.ts'],
  pollIntervalMs: 0,
  sleep: async () => undefined,
};

// Tokens are CONSTRUCTED at runtime (prefix + filler) so no literal secret
// string lives in this file — that keeps the test out of GitHub push-protection
// / secret-scanning while still exercising every sanitizer pattern.
const ghToken = 'ghp_' + 'A'.repeat(32);

describe('sanitizeCiLog', () => {
  it('masks GitHub tokens, bearer headers and KEY=secret assignments', () => {
    const raw = `token=${ghToken} Authorization: Bearer abcdef123456789 API_KEY=supersecretvalue`;
    const out = sanitizeCiLog(raw);
    expect(out).not.toContain(ghToken);
    expect(out).not.toContain('supersecretvalue');
    expect(out).toContain('***');
  });

  it('masks non-GitHub provider tokens (slack/stripe/google/npm/jwt) and AUTH= keys', () => {
    const samples = [
      'xoxb-' + '1234567890abcdef',
      'sk_' + 'live_' + 'a'.repeat(24),
      'AIza' + 'b'.repeat(35),
      'npm_' + 'c'.repeat(36),
      'eyJ' + 'd'.repeat(30),
    ];
    for (const s of samples) {
      expect(sanitizeCiLog(`leaked ${s} here`)).not.toContain(s);
    }
    expect(sanitizeCiLog('DEPLOY_AUTH=hunter2longvalue')).not.toContain('hunter2longvalue');
  });
});

describe('commitPushAndWatch', () => {
  it('refuses to push a protected branch', async () => {
    const { exec, calls } = makeExec({ branch: 'master' });
    const res = await commitPushAndWatch({ ...base, exec });
    expect(res.status).toBe('skipped');
    expect(res.pushed).toBe(false);
    expect(calls.some((c) => c[0] === 'git' && c[1] === 'push')).toBe(false);
  });

  it('never force-pushes', async () => {
    const { exec, calls } = makeExec({
      branch: 'feature/x',
      sha: 'abc123',
      runs: [{ databaseId: 7, headSha: 'abc123', status: 'completed' }],
      view: () => ({ status: 'completed', conclusion: 'success' }),
    });
    const res = await commitPushAndWatch({ ...base, exec });
    expect(res.status).toBe('green');
    const push = calls.find((c) => c[0] === 'git' && c[1] === 'push');
    expect(push).toEqual(['git', 'push', 'origin', 'feature/x']);
    expect(push!.some((a) => /force/.test(a))).toBe(false);
  });

  it('matches the run by head SHA, not the latest run', async () => {
    const { exec, calls } = makeExec({
      sha: 'match-sha',
      runs: [
        { databaseId: 99, headSha: 'other-sha', status: 'completed' },
        { databaseId: 42, headSha: 'match-sha', status: 'completed' },
      ],
      view: () => ({ status: 'completed', conclusion: 'success' }),
    });
    const res = await commitPushAndWatch({ ...base, exec });
    expect(res.runId).toBe('42');
    // The run view must have been called for the SHA-matched id, not 99.
    expect(calls.some((c) => c.includes('view') && c.includes('42'))).toBe(true);
    expect(calls.some((c) => c.includes('view') && c.includes('99'))).toBe(false);
  });

  it('returns sanitized failure feedback on a failed run', async () => {
    const { exec } = makeExec({
      sha: 's',
      runs: [{ databaseId: 1, headSha: 's', status: 'completed' }],
      view: () => ({ status: 'completed', conclusion: 'failure' }),
      failedLog: `deploy failed; token=${ghToken}`,
    });
    const res = await commitPushAndWatch({ ...base, exec });
    expect(res.status).toBe('failed');
    expect(res.feedback).toContain('ci-feedback');
    expect(res.feedback).not.toContain(ghToken);
  });

  it('fails when a required environment deploy job is not green', async () => {
    const { exec } = makeExec({
      sha: 's',
      runs: [{ databaseId: 1, headSha: 's', status: 'completed' }],
      view: () => ({
        status: 'completed',
        conclusion: 'success',
        jobs: [{ name: 'deploy-staging', conclusion: 'failure', status: 'completed' }],
      }),
      failedLog: 'staging smoke failed',
    });
    const res = await commitPushAndWatch({ ...base, exec, watchEnvironments: ['staging'] });
    expect(res.status).toBe('failed');
    expect(res.feedback).toMatch(/staging/);
  });

  it('returns timeout when the run never concludes within the budget', async () => {
    const { exec } = makeExec({
      sha: 's',
      runs: [{ databaseId: 1, headSha: 's', status: 'in_progress' }],
      view: () => ({ status: 'in_progress', conclusion: null }),
    });
    const res = await commitPushAndWatch({ ...base, exec, timeoutMs: 0 });
    expect(res.status).toBe('timeout');
  });
});
