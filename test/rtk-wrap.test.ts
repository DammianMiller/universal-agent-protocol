/**
 * Tests for the rtk-wrap policy enforcer's package-manager handling.
 * `rtk npm` maps to `npm run`, so npm/pnpm/yarn *builtins* (view, install,
 * publish, …) must be routed via `rtk proxy`, not `rtk npm` (which would mangle
 * `npm view` -> `npm run view`). Script runners (run/test) stay on `rtk npm`.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { join } from 'path';

// The SOURCE enforcer — see iac-parity.test.ts for why the materialised copy
// under `.policy-tools/` is the wrong thing to point a test at.
const ENF = join(__dirname, '../src/policies/enforcers/rtk_wrap.py');

// The enforcer exits 2 on a block (valid JSON still on stdout), so use
// spawnSync which does not throw on a non-zero exit.
function reason(cmd: string): string {
  const r = spawnSync(
    'python3',
    [ENF, '--operation', 'Bash', '--args', JSON.stringify({ command: cmd })],
    { encoding: 'utf-8' }
  );
  return (JSON.parse(r.stdout || '{}').reason as string) || '';
}

describe('rtk-wrap enforcer: package-manager builtins', () => {
  it('routes npm builtins through rtk proxy (no `npm run` mangling)', () => {
    expect(reason('npm view pkg version')).toContain('Use: rtk proxy npm view');
    expect(reason('npm install lodash')).toContain('Use: rtk proxy npm install');
    expect(reason('npm publish')).toContain('Use: rtk proxy npm publish');
    expect(reason('pnpm add left-pad')).toContain('Use: rtk proxy pnpm add');
  });

  it('keeps script runners on rtk <pm> (run/test)', () => {
    expect(reason('npm run build')).toContain('Use: rtk npm run build');
    expect(reason('npm test')).toContain('Use: rtk npm test');
  });

  it('leaves non-package-manager wrapped CLIs unchanged', () => {
    expect(reason('git status')).toContain('Use: rtk git status');
  });
});

/** True when the enforcer refused the command. */
function blocked(cmd: string): boolean {
  const r = spawnSync(
    'python3',
    [ENF, '--operation', 'Bash', '--args', JSON.stringify({ command: cmd })],
    { encoding: 'utf-8' }
  );
  return JSON.parse(r.stdout || '{}').allowed === false;
}

describe('rtk-wrap: a command is a sequence of statements', () => {
  /**
   * Whole-command matching was wrong in BOTH directions.
   *
   * It accepted `rtk` only at the very start, so an already-wrapped call after a
   * `cd` or an env assignment was refused — and the suggestion prefixed rtk to
   * the entire line, producing `rtk cd /srv/app; git log`, which is not a
   * runnable command.
   *
   * More seriously it scanned only the first three tokens, so a bare invocation
   * hidden behind a `cd` was never seen at all. That is a bypass: `cd . && git
   * push` went straight through. Reading the leading binary of each statement is
   * what the shell itself does.
   */
  it('closes the bypass: a bare CLI behind a cd is still refused', () => {
    // These were ALLOWED before — `git`/`npm` sat at token index 3.
    expect(blocked('cd /srv/app && git log')).toBe(true);
    expect(blocked('cd /srv/app && npm ci')).toBe(true);
    expect(blocked('cd /a/b/c && docker ps')).toBe(true);
    expect(blocked('mkdir -p x && cd x && git init')).toBe(true);
  });

  it('accepts a wrapped call that is not the first statement', () => {
    // These were REFUSED before, with an unrunnable suggestion.
    expect(blocked('cd /srv/app && rtk git log --oneline')).toBe(false);
    expect(blocked('cd /srv/app; rtk git status')).toBe(false);
    expect(blocked('S=/tmp/x; rtk git apply $S/p.patch')).toBe(false);
    expect(blocked('cd /x && rtk npm run build')).toBe(false);
  });

  it('suggests fixing the STATEMENT, not the whole line', () => {
    // The old text was `Use: rtk cd /srv/app && git log`.
    const r = reason('cd /srv/app && git log');
    expect(r).toContain('Use: rtk git log');
    expect(r).not.toContain('rtk cd');
  });

  it('still routes a package-manager builtin correctly mid-command', () => {
    expect(reason('cd /x && npm view pkg version')).toContain('Use: rtk proxy npm view');
  });

  it('judges the leading binary, so a CLI named as an ARGUMENT is not an invocation', () => {
    // `git` here is text, not a command being run.
    expect(blocked('echo "git status"')).toBe(false);
    expect(blocked('grep -rn docker README.md')).toBe(false);
    expect(blocked('ls -la')).toBe(false);
  });

  it('is not fooled by an env-assignment prefix on an unwrapped call', () => {
    expect(blocked('FOO=bar git push')).toBe(true);
    expect(blocked('cd /x && GIT_DIR=/y git log')).toBe(true);
  });
});
