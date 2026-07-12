/**
 * validate-plan-on-change: the enforcer forces `validate the plan` on any
 * plan-file write, and `uap plan validate` unblocks it for the window.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { planCommand } from '../src/cli/plan.js';

const ENFORCER = join(process.cwd(), 'src', 'policies', 'enforcers', 'validate_plan_on_change.py');
const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'uap-plan-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function run(op: string, filePath: string, env: Record<string, string> = {}): number {
  const r = spawnSync('python3', [ENFORCER, '--operation', op, '--args', JSON.stringify({ file_path: filePath })], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  return r.status ?? -1;
}

/** Seed `.uap/plan_state.json` in a temp state dir with a validated_at offset. */
function seedValidatedAgo(secondsAgo: number): string {
  const d = tmp();
  mkdirSync(join(d, '.uap'), { recursive: true });
  writeFileSync(join(d, '.uap', 'plan_state.json'), JSON.stringify({ validated_at: Math.floor(Date.now() / 1000) - secondsAgo }));
  return join(d, '.uap');
}

describe('validate-plan-on-change enforcer', () => {
  it('BLOCKS a plan-file write when never validated', () => {
    const stateDir = join(tmp(), '.uap'); // empty (no state)
    expect(run('Write', 'plans/my-plan.md', { UAP_STATE_DIR: stateDir })).toBe(2);
    expect(run('Write', 'IMPLEMENTATION-PLAN.md', { UAP_STATE_DIR: stateDir })).toBe(2);
    expect(run('Edit', 'docs/rollout-plan.md', { UAP_STATE_DIR: stateDir })).toBe(2);
  });

  it('ALLOWS non-plan files and non-edit ops', () => {
    const stateDir = join(tmp(), '.uap');
    expect(run('Write', 'src/foo.ts', { UAP_STATE_DIR: stateDir })).toBe(0);
    expect(run('Write', 'planning-guide.md', { UAP_STATE_DIR: stateDir })).toBe(0); // not "plan"
    expect(run('Write', 'explanation.md', { UAP_STATE_DIR: stateDir })).toBe(0);
    expect(run('Bash', 'plans/x.md', { UAP_STATE_DIR: stateDir })).toBe(0); // not an edit op
  });

  it('ALLOWS a plan write when validated within the window', () => {
    const stateDir = seedValidatedAgo(10);
    expect(run('Write', 'plans/my-plan.md', { UAP_STATE_DIR: stateDir, UAP_PLAN_VALIDATE_WINDOW: '300' })).toBe(0);
  });

  it('RE-BLOCKS a plan write once the validation is stale', () => {
    const stateDir = seedValidatedAgo(9999);
    expect(run('Write', 'plans/my-plan.md', { UAP_STATE_DIR: stateDir, UAP_PLAN_VALIDATE_WINDOW: '300' })).toBe(2);
  });

  it('honors the UAP_PLAN_VALIDATE_OFF escape hatch', () => {
    const stateDir = join(tmp(), '.uap');
    expect(run('Write', 'plans/my-plan.md', { UAP_STATE_DIR: stateDir, UAP_PLAN_VALIDATE_OFF: '1' })).toBe(0);
  });
});

describe('uap plan validate CLI', () => {
  it('records a fresh validation the enforcer then honors', async () => {
    const d = tmp();
    await planCommand('validate', {}, d);
    // The state the CLI wrote should unblock the enforcer for the same dir.
    const code = run('Write', 'plans/my-plan.md', { UAP_STATE_DIR: join(d, '.uap') });
    expect(code).toBe(0);
  });

  it('status reports fresh right after validate, via JSON', async () => {
    const d = tmp();
    await planCommand('validate', {}, d);
    const orig = console.log;
    let out = '';
    console.log = (s?: unknown) => { out += String(s); };
    try {
      await planCommand('status', { json: true }, d);
    } finally {
      console.log = orig;
    }
    const parsed = JSON.parse(out);
    expect(parsed.fresh).toBe(true);
    expect(parsed.validated_at).toBeGreaterThan(0);
  });
});
