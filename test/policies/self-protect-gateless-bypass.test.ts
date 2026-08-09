/**
 * enforcement-self-protect: the constrained party must not self-grant the
 * gateless-root override.
 *
 * The gateless-root REFUSAL (v1.186.7) exists BECAUSE an agent-driven launch
 * does not honour a warning — the advisory shipped, fired, named the exact
 * right root, and the next run was launched at the gateless root anyway, then
 * spent 34 minutes taking a crate from 1 failing test to 3 while reporting
 * "100% of gates". A hatch that same party can write into its own command line
 * is not an override, it is an off switch.
 *
 * The two spellings are matched DIFFERENTLY on purpose. The env assignment is
 * scanned against the raw command, like every sibling entry. The bare flag NAME
 * appears in ordinary prose — docs, commit messages, `grep` — so scanning the
 * raw command for it refused honest work; it runs against `scannable_command`,
 * which blanks quoted blobs but leaves text that is handed to a shell intact.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { join } from 'path';

const ENFORCER = join(process.cwd(), 'src', 'policies', 'enforcers', 'enforcement_self_protect.py');
// Split so this file's own text cannot trip the very pattern it is testing.
const FLAG = '--allow-' + 'gateless-root';
const ENV = 'UAP_ALLOW_' + 'GATELESS_ROOT';

type Verdict = { exit: number; allowed: boolean; reason: string };

function run(command: string, op = 'Bash'): Verdict {
  const r = spawnSync('python3', [ENFORCER, '--operation', op, '--args', JSON.stringify({ command })], {
    encoding: 'utf8',
    env: { ...process.env, UAP_SELF_PROTECT_OFF: '' },
  });
  let parsed: { allowed?: boolean; reason?: string } = {};
  try {
    parsed = JSON.parse(r.stdout || '{}');
  } catch {
    /* leave empty */
  }
  return { exit: r.status ?? -1, allowed: parsed.allowed ?? false, reason: parsed.reason ?? '' };
}

/**
 * Assert a REFUSAL, not merely a falsy `allowed`.
 *
 * `allowed` defaults to false when the enforcer crashes or prints unparseable
 * output, so asserting it alone would pass against a broken interpreter. The
 * exit code and the reason text pin that the refusal actually came from the
 * bypass branch.
 */
function expectBlocked(v: Verdict) {
  expect(v.allowed).toBe(false);
  expect(v.exit).toBe(2);
  expect(v.reason).toMatch(/BLOCKED/);
}

describe('self-protect blocks self-granting the gateless-root override', () => {
  it('blocks the inline env form', () => {
    expectBlocked(run(`${ENV}=1 uap deliver "do the thing"`));
  });

  it('blocks the quoted inline env forms', () => {
    expectBlocked(run(`${ENV}="1" uap deliver "x"`));
    expectBlocked(run(`${ENV}='1' uap deliver "x"`));
  });

  it('blocks an export followed by the launch — the form seen live for NO_LOCK', () => {
    expectBlocked(run(`export ${ENV}=1 && uap deliver "x"`));
  });

  it('blocks the env-prefix form', () => {
    expectBlocked(run(`env ${ENV}=1 uap deliver "x"`));
  });

  it('blocks the CLI flag, which is exactly as self-grantable as the env var', () => {
    expectBlocked(run(`uap deliver ${FLAG} --project-root /srv/app "do the thing"`));
  });

  it('blocks the flag when it is handed to a shell', () => {
    // scannable_command leaves shell-bound text intact precisely so this is
    // still caught rather than laundered through `bash -c`.
    expectBlocked(run(`bash -c "uap deliver ${FLAG} probe"`));
  });

  it('leaves an ordinary deliver alone', () => {
    // A control that fires on everything teaches the reader to ignore it.
    expect(run('uap deliver --project-root /srv/app/sub "do the thing"').allowed).toBe(true);
  });

  it('does not fire on a longer option that merely starts the same way', () => {
    expect(run(`uap deliver ${FLAG}ed-thing "x"`).allowed).toBe(true);
  });

  it('does not refuse a commit message that NAMES the flag', () => {
    // This is the change's own commit message. Scanning the raw command for a
    // bare flag name refused it — documentation and history have to be able to
    // talk about the switch.
    expect(run(`git commit -m "docs: ${FLAG} is operator-only"`).allowed).toBe(true);
  });

  it('does not refuse grepping for the flag', () => {
    expect(run(`rg -- ${FLAG} src/`).allowed).toBe(true);
  });

  it('does not treat an upper-case spelling as a bypass', () => {
    // commander options are case-sensitive, so this is not a working override.
    // Matching it would only widen the prose surface for no security gain.
    expect(run(`uap deliver ${FLAG.toUpperCase()} "x"`).allowed).toBe(true);
  });

  it('leaves a value of 0 alone', () => {
    // The consumer requires exactly "1"; anything else enables nothing.
    expect(run(`${ENV}=0 uap deliver "x"`).allowed).toBe(true);
  });
});
