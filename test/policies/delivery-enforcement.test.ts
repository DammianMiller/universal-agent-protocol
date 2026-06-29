import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import { join } from 'path';

const ENFORCER = join(process.cwd(), 'src', 'policies', 'enforcers', 'delivery_enforcement.py');
const ROOT = process.cwd();

function run(
  target: string,
  env: Record<string, string> = {},
  op = 'Edit'
): { exit: number; allowed: boolean; reason: string; route?: string } {
  const r = spawnSync(
    'python3',
    [ENFORCER, '--operation', op, '--args', JSON.stringify({ file_path: join(ROOT, target) })],
    { env: { ...process.env, UAP_REPO_ROOT: ROOT, ...env }, encoding: 'utf8' }
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
    const r = run('src/feature.ts', { UAP_ENFORCE_DELIVERY: 'block' }, 'Bash');
    expect(r.exit).toBe(0);
    expect(r.reason).toMatch(/not a file-edit/);
  });
});
