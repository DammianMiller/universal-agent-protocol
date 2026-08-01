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

// Deleting the gate's own state is not a way out of the gate. Observed live 7x
// on 2026-07-31 (octopus_invaders_v3): `rm -f .uap/pending-deliver.jsonl`
// interleaved with kill -9 of the running deliver, discarding the queued edit
// intents that `uap deliver --pending` replays rather than completing them.
describe('delivery-enforcement — deliver state files are not removable', () => {
  function runBash(command: string, env: Record<string, string> = {}) {
    const r = spawnSync('python3', [ENFORCER, '--operation', 'bash', '--args', JSON.stringify({ command })], {
      env: { ...hermeticEnv(), UAP_REPO_ROOT: ROOT, ...env },
      encoding: 'utf8',
    });
    let p: { allowed?: boolean; reason?: string } = {};
    try { p = JSON.parse(r.stdout || '{}'); } catch { /* empty */ }
    return { exit: r.status ?? -1, allowed: p.allowed ?? false, reason: p.reason ?? '' };
  }

  it('blocks rm of the pending-deliver queue', () => {
    const r = runBash('rm -f .uap/pending-deliver.jsonl');
    expect(r.exit).toBe(2);
    expect(r.reason).toMatch(/delivery gate's own state/i);
    // Must point at the constructive path, not just refuse.
    expect(r.reason).toMatch(/--pending/i);
    expect(r.reason).toContain('.uap/pending-deliver.jsonl');
  });

  it('blocks rm of the lock and heartbeat, including via an absolute path', () => {
    expect(runBash('rm -f /home/u/proj/.uap/deliver.lock').exit).toBe(2);
    expect(runBash('rm .uap/deliver.heartbeat').exit).toBe(2);
    expect(runBash('rm -f /home/u/proj/.uap/deliver.lock').reason).toContain('/home/u/proj/.uap/deliver.lock');
  });

  it('names the right remedy for the lock, which is NOT the pending queue', () => {
    // Telling an agent on a wedged lock to run `--pending` sends it somewhere
    // that cannot help; the lock's answer is that stale locks self-reclaim.
    const r = runBash('rm -f .uap/deliver.lock');
    expect(r.reason).toMatch(/single-flight/i);
    expect(r.reason).not.toMatch(/--pending/);
  });

  // Guarding only `rm <literal path>` would repeat the mistake this change
  // exists to fix: the model found the laundered kill 8s after being refused.
  // `: > …` is SHORTER than the command it blocks and equally destructive.
  it('blocks the non-rm ways to destroy the same state', () => {
    expect(runBash(': > .uap/pending-deliver.jsonl').exit).toBe(2);
    expect(runBash('truncate -s 0 .uap/pending-deliver.jsonl').exit).toBe(2);
    expect(runBash('mv .uap/deliver.lock /tmp/').exit).toBe(2);
    expect(runBash('unlink .uap/deliver.lock').exit).toBe(2);
  });

  it('blocks removing the whole .uap directory or globbing it', () => {
    expect(runBash('rm -rf .uap').exit).toBe(2);
    expect(runBash('rm -rf .uap/').exit).toBe(2);
    expect(runBash('rm -rf .uap/*').exit).toBe(2);
  });

  it('is not relaxed by advisory mode (destroying state is not an edit)', () => {
    expect(runBash('rm -f .uap/pending-deliver.jsonl', { UAP_ENFORCE_DELIVERY: 'advisory' }).exit).toBe(2);
  });

  it("does not block deliver's own housekeeping (UAP_DELIVER_ACTIVE=1)", () => {
    expect(runBash('rm -f .uap/pending-deliver.jsonl', { UAP_DELIVER_ACTIVE: '1' }).exit).toBe(0);
  });

  it('leaves ordinary rm alone', () => {
    expect(runBash('rm -rf dist/').exit).toBe(0);
    expect(runBash('rm -f .uap/visual/shot.png').exit).toBe(0);
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
