import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { join } from 'path';

const ENFORCER = join(process.cwd(), 'src', 'policies', 'enforcers', 'delivery_enforcement.py');
const ROOT = process.cwd();

/**
 * The enforcer honors ambient exemptions by design — which makes a raw
 * `...process.env` spread non-hermetic: an operator's UAP_ENFORCE_DELIVERY=
 * advisory, or the UAP_DELIVER_ACTIVE=1 that deliver sets for its own gate
 * subprocesses, leaks in and flips the "block by default" assertions (exit 0
 * where exit 2 is expected). That made these tests red on any operator box —
 * and unconditionally red when the UAP repo itself is the target of a deliver
 * run (`npm test` gate can then NEVER pass: a live mission burned its turn
 * budget against it, 2026-07-10). Strip the enforcement-relevant vars; each
 * test states its policy env explicitly.
 */
const ENFORCEMENT_ENV_VARS = ['UAP_ENFORCE_DELIVERY', 'UAP_DELIVER_ACTIVE', 'UAP_DELIVER_BYPASS'];
function hermeticEnv(): NodeJS.ProcessEnv {
  const e: NodeJS.ProcessEnv = { ...process.env };
  for (const k of ENFORCEMENT_ENV_VARS) delete e[k];
  return e;
}

function run(
  target: string,
  env: Record<string, string> = {},
  op = 'Edit'
): { exit: number; allowed: boolean; reason: string; route?: string } {
  const r = spawnSync(
    'python3',
    [ENFORCER, '--operation', op, '--args', JSON.stringify({ file_path: join(ROOT, target) })],
    { env: { ...hermeticEnv(), UAP_REPO_ROOT: ROOT, ...env }, encoding: 'utf8' }
  );
  let parsed: { allowed?: boolean; reason?: string; route?: string } = {};
  try {
    parsed = JSON.parse(r.stdout || '{}');
  } catch {
    /* leave empty */
  }
  return { exit: r.status ?? -1, allowed: parsed.allowed ?? false, reason: parsed.reason ?? '', route: parsed.route };
}

describe('delivery-enforcement enforcer', () => {
  it('block by default: blocks a direct source edit (exit 2)', () => {
    const r = run('src/feature.ts');
    expect(r.exit).toBe(2);
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/uap deliver/);
  });

  it('R1: a block emits a machine-actionable route:deliver signal', () => {
    const r = run('src/feature.ts');
    expect(r.exit).toBe(2);
    expect(r.route).toBe('deliver');
  });

  it('advisory mode (opt-out): allows a source edit with a nudge (exit 0)', () => {
    const r = run('src/feature.ts', { UAP_ENFORCE_DELIVERY: 'advisory' });
    expect(r.exit).toBe(0);
    expect(r.allowed).toBe(true);
    expect(r.reason).toMatch(/advisory/);
  });

  it('block mode: blocks a direct source edit (exit 2)', () => {
    const r = run('src/feature.ts', { UAP_ENFORCE_DELIVERY: 'block' });
    expect(r.exit).toBe(2);
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/uap deliver/);
  });

  it('block mode honors UAP_DELIVER_ACTIVE (deliver-driven run)', () => {
    const r = run('src/feature.ts', { UAP_ENFORCE_DELIVERY: 'block', UAP_DELIVER_ACTIVE: '1' });
    expect(r.exit).toBe(0);
    expect(r.reason).toMatch(/deliver-driven/);
  });

  it('block mode honors UAP_DELIVER_BYPASS', () => {
    const r = run('src/feature.ts', { UAP_ENFORCE_DELIVERY: 'block', UAP_DELIVER_BYPASS: '1' });
    expect(r.exit).toBe(0);
    expect(r.reason).toMatch(/BYPASS/);
  });

  it('exempts docs, configs and test files even in block mode', () => {
    expect(run('docs/guide.md', { UAP_ENFORCE_DELIVERY: 'block' }).exit).toBe(0);
    expect(run('package.json', { UAP_ENFORCE_DELIVERY: 'block' }).exit).toBe(0);
    expect(run('src/feature.test.ts', { UAP_ENFORCE_DELIVERY: 'block' }).exit).toBe(0);
    expect(run('src/policies/x.ts', { UAP_ENFORCE_DELIVERY: 'block' }).exit).toBe(0);
  });

  it('ignores non-edit operations', () => {
    // NOTE: Bash is now GATED (source-writes route to deliver; GUI browser
    // launches are blocked) — use a genuinely non-edit op to keep the intent.
    const r = run('src/feature.ts', { UAP_ENFORCE_DELIVERY: 'block' }, 'Read');
    expect(r.exit).toBe(0);
    expect(r.reason).toMatch(/not a file-edit/);
  });
});

// A/B: fast-path + deliver-running back-off. These need full args (old/new
// strings, lock state) so they use a dedicated runner.
function runArgs(
  args: Record<string, unknown>,
  env: Record<string, string> = {}
): { exit: number; allowed: boolean; reason: string; route?: string } {
  const r = spawnSync('python3', [ENFORCER, '--operation', 'Edit', '--args', JSON.stringify(args)], {
    env: { ...hermeticEnv(), UAP_REPO_ROOT: ROOT, ...env },
    encoding: 'utf8',
  });
  let p: { allowed?: boolean; reason?: string; route?: string } = {};
  try { p = JSON.parse(r.stdout || '{}'); } catch { /* empty */ }
  return { exit: r.status ?? -1, allowed: p.allowed ?? false, reason: p.reason ?? '', route: p.route };
}

const big = 'x'.repeat(400);

describe('delivery-enforcement — fast-path (A) and deliver back-off (B)', () => {
  it('A: a root-level test.js basename is exempt (fast feedback loop)', () => {
    const r = runArgs({ file_path: join(ROOT, 'test.js'), old_string: big, new_string: big }, { UAP_ENFORCE_DELIVERY: 'block' });
    expect(r.exit).toBe(0);
    expect(r.reason).toMatch(/test file/);
  });

  it('A: a trivial edit to source is allowed directly', () => {
    const r = runArgs({ file_path: join(ROOT, 'src/x.ts'), old_string: 'a=1', new_string: 'a=2' }, { UAP_ENFORCE_DELIVERY: 'block' });
    expect(r.exit).toBe(0);
    expect(r.reason).toMatch(/trivial edit fast-path/);
  });

  it('A: a substantive source edit still routes through deliver', () => {
    const r = runArgs({ file_path: join(ROOT, 'src/x.ts'), old_string: big, new_string: 'y'.repeat(400) }, { UAP_ENFORCE_DELIVERY: 'block' });
    expect(r.exit).toBe(2);
    expect(r.route).toBe('deliver');
  });

  it('A: fast-path off makes a trivial edit route through deliver again', () => {
    const r = runArgs({ file_path: join(ROOT, 'src/x.ts'), old_string: 'a=1', new_string: 'a=2' }, { UAP_ENFORCE_DELIVERY: 'block', UAP_DELIVER_FASTPATH: 'off' });
    expect(r.exit).toBe(2);
    expect(r.route).toBe('deliver');
  });

  it('B: a substantive edit while a live deliver holds the lock returns route:wait', () => {
    const { mkdtempSync, writeFileSync, mkdirSync, rmSync } = require('fs') as typeof import('fs');
    const dir = mkdtempSync(join(require('os').tmpdir(), 'uap-backoff-'));
    try {
      mkdirSync(join(dir, '.uap'), { recursive: true });
      mkdirSync(join(dir, 'src'), { recursive: true });
      // hold the lock with a live pid (our parent)
      writeFileSync(join(dir, '.uap', 'deliver.lock'), `${process.ppid}|now`);
      const r = runArgs(
        { file_path: join(dir, 'src/x.ts'), old_string: big, new_string: 'y'.repeat(400) },
        { UAP_ENFORCE_DELIVERY: 'block', UAP_REPO_ROOT: dir }
      );
      expect(r.exit).toBe(2);
      expect(r.route).toBe('wait');
      expect(r.reason).toMatch(/ALREADY in progress/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
