/**
 * Command-text scanning: prose must not trip a gate, and stripping prose must
 * not open a bypass.
 *
 * Gates match markers ("terraform apply", "gh pr merge") as substrings of a
 * Bash command, which also matched those words inside DATA — a quoted prose
 * argument or a heredoc body. So a command that merely *mentioned* another
 * command was blocked as if it were one.
 *
 * The dangerous half of the fix is the bypass surface it could create: text
 * handed to a shell IS a command. Every "still blocks" case below exists to
 * prove that stripping did not open a hole, and each fails if the shell-exec
 * guard in _common.hands_text_to_shell() is removed.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync, execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const ENFORCERS = join(process.cwd(), 'src', 'policies', 'enforcers');
const IAC_GATE = join(ENFORCERS, 'iac_plan_destruction_check.py');
const WORKDIR_GATE = join(ENFORCERS, 'workdir_scope.py');

function cleanGitEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_')) delete env[key];
  }
  delete env.UAP_IAC_PLAN_REVIEWED;
  return env;
}

function git(repo: string, args: string[]): void {
  execFileSync('git', args, { cwd: repo, stdio: 'ignore', env: cleanGitEnv() });
}

function run(
  enforcer: string,
  repo: string,
  command: string,
  env: Record<string, string> = {}
): number {
  const res = spawnSync(
    'python3',
    [enforcer, '--operation', 'Bash', '--args', JSON.stringify({ command })],
    { cwd: repo, env: cleanGitEnv({ UAP_REPO_ROOT: repo, ...env }) }
  );
  return res.status ?? -1;
}

const ALLOW = 0;
const BLOCK = 2;

/** An apply command, assembled so this file never contains the literal. */
const TF_APPLY = ['terraform', 'apply'].join(' ');

describe('gate command-text scanning', () => {
  let repo: string;
  let state: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'uap-cmdtext-'));
    state = mkdtempSync(join(tmpdir(), 'uap-state-'));
    git(repo, ['init', '-b', 'main']);
    git(repo, ['config', 'user.email', 'test@example.com']);
    git(repo, ['config', 'user.name', 'Test']);
    writeFileSync(join(repo, 'README.md'), '# test\n');
    // Tracked terraform dir + an untracked .tf, so the local-tree scan has
    // something to find (see iac-plan-destruction.test.ts for why tracking the
    // directory matters).
    mkdirSync(join(repo, 'infra', 'terraform'), { recursive: true });
    writeFileSync(join(repo, 'infra', 'terraform', 'existing.tf'), '# tracked\n');
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-m', 'init']);
    writeFileSync(join(repo, 'infra', 'terraform', 'unrelated.tf'), '# noise\n');
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(state, { recursive: true, force: true });
  });

  const iac = (cmd: string) => run(IAC_GATE, repo, cmd, { UAP_STATE_DIR: state });

  describe('iac gate — prose must not look like a command', () => {
    it('allows a note that merely mentions an apply', () => {
      expect(iac(`uap memory store "the fix landed after a ${TF_APPLY} run"`)).toBe(
        ALLOW
      );
    });

    it('allows a note that merely mentions a merge', () => {
      expect(iac('uap memory store "blocked during gh pr merge 591 --repo a/b"')).toBe(
        ALLOW
      );
    });

    it('allows a commit message mentioning an apply', () => {
      expect(iac(`git commit -m "document the ${TF_APPLY} runbook"`)).toBe(ALLOW);
    });

    it('allows a heredoc body mentioning an apply', () => {
      expect(iac(`python3 - <<PY\n# ${TF_APPLY} is described here\nprint(1)\nPY`)).toBe(
        ALLOW
      );
    });
  });

  describe('iac gate — the real thing is still blocked', () => {
    it('blocks a bare apply', () => {
      expect(iac(`${TF_APPLY} -auto-approve`)).toBe(BLOCK);
    });

    it('blocks an apply hidden in sh -c (bypass guard)', () => {
      expect(iac(`sh -c "${TF_APPLY} -auto-approve"`)).toBe(BLOCK);
    });

    it('blocks an apply hidden in bash -c (bypass guard)', () => {
      expect(iac(`bash -c "${TF_APPLY}"`)).toBe(BLOCK);
    });

    it('blocks an apply piped into a shell via heredoc (bypass guard)', () => {
      expect(iac(`bash <<EOF\n${TF_APPLY}\nEOF`)).toBe(BLOCK);
    });

    it('blocks an apply reached through eval (bypass guard)', () => {
      expect(iac(`eval "${TF_APPLY} -auto-approve"`)).toBe(BLOCK);
    });

    it('blocks an apply behind command substitution (bypass guard)', () => {
      expect(iac(`echo "$(${TF_APPLY})"`)).toBe(BLOCK);
    });

    it('blocks an apply following a legitimate quoted argument', () => {
      expect(iac(`git commit -m "some message" && ${TF_APPLY}`)).toBe(BLOCK);
    });
  });

  describe('workdir-scope — heredoc bodies are data', () => {
    const workdir = (cmd: string) => run(WORKDIR_GATE, repo, cmd, { UAP_WORKDIR_ROOT: repo });

    it('allows a heredoc body whose text parses as a redirection', () => {
      // The exact shape that blocked a real patch script: the redirection
      // regex matches the '>' closing an angle-bracket placeholder and takes
      // the rest as a write destination.
      const body = '    # `gh api repos/<owner>/<name>/pulls/<n>/merge` carries the repo';
      expect(workdir(`python3 - <<PY\n${body}\nPY`)).toBe(ALLOW);
    });

    it('still flags a write to an out-of-scope quoted destination', () => {
      // Quoted args must KEEP being scanned here — a write destination is
      // routinely quoted, so this gate strips heredoc bodies only.
      expect(workdir('cp README.md "/etc/uap-should-not-write"')).toBe(BLOCK);
    });

    it('still flags an out-of-scope redirection', () => {
      expect(workdir('echo hi > /etc/uap-should-not-write')).toBe(BLOCK);
    });

    it('still flags a write inside a shell-executed heredoc (bypass guard)', () => {
      expect(workdir('bash <<EOF\ncp README.md /etc/uap-should-not-write\nEOF')).toBe(
        BLOCK
      );
    });
  });
});
